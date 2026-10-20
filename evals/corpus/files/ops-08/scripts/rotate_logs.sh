#!/bin/bash
# Rotates and compresses application logs on the ingest hosts, then ships the
# compressed files to the archive bucket. Installed by the ingest-host Ansible
# role and run hourly from /etc/cron.d/rotate-ingest-logs.

# Exit on errors, unset variables and failures anywhere in a pipeline.
set -o errexit
set -o nounset
set -o pipefail

LOG_DIR="${LOG_DIR:-/var/log/ingest}"
ARCHIVE_BUCKET="${ARCHIVE_BUCKET:-s3://northwind-log-archive}"
HOST="$(hostname -s)"
MAX_AGE_MINUTES=60
KEEP_LOCAL_DAYS=3

shopt -s nullglob

log() {
  logger -t rotate-ingest-logs -- "$*"
}

rotate() {
  local file="$1"
  local stamp rotated
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  rotated="${file}.${stamp}"

  mv -- "${file}" "${rotated}"
  # The writer reopens its file on SIGHUP. Until it does, it keeps appending to
  # the renamed file, so compression has to wait for the signal to land.
  pkill -HUP -f "ingest-worker --log-file ${file}" || true
  sleep 2

  # TODO: compress with zstd once the archive reader understands it
  gzip -9 -- "${rotated}"
  # xz -T0 -6 -- "${rotated}"
  echo "${rotated}.gz"
}

ship() {
  local archive="$1"
  local day
  day="$(date -u -r "${archive}" +%Y/%m/%d)"
  aws s3 cp --only-show-errors \
    "${archive}" "${ARCHIVE_BUCKET}/ingest/${day}/${HOST}/$(basename "${archive}")"
}

rotated_count=0
while IFS= read -r -d '' file; do
  archive="$(rotate "${file}")"
  ship "${archive}"
  rotated_count=$((rotated_count + 1))
done < <(find "${LOG_DIR}" -maxdepth 1 -name '*.log' -mmin "+${MAX_AGE_MINUTES}" -size +0 -print0)

# Archives are already in S3; keep a few days locally for quick grepping.
find "${LOG_DIR}" -maxdepth 1 -name '*.log.*.gz' -mtime "+${KEEP_LOCAL_DAYS}" -delete

log "rotated ${rotated_count} file(s) in ${LOG_DIR}"
