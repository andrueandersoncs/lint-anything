# Search indexing

This document describes how documents get from the operational databases into
the search cluster, and what to look at when search results are stale.

## Overview

Every searchable object (documents, comments, tickets, knowledge base
articles) has a row in `search.documents`. The row records where the object
lives (`source_type`, `source_id`), when it last changed in its source
(`source_updated_at`) and when it was last indexed (`indexed_at`). A document is
*stale* when `source_updated_at > indexed_at`.

Source services do not talk to the search cluster. They publish a change event
and the reindexer does the rest:

```json
{
  "type": "document.changed",
  "source_type": "kb_article",
  "source_id": "8f14e45f-ceea-467a-9e1b-6a8f7d2b3c41",
  "workspace_id": "c9f0f895-fb98-4b3a-8d5e-1f2a3b4c5d6e",
  "changed_at": "2026-10-19T09:14:03Z"
}
```

## The reindexer

The reindexer (`services/search/reindex`) runs as a deployment with eight
workers. Each worker loops:

1. List up to 200 stale documents that nobody holds a lease on.
2. Take a five-minute lease on each one.
3. Load the source object, split it into chunks and embed them.
4. Write the chunks to OpenSearch with a bulk request.
5. Mark the document indexed and release the lease.

The SQL for steps 1, 2 and 5 lives in `queries/search/reindex.sql`. Embedding
is batched per worker:

```go
batch := make([]embed.Input, 0, 64)
for _, doc := range docs {
	batch = append(batch, embed.Input{ID: doc.ID, Text: doc.Body})
}
vectors, err := embedder.Embed(ctx, batch)
```

Leases make the workers safe to scale horizontally; a crashed worker's leases
simply expire.

## Index layout

Each workspace gets its own index alias, `ws-<workspace_id>`, pointing at a
shared physical index per region. Index settings are managed in Terraform:

```hcl
resource "opensearch_index_template" "documents" {
  name = "documents"
  body = file("${path.module}/templates/documents.json")
}
```

## Data flow

```
 source services ──► change events (Kafka: search.changes.v1)
                             │
                             ▼
                  ┌─────────────────────┐
                  │  change consumer    │── upsert ──► search.documents
                  └─────────────────────┘                    │
                                                             ▼
                  ┌─────────────────────┐   lease    ┌──────────────┐
                  │  reindex workers    │◄──────────│ stale rows   │
                  └─────────────────────┘            └──────────────┘
                             │
                             ▼
                      OpenSearch (bulk)
```

## Debugging stale results

Check how far behind the reindexer is, per workspace:

```sql
SELECT workspace_id, COUNT(*) AS stale
FROM search.documents
WHERE deleted_at IS NULL
  AND (indexed_at IS NULL OR source_updated_at > indexed_at)
GROUP BY workspace_id
ORDER BY stale DESC
LIMIT 20;
```

If one workspace dominates, it is usually a bulk import; the backlog drains on
its own. If every workspace is behind, check the worker logs for embedding
timeouts:

```sh
kubectl -n search logs deployment/reindex --since=30m | grep -c 'embed: deadline exceeded'
```
