// Package reminders emails subscribers whose plans are about to renew so
// they have time to cancel or update their payment method.
package reminders

import (
	"context"
	"errors"
	"fmt"
	"time"

	"example.com/subs/internal/mail"
)

// noticeLead is how far ahead of renewal the notice goes out. Card networks
// require at least seven days of warning for annual plans; two weeks leaves
// room for a failed delivery to be retried on a later run.
const noticeLead = 14 * 24 * time.Hour

// Subscription is the slice of subscription data the reminder job reads.
type Subscription struct {
	ID         string
	OwnerEmail string
	OwnerName  string
	PlanName   string
	PriceCents int64
	Currency   string
	RenewsAt   time.Time
	AutoRenew  bool
	// NotifiedFor is the renewal date the last notice was sent for, or the
	// zero time if none has been sent yet.
	NotifiedFor time.Time
}

// Repository loads subscriptions and records which ones were notified.
type Repository interface {
	ListRenewingBetween(ctx context.Context, from, to time.Time) ([]Subscription, error)
	MarkNotified(ctx context.Context, id string, renewsAt time.Time) error
}

// Sender delivers one composed email.
type Sender interface {
	Send(ctx context.Context, msg mail.Message) error
}

// Job sends renewal notices. It is safe to run repeatedly: a subscription
// is notified at most once per renewal date.
type Job struct {
	repo   Repository
	sender Sender
	now    func() time.Time
}

// NewJob returns a Job that reads and records subscriptions through repo,
// delivers notices through sender, and takes the current time from now.
func NewJob(repo Repository, sender Sender, now func() time.Time) *Job {
	return &Job{repo: repo, sender: sender, now: now}
}

// Run notifies every eligible subscription renewing within noticeLead and
// returns how many notices were sent. A failed send does not stop the run;
// the failures are returned together once every subscription was tried.
func (j *Job) Run(ctx context.Context) (int, error) {
	now := j.now()
	cutoff := now.Add(noticeLead)
	subs, err := j.repo.ListRenewingBetween(ctx, now, cutoff)
	if err != nil {
		return 0, fmt.Errorf("list subscriptions renewing before %s: %w", cutoff.Format(time.DateOnly), err)
	}

	sent := 0
	var failures []error
	for _, sub := range subs {
		if !needsNotice(sub) {
			continue
		}
		if err := j.sender.Send(ctx, renewalMessage(sub)); err != nil {
			failures = append(failures, fmt.Errorf("send renewal notice for subscription %s: %w", sub.ID, err))
			continue
		}
		if err := j.repo.MarkNotified(ctx, sub.ID, sub.RenewsAt); err != nil {
			failures = append(failures, fmt.Errorf("record renewal notice for subscription %s: %w", sub.ID, err))
			continue
		}
		sent++
	}
	return sent, errors.Join(failures...)
}

// needsNotice reports whether sub should get a notice for its upcoming
// renewal. Subscriptions that will not renew automatically get an expiry
// email from the billing service instead, so they are skipped here.
func needsNotice(sub Subscription) bool {
	if !sub.AutoRenew || sub.OwnerEmail == "" {
		return false
	}
	return !sub.NotifiedFor.Equal(sub.RenewsAt)
}

func renewalMessage(sub Subscription) mail.Message {
	greeting := "Hello"
	if sub.OwnerName != "" {
		greeting = "Hello " + sub.OwnerName
	}
	body := fmt.Sprintf(
		"%s,\n\nYour %s plan renews on %s for %s.\n\nTo change or cancel it, visit your account settings before that date.\n",
		greeting, sub.PlanName, sub.RenewsAt.Format("January 2, 2006"), formatPrice(sub.PriceCents, sub.Currency),
	)
	return mail.Message{
		To:      sub.OwnerEmail,
		Subject: fmt.Sprintf("Your %s plan renews soon", sub.PlanName),
		Body:    body,
	}
}

// formatPrice renders minor units as a decimal amount. Every currency the
// billing service accepts has two decimal places.
func formatPrice(cents int64, currency string) string {
	return fmt.Sprintf("%d.%02d %s", cents/100, cents%100, currency)
}
