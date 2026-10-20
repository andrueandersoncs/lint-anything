"""Coupon endpoints for the checkout cart."""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.api.deps import current_customer, get_cart_repository, get_coupon_repository
from app.domain.carts import AppliedCoupon, CartRepository
from app.domain.coupons import CouponKind, CouponRepository
from app.domain.customers import Customer

router = APIRouter(prefix="/carts", tags=["coupons"])

CENTS = Decimal("0.01")


class ApplyCouponRequest(BaseModel):
    code: str = Field(min_length=3, max_length=32)


class AppliedCouponResponse(BaseModel):
    code: str
    discount: Decimal
    cart_total: Decimal


def _unprocessable(reason: str) -> HTTPException:
    return HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail=reason)


@router.post("/{cart_id}/coupons", response_model=AppliedCouponResponse)
def apply_coupon(
    cart_id: str,
    body: ApplyCouponRequest,
    customer: Customer = Depends(current_customer),
    carts: CartRepository = Depends(get_cart_repository),
    coupons: CouponRepository = Depends(get_coupon_repository),
) -> AppliedCouponResponse:
    cart = carts.get(cart_id)
    if cart is None or cart.customer_id != customer.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="cart not found")

    # Codes are printed in capitals on flyers, but customers type them however they like.
    coupon = coupons.find_by_code(body.code.strip().upper())
    if coupon is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="unknown coupon code")

    now = datetime.now(timezone.utc)
    if coupon.starts_at > now or (coupon.expires_at is not None and coupon.expires_at <= now):
        raise _unprocessable("this coupon is not currently active")
    if cart.subtotal < coupon.minimum_subtotal:
        raise _unprocessable(f"this coupon needs a subtotal of at least {coupon.minimum_subtotal}")
    if coupon.new_customers_only and customer.completed_orders > 0:
        raise _unprocessable("this coupon is only for a first order")
    if coupon.uses_per_customer is not None:
        previous_uses = coupons.count_redemptions(coupon.id, customer.id)
        if previous_uses >= coupon.uses_per_customer:
            raise _unprocessable("you have already used this coupon")
    if cart.applied_coupons and not (
        coupon.stackable and all(applied.stackable for applied in cart.applied_coupons)
    ):
        raise _unprocessable("this coupon cannot be combined with the coupons already applied")

    if coupon.kind is CouponKind.PERCENT_OFF:
        discount = cart.subtotal * coupon.value / 100
        if coupon.max_discount is not None:
            discount = min(discount, coupon.max_discount)
    elif coupon.kind is CouponKind.AMOUNT_OFF:
        discount = min(coupon.value, cart.subtotal)
    else:
        discount = cart.shipping_total
    discount = discount.quantize(CENTS, rounding=ROUND_HALF_UP)

    cart.add_coupon(AppliedCoupon(code=coupon.code, discount=discount, stackable=coupon.stackable))
    carts.save(cart)
    coupons.record_redemption(coupon.id, customer.id, cart.id, redeemed_at=now)

    return AppliedCouponResponse(code=coupon.code, discount=discount, cart_total=cart.total)
