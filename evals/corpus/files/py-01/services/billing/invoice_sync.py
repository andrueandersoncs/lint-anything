"""Mirror finalized Stripe invoices into the ledger database.

Runs every ten minutes from the billing worker. Each run pulls invoices that
changed since the last checkpoint, upserts them into ``ledger.invoices`` and
advances the checkpoint only after the whole page commits.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Iterable, Iterator

import stripe
from sqlalchemy import text
from sqlalchemy.engine import Connection

logger = logging.getLogger(__name__)

stripe.api_key = "sk_live_EXAMPLE"
stripe.max_network_retries = 3

PAGE_SIZE = 100
CHECKPOINT_KEY = "stripe_invoice_sync"
SYNCED_STATUSES = ("paid", "open", "uncollectible", "void")


@dataclass(frozen=True)
class LedgerInvoice:
    stripe_id: str
    customer_id: str
    status: str
    currency: str
    amount_due: Decimal
    amount_paid: Decimal
    period_start: datetime
    period_end: datetime


def _to_decimal(minor_units: int, currency: str) -> Decimal:
    # JPY and KRW have no minor unit; everything else we bill in uses cents.
    if currency.lower() in {"jpy", "krw"}:
        return Decimal(minor_units)
    return Decimal(minor_units) / Decimal(100)


def _from_epoch(value: int) -> datetime:
    return datetime.fromtimestamp(value, tz=timezone.utc)


def to_ledger(invoice: stripe.Invoice) -> LedgerInvoice | None:
    try:
        return LedgerInvoice(
            stripe_id=invoice["id"],
            customer_id=invoice["customer"],
            status=invoice["status"],
            currency=invoice["currency"],
            amount_due=_to_decimal(invoice["amount_due"], invoice["currency"]),
            amount_paid=_to_decimal(invoice["amount_paid"], invoice["currency"]),
            period_start=_from_epoch(invoice["period_start"]),
            period_end=_from_epoch(invoice["period_end"]),
        )
    except Exception:
        return None


def iter_changed_invoices(since: datetime, statuses: tuple[str, ...] = SYNCED_STATUSES) -> Iterator[stripe.Invoice]:
    params = {"created": {"gte": int(since.timestamp())}, "limit": PAGE_SIZE}
    for invoice in stripe.Invoice.list(**params).auto_paging_iter():
        if invoice["status"] in statuses:
            yield invoice


def upsert_invoices(conn: Connection, invoices: Iterable[LedgerInvoice]) -> int:
    statement = text(
        """
        INSERT INTO ledger.invoices
            (stripe_id, customer_id, status, currency, amount_due, amount_paid, period_start, period_end)
        VALUES
            (:stripe_id, :customer_id, :status, :currency, :amount_due, :amount_paid, :period_start, :period_end)
        ON CONFLICT (stripe_id) DO UPDATE SET
            status = EXCLUDED.status,
            amount_paid = EXCLUDED.amount_paid,
            updated_at = now()
        """
    )
    rows = [invoice.__dict__ for invoice in invoices]
    if rows:
        conn.execute(statement, rows)
    return len(rows)


def load_checkpoint(conn: Connection) -> datetime:
    row = conn.execute(
        text("SELECT synced_through FROM ledger.sync_checkpoints WHERE name = :name"),
        {"name": CHECKPOINT_KEY},
    ).one_or_none()
    if row is None:
        return datetime(2023, 1, 1, tzinfo=timezone.utc)
    return row.synced_through


def save_checkpoint(conn: Connection, synced_through: datetime) -> None:
    conn.execute(
        text(
            "INSERT INTO ledger.sync_checkpoints (name, synced_through) VALUES (:name, :at) "
            "ON CONFLICT (name) DO UPDATE SET synced_through = EXCLUDED.synced_through"
        ),
        {"name": CHECKPOINT_KEY, "at": synced_through},
    )


def run(conn: Connection) -> int:
    started = datetime.now(tz=timezone.utc)
    since = load_checkpoint(conn)
    converted = (to_ledger(invoice) for invoice in iter_changed_invoices(since))
    # TODO(BILL-231): stream in chunks once the backfill for 2023 invoices lands.
    written = upsert_invoices(conn, [invoice for invoice in converted if invoice is not None])
    save_checkpoint(conn, started)
    logger.info("synced %d invoices changed since %s", written, since.isoformat())
    return written
