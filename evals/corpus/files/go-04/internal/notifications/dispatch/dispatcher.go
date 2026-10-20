// Package dispatch delivers queued notifications to users over email, SMS,
// mobile push and customer webhooks.
//
// Producers never talk to providers directly. They write a Message into the
// transactional outbox in the same database transaction as the business change
// that caused it, and the Dispatcher drains the outbox:
//
//  1. A worker claims a batch of due messages under a time-limited lease.
//  2. For each message it loads the recipient's preferences, drops anything
//     the recipient opted out of, and defers non-urgent messages that fall in
//     the recipient's quiet hours.
//  3. It renders the template for each remaining channel and hands it to the
//     channel's Sender, retrying transient failures with jittered backoff.
//  4. The outcome is written back to the outbox and the lease is released.
//
// Delivery is at-least-once. Senders receive a stable idempotency key per
// message and channel so that providers which support it can drop duplicates.
package dispatch

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Channel is a delivery medium.
type Channel string

const (
	ChannelEmail   Channel = "email"
	ChannelSMS     Channel = "sms"
	ChannelPush    Channel = "push"
	ChannelWebhook Channel = "webhook"
)

// defaultChannelOrder is used when a message does not name its channels. The
// order matters for urgent messages: push is tried before SMS because it is
// free, and SMS is the fallback when push fails.
var defaultChannelOrder = []Channel{ChannelPush, ChannelEmail, ChannelSMS, ChannelWebhook}

// Priority controls quiet-hours handling, digests and channel fallback.
type Priority int

const (
	// PriorityLow messages are collected into a daily digest when the
	// recipient has digests turned on.
	PriorityLow Priority = iota
	// PriorityNormal messages are delivered promptly but respect quiet hours.
	PriorityNormal
	// PriorityUrgent messages, such as security alerts and failed payments,
	// ignore quiet hours and opt-outs and fall back to SMS when push fails.
	PriorityUrgent
)

func (p Priority) String() string {
	switch p {
	case PriorityLow:
		return "low"
	case PriorityNormal:
		return "normal"
	case PriorityUrgent:
		return "urgent"
	}
	return fmt.Sprintf("priority(%d)", int(p))
}

// Message is one notification waiting in the outbox.
type Message struct {
	ID          string
	TenantID    string
	RecipientID string
	Template    string
	Data        map[string]any
	Priority    Priority
	// Channels restricts delivery to the listed channels. Empty means every
	// channel the recipient has enabled.
	Channels  []Channel
	DedupeKey string
	CreatedAt time.Time
	NotBefore time.Time
	// Attempts counts previous claims of this message that ended without a
	// successful delivery.
	Attempts int
}

// Recipient is the addressing information for one user.
type Recipient struct {
	ID         string
	Email      string
	Phone      string
	PushTokens []string
	WebhookURL string
	Locale     string
	TimeZone   *time.Location
}

// QuietHours is a daily window, in the recipient's time zone, during which
// non-urgent notifications are held back. Start may be later than End for
// windows that span midnight, for example 22:00 to 07:00.
type QuietHours struct {
	Start time.Duration // offset from local midnight
	End   time.Duration
}

// Preferences are a recipient's notification settings.
type Preferences struct {
	Enabled  map[Channel]bool
	OptedOut map[string]bool // keyed by template name
	Quiet    *QuietHours
	// DigestLow collects low-priority messages into one daily email.
	DigestLow bool
}

// Lease is a claim on a batch of outbox rows. Rows return to the queue when
// the lease expires, so a crashed worker cannot strand messages.
type Lease struct {
	ID        string
	ExpiresAt time.Time
}

// Digest is a recipient's accumulated low-priority messages.
type Digest struct {
	ID          string
	TenantID    string
	RecipientID string
	Messages    []Message
	DueAt       time.Time
}

// Rendered is a template rendered for one channel.
type Rendered struct {
	Subject string
	Body    string
	HTML    string
}

