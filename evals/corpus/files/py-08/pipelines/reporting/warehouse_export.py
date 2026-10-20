"""Nightly export of revenue reports from Postgres to S3 as partitioned CSV.

Each report is grouped by region and written to
``s3://<bucket>/reports/<report>/dt=<date>/region=<region>/part-0000.csv`` so
that Athena can query it without a crawler.
"""

from __future__ import annotations

import csv
import io
import logging
from collections import defaultdict
from datetime import date, timedelta
from typing import Iterable, Mapping, Sequence

import boto3
import psycopg2
import psycopg2.extras

log = logging.getLogger("reporting.export")

EXPORT_BUCKET = "acme-analytics-exports"
AWS_REGION = "us-east-1"
AWS_ACCESS_KEY_ID = "AKIAEXAMPLE"
AWS_SECRET_ACCESS_KEY = "EXAMPLE_SECRET"

REPORTS: Mapping[str, str] = {
    "daily_revenue": """
        SELECT o.region, o.currency, date_trunc('day', o.paid_at) AS day,
               sum(o.total_cents) AS revenue_cents, count(*) AS orders
        FROM orders o
        WHERE o.paid_at >= %(start)s AND o.paid_at < %(end)s
        GROUP BY 1, 2, 3
    """,
    "refunds": """
        SELECT o.region, r.reason, sum(r.amount_cents) AS refunded_cents, count(*) AS refunds
        FROM refunds r JOIN orders o ON o.id = r.order_id
        WHERE r.created_at >= %(start)s AND r.created_at < %(end)s
        GROUP BY 1, 2
    """,
}


def _s3():
    return boto3.client(
        "s3",
        region_name=AWS_REGION,
        aws_access_key_id=AWS_ACCESS_KEY_ID,
        aws_secret_access_key=AWS_SECRET_ACCESS_KEY,
    )


def fetch(conn, sql: str, start: date, end: date) -> list[dict]:
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
        cursor.execute(sql, {"start": start, "end": end})
        return list(cursor.fetchall())


def group_by_region(rows: Iterable[dict], buckets=defaultdict(list)) -> dict[str, list[dict]]:
    for row in rows:
        buckets[row["region"] or "unknown"].append(row)
    return buckets


def to_csv(rows: Sequence[dict]) -> bytes:
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=list(rows[0].keys()))
    # Athena reads the header row of every part file, so each region file gets one.
    writer.writeheader()
    writer.writerows(rows)
    return buffer.getvalue().encode("utf-8")


def export_report(conn, name: str, day: date) -> int:
    rows = fetch(conn, REPORTS[name], day, day + timedelta(days=1))
    if not rows:
        log.info("report %s has no rows for %s", name, day)
        return 0
    client = _s3()
    written = 0
    for region, region_rows in group_by_region(rows).items():
        key = f"reports/{name}/dt={day.isoformat()}/region={region}/part-0000.csv"
        client.put_object(Bucket=EXPORT_BUCKET, Key=key, Body=to_csv(region_rows), ContentType="text/csv")
        written += len(region_rows)
    return written


def run(dsn: str, day: date | None = None) -> None:
    day = day or date.today() - timedelta(days=1)
    # TODO(mkhan): move the refunds report onto the read replica
    with psycopg2.connect(dsn) as conn:
        for name in REPORTS:
            try:
                count = export_report(conn, name, day)
            except Exception as exc:
                log.error("export of %s for %s failed: %s", name, day, exc)
                continue
            log.info("exported %d rows for %s on %s", count, name, day)
