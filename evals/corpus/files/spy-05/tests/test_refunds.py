from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest

from shop.orders import Order
from shop.payments import GatewayDeclined
from shop.refunds import RefundRejected, RefundService

NOW = datetime(2026, 3, 14, 12, 0, tzinfo=timezone.utc)


class FakeGateway:
    def __init__(self):
        self.refund_calls = []
        self.decline_with = None

    def refund(self, payment_id, amount):
        if self.decline_with is not None:
            raise self.decline_with
        self.refund_calls.append((payment_id, amount))
        return f"re_{len(self.refund_calls)}"


class InMemoryOrders:
    def __init__(self, *orders):
        self._orders = {order.id: order for order in orders}

    def get(self, order_id):
        return self._orders[order_id]

    def save(self, order):
        self._orders[order.id] = order


def make_order(total="80.00", refunded="0.00", delivered_days_ago=3):
    return Order(
        id="ord_1",
        payment_id="pay_1",
        total=Decimal(total),
        refunded=Decimal(refunded),
        delivered_at=NOW - timedelta(days=delivered_days_ago),
    )


@pytest.fixture
def gateway():
    return FakeGateway()


def refund_service(order, gateway):
    return RefundService(orders=InMemoryOrders(order), gateway=gateway, clock=lambda: NOW)


def test_refund(gateway):
    service = refund_service(make_order(), gateway)

    receipt = service.refund("ord_1", Decimal("80.00"), reason="arrived damaged")

    assert gateway.refund_calls == [("pay_1", Decimal("80.00"))]
    assert receipt.amount == Decimal("80.00")
    assert service.refundable_amount("ord_1") == Decimal("0.00")


def test_partial_refunds_can_be_issued_until_the_total_is_reached(gateway):
    service = refund_service(make_order(), gateway)

    service.refund("ord_1", Decimal("30.00"), reason="missing accessory")
    service.refund("ord_1", Decimal("50.00"), reason="returned")

    assert gateway.refund_calls == [("pay_1", Decimal("30.00")), ("pay_1", Decimal("50.00"))]
    assert service.refundable_amount("ord_1") == Decimal("0.00")


def test_refund_2(gateway):
    service = refund_service(make_order(refunded="50.00"), gateway)

    with pytest.raises(RefundRejected, match="exceeds the refundable amount"):
        service.refund("ord_1", Decimal("40.00"), reason="returned")

    assert gateway.refund_calls == []


@pytest.mark.parametrize("amount", ["0.00", "-5.00"])
def test_non_positive_amounts_are_rejected(gateway, amount):
    service = refund_service(make_order(), gateway)

    with pytest.raises(RefundRejected, match="must be positive"):
        service.refund("ord_1", Decimal(amount), reason="goodwill")


def test_refund_after_return_window_is_rejected(gateway):
    service = refund_service(make_order(delivered_days_ago=31), gateway)

    with pytest.raises(RefundRejected, match="return window"):
        service.refund("ord_1", Decimal("10.00"), reason="changed mind")


def test_return_window_does_not_apply_to_damaged_goods(gateway):
    # Card networks let customers dispute damaged goods for months, so we refund rather than fight it.
    service = refund_service(make_order(delivered_days_ago=90), gateway)

    service.refund("ord_1", Decimal("80.00"), reason="arrived damaged")

    assert gateway.refund_calls == [("pay_1", Decimal("80.00"))]


def test_errors(gateway):
    gateway.decline_with = GatewayDeclined("merchant balance too low")
    service = refund_service(make_order(), gateway)

    with pytest.raises(GatewayDeclined):
        service.refund("ord_1", Decimal("25.00"), reason="returned")

    assert service.refundable_amount("ord_1") == Decimal("80.00")


def test_refund_reason(gateway):
    service = refund_service(make_order(), gateway)

    with pytest.raises(RefundRejected, match="reason is required"):
        service.refund("ord_1", Decimal("10.00"), reason="   ")
