import { describe, expect, it, vi } from "vitest";
import { InvoiceCalculator, type TaxRateClient } from "./invoice";

const issueDate = new Date("2026-03-01T09:30:00Z");
const clock = { now: () => issueDate };
const germanCustomer = { id: "cus_1042", region: "DE" };

function taxRatesOf(rate: number): TaxRateClient {
  return { rateFor: vi.fn(async () => rate) };
}

function calculatorWith(rate: number): InvoiceCalculator {
  return new InvoiceCalculator(taxRatesOf(rate), clock);
}

describe("InvoiceCalculator", () => {
  it("sums quantity times unit price into the subtotal", async () => {
    const calculator = calculatorWith(0);
    calculator.addLine({ sku: "PEN-BLK", description: "Gel pen", quantity: 12, unitPriceCents: 150 });
    calculator.addLine({ sku: "NB-A5", description: "A5 notebook", quantity: 3, unitPriceCents: 899 });

    const invoice = await calculator.finalize(germanCustomer);

    expect(invoice.subtotalCents).toBe(4497);
    expect(invoice.totalCents).toBe(4497);
  });

  it("keeps lines in the order they were added", async () => {
    const calculator = calculatorWith(0);
    calculator.addLine({ sku: "NB-A5", description: "A5 notebook", quantity: 1, unitPriceCents: 899 });
    calculator.addLine({ sku: "PEN-BLK", description: "Gel pen", quantity: 1, unitPriceCents: 150 });

    const invoice = await calculator.finalize(germanCustomer);

    expect(invoice.lines.map((line) => line.sku)).toEqual(["NB-A5", "PEN-BLK"]);
  });

  it("charges tax at the rate for the customer's region on the issue date", async () => {
    const taxRates = taxRatesOf(0.19);
    const calculator = new InvoiceCalculator(taxRates, clock);
    calculator.addLine({ sku: "DESK-OAK", description: "Oak desk", quantity: 1, unitPriceCents: 25_000 });

    const invoice = await calculator.finalize(germanCustomer);

    expect(taxRates.rateFor).toHaveBeenCalledWith("DE", issueDate);
    expect(invoice.taxCents).toBe(4750);
    expect(invoice.totalCents).toBe(29_750);
  });

  it("rounds tax per line rather than on the invoice total", async () => {
    const calculator = calculatorWith(0.19);
    calculator.addLine({ sku: "PEN-BLK", description: "Gel pen", quantity: 1, unitPriceCents: 150 });
    calculator.addLine({ sku: "PEN-RED", description: "Gel pen, red", quantity: 1, unitPriceCents: 150 });

    const invoice = await calculator.finalize(germanCustomer);

    expect(invoice.lines.map((line) => line.taxCents)).toEqual([28, 28]);
    expect(invoice.taxCents).toBe(56);
  });

  it("subtracts a percentage coupon before tax is applied", async () => {
    const calculator = calculatorWith(0.2);
    calculator.addLine({ sku: "CHAIR-MESH", description: "Mesh chair", quantity: 1, unitPriceCents: 10_000 });
    calculator.applyCoupon({ code: "SPRING10", percentOff: 10 });

    const invoice = await calculator.finalize(germanCustomer);

    expect(invoice.taxCents).toBe(1_800);
    expect(invoice.totalCents).toBe(10_800);
  });

  it("stamps the invoice with the current date and the customer id", async () => {
    const calculator = calculatorWith(0);
    calculator.addLine({ sku: "PEN-BLK", description: "Gel pen", quantity: 1, unitPriceCents: 150 });

    const invoice = await calculator.finalize(germanCustomer);

    expect(invoice.issuedAt).toEqual(issueDate);
    expect(invoice.customerId).toBe("cus_1042");
  });

  it("refuses to finalize an invoice with no lines", async () => {
    const calculator = calculatorWith(0.19);

    await expect(calculator.finalize(germanCustomer)).rejects.toThrow(/no lines/);
  });
});
