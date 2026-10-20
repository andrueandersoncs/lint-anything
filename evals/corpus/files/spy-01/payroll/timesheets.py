"""Weekly timesheets for hourly staff."""

from __future__ import annotations

import csv
import io
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from html import escape

OVERTIME_THRESHOLD_HOURS = Decimal(40)
OVERTIME_MULTIPLIER = Decimal("1.5")
CENTS = Decimal("0.01")
SECONDS_PER_HOUR = Decimal(3600)
TIMECLOCK_TIME_FORMAT = "%Y-%m-%d %H:%M"


@dataclass(frozen=True)
class Shift:
    clock_in: datetime
    clock_out: datetime
    unpaid_break_minutes: int = 0

    @property
    def hours(self) -> Decimal:
        worked = self.clock_out - self.clock_in - timedelta(minutes=self.unpaid_break_minutes)
        return Decimal(worked.total_seconds()) / SECONDS_PER_HOUR


class WeeklyTimesheet:
    """The shifts one employee worked during a pay week, and what they are owed for them."""

    def __init__(self, employee_id: str, week_start: date, shifts: list[Shift]) -> None:
        self.employee_id = employee_id
        self.week_start = week_start
        self._shifts = tuple(shifts)

    @property
    def shifts(self) -> tuple[Shift, ...]:
        return self._shifts

    @classmethod
    def from_timeclock_csv(cls, employee_id: str, week_start: date, export: str) -> WeeklyTimesheet:
        """Reads the kiosk's CSV export (columns: employee, in, out, break)."""
        week_end = week_start + timedelta(days=7)
        shifts = []
        for row in csv.DictReader(io.StringIO(export)):
            # The kiosk exports every punch at the location, so other staff share the file.
            if row["employee"].strip() != employee_id:
                continue
            clock_in = datetime.strptime(row["in"].strip(), TIMECLOCK_TIME_FORMAT)
            if not week_start <= clock_in.date() < week_end:
                continue
            clock_out = datetime.strptime(row["out"].strip(), TIMECLOCK_TIME_FORMAT)
            if clock_out <= clock_in:
                raise ValueError(f"shift for {employee_id} starting {clock_in} ends before it starts")
            shifts.append(Shift(clock_in, clock_out, int(row.get("break") or 0)))
        return cls(employee_id, week_start, shifts)

    def total_hours(self) -> Decimal:
        return sum((shift.hours for shift in self._shifts), Decimal(0))

    def regular_hours(self) -> Decimal:
        return min(self.total_hours(), OVERTIME_THRESHOLD_HOURS)

    def overtime_hours(self) -> Decimal:
        return max(self.total_hours() - OVERTIME_THRESHOLD_HOURS, Decimal(0))

    def gross_pay(self, hourly_rate: Decimal) -> Decimal:
        regular = self.regular_hours() * hourly_rate
        overtime = self.overtime_hours() * hourly_rate * OVERTIME_MULTIPLIER
        return (regular + overtime).quantize(CENTS, rounding=ROUND_HALF_UP)

    def payslip_html(self, employee_name: str, hourly_rate: Decimal) -> str:
        shift_rows = "".join(
            f"<tr><td>{shift.clock_in:%a %d %b}</td><td>{shift.hours:.2f}</td></tr>"
            for shift in self._shifts
        )
        return (
            f"<h2>{escape(employee_name)} &mdash; week of {self.week_start:%d %B %Y}</h2>"
            f"<table><tr><th>Day</th><th>Hours</th></tr>{shift_rows}</table>"
            f"<p>Regular: {self.regular_hours():.2f} h &middot; "
            f"Overtime: {self.overtime_hours():.2f} h</p>"
            f"<p><strong>Gross pay: ${self.gross_pay(hourly_rate):,.2f}</strong></p>"
        )

    def provider_export_line(self, hourly_rate: Decimal) -> str:
        """One fixed-width record for the payroll provider's weekly import file."""
        gross_cents = int(self.gross_pay(hourly_rate) * 100)
        return (
            f"{self.employee_id:<10}"
            f"{self.week_start:%Y%m%d}"
            f"{self.regular_hours():07.2f}"
            f"{self.overtime_hours():07.2f}"
            f"{gross_cents:09d}"
        )