// Delivery is everything a Sender needs to deliver one message on one channel.
type Delivery struct {
	MessageID      string
	IdempotencyKey string
	Recipient      Recipient
	Content        Rendered
	Priority       Priority
	// SigningSecret is set only for webhook deliveries; the webhook sender
	// uses it to sign the request body so customers can verify its origin.
	SigningSecret string
}

// Outcome records what happened on one channel.
type Outcome struct {
	Channel    Channel
	ProviderID string
	Err        error
	Attempts   int
}

var (
	// ErrPermanent wraps sender errors that cannot succeed on retry, such as
	// an invalid phone number or a revoked push token.
	ErrPermanent = errors.New("dispatch: permanent delivery failure")
	// ErrUnknownRecipient is returned by a Directory for deleted users.
	ErrUnknownRecipient = errors.New("dispatch: unknown recipient")
	// ErrNoChannels is recorded when a message has nowhere to go.
	ErrNoChannels = errors.New("dispatch: no deliverable channels")
	// ErrSMSBudget is recorded when a tenant has used its hourly SMS budget.
	ErrSMSBudget = errors.New("dispatch: tenant sms budget exhausted")

	errLeaseLost = errors.New("dispatch: lease expired before the batch finished")
)

// Outbox is the durable queue of pending messages.
type Outbox interface {
	// ClaimBatch leases up to limit due messages for ttl.
	ClaimBatch(ctx context.Context, limit int, ttl time.Duration) (Lease, []Message, error)
	ExtendLease(ctx context.Context, leaseID string, ttl time.Duration) error
	ReleaseLease(ctx context.Context, leaseID string) error

	MarkDelivered(ctx context.Context, messageID string, outcomes []Outcome) error
	MarkFailed(ctx context.Context, messageID string, outcomes []Outcome) error
	Reschedule(ctx context.Context, messageID string, notBefore time.Time, reason string) error

	AppendToDigest(ctx context.Context, msg Message) error
	DueDigests(ctx context.Context, now time.Time, limit int) ([]Digest, error)
	ClearDigest(ctx context.Context, digestID string) error
}

// Directory resolves recipients and their preferences.
type Directory interface {
	Recipient(ctx context.Context, tenantID, userID string) (Recipient, error)
	Preferences(ctx context.Context, tenantID, userID string) (Preferences, error)
}

// Renderer renders a named template for a channel and locale.
type Renderer interface {
	Render(ctx context.Context, template string, channel Channel, locale string, data map[string]any) (Rendered, error)
}

// Sender delivers on a single channel and returns the provider's message ID.
type Sender interface {
	Send(ctx context.Context, d Delivery) (providerID string, err error)
}

// Deduper remembers dedupe keys for a window so that a producer retrying its
// own transaction does not notify the user twice.
type Deduper interface {
	// Seen records key and reports whether it had already been recorded.
	Seen(ctx context.Context, key string, window time.Duration) (bool, error)
}

// SecretSource reads secrets from the platform secret manager.
type SecretSource interface {
	Get(ctx context.Context, name string) (string, error)
}

// Metrics receives counters and timings. Implementations must not block.
type Metrics interface {
	Count(name string, value int64, tags ...string)
	Timing(name string, d time.Duration, tags ...string)
}

// Config tunes the dispatcher. Zero values are replaced by the defaults below.
type Config struct {
	Workers       int
	BatchSize     int
	LeaseDuration time.Duration
	PollInterval  time.Duration

	// SendAttempts bounds retries of one channel within a single claim.
	SendAttempts int
	BaseBackoff  time.Duration
	MaxBackoff   time.Duration
	SendTimeout  time.Duration

	// MaxAttempts bounds how many times a message is claimed before it is
	// marked failed.
	MaxAttempts int

	DedupeWindow        time.Duration
	SMSPerTenantPerHour int

	// WebhookSecretName names the secret-manager entry holding the key used
	// to sign outgoing webhooks.
	WebhookSecretName string
}

