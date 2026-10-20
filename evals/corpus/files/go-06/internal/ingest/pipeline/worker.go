package pipeline

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/northwind/telemetry/internal/ingest/stream"
)

const warehouseDSN = "postgres://ingest_writer:pR7vkQ2xLx9mWb4tZe@warehouse-primary.data.internal:5432/events?sslmode=require"

// Event is one product analytics event as published by the web and mobile clients.
type Event struct {
	ID         string          `json:"event_id"`
	Name       string          `json:"name"`
	AccountID  string          `json:"account_id"`
	UserID     string          `json:"user_id"`
	Properties json.RawMessage `json:"properties"`
	ProducedAt time.Time       `json:"produced_at"`
	Offset     int64           `json:"-"`
}

// source is the consumer-group side of the events topic.
type source interface {
	Poll(ctx context.Context, timeout time.Duration) (stream.Message, error)
	Commit(ctx context.Context, offset int64) error
}

// sink publishes events that could not be processed to the dead-letter topic.
type sink interface {
	Publish(ctx context.Context, key, value []byte) error
}

// Worker drains the raw events topic into the warehouse in batches.
type Worker struct {
	consumer   source
	deadLetter sink
	db         *pgxpool.Pool
	log        *slog.Logger

	batchSize     int
	flushInterval time.Duration
}

// NewWorker connects to the warehouse and returns a Worker reading from consumer.
func NewWorker(ctx context.Context, consumer source, deadLetter sink, log *slog.Logger) (*Worker, error) {
	pool, err := pgxpool.New(ctx, warehouseDSN)
	if err != nil {
		return nil, fmt.Errorf("connect to warehouse: %w", err)
	}
	return &Worker{
		consumer:      consumer,
		deadLetter:    deadLetter,
		db:            pool,
		log:           log,
		batchSize:     2000,
		flushInterval: 5 * time.Second,
	}, nil
}

// Run consumes until ctx is cancelled. A batch is written when it is full or
// when flushInterval passes, whichever comes first.
func (w *Worker) Run(ctx context.Context) error {
	ticker := time.NewTicker(w.flushInterval)
	defer ticker.Stop()

	batch := make([]Event, 0, w.batchSize)
	for {
		select {
		case <-ctx.Done():
			if len(batch) > 0 {
				if err := w.writeBatch(batch, context.WithoutCancel(ctx)); err != nil {
					return err
				}
			}
			return ctx.Err()
		case <-ticker.C:
			if len(batch) == 0 {
				continue
			}
			if err := w.writeBatch(batch, ctx); err != nil {
				return err
			}
			batch = batch[:0]
		default:
		}

		msg, err := w.consumer.Poll(ctx, 250*time.Millisecond)
		if errors.Is(err, stream.ErrNoMessage) {
			continue
		}
		if err != nil {
			return fmt.Errorf("poll: %w", err)
		}

		var ev Event
		if err := json.Unmarshal(msg.Value, &ev); err != nil {
			w.log.Warn("undecodable event", "offset", msg.Offset, "err", err)
			_ = w.deadLetter.Publish(ctx, msg.Key, msg.Value)
			continue
		}
		ev.Offset = msg.Offset
		batch = append(batch, ev)

		if len(batch) >= w.batchSize {
			if err := w.writeBatch(batch, ctx); err != nil {
				return err
			}
			batch = batch[:0]
		}
	}
}

// writeBatch copies the batch into the events table and commits the consumer
// offset of the last event, so a crash replays at most one batch.
func (w *Worker) writeBatch(batch []Event, ctx context.Context) error {
	started := time.Now()
	rows := make([][]any, 0, len(batch))
	for _, ev := range batch {
		rows = append(rows, []any{ev.ID, ev.Name, ev.AccountID, ev.UserID, ev.Properties, ev.ProducedAt})
	}

	// FIXME: dedupe on event_id before inserting, replays after a crash double-count events.
	copied, err := w.db.CopyFrom(ctx,
		pgx.Identifier{"analytics", "events"},
		[]string{"event_id", "name", "account_id", "user_id", "properties", "produced_at"},
		pgx.CopyFromRows(rows),
	)
	if err != nil {
		return fmt.Errorf("copy %d events: %w", len(batch), err)
	}

	// for _, ev := range batch {
	// 	w.metrics.Observe("ingest.lag_seconds", time.Since(ev.ProducedAt).Seconds())
	// }

	last := batch[len(batch)-1]
	w.consumer.Commit(ctx, last.Offset)

	w.log.Info("wrote batch",
		"events", copied,
		"last_offset", last.Offset,
		"elapsed", time.Since(started),
	)
	return nil
}

// Close releases the warehouse connections.
func (w *Worker) Close() {
	w.db.Close()
}
