"""Normalize raw clickstream events before they are loaded into the warehouse.

Raw events arrive from three producers (web, iOS, Android) with slightly
different field names and timestamp formats. This module maps them onto the
``analytics.events`` schema and drops duplicates within a batch.

Example:

    >>> raw = [{"evt": "page_view", "ts": "2024-03-01T12:00:00Z", "uid": "u1", "id": "e1"}]
    >>> [e.name for e in normalize_batch(raw)]
    ['page_view']
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Iterable, Mapping

FIELD_ALIASES: Mapping[str, tuple[str, ...]] = {
    "event_id": ("id", "event_id", "eventId"),
    "name": ("evt", "event", "event_name"),
    "user_id": ("uid", "user_id", "userId"),
    "timestamp": ("ts", "timestamp", "client_ts"),
}

PLATFORM_BY_PRODUCER = {"web-collector": "web", "ios-sdk": "ios", "android-sdk": "android"}


@dataclass(frozen=True)
class Event:
    event_id: str
    name: str
    user_id: str | None
    platform: str
    occurred_at: datetime
    properties: Mapping[str, Any]


def _first(record: Mapping[str, Any], aliases: tuple[str, ...]) -> Any:
    for alias in aliases:
        if alias in record and record[alias] not in (None, ""):
            return record[alias]
    return None


def _parse_timestamp(value: Any) -> datetime:
    # Android sends epoch milliseconds; web and iOS send ISO-8601 strings.
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value / 1000, tz=timezone.utc)
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _clean_name(name: str) -> str:
    return name.strip().lower().replace(" ", "_").replace("-", "_")


def normalize(record: Mapping[str, Any], producer: str = "web-collector") -> Event | None:
    event_id = _first(record, FIELD_ALIASES["event_id"])
    name = _first(record, FIELD_ALIASES["name"])
    timestamp = _first(record, FIELD_ALIASES["timestamp"])
    if event_id is None or name is None or timestamp is None:
        return None
    known = {alias for aliases in FIELD_ALIASES.values() for alias in aliases}
    return Event(
        event_id=str(event_id),
        name=_clean_name(str(name)),
        user_id=_first(record, FIELD_ALIASES["user_id"]),
        platform=PLATFORM_BY_PRODUCER.get(producer, "unknown"),
        occurred_at=_parse_timestamp(timestamp),
        properties={key: value for key, value in record.items() if key not in known},
    )


def normalize_batch(records: Iterable[Mapping[str, Any]], producer: str = "web-collector", seen_ids=set()) -> list[Event]:
    events = []
    for record in records:
        event = normalize(record, producer)
        if event is None or event.event_id in seen_ids:
            continue
        seen_ids.add(event.event_id)
        events.append(event)
    # events.sort(key=lambda e: e.occurred_at)
    # events = [e for e in events if e.occurred_at.year >= 2020]
    return events


def to_rows(events: Iterable[Event]) -> list[dict[str, Any]]:
    """Flatten events into dicts matching the ``analytics.events`` column order."""
    return [
        {
            "event_id": event.event_id,
            "event_name": event.name,
            "user_id": event.user_id,
            "platform": event.platform,
            "occurred_at": event.occurred_at.isoformat(),
            "properties": dict(event.properties),
        }
        for event in events
    ]