func (c *Config) setDefaults() {
	if c.Workers == 0 {
		c.Workers = 4
	}
	if c.BatchSize == 0 {
		c.BatchSize = 100
	}
	if c.LeaseDuration == 0 {
		c.LeaseDuration = 2 * time.Minute
	}
	if c.PollInterval == 0 {
		c.PollInterval = time.Second
	}
	if c.SendAttempts == 0 {
		c.SendAttempts = 3
	}
	if c.BaseBackoff == 0 {
		c.BaseBackoff = 200 * time.Millisecond
	}
	if c.MaxBackoff == 0 {
		c.MaxBackoff = 5 * time.Second
	}
	if c.SendTimeout == 0 {
		c.SendTimeout = 10 * time.Second
	}
	if c.MaxAttempts == 0 {
		c.MaxAttempts = 8
	}
	if c.DedupeWindow == 0 {
		c.DedupeWindow = 24 * time.Hour
	}
	if c.SMSPerTenantPerHour == 0 {
		c.SMSPerTenantPerHour = 5000
	}
}

func (c Config) validate() error {
	var problems []string
	if c.Workers < 1 {
		problems = append(problems, "Workers must be at least 1")
	}
	if c.BatchSize < 1 || c.BatchSize > 1000 {
		problems = append(problems, "BatchSize must be between 1 and 1000")
	}
	if c.LeaseDuration < 10*time.Second {
		problems = append(problems, "LeaseDuration must be at least 10s")
	}
	if c.SendTimeout*time.Duration(c.SendAttempts) >= c.LeaseDuration {
		problems = append(problems, "SendTimeout × SendAttempts must be shorter than LeaseDuration")
	}
	if c.BaseBackoff > c.MaxBackoff {
		problems = append(problems, "BaseBackoff must not exceed MaxBackoff")
	}
	if c.WebhookSecretName == "" {
		problems = append(problems, "WebhookSecretName is required")
	}
	if len(problems) > 0 {
		return fmt.Errorf("dispatch: invalid config: %s", strings.Join(problems, "; "))
	}
	return nil
}

// Deps are the dispatcher's collaborators.
type Deps struct {
	Outbox    Outbox
	Directory Directory
	Renderer  Renderer
	Senders   map[Channel]Sender
	Deduper   Deduper
	Secrets   SecretSource
	Metrics   Metrics
	Logger    *slog.Logger
}

// Dispatcher drains the outbox. Create one with New and start it with Run.
type Dispatcher struct {
	cfg      Config
	outbox   Outbox
	dir      Directory
	renderer Renderer
	senders  map[Channel]Sender
	dedupe   Deduper
	metrics  Metrics
	log      *slog.Logger
	now      func() time.Time

	webhookSecret string
	sms           *smsBudget

	delivered atomic.Int64
	failed    atomic.Int64
	deferred  atomic.Int64
	dropped   atomic.Int64
}

// New validates cfg, loads the webhook signing key and returns a Dispatcher.
func New(ctx context.Context, cfg Config, deps Deps) (*Dispatcher, error) {
	cfg.setDefaults()
	if err := cfg.validate(); err != nil {
		return nil, err
	}
	if deps.Outbox == nil || deps.Directory == nil || deps.Renderer == nil || deps.Deduper == nil {
		return nil, errors.New("dispatch: Outbox, Directory, Renderer and Deduper are required")
	}
	if len(deps.Senders) == 0 {
		return nil, errors.New("dispatch: at least one Sender is required")
	}
	logger := deps.Logger
	if logger == nil {
		logger = slog.Default()
	}

	secret, err := deps.Secrets.Get(ctx, cfg.WebhookSecretName)
	if err != nil {
		return nil, fmt.Errorf("dispatch: load webhook signing secret %q: %w", cfg.WebhookSecretName, err)
	}

	return &Dispatcher{
		cfg:           cfg,
		outbox:        deps.Outbox,
		dir:           deps.Directory,
		renderer:      deps.Renderer,
		senders:       deps.Senders,
		dedupe:        deps.Deduper,
		metrics:       deps.Metrics,
		log:           logger.With("component", "notifications.dispatch"),
		now:           time.Now,
		webhookSecret: secret,
		sms:           newSMSBudget(cfg.SMSPerTenantPerHour),
	}, nil
}

