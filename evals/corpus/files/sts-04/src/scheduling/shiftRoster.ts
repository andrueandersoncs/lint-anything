export type StaffRole = "cashier" | "stocker" | "supervisor";

export interface Shift {
  readonly id: string;
  readonly role: StaffRole;
  readonly start: Date;
  readonly end: Date;
}

export class RosterConflictError extends Error {
  constructor(
    message: string,
    readonly employeeId: string,
    readonly shiftId: string,
  ) {
    super(message);
    this.name = "RosterConflictError";
  }
}

/** Working-time rules from the store staffing agreement. */
const MAX_WEEKLY_HOURS = 40;
const MIN_REST_HOURS = 11;

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * One store's roster for one week. Every assignment is checked against the
 * working-time rules, so a roster built through `assign` and `claim` never
 * double-books anyone or exceeds the weekly limit.
 */
export class ShiftRoster {
  private readonly assigned = new Map<string, Shift[]>();
  private readonly open: Shift[] = [];

  /** Publishes a shift nobody is assigned to yet. */
  post(shift: Shift): void {
    this.open.push(shift);
  }

  /** Assigns an open shift to `employeeId`, enforcing the working-time rules. */
  claim(shiftId: string, employeeId: string): Shift {
    const index = this.open.findIndex((shift) => shift.id === shiftId);
    if (index === -1) {
      throw new RosterConflictError(`shift ${shiftId} is not open`, employeeId, shiftId);
    }
    const shift = this.open[index];
    this.assign(employeeId, shift);
    this.open.splice(index, 1);
    return shift;
  }

  assign(employeeId: string, shift: Shift): void {
    const current = this.assigned.get(employeeId) ?? [];
    for (const other of current) {
      if (shift.start < other.end && other.start < shift.end) {
        throw new RosterConflictError(`overlaps shift ${other.id}`, employeeId, shift.id);
      }
      if (restHoursBetween(shift, other) < MIN_REST_HOURS) {
        throw new RosterConflictError(`less than ${MIN_REST_HOURS}h rest after shift ${other.id}`, employeeId, shift.id);
      }
    }
    if (totalHours([...current, shift]) > MAX_WEEKLY_HOURS) {
      throw new RosterConflictError(`would exceed ${MAX_WEEKLY_HOURS}h this week`, employeeId, shift.id);
    }
    this.assigned.set(
      employeeId,
      [...current, shift].sort((a, b) => a.start.getTime() - b.start.getTime()),
    );
  }

  /** Puts an assigned shift back on the open board. */
  release(employeeId: string, shiftId: string): void {
    const current = this.assigned.get(employeeId) ?? [];
    const shift = current.find((candidate) => candidate.id === shiftId);
    if (shift === undefined) {
      return;
    }
    this.assigned.set(
      employeeId,
      current.filter((candidate) => candidate.id !== shiftId),
    );
    this.open.push(shift);
  }

  /** The employee's shifts this week, earliest first. */
  shiftsFor(employeeId: string): Shift[] {
    return this.assigned.get(employeeId) ?? [];
  }

  hoursFor(employeeId: string): number {
    return totalHours(this.shiftsFor(employeeId));
  }

  /** Shifts still waiting for someone to claim them. */
  get openShifts(): Shift[] {
    return this.open;
  }

  isCovered(role: StaffRole, at: Date): boolean {
    for (const shifts of this.assigned.values()) {
      if (shifts.some((shift) => shift.role === role && shift.start <= at && at < shift.end)) {
        return true;
      }
    }
    return false;
  }
}

function totalHours(shifts: ReadonlyArray<Shift>): number {
  return shifts.reduce((hours, shift) => hours + (shift.end.getTime() - shift.start.getTime()) / MS_PER_HOUR, 0);
}

function restHoursBetween(a: Shift, b: Shift): number {
  const [first, second] = a.start < b.start ? [a, b] : [b, a];
  return (second.start.getTime() - first.end.getTime()) / MS_PER_HOUR;
}
