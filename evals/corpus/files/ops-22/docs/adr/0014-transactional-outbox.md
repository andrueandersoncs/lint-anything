# ADR 0014: Publish billing events through a transactional outbox

- **Status:** Accepted
- **Date:** 2026-06-02
- **Deciders:** Platform team, Billing team

## Context

Ledger publishes events such as `invoice.finalized` and `payment.succeeded` to
Kafka. Today the publish happens in application code right after the database
transaction commits. When the process dies between the commit and the publish,
the event is lost; when the publish succeeds but the commit is rolled back by a
later error, consumers see an event for a change that never happened.

Both have happened in production. The notifications service sent receipts for
three payments that were later rolled back (incident INC-2291), and the
warehouse missed roughly 40 `invoice.finalized` events during the June 12
deploy.

## Decision

Events are written to a `billing.outbox` table in the same transaction as the
change they describe. A separate relay process reads unpublished rows in
insertion order, publishes them to Kafka, and marks them published.

The table has one row per event:

    id            bigserial primary key
    aggregate_id  uuid not null
    event_type    text not null
    payload       jsonb not null
    created_at    timestamptz not null default now()
    published_at  timestamptz

The relay claims rows with `FOR UPDATE SKIP LOCKED` so several relays can run
for availability without publishing the same row twice in the normal case.
Consumers must still be idempotent, because a relay can crash after publishing
and before marking the row; every event carries its outbox `id` as the Kafka
message key's suffix for deduplication.

Published rows are deleted by a nightly job after seven days.

## Consequences

- Events are delivered at least once and never for rolled-back changes.
- Publishing latency rises from a few milliseconds to the relay's poll
  interval, configured at 200 ms. No current consumer needs better than one
  second.
- The outbox table adds write load to the primary. At current volume this is
  about 300 inserts per second at peak, which is well within budget.
- Application code must not call the Kafka producer directly for billing
  events any more. The `events.Publish` helper is removed and replaced with
  `outbox.Enqueue(tx, event)`, which only accepts a transaction.

## Alternatives considered

**Change data capture with Debezium.** Avoids the extra table, but couples
consumers to our table layout and adds a Kafka Connect cluster we would have to
operate. Rejected for now; we may revisit if more services need CDC.

**Two-phase commit between Postgres and Kafka.** Kafka does not participate in
XA transactions, so this is not available.
