"""Shipping quotes shown at checkout."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from enum import Enum


class Service(Enum):
    """Carrier service levels with their per-kilogram rate and usual transit time."""

    GROUND = ("ground", Decimal("1.10"), 5)
    EXPRESS = ("express", Decimal("2.40"), 2)
    OVERNIGHT = ("overnight", Decimal("4.75"), 1)

    def __init__(self, code: str, rate_per_kg: Decimal, transit_days: int) -> None:
        self.code = code
        self.rate_per_kg = rate_per_kg
        self.transit_days = transit_days


MINIMUM_CHARGE = Decimal("4.99")
REMOTE_REGIONS = frozenset({"AK", "HI", "PR", "GU", "VI"})
CENTS = Decimal("0.01")


@dataclass(frozen=True)
class Parcel:
    weight_kg: Decimal
    length_cm: Decimal
    width_cm: Decimal
    height_cm: Decimal


@dataclass(frozen=True)
class Quote:
    service: Service
    amount: Decimal
    transit_days: int


def quote(service: Service, parcels: Sequence[Parcel], region: str, order_subtotal: Decimal) -> Quote:
    """Price one service for the given parcels going to a state or territory code."""
    if not parcels:
        raise ValueError("cannot quote shipping for an empty shipment")

    if service is Service.GROUND and order_subtotal >= Decimal("75.00"):
        amount = Decimal(0)
    else:
        amount = _carrier_charge(service, parcels, region)

    return Quote(
        service=service,
        amount=amount.quantize(CENTS, rounding=ROUND_HALF_UP),
        transit_days=_transit_days(service, region),
    )


def quotes_for_checkout(parcels: Sequence[Parcel], region: str, order_subtotal: Decimal) -> list[Quote]:
    """Every service we can offer for this shipment, cheapest first."""
    offered = [
        service
        for service in Service
        # The overnight partner does not fly to the territories.
        if not (service is Service.OVERNIGHT and region in REMOTE_REGIONS)
    ]
    quotes = [quote(service, parcels, region, order_subtotal) for service in offered]
    return sorted(quotes, key=lambda offer: (offer.amount, offer.transit_days))


def _carrier_charge(service: Service, parcels: Sequence[Parcel], region: str) -> Decimal:
    weight = sum((_billable_weight(parcel) for parcel in parcels), Decimal(0))
    amount = service.rate_per_kg * weight

    heavy_parcels = sum(1 for parcel in parcels if parcel.weight_kg > 30)
    amount += heavy_parcels * Decimal("12.50")

    if region in REMOTE_REGIONS:
        amount *= Decimal("1.35")

    return max(amount, MINIMUM_CHARGE)


def _billable_weight(parcel: Parcel) -> Decimal:
    """Carriers bill the larger of actual and dimensional weight."""
    volume_cm3 = parcel.length_cm * parcel.width_cm * parcel.height_cm
    return max(parcel.weight_kg, volume_cm3 / 5000)


def _transit_days(service: Service, region: str) -> int:
    if region in REMOTE_REGIONS:
        return service.transit_days + 3
    return service.transit_days
