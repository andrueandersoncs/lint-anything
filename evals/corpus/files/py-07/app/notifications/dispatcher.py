"""Fan out user notifications to email, push and in-app channels."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from enum import Enum
from typing import Iterable, Mapping

import httpx

from app.notifications import inbox, preferences, push

logger = logging.getLogger(__name__)

SENDGRID_API_URL = "https://api.sendgrid.com/v3/mail/send"
SENDGRID_API_KEY = "SG.EXAMPLE"
FROM_ADDRESS = "notifications@relaybox.io"

QUIET_HOURS_EXEMPT = frozenset({"security_alert", "password_reset", "payment_failed"})


class Channel(str, Enum):
    EMAIL = "email"
    PUSH = "push"
    IN_APP = "in_app"


@dataclass(frozen=True)
class Notification:
    user_id: str
    kind: str
    subject: str
    body: str
    data: Mapping[str, str]


class DeliveryError(RuntimeError):
    pass


def _send_email(address: str, notification: Notification) -> None:
    response = httpx.post(
        SENDGRID_API_URL,
        headers={"Authorization": f"Bearer {SENDGRID_API_KEY}"},
        json={
            "personalizations": [{"to": [{"email": address}]}],
            "from": {"email": FROM_ADDRESS},
            "subject": notification.subject,
            "content": [{"type": "text/plain", "value": notification.body}],
        },
        timeout=5.0,
    )
    if response.status_code >= 400:
        raise DeliveryError(f"sendgrid returned {response.status_code}")


def _channels_for(user_id: str, kind: str, exempt: frozenset[str] = QUIET_HOURS_EXEMPT) -> list[Channel]:
    prefs = preferences.for_user(user_id)
    if prefs.in_quiet_hours() and kind not in exempt:
        return [Channel.IN_APP]
    return [Channel(name) for name in prefs.enabled_channels(kind)]


def dispatch(notification: Notification, only: Iterable[Channel] | None = None) -> list[Channel]:
    channels = _channels_for(notification.user_id, notification.kind)
    if only is not None:
        allowed = set(only)
        channels = [channel for channel in channels if channel in allowed]

    delivered = []
    for channel in channels:
        try:
            if channel is Channel.EMAIL:
                address = preferences.email_for(notification.user_id)
                _send_email(address, notification)
            elif channel is Channel.PUSH:
                push.send(notification.user_id, notification.subject, dict(notification.data))
            else:
                inbox.append(notification.user_id, notification.subject, notification.body)
        except Exception:
            # In-app is the channel of last resort; if it fails the caller must retry.
            if channel is Channel.IN_APP:
                raise
            logger.warning("delivery via %s failed for user %s", channel.value, notification.user_id, exc_info=True)
            continue
        delivered.append(channel)

    # FIXME: push tokens for uninstalled apps are never pruned
    # if Channel.PUSH not in delivered:
    #     push.prune_tokens(notification.user_id)
    #     inbox.append(notification.user_id, notification.subject, notification.body)
    return delivered
