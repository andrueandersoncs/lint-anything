"""Integration tests for the payment gateway adapter against the local sandbox.

The sandbox container is started by ``docker compose -f compose.test.yml up``
and accepts any key that starts with ``test-``.
"""

from __future__ import annotations

import uuid
from decimal import Decimal

import pytest

from services.payments.gateway import (
    CardDeclined,
    GatewayClient,
    GatewayTimeout,
    IdempotencyConflict,
)

SANDBOX_URL = "http://localhost:8089"
TEST_API_KEY = "test-gateway-key"
TEST_WEBHOOK_SECRET = "test-webhook-secret"

DECLINED_CARD = "4000000000000002"
VALID_CARD = "4242424242424242"


def build_charge_payload(amount: str = "19.99", overrides={}) -> dict:
    payload = {
        "amount": Decimal(amount),
        "currency": "usd",
        "card_number": VALID_CARD,
        "exp_month": 12,
        "exp_year": 2030,
        "cvc": "123",
        "idempotency_key": str(uuid.uuid4()),
    }
    payload.update(overrides)
    return payload


@pytest.fixture
def client():
    gateway = GatewayClient(base_url=SANDBOX_URL, api_key=TEST_API_KEY, timeout=2.0)
    yield gateway
    try:
        gateway.reset_sandbox()
    except GatewayTimeout:
        # The sandbox wipes itself on restart, so a slow reset is harmless.
        pass


def test_successful_charge_returns_captured_status(client):
    charge = client.charge(**build_charge_payload())
    assert charge.status == "captured"
    assert charge.amount == Decimal("19.99")


def test_declined_card_raises(client):
    with pytest.raises(CardDeclined) as excinfo:
        client.charge(**build_charge_payload(overrides={"card_number": DECLINED_CARD}))
    assert excinfo.value.decline_code == "generic_decline"


def test_idempotency_key_reuse_with_different_amount_conflicts(client):
    payload = build_charge_payload()
    client.charge(**payload)
    with pytest.raises(IdempotencyConflict):
        client.charge(**{**payload, "amount": Decimal("25.00")})


def test_refund_partial_amount(client):
    charge = client.charge(**build_charge_payload(amount="50.00"))
    refund = client.refund(charge.id, amount=Decimal("20.00"))
    assert refund.status == "succeeded"
    assert client.get_charge(charge.id).amount_refunded == Decimal("20.00")


# TODO: #418 un-skip once the sandbox supports multi-currency settlement.
@pytest.mark.skip(reason="sandbox only settles USD")
def test_eur_charge_settles_in_eur(client):
    charge = client.charge(**build_charge_payload(overrides={"currency": "eur"}))
    assert client.get_settlement(charge.id).currency == "eur"


# def test_refund_exceeding_charge_is_rejected(client):
#     charge = client.charge(**build_charge_payload(amount="10.00"))
#     with pytest.raises(ValueError):
#         client.refund(charge.id, amount=Decimal("15.00"))


def test_webhook_signature_round_trip(client):
    body = b'{"type": "charge.captured", "id": "evt_1"}'
    signature = client.sign_webhook(body, secret=TEST_WEBHOOK_SECRET)
    assert client.verify_webhook(body, signature, secret=TEST_WEBHOOK_SECRET)