// Stats is a snapshot of the dispatcher's counters since it started.
type Stats struct {
	Delivered int64
	Failed    int64
	Deferred  int64
	Dropped   int64
}

// Stats returns the current counters. It is safe to call concurrently with Run.
func (d *Dispatcher) Stats() Stats {
	return Stats{
		Delivered: d.delivered.Load(),
		Failed:    d.failed.Load(),
		Deferred:  d.deferred.Load(),
		Dropped:   d.dropped.Load(),
	}
}

// Run starts cfg.Workers workers and blocks until ctx is cancelled and every
// worker has finished its current batch. It returns nil on a clean shutdown.
func (d *Dispatcher) Run(ctx context.Context) error {
	var wg sync.WaitGroup
	errs := make(chan error, d.cfg.Workers)
	for i := 0; i < d.cfg.Workers; i++ {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()
			errs <- d.work(ctx, worker)
		}(i)
	}
	wg.Wait()
	close(errs)

	var failures []error
	for err := range errs {
		if err != nil && !errors.Is(err, context.Canceled) {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}

// work is one worker's loop. Batch errors are logged and retried after the
// poll interval; only cancellation ends the loop.
func (d *Dispatcher) work(ctx context.Context, worker int) error {
	log := d.log.With("worker", worker)
	idle := d.cfg.PollInterval
	for {
		n, err := d.runOnce(ctx)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err != nil {
			log.Error("notification batch failed", "err", err)
			d.metrics.Count("notifications.batch_errors", 1)
		}
		if n > 0 && err == nil {
			// A full or partial batch means more work is probably waiting.
			idle = d.cfg.PollInterval
			continue
		}
		if err := sleep(ctx, jitter(idle)); err != nil {
			return err
		}
		// Back off gently while the outbox stays empty, up to ten poll intervals.
		idle = min(idle*2, 10*d.cfg.PollInterval)
	}
}

// runOnce claims and processes one batch, returning how many messages it held.
func (d *Dispatcher) runOnce(ctx context.Context) (int, error) {
	lease, batch, err := d.outbox.ClaimBatch(ctx, d.cfg.BatchSize, d.cfg.LeaseDuration)
	if err != nil {
		return 0, fmt.Errorf("claim batch: %w", err)
	}
	if len(batch) == 0 {
		return 0, nil
	}

	started := d.now()
	processErr := d.processBatch(ctx, lease, batch)

	// Release even when ctx is cancelled so another worker can pick up the
	// unprocessed remainder immediately instead of waiting for expiry.
	if err := d.outbox.ReleaseLease(context.WithoutCancel(ctx), lease.ID); err != nil {
		return len(batch), errors.Join(processErr, fmt.Errorf("release lease %s: %w", lease.ID, err))
	}
	d.metrics.Timing("notifications.batch", d.now().Sub(started))
	d.metrics.Count("notifications.claimed", int64(len(batch)))
	return len(batch), processErr
}

// processBatch dispatches each message in the batch in priority order, so that
// urgent messages are not stuck behind a long run of marketing emails if the
// lease runs short.
func (d *Dispatcher) processBatch(ctx context.Context, lease Lease, batch []Message) error {
	sort.SliceStable(batch, func(i, j int) bool {
		return batch[i].Priority > batch[j].Priority
	})

	expires := lease.ExpiresAt
	for i, msg := range batch {
		if err := ctx.Err(); err != nil {
			return err
		}
		now := d.now()
		if now.After(expires) {
			return fmt.Errorf("%w: %d of %d messages left", errLeaseLost, len(batch)-i, len(batch))
		}
		// Renew once less than a quarter of the lease remains. Renewing on
		// every message would double the write load on the outbox table.
		if expires.Sub(now) < d.cfg.LeaseDuration/4 {
			d.outbox.ExtendLease(ctx, lease.ID, d.cfg.LeaseDuration)
			expires = now.Add(d.cfg.LeaseDuration)
		}
		if err := d.dispatch(ctx, msg); err != nil {
			return fmt.Errorf("message %s: %w", msg.ID, err)
		}
	}
	return nil
}

// dispatch handles one message end to end. It returns an error only when the
// outbox or directory cannot be updated or read; delivery failures are
// recorded on the message itself.
func (d *Dispatcher) dispatch(ctx context.Context, msg Message) error {
	log := d.log.With("message", msg.ID, "template", msg.Template, "tenant", msg.TenantID)

	if msg.DedupeKey != "" {
		seen, err := d.dedupe.Seen(ctx, msg.TenantID+":"+msg.DedupeKey, d.cfg.DedupeWindow)
		if err != nil {
			return fmt.Errorf("dedupe: %w", err)
		}
		if seen {
			log.Info("dropping duplicate notification", "dedupe_key", msg.DedupeKey)
			d.dropped.Add(1)
			d.metrics.Count("notifications.duplicates", 1, "template:"+msg.Template)
			return d.outbox.MarkDelivered(ctx, msg.ID, nil)
		}
	}

	recipient, err := d.dir.Recipient(ctx, msg.TenantID, msg.RecipientID)
	if errors.Is(err, ErrUnknownRecipient) {
		log.Info("recipient no longer exists")
		d.dropped.Add(1)
		return d.outbox.MarkFailed(ctx, msg.ID, []Outcome{{Err: err}})
	}
	if err != nil {
		return fmt.Errorf("load recipient %s: %w", msg.RecipientID, err)
	}

	prefs, err := d.dir.Preferences(ctx, msg.TenantID, msg.RecipientID)
	if err != nil {
		return fmt.Errorf("load preferences for %s: %w", msg.RecipientID, err)
	}

	if prefs.OptedOut[msg.Template] && msg.Priority != PriorityUrgent {
		d.dropped.Add(1)
		d.metrics.Count("notifications.opted_out", 1, "template:"+msg.Template)
		return d.outbox.MarkDelivered(ctx, msg.ID, nil)
	}

	if msg.Priority == PriorityLow && prefs.DigestLow {
		if err := d.outbox.AppendToDigest(ctx, msg); err != nil {
			return fmt.Errorf("append to digest: %w", err)
		}
		return d.outbox.MarkDelivered(ctx, msg.ID, nil)
	}

	if msg.Priority != PriorityUrgent {
		if until, quiet := quietUntil(prefs.Quiet, recipient.TimeZone, d.now()); quiet {
			d.deferred.Add(1)
			d.metrics.Count("notifications.quiet_hours", 1)
			return d.outbox.Reschedule(ctx, msg.ID, until, "quiet hours")
		}
	}

	channels := selectChannels(msg, recipient, prefs)
	if len(channels) == 0 {
		d.failed.Add(1)
		return d.outbox.MarkFailed(ctx, msg.ID, []Outcome{{Err: ErrNoChannels}})
	}

	outcomes := d.deliverAll(ctx, msg, recipient, channels)
	if msg.Priority == PriorityUrgent {
		outcomes = d.urgentFallback(ctx, msg, recipient, outcomes)
	}
	return d.record(ctx, msg, outcomes)
}

// deliverAll sends on every channel concurrently. Outcomes are returned in the
// order of channels regardless of completion order.
func (d *Dispatcher) deliverAll(ctx context.Context, msg Message, recipient Recipient, channels []Channel) []Outcome {
	outcomes := make([]Outcome, len(channels))
	var wg sync.WaitGroup
	for i, ch := range channels {
		if ch == ChannelSMS && !d.sms.take(msg.TenantID, d.now()) {
			outcomes[i] = Outcome{Channel: ch, Err: ErrSMSBudget}
			d.metrics.Count("notifications.sms_budget_exhausted", 1, "tenant:"+msg.TenantID)
			continue
		}
		wg.Add(1)
		go func(i int, ch Channel) {
			defer wg.Done()
			outcomes[i] = d.deliverOne(ctx, msg, recipient, ch)
		}(i, ch)
	}
	wg.Wait()
	return outcomes
}

// urgentFallback retries an urgent message over SMS when push was the only
// channel attempted and it failed. Security alerts must reach the user.
func (d *Dispatcher) urgentFallback(ctx context.Context, msg Message, recipient Recipient, outcomes []Outcome) []Outcome {
	pushFailed := false
	for _, o := range outcomes {
		if o.Err == nil {
			return outcomes
		}
		if o.Channel == ChannelSMS {
			return outcomes
		}
		if o.Channel == ChannelPush {
			pushFailed = true
		}
	}
	if !pushFailed || recipient.Phone == "" {
		return outcomes
	}
	d.log.Warn("push failed for urgent notification, falling back to sms", "message", msg.ID)
	d.metrics.Count("notifications.sms_fallback", 1, "template:"+msg.Template)
	return append(outcomes, d.deliverOne(ctx, msg, recipient, ChannelSMS))
}

// deliverOne renders and sends a message on a single channel, retrying
// transient failures up to cfg.SendAttempts times.
func (d *Dispatcher) deliverOne(ctx context.Context, msg Message, recipient Recipient, ch Channel) Outcome {
	sender, ok := d.senders[ch]
	if !ok {
		return Outcome{Channel: ch, Err: fmt.Errorf("%w: no sender configured for %s", ErrPermanent, ch)}
	}

	content, err := d.renderer.Render(ctx, msg.Template, ch, localeOrDefault(recipient.Locale), msg.Data)
	if err != nil {
		return Outcome{Channel: ch, Err: fmt.Errorf("%w: render %s for %s: %w", ErrPermanent, msg.Template, ch, err)}
	}

	delivery := Delivery{
		MessageID:      msg.ID,
		IdempotencyKey: msg.ID + ":" + string(ch),
		Recipient:      recipient,
		Content:        content,
		Priority:       msg.Priority,
	}
	if ch == ChannelWebhook {
		delivery.SigningSecret = d.webhookSecret
	}

	var lastErr error
	for attempt := 1; attempt <= d.cfg.SendAttempts; attempt++ {
		sendCtx, cancel := context.WithTimeout(ctx, d.cfg.SendTimeout)
		started := d.now()
		providerID, err := sender.Send(sendCtx, delivery)
		cancel()
		d.metrics.Timing("notifications.send", d.now().Sub(started), "channel:"+string(ch), "ok:"+fmt.Sprint(err == nil))

		if err == nil {
			return Outcome{Channel: ch, ProviderID: providerID, Attempts: attempt}
		}
		lastErr = err
		if errors.Is(err, ErrPermanent) || ctx.Err() != nil {
			return Outcome{Channel: ch, Err: err, Attempts: attempt}
		}
		if attempt == d.cfg.SendAttempts {
			break
		}
		if err := sleep(ctx, d.backoff(attempt)); err != nil {
			return Outcome{Channel: ch, Err: errors.Join(lastErr, err), Attempts: attempt}
		}
	}
	return Outcome{Channel: ch, Err: lastErr, Attempts: d.cfg.SendAttempts}
}

// record writes the result back to the outbox. A message counts as delivered
// when at least one channel succeeded. If every channel failed it is retried
// later, unless all failures were permanent or the message has used up its
// attempts, in which case it is marked failed.
func (d *Dispatcher) record(ctx context.Context, msg Message, outcomes []Outcome) error {
	var succeeded, permanent int
	for _, o := range outcomes {
		switch {
		case o.Err == nil:
			succeeded++
		case errors.Is(o.Err, ErrPermanent):
			permanent++
		}
	}

	switch {
	case succeeded > 0:
		d.delivered.Add(1)
		d.metrics.Count("notifications.delivered", 1, "template:"+msg.Template, "priority:"+msg.Priority.String())
		if err := d.outbox.MarkDelivered(ctx, msg.ID, outcomes); err != nil {
			return fmt.Errorf("mark delivered: %w", err)
		}
		return nil

	case permanent == len(outcomes) || msg.Attempts+1 >= d.cfg.MaxAttempts:
		d.failed.Add(1)
		d.metrics.Count("notifications.failed", 1, "template:"+msg.Template)
		d.log.Warn("notification failed permanently",
			"message", msg.ID,
			"attempts", msg.Attempts+1,
			"errors", summarize(outcomes),
		)
		if err := d.outbox.MarkFailed(ctx, msg.ID, outcomes); err != nil {
			return fmt.Errorf("mark failed: %w", err)
		}
		return nil

	default:
		next := d.now().Add(retryDelay(msg.Attempts + 1))
		d.metrics.Count("notifications.rescheduled", 1, "template:"+msg.Template)
		if err := d.outbox.Reschedule(ctx, msg.ID, next, summarize(outcomes)); err != nil {
			return fmt.Errorf("reschedule: %w", err)
		}
		return nil
	}
}

// SendDigests emails every digest that is due and returns how many were sent.
// It is driven by a scheduled job rather than the worker loop because digests
// go out at a fixed local time rather than as soon as possible.
func (d *Dispatcher) SendDigests(ctx context.Context, limit int) (int, error) {
	digests, err := d.outbox.DueDigests(ctx, d.now(), limit)
	if err != nil {
		return 0, fmt.Errorf("load due digests: %w", err)
	}

	sent := 0
	var failures []error
	for _, dg := range digests {
		if err := ctx.Err(); err != nil {
			return sent, err
		}
		if err := d.sendDigest(ctx, dg); err != nil {
			failures = append(failures, fmt.Errorf("digest %s: %w", dg.ID, err))
			continue
		}
		sent++
	}
	d.metrics.Count("notifications.digests_sent", int64(sent))
	return sent, errors.Join(failures...)
}

func (d *Dispatcher) sendDigest(ctx context.Context, dg Digest) error {
	recipient, err := d.dir.Recipient(ctx, dg.TenantID, dg.RecipientID)
	if errors.Is(err, ErrUnknownRecipient) || (err == nil && recipient.Email == "") {
		// Nobody to send to; drop the digest rather than retrying it forever.
		return d.outbox.ClearDigest(ctx, dg.ID)
	}
	if err != nil {
		return err
	}

	items := make([]map[string]any, 0, len(dg.Messages))
	for _, m := range dg.Messages {
		items = append(items, map[string]any{
			"template":   m.Template,
			"data":       m.Data,
			"created_at": m.CreatedAt,
		})
	}
	msg := Message{
		ID:          "digest-" + dg.ID,
		TenantID:    dg.TenantID,
		RecipientID: dg.RecipientID,
		Template:    "digest",
		Data:        map[string]any{"items": items, "count": len(items)},
		Priority:    PriorityLow,
		CreatedAt:   d.now(),
	}

	out := d.deliverOne(ctx, msg, recipient, ChannelEmail)
	if out.Err != nil {
		return out.Err
	}
	return d.outbox.ClearDigest(ctx, dg.ID)
}

// selectChannels decides where a message goes: the channels the message asks
// for (or the default order), minus those the recipient disabled and those the
// recipient has no address for. Urgent messages ignore disabled channels.
func selectChannels(msg Message, recipient Recipient, prefs Preferences) []Channel {
	candidates := msg.Channels
	if len(candidates) == 0 {
		candidates = defaultChannelOrder
	}

	// TODO(NOTIF-88): honour per-template channel overrides from the tenant admin console.
	selected := make([]Channel, 0, len(candidates))
	for _, ch := range candidates {
		if !addressable(recipient, ch) {
			continue
		}
		if msg.Priority != PriorityUrgent && !prefs.Enabled[ch] {
			continue
		}
		selected = append(selected, ch)
	}

	// Urgent messages go to push alone first; urgentFallback adds SMS only if
	// push fails, so users are not woken by a text they also got as a push.
	if msg.Priority == PriorityUrgent && len(msg.Channels) == 0 {
		for _, ch := range selected {
			if ch == ChannelPush {
				return []Channel{ChannelPush}
			}
		}
	}
	return selected
}

func addressable(r Recipient, ch Channel) bool {
	switch ch {
	case ChannelEmail:
		return r.Email != ""
	case ChannelSMS:
		return r.Phone != ""
	case ChannelPush:
		return len(r.PushTokens) > 0
	case ChannelWebhook:
		return r.WebhookURL != ""
	}
	return false
}

// quietUntil reports whether now falls inside the recipient's quiet hours and,
// if so, when they end. A nil window or location means no quiet hours.
func quietUntil(q *QuietHours, loc *time.Location, now time.Time) (time.Time, bool) {
	if q == nil || loc == nil || q.Start == q.End {
		return time.Time{}, false
	}
	local := now.In(loc)
	midnight := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, loc)
	offset := local.Sub(midnight)

	if q.Start < q.End {
		// Same-day window, e.g. 13:00 to 15:00.
		if offset >= q.Start && offset < q.End {
			return midnight.Add(q.End), true
		}
		return time.Time{}, false
	}

	// Window spanning midnight, e.g. 22:00 to 07:00.
	switch {
	case offset >= q.Start:
		return midnight.AddDate(0, 0, 1).Add(q.End), true
	case offset < q.End:
		return midnight.Add(q.End), true
	}
	return time.Time{}, false
}

