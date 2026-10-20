// Package partners connects order events to partner integrations.
package partners

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"
)

// signatureHeader carries the HMAC partners use to check that an event
// came from us; the name is part of the published integration contract.
const signatureHeader = "X-Shop-Signature"

// Event is one order event a partner subscribed to.
type Event struct {
	ID         string    `json:"id"`
	Type       string    `json:"type"`
	OrderID    string    `json:"order_id"`
	OccurredAt time.Time `json:"occurred_at"`
}

// Endpoint is a partner's registered webhook.
type Endpoint struct {
	URL    string
	Secret []byte
}

// RejectedError reports a 4xx answer. Partners use those to say an event
// will never be accepted, so it is not retried.
type RejectedError struct {
	Status int
}

func (e *RejectedError) Error() string {
	return fmt.Sprintf("partner rejected event with status %d", e.Status)
}

// Notifier posts signed events to partner endpoints, retrying network
// errors and 5xx answers with exponential backoff.
type Notifier struct {
	HTTP        *http.Client
	MaxAttempts int
	BaseDelay   time.Duration
}

// Deliver sends ev to ep, giving up after MaxAttempts or on a rejection.
func (n *Notifier) Deliver(ctx context.Context, ep Endpoint, ev Event) error {
	body, err := json.Marshal(ev)
	if err != nil {
		return fmt.Errorf("encode event %s: %w", ev.ID, err)
	}
	signature := sign(ep.Secret, body)

	delay := n.BaseDelay
	var lastErr error
	for attempt := 1; attempt <= n.MaxAttempts; attempt++ {
		err := n.post(ctx, ep.URL, body, signature)
		if err == nil {
			return nil
		}
		var rejected *RejectedError
		if errors.As(err, &rejected) {
			return fmt.Errorf("deliver event %s: %w", ev.ID, err)
		}
		lastErr = fmt.Errorf("deliver event %s, attempt %d: %w", ev.ID, attempt, err)
		select {
		case <-ctx.Done():
			return errors.Join(lastErr, ctx.Err())
		case <-time.After(delay):
		}
		delay *= 2
	}
	return lastErr
}

func (n *Notifier) post(ctx context.Context, url string, body []byte, signature string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build request for %s: %w", url, err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(signatureHeader, signature)

	resp, err := n.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("post to %s: %w", url, err)
	}
	if err := resp.Body.Close(); err != nil {
		return fmt.Errorf("close response from %s: %w", url, err)
	}
	switch {
	case resp.StatusCode < http.StatusMultipleChoices:
		return nil
	case resp.StatusCode < http.StatusInternalServerError:
		return &RejectedError{Status: resp.StatusCode}
	default:
		return fmt.Errorf("partner returned status %d", resp.StatusCode)
	}
}

// sign returns the hex HMAC-SHA256 of body under the partner's secret.
func sign(secret, body []byte) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}
