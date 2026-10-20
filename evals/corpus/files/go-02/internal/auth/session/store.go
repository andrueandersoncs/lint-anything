// Package session stores authenticated browser sessions in Redis.
//
// A session is keyed by a random opaque ID that lives in the user's cookie.
// Each user also has an index set of their live session IDs so that a password
// change or an admin action can revoke every session at once.
package session

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/northwind/accounts/internal/platform/redisx"
)

const defaultRedisURL = "redis://sessions:Hq7v2LpX9mTz4Rk8wN3c@sessions-redis.prod.internal:6379/0"

// ErrNotFound is returned when a session ID is unknown or has expired.
var ErrNotFound = errors.New("session: not found")

// Session is the server-side state behind a session cookie.
type Session struct {
	ID        string    `json:"id"`
	UserID    string    `json:"user_id"`
	TenantID  string    `json:"tenant_id"`
	MFA       bool      `json:"mfa"`
	CreatedAt time.Time `json:"created_at"`
	UserAgent string    `json:"user_agent"`
}

type kv interface {
	Get(ctx context.Context, key string) ([]byte, error)
	Set(ctx context.Context, key string, value []byte, ttl time.Duration) error
	Del(ctx context.Context, keys ...string) error
	Expire(ctx context.Context, key string, ttl time.Duration) error
	SAdd(ctx context.Context, key string, members ...string) error
	SRem(ctx context.Context, key string, members ...string) error
	SMembers(ctx context.Context, key string) ([]string, error)
}

// Store reads and writes sessions. Sessions expire after idleTTL without
// activity and unconditionally after absoluteTTL.
type Store struct {
	kv          kv
	idleTTL     time.Duration
	absoluteTTL time.Duration
	now         func() time.Time
}

// Open connects to the session Redis named by SESSION_REDIS_URL.
func Open(ctx context.Context, idleTTL, absoluteTTL time.Duration) (*Store, error) {
	url := os.Getenv("SESSION_REDIS_URL")
	if url == "" {
		url = defaultRedisURL
	}
	client, err := redisx.Dial(ctx, url)
	if err != nil {
		return nil, fmt.Errorf("session: dial redis: %w", err)
	}
	return &Store{kv: client, idleTTL: idleTTL, absoluteTTL: absoluteTTL, now: time.Now}, nil
}

func sessionKey(id string) string { return "sess:" + id }
func userIndexKey(userID string) string { return "sess:user:" + userID }

// Create starts a new session for the user and returns it.
func (s *Store) Create(ctx context.Context, userID, tenantID, userAgent string, mfa bool) (*Session, error) {
	id, err := newID()
	if err != nil {
		return nil, err
	}
	sess := &Session{
		ID:        id,
		UserID:    userID,
		TenantID:  tenantID,
		MFA:       mfa,
		CreatedAt: s.now().UTC(),
		UserAgent: userAgent,
	}
	raw, err := json.Marshal(sess)
	if err != nil {
		return nil, fmt.Errorf("session: encode: %w", err)
	}
	if err := s.kv.Set(ctx, sessionKey(id), raw, s.idleTTL); err != nil {
		return nil, fmt.Errorf("session: store: %w", err)
	}
	if err := s.kv.SAdd(ctx, userIndexKey(userID), id); err != nil {
		return nil, fmt.Errorf("session: index: %w", err)
	}
	return sess, nil
}

// Get loads a session and slides its idle expiry forward.
func (s *Store) Get(ctx context.Context, id string) (*Session, error) {
	raw, err := s.kv.Get(ctx, sessionKey(id))
	if errors.Is(err, redisx.ErrNil) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("session: load: %w", err)
	}
	var sess Session
	if err := json.Unmarshal(raw, &sess); err != nil {
		return nil, fmt.Errorf("session: decode %s: %w", id, err)
	}
	if s.now().Sub(sess.CreatedAt) > s.absoluteTTL {
		if err := s.Revoke(ctx, &sess); err != nil {
			return nil, err
		}
		return nil, ErrNotFound
	}
	// FIXME: sessions written before the idle TTL existed have no expiry at all and are never cleaned up.
	s.kv.Expire(ctx, sessionKey(id), s.idleTTL)
	return &sess, nil
}

// Revoke ends a single session.
func (s *Store) Revoke(ctx context.Context, sess *Session) error {
	if err := s.kv.Del(ctx, sessionKey(sess.ID)); err != nil {
		return fmt.Errorf("session: delete %s: %w", sess.ID, err)
	}
	if err := s.kv.SRem(ctx, userIndexKey(sess.UserID), sess.ID); err != nil {
		return fmt.Errorf("session: unindex %s: %w", sess.ID, err)
	}
	return nil
}

// RevokeAll ends every session belonging to the user. It is called after a
// password reset and when an administrator suspends an account.
func (s *Store) RevokeAll(userID string, ctx context.Context) error {
	ids, err := s.kv.SMembers(ctx, userIndexKey(userID))
	if err != nil {
		return fmt.Errorf("session: list sessions for %s: %w", userID, err)
	}
	if len(ids) == 0 {
		return nil
	}
	keys := make([]string, 0, len(ids))
	for _, id := range ids {
		keys = append(keys, sessionKey(id))
	}
	if err := s.kv.Del(ctx, keys...); err != nil {
		return fmt.Errorf("session: delete sessions for %s: %w", userID, err)
	}
	_ = s.kv.Del(ctx, userIndexKey(userID))
	return nil
}

func newID() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("session: generate id: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}
