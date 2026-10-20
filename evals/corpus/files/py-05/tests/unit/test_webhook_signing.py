import hashlib
import hmac
import json
import time

import pytest

from app.webhooks.signing import (
    SignatureExpired,
    SignatureMismatch,
    sign_payload,
    verify_signature,
)

WEBHOOK_SECRET = "whsec_test_secret"
OTHER_SECRET = "whsec_test_other"


def _payload(event_type):
    return json.dumps({"type": event_type, "data": {"id": "sub_123", "plan": "team"}}).encode()


def _manual_signature(body, secret, timestamp):
    signed = f"{timestamp}.".encode() + body
    digest = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    return f"t={timestamp},v1={digest}"


def _parse_header(header):
    try:
        parts = dict(item.split("=", 1) for item in header.split(","))
        return int(parts["t"]), parts["v1"]
    except:
        return None


def test_sign_payload_matches_manual_hmac():
    body = _payload("subscription.created")
    now = int(time.time())
    assert sign_payload(body, WEBHOOK_SECRET, timestamp=now) == _manual_signature(body, WEBHOOK_SECRET, now)


def test_verify_accepts_fresh_signature():
    body = _payload("subscription.updated")
    header = sign_payload(body, WEBHOOK_SECRET, timestamp=int(time.time()))
    assert verify_signature(body, header, WEBHOOK_SECRET)


def test_verify_rejects_wrong_secret():
    body = _payload("subscription.updated")
    header = sign_payload(body, OTHER_SECRET, timestamp=int(time.time()))
    with pytest.raises(SignatureMismatch):
        verify_signature(body, header, WEBHOOK_SECRET)


def test_verify_rejects_tampered_body():
    body = _payload("invoice.paid")
    header = sign_payload(body, WEBHOOK_SECRET, timestamp=int(time.time()))
    with pytest.raises(SignatureMismatch):
        verify_signature(body.replace(b"team", b"enterprise"), header, WEBHOOK_SECRET)


def test_verify_rejects_stale_timestamp():
    body = _payload("invoice.paid")
    stale = int(time.time()) - 60 * 10
    header = sign_payload(body, WEBHOOK_SECRET, timestamp=stale)
    with pytest.raises(SignatureExpired):
        verify_signature(body, header, WEBHOOK_SECRET)


def test_header_format():
    body = _payload("customer.deleted")
    header = sign_payload(body, WEBHOOK_SECRET, timestamp=1700000000)
    timestamp, digest = _parse_header(header)
    assert timestamp == 1700000000
    assert len(digest) == 64
    # FIXME: the v0 scheme is still emitted for legacy consumers, assert it is gone after cutover
    # assert "v0=" not in header
    # assert header.count(",") == 1
