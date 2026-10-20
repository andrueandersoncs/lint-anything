-- Queries used by the search reindexer (services/search/reindex). Compiled into
-- Go by sqlc; package settings live in sqlc.yaml at the repository root.

-- name: ListStaleDocuments :many
-- Documents whose source row changed after they were last indexed, oldest
-- first, so a backlog drains in the order users are most likely to notice.
-- Documents leased by another worker are skipped.
SELECT
    d.id,
    d.workspace_id,
    d.source_type,
    d.source_id,
    d.indexed_at,
    d.source_updated_at
FROM search.documents d
WHERE d.deleted_at IS NULL
  AND (d.indexed_at IS NULL OR d.source_updated_at > d.indexed_at)
  AND NOT EXISTS (
      SELECT *
      FROM search.reindex_leases l
      WHERE l.document_id = d.id
        AND l.expires_at > now()
  )
ORDER BY d.source_updated_at
LIMIT sqlc.arg(batch_size);

-- name: CountStaleDocumentsByWorkspace :many
SELECT
    d.workspace_id,
    COUNT(*) AS stale
FROM search.documents d
WHERE d.deleted_at IS NULL
  AND (d.indexed_at IS NULL OR d.source_updated_at > d.indexed_at)
GROUP BY d.workspace_id
ORDER BY stale DESC;

-- name: AcquireReindexLease :one
-- A lease stops two workers from embedding the same document. An expired
-- lease can be taken over; a live one makes this return no rows.
INSERT INTO search.reindex_leases (document_id, worker_id, expires_at)
VALUES (sqlc.arg(document_id), sqlc.arg(worker_id), now() + interval '5 minutes')
ON CONFLICT (document_id) DO UPDATE
    SET worker_id = EXCLUDED.worker_id,
        expires_at = EXCLUDED.expires_at
    WHERE search.reindex_leases.expires_at <= now()
RETURNING document_id, worker_id, expires_at;

-- name: MarkDocumentIndexed :exec
UPDATE search.documents
SET indexed_at = sqlc.arg(indexed_at),
    embedding_model = sqlc.arg(embedding_model),
    chunk_count = sqlc.arg(chunk_count)
WHERE id = sqlc.arg(id);

-- name: ReleaseReindexLease :exec
DELETE FROM search.reindex_leases
WHERE document_id = sqlc.arg(document_id)
  AND worker_id = sqlc.arg(worker_id);

-- name: ImportLegacySynonyms :exec
-- Backfill from the synonym store of the old search cluster. TODO: delete
-- after the legacy cluster is decommissioned, tracked in
-- https://github.com/northwind-labs/platform/issues/2231
INSERT INTO search.synonyms (term, synonym, locale, source)
SELECT legacy.term, legacy.synonym, legacy.locale, 'legacy'
FROM dblink(
    'host=legacy-search.db.internal port=5432 dbname=search user=search_ro password=EXAMPLE_SECRET',
    'SELECT term, synonym, locale FROM synonyms WHERE active'
) AS legacy(term text, synonym text, locale text)
ON CONFLICT (term, synonym, locale) DO NOTHING;

-- name: ListSynonymsForLocale :many
SELECT term, synonym
FROM search.synonyms
WHERE locale = sqlc.arg(locale)
ORDER BY term, synonym;

-- name: GetDocumentForReindex :one
SELECT *
FROM search.documents
WHERE id = sqlc.arg(id)
  AND deleted_at IS NULL;
