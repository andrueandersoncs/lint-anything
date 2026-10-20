// Package carrier is a small client for the parcel carrier's rating and
// tracking API.
package carrier

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// maxResponseBytes caps how much of a response body is read. The largest
// legitimate response, a tracking history with every scan event, stays well
// under a quarter of this.
const maxResponseBytes = 1 << 20

// ErrNotFound is returned when the carrier has no record of a tracking number.
var ErrNotFound = errors.New("carrier: tracking number not found")

// ErrBadResponse is returned when the carrier answers with a body that
// cannot be interpreted.
var ErrBadResponse = errors.New("carrier: malformed response")

// Client calls the carrier API with one account's credentials.
type Client struct {
	baseURL *url.URL
	apiKey  string
	http    *http.Client
}

// NewClient returns a Client for the API rooted at baseURL.
func NewClient(baseURL *url.URL, apiKey string, httpClient *http.Client) *Client {
	return &Client{baseURL: baseURL, apiKey: apiKey, http: httpClient}
}

// Parcel describes one package to be rated.
type Parcel struct {
	WeightGrams int    `json:"weight_grams"`
	LengthMM    int    `json:"length_mm"`
	WidthMM     int    `json:"width_mm"`
	HeightMM    int    `json:"height_mm"`
	FromPostal  string `json:"from_postal_code"`
	ToPostal    string `json:"to_postal_code"`
	ToCountry   string `json:"to_country"`
}

// Rate is one service level the carrier offers for a parcel.
type Rate struct {
	Service       string `json:"service"`
	AmountCents   int64  `json:"amount_cents"`
	Currency      string `json:"currency"`
	EstimatedDays int    `json:"estimated_days"`
}

// TrackingEvent is one scan recorded against a parcel.
type TrackingEvent struct {
	At          time.Time `json:"at"`
	Location    string    `json:"location"`
	Description string    `json:"description"`
}

// Tracking is the carrier's current view of a shipment.
type Tracking struct {
	Number    string          `json:"tracking_number"`
	Status    string          `json:"status"`
	Delivered bool            `json:"delivered"`
	Events    []TrackingEvent `json:"events"`
}

// Rates returns the service levels available for p in the order the
// carrier lists them.
func (c *Client) Rates(ctx context.Context, p Parcel) ([]Rate, error) {
	payload, err := json.Marshal(p)
	if err != nil {
		return nil, fmt.Errorf("encode rate request: %w", err)
	}
	status, body, err := c.do(ctx, http.MethodPost, "/v2/rates", payload)
	if err != nil {
		return nil, errors.New("rate request failed")
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("rate request: %w", apiError(status, body))
	}
	var out struct {
		Rates []Rate `json:"rates"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("decode rates: %w: %w", ErrBadResponse, err)
	}
	return out.Rates, nil
}

// Track returns the shipment state for a tracking number. It returns
// ErrNotFound when the carrier does not know the number.
func (c *Client) Track(ctx context.Context, number string) (Tracking, error) {
	status, body, err := c.do(ctx, http.MethodGet, "/v2/tracking/"+url.PathEscape(number), nil)
	if err != nil {
		return Tracking{}, fmt.Errorf("track %s: %w", number, err)
	}
	if status == http.StatusNotFound {
		return Tracking{}, ErrNotFound
	}
	if status != http.StatusOK {
		return Tracking{}, fmt.Errorf("track %s: %w", number, apiError(status, body))
	}
	var t Tracking
	if err := json.Unmarshal(body, &t); err != nil {
		return Tracking{}, fmt.Errorf("track %s: %w", number, ErrBadResponse)
	}
	return t, nil
}

// apiError builds an error from a non-success response. The carrier puts a
// readable reason in the "message" field; when that is missing the raw body
// is kept instead so the reason is not lost.
func apiError(status int, body []byte) error {
	var e struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(body, &e) != nil || e.Message == "" {
		return fmt.Errorf("status %d: %s", status, bytes.TrimSpace(body))
	}
	return fmt.Errorf("status %d: %s", status, e.Message)
}

func (c *Client) do(ctx context.Context, method, path string, payload []byte) (int, []byte, error) {
	var reqBody io.Reader
	if payload != nil {
		reqBody = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL.JoinPath(path).String(), reqBody)
	if err != nil {
		return 0, nil, fmt.Errorf("build %s %s: %w", method, path, err)
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("Accept", "application/json")
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return 0, nil, fmt.Errorf("%s %s: %w", method, path, err)
	}
	body, readErr := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	closeErr := resp.Body.Close()
	if readErr != nil {
		return 0, nil, fmt.Errorf("read %s %s response: %w", method, path, readErr)
	}
	if closeErr != nil {
		return 0, nil, fmt.Errorf("close %s %s response: %w", method, path, closeErr)
	}
	return resp.StatusCode, body, nil
}
