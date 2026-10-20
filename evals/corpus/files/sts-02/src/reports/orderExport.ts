export interface ExportedOrderLine {
  readonly sku: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
}

export interface ExportedOrder {
  readonly id: string;
  readonly placedAt: Date;
  readonly customerName: string;
  readonly lines: ReadonlyArray<ExportedOrderLine>;
  readonly taxCents: number;
  readonly refunded: boolean;
}

export interface ExportOptions {
  /** Refunded orders are left out unless this is set. */
  readonly includeRefunded?: boolean;
}

const FINANCE_COLUMNS = ["order_id", "placed_on", "net", "tax", "gross"] as const;

export function exportOrders(
  orders: ReadonlyArray<ExportedOrder>,
  forFinance: boolean,
  options: ExportOptions = {},
): string {
  const selected = selectOrders(orders, options);
  return forFinance ? financeCsv(selected) : operationsSummary(selected);
}

function selectOrders(
  orders: ReadonlyArray<ExportedOrder>,
  options: ExportOptions,
): ReadonlyArray<ExportedOrder> {
  const kept = options.includeRefunded ? orders : orders.filter((order) => !order.refunded);
  return [...kept].sort((a, b) => a.placedAt.getTime() - b.placedAt.getTime());
}

function financeCsv(orders: ReadonlyArray<ExportedOrder>): string {
  const rows = orders.map((order) => {
    const net = netCents(order);
    return [
      order.id,
      isoDay(order.placedAt),
      formatAmount(net),
      formatAmount(order.taxCents),
      formatAmount(net + order.taxCents),
    ];
  });
  const totalNet = sum(orders.map(netCents));
  const totalTax = sum(orders.map((order) => order.taxCents));
  const totals = ["TOTAL", "", formatAmount(totalNet), formatAmount(totalTax), formatAmount(totalNet + totalTax)];
  return [[...FINANCE_COLUMNS], ...rows, totals].map(toCsvRow).join("\n");
}

function operationsSummary(orders: ReadonlyArray<ExportedOrder>): string {
  if (orders.length === 0) {
    return "No orders in this period.";
  }
  const lines = orders.map((order) => {
    const units = sum(order.lines.map((line) => line.quantity));
    const refundNote = order.refunded ? " (refunded)" : "";
    return `#${order.id}  ${isoDay(order.placedAt)}  ${order.customerName}  ${units} units  $${formatAmount(netCents(order))}${refundNote}`;
  });
  return [`${orders.length} orders`, ...lines].join("\n");
}

function netCents(order: ExportedOrder): number {
  return sum(order.lines.map((line) => line.quantity * line.unitPriceCents));
}

function sum(values: ReadonlyArray<number>): number {
  return values.reduce((total, value) => total + value, 0);
}

function formatAmount(cents: number): string {
  return (cents / 100).toFixed(2);
}

function isoDay(date: Date): string {
  return date.toISOString().split("T")[0];
}

// Spreadsheet tools split on commas inside unquoted fields and treat a doubled
// quote as a literal one, so quote any field that contains either.
function toCsvRow(fields: ReadonlyArray<string>): string {
  return fields
    .map((field) => (/[",\n]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field))
    .join(",");
}
