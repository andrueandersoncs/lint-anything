// Package ratelimit provides a token-bucket limiter for calling upstream APIs
// that enforce a requests-per-second quota.
//
// The zero value is not usable; construct a Limiter with New:
//
//	lim := ratelimit.New(50, 10) // 50 requests per second, bursts of up to 10
//	for _, id := range accountIDs {
//		if err := lim.Wait(ctx); err != nil {
//			return err
//		}
//		if err := crm.SyncAccount(ctx, id); err != nil {
//			return err
//		}
//	}
package ratelimit

import (
	"context"
	"errors"
	"sync"
	"time"
)

// ErrBurstExceeded is returned by WaitN when n can never be satisfied because
// it is larger than the bucket.
var ErrBurstExceeded = errors.New("ratelimit: request exceeds burst size")

// Limiter is a token bucket that is safe for concurrent use.
type Limiter struct {
	mu     sync.Mutex
	rate   float64 // tokens added per second
	burst  float64
	tokens float64
	last   time.Time
	now    func() time.Time
}

// New returns a Limiter that allows rate events per second with bursts of up
// to burst events. The bucket starts full.
func New(rate float64, burst int) *Limiter {
	return &Limiter{
		rate:   rate,
		burst:  float64(burst),
		tokens: float64(burst),
		last:   time.Now(),
		now:    time.Now,
	}
}

// Allow reports whether one event may happen now, consuming a token if so.
// It never blocks, which makes it suitable for shedding load in HTTP handlers:
//
//	if !lim.Allow() {
//		http.Error(w, "slow down", http.StatusTooManyRequests)
//		return
//	}
func (l *Limiter) Allow() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.refill()
	if l.tokens >= 1 {
		l.tokens--
		return true
	}
	return false
}

// Wait blocks until one token is available or ctx is done.
func (l *Limiter) Wait(ctx context.Context) error {
	return l.WaitN(ctx, 1)
}

// WaitN blocks until n tokens are available or ctx is done. If ctx has a
// deadline that would pass before the tokens arrive, WaitN fails immediately
// rather than sleeping until the deadline.
func (l *Limiter) WaitN(ctx context.Context, n int) error {
	if float64(n) > l.burst {
		return ErrBurstExceeded
	}
	for {
		delay, ok := l.reserve(float64(n))
		if ok {
			return nil
		}
		if deadline, has := ctx.Deadline(); has && l.now().Add(delay).After(deadline) {
			return context.DeadlineExceeded
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

// Do waits for a token and then calls fn, so callers can write
//
//	err := lim.Do(ctx, func(ctx context.Context) error {
//		return client.Publish(ctx, event)
//	})
func (l *Limiter) Do(ctx context.Context, fn func(context.Context) error) error {
	if err := l.Wait(ctx); err != nil {
		return err
	}
	return fn(ctx)
}

// reserve takes n tokens if they are available. Otherwise it reports how long
// the caller should sleep before trying again.
func (l *Limiter) reserve(n float64) (time.Duration, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.refill()
	if l.tokens >= n {
		l.tokens -= n
		return 0, true
	}
	missing := n - l.tokens
	return time.Duration(missing / l.rate * float64(time.Second)), false
}

// refill adds the tokens earned since the last call. Callers must hold l.mu.
func (l *Limiter) refill() {
	now := l.now()
	elapsed := now.Sub(l.last).Seconds()
	l.last = now
	l.tokens += elapsed * l.rate
	if l.tokens > l.burst {
		l.tokens = l.burst
	}
}
