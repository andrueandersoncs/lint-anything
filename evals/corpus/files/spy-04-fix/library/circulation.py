"""Circulation desk: checkouts, renewals, and returns."""

from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass, replace
from datetime import date, timedelta
from decimal import Decimal
from enum import Enum
from types import MappingProxyType
from typing import Protocol


class Material(Enum):
    BOOK = "book"
    AUDIOBOOK = "audiobook"
    DVD = "dvd"


LOAN_PERIODS = MappingProxyType({
    Material.BOOK: timedelta(days=21),
    Material.AUDIOBOOK: timedelta(days=21),
    Material.DVD: timedelta(days=7),
})
DAILY_FINES = MappingProxyType({
    Material.BOOK: Decimal("0.25"),
    Material.AUDIOBOOK: Decimal("0.25"),
    Material.DVD: Decimal("1.00"),
})
# Returns dropped in the book bin over a weekend are only scanned on Monday or Tuesday.
GRACE_DAYS = 2
FINE_CAP_PER_ITEM = Decimal("10.00")
MAX_RENEWALS = 2
BORROWING_BLOCKED_AT = Decimal("15.00")


@dataclass(frozen=True)
class Loan:
    item_id: str
    patron_id: str
    material: Material
    due: date
    renewals: int = 0
    returned_on: date | None = None

    def fine_on(self, returned: date) -> Decimal:
        days_late = (returned - self.due).days
        if days_late <= GRACE_DAYS:
            return Decimal(0)
        return min(days_late * DAILY_FINES[self.material], FINE_CAP_PER_ITEM)

    def renewal_refusal(self, today: date) -> str | None:
        if today > self.due:
            return "overdue items must be returned before they can be renewed"
        if self.renewals >= MAX_RENEWALS:
            return f"items can be renewed at most {MAX_RENEWALS} times"
        return None

    def renewed(self, today: date) -> Loan:
        return replace(self, due=today + LOAN_PERIODS[self.material], renewals=self.renewals + 1)


class LoanStore(Protocol):
    def open_loans(self, patron_id: str) -> list[Loan]: ...

    def save(self, loan: Loan) -> None: ...


class FineLedger(Protocol):
    def balance(self, patron_id: str) -> Decimal: ...

    def charge(self, patron_id: str, amount: Decimal, memo: str) -> None: ...


class BorrowingBlocked(Exception):
    def __init__(self, patron_id: str, owed: Decimal) -> None:
        super().__init__(f"patron {patron_id} owes {owed} and cannot borrow until it is paid")
        self.patron_id = patron_id
        self.owed = owed


class RenewalRefused(Exception):
    pass


def _projected_fines(loans: Iterable[Loan], on: date) -> Decimal:
    """What the patron would owe if every open loan came back on the given day."""
    return sum((loan.fine_on(on) for loan in loans), Decimal(0))


class CirculationDesk:
    def __init__(self, loans: LoanStore, fines: FineLedger, today: Callable[[], date]) -> None:
        self._loans = loans
        self._fines = fines
        self._today = today

    def check_out(self, patron_id: str, item_id: str, material: Material) -> Loan:
        today = self._today()
        owed = self._fines.balance(patron_id) + _projected_fines(self._loans.open_loans(patron_id), today)
        if owed >= BORROWING_BLOCKED_AT:
            raise BorrowingBlocked(patron_id, owed)
        loan = Loan(
            item_id=item_id, patron_id=patron_id, material=material, due=today + LOAN_PERIODS[material]
        )
        self._loans.save(loan)
        return loan

    def renew(self, loan: Loan) -> Loan:
        today = self._today()
        refusal = loan.renewal_refusal(today)
        if refusal is not None:
            raise RenewalRefused(refusal)
        renewed = loan.renewed(today)
        self._loans.save(renewed)
        return renewed

    def check_in(self, loan: Loan) -> Decimal:
        today = self._today()
        fine = loan.fine_on(today)
        self._loans.save(replace(loan, returned_on=today))
        if fine:
            self._fines.charge(loan.patron_id, fine, memo=f"late return of {loan.item_id}")
        return fine