// backoff returns the delay before send attempt+1: exponential from
// BaseBackoff, capped at MaxBackoff, with full jitter.
func (d *Dispatcher) backoff(attempt int) time.Duration {
	ceiling := d.cfg.BaseBackoff << (attempt - 1)
	if ceiling <= 0 || ceiling > d.cfg.MaxBackoff {
		ceiling = d.cfg.MaxBackoff
	}
	return time.Duration(rand.Int64N(int64(ceiling) + 1))
}

// retryDelays is the schedule for re-queuing a message whose channels all
// failed. It is deliberately coarse; provider outages tend to last minutes.
var retryDelays = []time.Duration{
	time.Minute,
	5 * time.Minute,
	15 * time.Minute,
	time.Hour,
	4 * time.Hour,
}

func retryDelay(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	if attempt > len(retryDelays) {
		return jitter(retryDelays[len(retryDelays)-1])
	}
	return jitter(retryDelays[attempt-1])
}

// jitter spreads d by ±10% so that workers started together drift apart.
func jitter(d time.Duration) time.Duration {
	spread := int64(d) / 10
	if spread <= 0 {
		return d
	}
	return d + time.Duration(rand.Int64N(2*spread+1)-spread)
}

func sleep(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// summarize renders per-channel errors as "email: timeout; sms: invalid number"
// for the outbox's last_error column.
func summarize(outcomes []Outcome) string {
	parts := make([]string, 0, len(outcomes))
	for _, o := range outcomes {
		if o.Err == nil {
			continue
		}
		channel := string(o.Channel)
		if channel == "" {
			channel = "dispatch"
		}
		parts = append(parts, channel+": "+o.Err.Error())
	}
	return strings.Join(parts, "; ")
}

func localeOrDefault(locale string) string {
	if locale == "" {
		return "en-US"
	}
	return locale
}

// smsBudget caps SMS sends per tenant per clock hour. SMS is the only channel
// that costs money per message, and a misbehaving integration could otherwise
// run up a large bill in minutes.
type smsBudget struct {
	mu     sync.Mutex
	limit  int
	window time.Time
	used   map[string]int
}

func newSMSBudget(limit int) *smsBudget {
	return &smsBudget{limit: limit, used: make(map[string]int)}
}

// take consumes one send from the tenant's budget for the current hour and
// reports whether one was available.
func (b *smsBudget) take(tenantID string, now time.Time) bool {
	b.mu.Lock()
	defer b.mu.Unlock()

	hour := now.Truncate(time.Hour)
	if !hour.Equal(b.window) {
		b.window = hour
		clear(b.used)
	}
	if b.used[tenantID] >= b.limit {
		return false
	}
	b.used[tenantID]++
	return true
}
