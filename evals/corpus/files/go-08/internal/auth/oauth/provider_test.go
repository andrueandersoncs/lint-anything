package oauth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

const (
	testClientID     = "test-client"
	testClientSecret = "test-client-secret"
)

// fakeTokenEndpoint stands in for the identity provider's token endpoint. It
// accepts one authorization code and one refresh token.
func fakeTokenEndpoint(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Errorf("parse form: %v", err)
			http.Error(w, "bad form", http.StatusBadRequest)
			return
		}
		id, secret, ok := r.BasicAuth()
		if !ok || id != testClientID || secret != testClientSecret {
			http.Error(w, `{"error":"invalid_client"}`, http.StatusUnauthorized)
			return
		}

		var resp map[string]any
		switch r.PostForm.Get("grant_type") {
		case "authorization_code":
			if r.PostForm.Get("code") != "good-code" || r.PostForm.Get("code_verifier") == "" {
				http.Error(w, `{"error":"invalid_grant"}`, http.StatusBadRequest)
				return
			}
			resp = map[string]any{
				"access_token":  "test-access-token",
				"refresh_token": "test-refresh-token",
				"token_type":    "Bearer",
				"expires_in":    3600,
			}
		case "refresh_token":
			if r.PostForm.Get("refresh_token") != "test-refresh-token" {
				http.Error(w, `{"error":"invalid_grant"}`, http.StatusBadRequest)
				return
			}
			resp = map[string]any{
				"access_token": "test-access-token-2",
				"token_type":   "Bearer",
				"expires_in":   3600,
			}
		default:
			http.Error(w, `{"error":"unsupported_grant_type"}`, http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(resp); err != nil {
			t.Errorf("encode token response: %v", err)
		}
	}))
}

func newTestProvider(t *testing.T, tokenURL string) *Provider {
	t.Helper()
	p, err := NewProvider(Config{
		ClientID:     testClientID,
		ClientSecret: testClientSecret,
		AuthURL:      "https://idp.test/authorize",
		TokenURL:     tokenURL,
		RedirectURL:  "https://app.test/oauth/callback",
	}, http.DefaultClient)
	if err != nil {
		t.Fatalf("NewProvider: %v", err)
	}
	// Pin the clock so expiry assertions are exact.
	p.now = func() time.Time { return time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC) }
	return p
}

func exchange(t *testing.T, ctx context.Context, p *Provider, code string) (*Token, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return p.Exchange(ctx, code, "verifier-0123456789abcdef0123456789abcdef0123")
}

func TestExchangeIssuesToken(t *testing.T) {
	srv := fakeTokenEndpoint(t)
	defer srv.Close()
	p := newTestProvider(t, srv.URL)

	tok, err := exchange(t, context.Background(), p, "good-code")
	if err != nil {
		t.Fatalf("Exchange: %v", err)
	}
	if tok.AccessToken != "test-access-token" {
		t.Errorf("AccessToken = %q, want test-access-token", tok.AccessToken)
	}
	if tok.RefreshToken != "test-refresh-token" {
		t.Errorf("RefreshToken = %q, want test-refresh-token", tok.RefreshToken)
	}
	wantExpiry := time.Date(2026, 3, 1, 13, 0, 0, 0, time.UTC)
	if !tok.Expiry.Equal(wantExpiry) {
		t.Errorf("Expiry = %v, want %v", tok.Expiry, wantExpiry)
	}
}

func TestExchangeRejectsUnknownCode(t *testing.T) {
	srv := fakeTokenEndpoint(t)
	defer srv.Close()
	p := newTestProvider(t, srv.URL)

	_, err := exchange(t, context.Background(), p, "stale-code")
	if !errors.Is(err, ErrInvalidGrant) {
		t.Fatalf("Exchange error = %v, want ErrInvalidGrant", err)
	}
}

func TestRefresh(t *testing.T) {
	srv := fakeTokenEndpoint(t)
	defer srv.Close()
	p := newTestProvider(t, srv.URL)

	tok, err := p.Refresh(context.Background(), "test-refresh-token")
	if err != nil {
		t.Fatalf("Refresh: %v", err)
	}
	if tok.AccessToken != "test-access-token-2" {
		t.Errorf("AccessToken = %q, want test-access-token-2", tok.AccessToken)
	}
	// The endpoint does not rotate refresh tokens, so the old one must be kept.
	if tok.RefreshToken != "test-refresh-token" {
		t.Errorf("RefreshToken = %q, want the original refresh token", tok.RefreshToken)
	}
}

func TestExchangeHonoursCancellation(t *testing.T) {
	srv := fakeTokenEndpoint(t)
	defer srv.Close()
	p := newTestProvider(t, srv.URL)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := exchange(t, ctx, p, "good-code"); !errors.Is(err, context.Canceled) {
		t.Fatalf("Exchange error = %v, want context.Canceled", err)
	}
}
