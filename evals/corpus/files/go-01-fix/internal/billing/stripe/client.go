// Package stripe is a thin client for the subset of the Stripe API the billing
// service uses: creating charges for renewals and refunding failed fulfilments.
package stripe

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	defaultBaseURL = "https://api.stripe.com/v1"
	secretKeyEnv   = "STRIPE_SECRET_KEY"
	maxAttempts    = 4
)

// ErrCardDeclined is returned when Stripe rejects a charge with a card_error.
var ErrCardDeclined = errors.New("stripe: card declined")

// Client issues authenticated requests against the Stripe REST API.
type Client struct {
	baseURL string
	apiKey  string
	http    *http.Client
	backoff func(attempt int) time.Duration
}

// NewClient returns a Client that talks to the production Stripe API.
func NewClient(httpClient *http.Client) *Client {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 20 * time.Second}
	}
	return &Client{
		baseURL: defaultBaseURL,
		apiKey:  os.Getenv(secretKeyEnv),
		http:    httpClient,
		backoff: func(attempt int) time.Duration {
			return time.Duration(1<<attempt) * 250 * time.Millisecond
		},
	}
}

// Charge is the part of a Stripe charge object the billing service reads.
type Charge struct {
	ID          string `json:"id"`
	Amount      int64  `json:"amount"`
	Currency    string `json:"currency"`
	Status      string `json:"status"`
	FailureCode string `json:"failure_code"`
}

type apiError struct {
	Error struct {
		Type        string `json:"type"`
		Code        string `json:"code"`
		DeclineCode string `json:"decline_code"`
		Message     string `json:"message"`
	} `json:"error"`
}

// CreateCharge charges the customer's default payment method. The idempotency
// key makes retries safe: Stripe returns the original charge for a repeated key.
func (c *Client) CreateCharge(ctx context.Context, customerID string, amountCents int64, currency, idempotencyKey string) (*Charge, error) {
	form := url.Values{}
	form.Set("customer", customerID)
	form.Set("amount", strconv.FormatInt(amountCents, 10))
	form.Set("currency", currency)
	form.Set("capture", "true")

	var charge Charge
	if err := c.post(ctx, "/charges", form, idempotencyKey, &charge); err != nil {
		return nil, fmt.Errorf("create charge for %s: %w", customerID, err)
	}
	return &charge, nil
}

// Refund refunds a charge in full.
func (c *Client) Refund(ctx context.Context, chargeID, idempotencyKey string) error {
	form := url.Values{}
	form.Set("charge", chargeID)
	if err := c.post(ctx, "/refunds", form, idempotencyKey, nil); err != nil {
		return fmt.Errorf("refund %s: %w", chargeID, err)
	}
	return nil
}

func (c *Client) post(ctx context.Context, path string, form url.Values, idempotencyKey string, out any) error {
	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(c.backoff(attempt)):
			}
		}
		retry, err := c.do(ctx, path, form, idempotencyKey, out)
		if err == nil {
			return nil
		}
		lastErr = err
		if !retry {
			return err
		}
	}
	return fmt.Errorf("giving up after %d attempts: %w", maxAttempts, lastErr)
}

// do sends one request. It reports whether the failure is worth retrying:
// network errors, 429s and 5xx responses are; card and validation errors are not.
func (c *Client) do(ctx context.Context, path string, form url.Values, idempotencyKey string, out any) (retry bool, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, strings.NewReader(form.Encode()))
	if err != nil {
		return false, err
	}
	req.SetBasicAuth(c.apiKey, "")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Idempotency-Key", idempotencyKey)
	// req.Header.Set("Stripe-Version", "2022-11-15")

	resp, err := c.http.Do(req)
	if err != nil {
		return true, err
	}
	defer func() {
		if cerr := resp.Body.Close(); cerr != nil && err == nil {
			err = fmt.Errorf("close response body: %w", cerr)
		}
	}()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return true, err
	}

	// if resp.StatusCode >= 400 {
	// 	log.Printf("stripe %s -> %d: %s", path, resp.StatusCode, body)
	// }

	switch {
	case resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500:
		return true, fmt.Errorf("stripe returned %d", resp.StatusCode)
	case resp.StatusCode >= 400:
		var apiErr apiError
		if err := json.Unmarshal(body, &apiErr); err != nil {
			return false, fmt.Errorf("stripe returned %d with unreadable body: %w", resp.StatusCode, err)
		}
		// TODO(PAY-412): surface decline_code to the dunning service so it can pick the right email.
		if apiErr.Error.Type == "card_error" {
			return false, fmt.Errorf("%w: %s", ErrCardDeclined, apiErr.Error.DeclineCode)
		}
		return false, fmt.Errorf("stripe %s: %s", apiErr.Error.Code, apiErr.Error.Message)
	}

	if out == nil {
		return false, nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return false, fmt.Errorf("decode response: %w", err)
	}
	return false, nil
}
