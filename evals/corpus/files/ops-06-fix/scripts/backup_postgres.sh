#!/usr/bin/env bash
#
# Nightly logical backup of the ledger Postgres database to S3.
#
# Runs from the backup-runner cron job on the ops bastion. The dump is streamed
# through zstd and uploaded without touching local disk, so the bastion does not
# need room for a full copy of the database.
#
# Usage: scripts/backup_postgres.sh <environment>

set -euo pipefail

ENVIRONMENT="${1:?usage: backup_postgres.sh <environment>}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BUCKET="s3://northwind-db-backups-${ENVIRONMENT}"
PREFIX="postgres/${ENVIRONMENT}"
KEY="${PREFIX}/ledger-${TIMESTAMP}.dump.zst"
RETENTION_DAYS="${RETENTION_DAYS:-35}"

# Connection settings come from the runner's environment file; the password is
# mounted by the secrets agent and never passed on the command line.
export PGHOST="${PGHOST:-ledger-primary.db.internal}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-backup_runner}"
export PGDATABASE="${PGDATABASE:-ledger}"
PGPASSWORD="$(< /run/secrets/pg_backup_password)"
export PGPASSWORD

log() {
  printf '%s [backup] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2
}

log "starting dump of ${PGDATABASE} on ${PGHOST} to ${BUCKET}/${KEY}"

pg_dump \
  --format=custom \
  --no-owner \
  --no-privileges \
  --exclude-table-data='audit.request_log_*' \
  --lock-wait-timeout=60s \
  | zstd -T0 -10 --quiet \
  | aws s3 cp - "${BUCKET}/${KEY}" \
      --expected-size 200000000000 \
      --storage-class STANDARD_IA \
      --only-show-errors

size_bytes="$(aws s3api head-object \
  --bucket "${BUCKET#s3://}" \
  --key "${KEY}" \
  --query ContentLength \
  --output text)"
log "uploaded ${size_bytes} bytes"

# A dump under 1 MiB means pg_dump died early and zstd only flushed a header.
if (( size_bytes < 1048576 )); then
  log "backup is suspiciously small, keeping older backups"
  exit 1
fi

# TODO(OPS-318): replace this loop with an S3 lifecycle rule once the bucket is managed in Terraform.
cutoff="$(date -u -d "-${RETENTION_DAYS} days" +%Y%m%d)"
aws s3 ls "${BUCKET}/${PREFIX}/" \
  | awk '{print $4}' \
  | while read -r name; do
      stamp="${name#ledger-}"
      stamp="${stamp:0:8}"
      if [[ "${stamp}" < "${cutoff}" ]]; then
        log "pruning ${name}"
        aws s3 rm --only-show-errors "${BUCKET}/${PREFIX}/${name}"
      fi
    done

log "done"
