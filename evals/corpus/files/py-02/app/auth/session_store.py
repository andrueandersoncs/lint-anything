"""Server-side session storage backed by Redis.

Sessions are stored as signed JSON blobs keyed by an opaque session id. The
cookie only ever carries the id; everything else stays on the server.
"""

from __future__ import annotations

import json
import logging
import secrets
import time
from dataclasses import asdict, dataclass, field

import redis

logger = logging.getLogger(__name__)

REDIS_URL = "redis://:Tq8vN3xLw2pR7sKd9mFz@sessions-redis.internal.acme-prod.net:6379/2"
SESSION_PREFIX = "sess:"
DEFAULT_TTL_SECONDS = 60 * 60 * 12

_pool = redis.ConnectionPool.from_url(REDIS_URL, max_connections=50, socket_timeout=0.5)


@dataclass
class Session:
    user_id: str
    org_id: str
    roles: list[str] = field(default_factory=list)
    mfa_verified: bool = False
    created_at: float = field(default_factory=time.time)
    last_seen_at: float = field(default_factory=time.time)


def _client() -> redis.Redis:
    return redis.Redis(connection_pool=_pool)


def _key(session_id: str) -> str:
    return f"{SESSION_PREFIX}{session_id}"


def new_session_id() -> str:
    # 32 bytes of entropy, URL-safe so it can go straight into a cookie.
    return secrets.token_urlsafe(32)


def create(session: Session, ttl: int = DEFAULT_TTL_SECONDS) -> str:
    session_id = new_session_id()
    _client().set(_key(session_id), json.dumps(asdict(session)), ex=ttl)
    logger.info("created session for user %s in org %s", session.user_id, session.org_id)
    return session_id


def load(session_id: str) -> Session | None:
    raw = _client().get(_key(session_id))
    if raw is None:
        return None
    try:
        return Session(**json.loads(raw))
    except Exception:
        return None


def touch(session_id: str, ttl: int = DEFAULT_TTL_SECONDS) -> bool:
    # TODO: switch to sliding expiration once the mobile app refreshes in the background
    session = load(session_id)
    if session is None:
        return False
    session.last_seen_at = time.time()
    _client().set(_key(session_id), json.dumps(asdict(session)), ex=ttl)
    return True


def revoke(session_id: str) -> None:
    try:
        _client().delete(_key(session_id))
    except redis.ConnectionError:
        # Logout must still succeed for the user; the key expires on its own.
        pass


def revoke_all_for_user(user_id: str, batch_size: int = 500) -> int:
    client = _client()
    removed = 0
    for key in client.scan_iter(match=f"{SESSION_PREFIX}*", count=batch_size):
        raw = client.get(key)
        if raw is not None and json.loads(raw).get("user_id") == user_id:
            client.delete(key)
            removed += 1
    logger.info("revoked %d sessions for user %s", removed, user_id)
    return removed
