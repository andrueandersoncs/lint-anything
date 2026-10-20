import { readFile } from "node:fs/promises"
import { join } from "node:path"

/**
 * Invoice rendering for customer-facing documents: the HTML used for the PDF and email body, the
 * plain-text email alternative, and the EPC payment QR payload for SEPA customers.
 *
 * All amounts are integers in the currency's minor unit (cents, öre, yen). Nothing in this module
 * performs I/O except {@link renderInvoiceDocument}, which loads the HTML shell and stylesheet.
 */

export type CurrencyCode = "EUR" | "USD" | "GBP" | "SEK" | "DKK" | "NOK" | "CHF" | "JPY" | "PLN"

export type LocaleCode = "en" | "de" | "fr" | "nl" | "es" | "sv"

export interface Money {
  readonly amount: number
  readonly currency: CurrencyCode
}

export interface PostalAddress {
  readonly line1: string
  readonly line2?: string
  readonly postalCode: string
  readonly city: string
  readonly region?: string
  /** ISO 3166-1 alpha-2. */
  readonly country: string
}

export interface Party {
  readonly legalName: string
  readonly address: PostalAddress
  readonly vatId?: string
  readonly email?: string
  readonly companyNumber?: string
}

export interface BankDetails {
  readonly beneficiary: string
  readonly iban: string
  readonly bic: string
  readonly bankName?: string
}

export type LineItemKind = "subscription" | "usage" | "proration" | "one_off" | "discount"

export interface LineItem {
  readonly id: string
  readonly kind: LineItemKind
  readonly description: string
  readonly quantity: number
  /** Unit price in minor units, before tax. Discounts carry a negative unit price. */
  readonly unitAmount: number
  /** Tax rate in basis points, e.g. 1900 for 19 %. */
  readonly taxRateBps: number
  readonly periodStart?: Date
  readonly periodEnd?: Date
  readonly productGroup?: string
}

export interface TaxLine {
  readonly rateBps: number
  readonly taxableAmount: number
  readonly taxAmount: number
}

export type InvoiceStatus = "draft" | "open" | "paid" | "void" | "uncollectible"

export interface Invoice {
  readonly number: string
  readonly status: InvoiceStatus
  readonly issuedAt: Date
  readonly dueAt: Date
  readonly currency: CurrencyCode
  readonly locale: LocaleCode
  readonly seller: Party
  readonly buyer: Party
  readonly lines: ReadonlyArray<LineItem>
  readonly amountPaid: number
  readonly reverseCharge: boolean
  readonly purchaseOrder?: string
  readonly bank?: BankDetails
  readonly memo?: string
}

export interface InvoiceTotals {
  readonly subtotal: number
  readonly discounts: number
  readonly taxLines: ReadonlyArray<TaxLine>
  readonly tax: number
  readonly total: number
  readonly amountPaid: number
  readonly amountDue: number
}

export interface RenderedInvoice {
  readonly html: string
  readonly text: string
  readonly totals: InvoiceTotals
  readonly epcPayload?: string
}

interface Strings {
  readonly invoice: string
  readonly creditNote: string
  readonly invoiceNumber: string
  readonly issued: string
  readonly due: string
  readonly billedTo: string
  readonly from: string
  readonly description: string
  readonly quantity: string
  readonly unitPrice: string
  readonly taxRate: string
  readonly amount: string
  readonly subtotal: string
  readonly discounts: string
  readonly taxOn: (rate: string, base: string) => string
  readonly total: string
  readonly amountPaid: string
  readonly amountDue: string
  readonly vatId: string
  readonly purchaseOrder: string
  readonly reverseCharge: string
  readonly payBy: (date: string) => string
  readonly paidInFull: string
  readonly bankTransfer: string
  readonly period: (start: string, end: string) => string
  readonly prorationNote: string
  readonly page: string
}

const STRINGS: Readonly<Record<LocaleCode, Strings>> = {
  en: {
    invoice: "Invoice",
    creditNote: "Credit note",
    invoiceNumber: "Invoice number",
    issued: "Date of issue",
    due: "Date due",
    billedTo: "Bill to",
    from: "From",
    description: "Description",
    quantity: "Qty",
    unitPrice: "Unit price",
    taxRate: "Tax",
    amount: "Amount",
    subtotal: "Subtotal",
    discounts: "Discounts",
    taxOn: (rate, base) => `VAT ${rate} on ${base}`,
    total: "Total",
    amountPaid: "Amount paid",
    amountDue: "Amount due",
    vatId: "VAT ID",
    purchaseOrder: "PO number",
    reverseCharge: "Reverse charge: VAT to be accounted for by the recipient.",
    payBy: (date) => `Please pay by ${date}.`,
    paidInFull: "Paid in full. Thank you.",
    bankTransfer: "Bank transfer",
    period: (start, end) => `${start} – ${end}`,
    prorationNote: "Adjusted for a plan change during the billing period.",
    page: "Page",
  },
  de: {
    invoice: "Rechnung",
    creditNote: "Gutschrift",
    invoiceNumber: "Rechnungsnummer",
    issued: "Rechnungsdatum",
    due: "Fällig am",
    billedTo: "Rechnungsempfänger",
    from: "Von",
    description: "Beschreibung",
    quantity: "Menge",
    unitPrice: "Einzelpreis",
    taxRate: "USt.",
    amount: "Betrag",
    subtotal: "Zwischensumme",
    discounts: "Rabatte",
    taxOn: (rate, base) => `USt. ${rate} auf ${base}`,
    total: "Gesamtbetrag",
    amountPaid: "Bezahlt",
    amountDue: "Offener Betrag",
    vatId: "USt-IdNr.",
    purchaseOrder: "Bestellnummer",
    reverseCharge: "Steuerschuldnerschaft des Leistungsempfängers.",
    payBy: (date) => `Bitte zahlen Sie bis zum ${date}.`,
    paidInFull: "Vollständig bezahlt. Vielen Dank.",
    bankTransfer: "Banküberweisung",
    period: (start, end) => `${start} – ${end}`,
    prorationNote: "Anteilig berechnet aufgrund eines Tarifwechsels im Abrechnungszeitraum.",
    page: "Seite",
  },
  fr: {
    invoice: "Facture",
    creditNote: "Avoir",
    invoiceNumber: "Numéro de facture",
    issued: "Date d'émission",
    due: "Date d'échéance",
    billedTo: "Facturé à",
    from: "De",
    description: "Description",
    quantity: "Qté",
    unitPrice: "Prix unitaire",
    taxRate: "TVA",
    amount: "Montant",
    subtotal: "Sous-total",
    discounts: "Remises",
    taxOn: (rate, base) => `TVA ${rate} sur ${base}`,
    total: "Total",
    amountPaid: "Montant payé",
    amountDue: "Montant dû",
    vatId: "N° TVA",
    purchaseOrder: "N° de commande",
    reverseCharge: "Autoliquidation : TVA due par le preneur.",
    payBy: (date) => `Merci de régler avant le ${date}.`,
    paidInFull: "Payée intégralement. Merci.",
    bankTransfer: "Virement bancaire",
    period: (start, end) => `${start} – ${end}`,
    prorationNote: "Ajusté suite à un changement d'offre pendant la période de facturation.",
    page: "Page",
  },
  nl: {
    invoice: "Factuur",
    creditNote: "Creditnota",
    invoiceNumber: "Factuurnummer",
    issued: "Factuurdatum",
    due: "Vervaldatum",
    billedTo: "Factuur aan",
    from: "Van",
    description: "Omschrijving",
    quantity: "Aantal",
    unitPrice: "Stukprijs",
    taxRate: "Btw",
    amount: "Bedrag",
    subtotal: "Subtotaal",
    discounts: "Kortingen",
    taxOn: (rate, base) => `Btw ${rate} over ${base}`,
    total: "Totaal",
    amountPaid: "Betaald",
    amountDue: "Te betalen",
    vatId: "Btw-nummer",
    purchaseOrder: "Inkoopordernummer",
    reverseCharge: "Btw verlegd.",
    payBy: (date) => `Graag betalen vóór ${date}.`,
    paidInFull: "Volledig betaald. Bedankt.",
    bankTransfer: "Bankoverschrijving",
    period: (start, end) => `${start} – ${end}`,
    prorationNote: "Aangepast vanwege een abonnementswijziging tijdens de factuurperiode.",
    page: "Pagina",
  },
  es: {
    invoice: "Factura",
    creditNote: "Nota de crédito",
    invoiceNumber: "Número de factura",
    issued: "Fecha de emisión",
    due: "Fecha de vencimiento",
    billedTo: "Facturar a",
    from: "De",
    description: "Descripción",
    quantity: "Cant.",
    unitPrice: "Precio unitario",
    taxRate: "IVA",
    amount: "Importe",
    subtotal: "Subtotal",
    discounts: "Descuentos",
    taxOn: (rate, base) => `IVA ${rate} sobre ${base}`,
    total: "Total",
    amountPaid: "Importe pagado",
    amountDue: "Importe pendiente",
    vatId: "NIF-IVA",
    purchaseOrder: "N.º de pedido",
    reverseCharge: "Inversión del sujeto pasivo.",
    payBy: (date) => `Por favor, pague antes del ${date}.`,
    paidInFull: "Pagada en su totalidad. Gracias.",
    bankTransfer: "Transferencia bancaria",
    period: (start, end) => `${start} – ${end}`,
    prorationNote: "Ajustado por un cambio de plan durante el periodo de facturación.",
    page: "Página",
  },
  sv: {
    invoice: "Faktura",
    creditNote: "Kreditfaktura",
    invoiceNumber: "Fakturanummer",
    issued: "Fakturadatum",
    due: "Förfallodatum",
    billedTo: "Faktureras till",
    from: "Från",
    description: "Beskrivning",
    quantity: "Antal",
    unitPrice: "À-pris",
    taxRate: "Moms",
    amount: "Belopp",
    subtotal: "Delsumma",
    discounts: "Rabatter",
    taxOn: (rate, base) => `Moms ${rate} på ${base}`,
    total: "Totalt",
    amountPaid: "Betalt",
    amountDue: "Att betala",
    vatId: "Momsreg.nr",
    purchaseOrder: "Ordernummer",
    reverseCharge: "Omvänd betalningsskyldighet.",
    payBy: (date) => `Vänligen betala senast ${date}.`,
    paidInFull: "Fullt betald. Tack.",
    bankTransfer: "Banköverföring",
    period: (start, end) => `${start} – ${end}`,
    prorationNote: "Justerat för ett planbyte under faktureringsperioden.",
    page: "Sida",
  },
}

const INTL_LOCALE: Readonly<Record<LocaleCode, string>> = {
  en: "en-GB",
  de: "de-DE",
  fr: "fr-FR",
  nl: "nl-NL",
  es: "es-ES",
  sv: "sv-SE",
}

/** Number of decimal places in each currency's minor unit. */
const MINOR_UNIT_DIGITS: Readonly<Record<CurrencyCode, number>> = {
  EUR: 2,
  USD: 2,
  GBP: 2,
  SEK: 2,
  DKK: 2,
  NOK: 2,
  CHF: 2,
  JPY: 0,
  PLN: 2,
}

const moneyFormatters = new Map<string, Intl.NumberFormat>()

const moneyFormatter = (locale: LocaleCode, currency: CurrencyCode): Intl.NumberFormat => {
  const cacheKey = `${locale}:${currency}`
  let formatter = moneyFormatters.get(cacheKey)
  if (formatter === undefined) {
    formatter = new Intl.NumberFormat(INTL_LOCALE[locale], {
      style: "currency",
      currency,
      minimumFractionDigits: MINOR_UNIT_DIGITS[currency],
      maximumFractionDigits: MINOR_UNIT_DIGITS[currency],
    })
    moneyFormatters.set(cacheKey, formatter)
  }
  return formatter
}

/** Formats an amount in minor units for display, e.g. `formatMoney(123456, "EUR", "de")` → `1.234,56 €`. */
export function formatMoney(amount: number, currency: CurrencyCode, locale: LocaleCode): string {
  if (!Number.isInteger(amount)) {
    throw new RangeError(`money amounts must be integers in minor units, got ${amount}`)
  }
  const major = amount / 10 ** MINOR_UNIT_DIGITS[currency]
  return moneyFormatter(locale, currency).format(major)
}

/** Formats a basis-point rate as a percentage with only as many decimals as needed (19 %, 5,5 %). */
export function formatRate(rateBps: number, locale: LocaleCode): string {
  return new Intl.NumberFormat(INTL_LOCALE[locale], {
    style: "percent",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(rateBps / 10_000)
}

/** Formats a calendar date in the invoice's locale. Dates are rendered in UTC so a document never shifts a day. */
export function formatDate(date: Date, locale: LocaleCode): string {
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(date)
}

const formatQuantity = (quantity: number, locale: LocaleCode): string =>
  new Intl.NumberFormat(INTL_LOCALE[locale], { maximumFractionDigits: 4 }).format(quantity)

/** Countries whose postal code is written after the city rather than before it. */
const POSTCODE_AFTER_CITY = new Set(["GB", "US", "CA", "AU", "IE"])

const COUNTRY_NAMES = new Map<string, Intl.DisplayNames>()

const countryName = (country: string, locale: LocaleCode): string => {
  let names = COUNTRY_NAMES.get(locale)
  if (names === undefined) {
    names = new Intl.DisplayNames([INTL_LOCALE[locale]], { type: "region" })
    COUNTRY_NAMES.set(locale, names)
  }
  return names.of(country) ?? country
}

/**
 * Formats a postal address as display lines following the destination country's convention. The
 * country line is omitted when seller and buyer are in the same country.
 */
export function formatAddress(address: PostalAddress, locale: LocaleCode, homeCountry?: string): ReadonlyArray<string> {
  const lines = [address.line1]
  if (address.line2) lines.push(address.line2)
  if (POSTCODE_AFTER_CITY.has(address.country)) {
    const region = address.region ? ` ${address.region}` : ""
    lines.push(`${address.city}${region} ${address.postalCode}`.trim())
  } else {
    lines.push(`${address.postalCode} ${address.city}`.trim())
    if (address.region) lines.push(address.region)
  }
  if (address.country !== homeCountry) lines.push(countryName(address.country, locale))
  return lines
}

/** Amount for one line in minor units, rounded half away from zero for fractional quantities. */
export function lineAmount(line: LineItem): number {
  const raw = line.quantity * line.unitAmount
  return Math.sign(raw) * Math.round(Math.abs(raw))
}

const isDiscount = (line: LineItem): boolean => line.kind === "discount" || line.unitAmount < 0

/**
 * Splits tax per rate. Tax is computed on the summed taxable amount of each rate rather than per
 * line, which is what EU invoicing rules expect and avoids accumulating rounding drift on invoices
 * with hundreds of usage lines.
 */
export function computeTaxLines(lines: ReadonlyArray<LineItem>, reverseCharge: boolean): ReadonlyArray<TaxLine> {
  const taxableByRate = new Map<number, number>()
  for (const line of lines) {
    const rate = reverseCharge ? 0 : line.taxRateBps
    taxableByRate.set(rate, (taxableByRate.get(rate) ?? 0) + lineAmount(line))
  }
  return [...taxableByRate.entries()]
    .sort(([a], [b]) => b - a)
    .map(([rateBps, taxableAmount]) => ({
      rateBps,
      taxableAmount,
      taxAmount: Math.sign(taxableAmount) * Math.round((Math.abs(taxableAmount) * rateBps) / 10_000),
    }))
}

/** Totals shown in the summary block. A negative `amountDue` means the customer is owed a credit. */
export function computeTotals(invoice: Invoice): InvoiceTotals {
  let subtotal = 0
  let discounts = 0
  for (const line of invoice.lines) {
    const amount = lineAmount(line)
    if (isDiscount(line)) discounts += amount
    else subtotal += amount
  }
  const taxLines = computeTaxLines(invoice.lines, invoice.reverseCharge)
  const tax = taxLines.reduce((sum, line) => sum + line.taxAmount, 0)
  const total = subtotal + discounts + tax
  return {
    subtotal,
    discounts,
    taxLines,
    tax,
    total,
    amountPaid: invoice.amountPaid,
    amountDue: total - invoice.amountPaid,
  }
}

interface LineGroup {
  readonly title: string | undefined
  readonly lines: ReadonlyArray<LineItem>
}

const KIND_ORDER: Readonly<Record<LineItemKind, number>> = {
  subscription: 0,
  proration: 1,
  usage: 2,
  one_off: 3,
  discount: 4,
}

/**
 * Groups lines by product group, keeping groups in first-seen order and sorting lines inside a group
 * by kind so subscriptions come before their prorations, usage, and discounts.
 */
export function groupLines(lines: ReadonlyArray<LineItem>): ReadonlyArray<LineGroup> {
  const groups = new Map<string, Array<LineItem>>()
  for (const line of lines) {
    const key = line.productGroup ?? ""
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [line])
    else group.push(line)
  }
  return [...groups.entries()].map(([title, grouped]) => ({
    title: title === "" ? undefined : title,
    lines: [...grouped].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]),
  }))
}

const describeLine = (line: LineItem, strings: Strings, locale: LocaleCode): ReadonlyArray<string> => {
  const parts = [line.description]
  if (line.periodStart !== undefined && line.periodEnd !== undefined) {
    parts.push(strings.period(formatDate(line.periodStart, locale), formatDate(line.periodEnd, locale)))
  }
  if (line.kind === "proration") parts.push(strings.prorationNote)
  return parts
}

const MOD97_DIGITS = /^[0-9]+$/

/** Validates an IBAN's length-independent mod-97 checksum. Spaces are ignored. */
export function isValidIban(iban: string): boolean {
  const compact = iban.replace(/\s+/g, "").toUpperCase()
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$/.test(compact)) return false
  const rearranged = compact.slice(4) + compact.slice(0, 4)
  const digits = [...rearranged].map((char) => (/[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char)).join("")
  if (!MOD97_DIGITS.test(digits)) return false
  let remainder = 0
  for (let index = 0; index < digits.length; index += 7) {
    remainder = Number(String(remainder) + digits.slice(index, index + 7)) % 97
  }
  return remainder === 1
}

/**
 * Builds the EPC069-12 ("GiroCode") payload for a SEPA credit transfer QR code. Returns `undefined`
 * when the invoice is not in euros, nothing is due, or the bank details are incomplete, since banking
 * apps reject codes that do not meet the spec.
 */
export function epcPayload(invoice: Invoice, amountDue: number): string | undefined {
  const bank = invoice.bank
  if (invoice.currency !== "EUR" || amountDue <= 0 || bank === undefined) return undefined
  if (!isValidIban(bank.iban) || amountDue > 99_999_999_999) return undefined
  const euros = (amountDue / 100).toFixed(2)
  return [
    "BCD",
    "002",
    "1",
    "SCT",
    bank.bic,
    bank.beneficiary.slice(0, 70),
    bank.iban.replace(/\s+/g, ""),
    `EUR${euros}`,
    "",
    "",
    `${invoice.number}`.slice(0, 140),
  ].join("\n")
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}

/** Escapes text for safe interpolation into HTML element content and quoted attributes. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char)
}

const partyBlock = (heading: string, party: Party, strings: Strings, locale: LocaleCode, homeCountry: string): string => {
  const lines = [party.legalName, ...formatAddress(party.address, locale, homeCountry)]
  if (party.vatId) lines.push(`${strings.vatId}: ${party.vatId}`)
  if (party.companyNumber) lines.push(party.companyNumber)
  if (party.email) lines.push(party.email)
  return [
    `<section class="party">`,
    `  <h2>${escapeHtml(heading)}</h2>`,
    ...lines.map((line) => `  <div>${escapeHtml(line)}</div>`),
    `</section>`,
  ].join("\n")
}

const metaRow = (label: string, value: string): string =>
  `<tr><th scope="row">${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`

const lineRow = (line: LineItem, invoice: Invoice, strings: Strings): string => {
  const money = (amount: number): string => formatMoney(amount, invoice.currency, invoice.locale)
  const [title, ...details] = describeLine(line, strings, invoice.locale)
  const detailHtml = details.map((detail) => `<div class="detail">${escapeHtml(detail)}</div>`).join("")
  const rate = invoice.reverseCharge ? "—" : formatRate(line.taxRateBps, invoice.locale)
  return [
    `<tr class="line line-${line.kind}">`,
    `  <td class="description"><div>${escapeHtml(title ?? "")}</div>${detailHtml}</td>`,
    `  <td class="num">${escapeHtml(formatQuantity(line.quantity, invoice.locale))}</td>`,
    `  <td class="num">${escapeHtml(money(line.unitAmount))}</td>`,
    `  <td class="num">${escapeHtml(rate)}</td>`,
    `  <td class="num">${escapeHtml(money(lineAmount(line)))}</td>`,
    `</tr>`,
  ].join("\n")
}

const linesTable = (invoice: Invoice, strings: Strings): string => {
  const header = [strings.description, strings.quantity, strings.unitPrice, strings.taxRate, strings.amount]
  const body = groupLines(invoice.lines).flatMap((group) => [
    ...(group.title === undefined ? [] : [`<tr class="group"><th colspan="5">${escapeHtml(group.title)}</th></tr>`]),
    ...group.lines.map((line) => lineRow(line, invoice, strings)),
  ])
  return [
    `<table class="lines">`,
    `  <thead><tr>${header.map((cell) => `<th>${escapeHtml(cell)}</th>`).join("")}</tr></thead>`,
    `  <tbody>`,
    ...body,
    `  </tbody>`,
    `</table>`,
  ].join("\n")
}

const totalsTable = (invoice: Invoice, totals: InvoiceTotals, strings: Strings): string => {
  const money = (amount: number): string => formatMoney(amount, invoice.currency, invoice.locale)
  const rows: Array<[string, string, string?]> = [[strings.subtotal, money(totals.subtotal)]]
  if (totals.discounts !== 0) rows.push([strings.discounts, money(totals.discounts)])
  for (const taxLine of totals.taxLines) {
    if (invoice.reverseCharge && taxLine.taxAmount === 0) continue
    rows.push([
      strings.taxOn(formatRate(taxLine.rateBps, invoice.locale), money(taxLine.taxableAmount)),
      money(taxLine.taxAmount),
    ])
  }
  rows.push([strings.total, money(totals.total), "total"])
  if (totals.amountPaid !== 0) rows.push([strings.amountPaid, money(-totals.amountPaid)])
  rows.push([strings.amountDue, money(totals.amountDue), "due"])
  return [
    `<table class="totals">`,
    ...rows.map(([label, value, className]) =>
      `  <tr${className ? ` class="${className}"` : ""}><th scope="row">${escapeHtml(label)}</th><td class="num">${escapeHtml(value)}</td></tr>`,
    ),
    `</table>`,
  ].join("\n")
}

const paymentBlock = (invoice: Invoice, totals: InvoiceTotals, strings: Strings): string => {
  if (totals.amountDue <= 0 || invoice.status === "paid") {
    return `<section class="payment paid"><p>${escapeHtml(strings.paidInFull)}</p></section>`
  }
  const parts = [`<p>${escapeHtml(strings.payBy(formatDate(invoice.dueAt, invoice.locale)))}</p>`]
  if (invoice.bank !== undefined) {
    parts.push(
      `<h3>${escapeHtml(strings.bankTransfer)}</h3>`,
      `<dl class="bank">`,
      `  <dt>IBAN</dt><dd>${escapeHtml(invoice.bank.iban)}</dd>`,
      `  <dt>BIC</dt><dd>${escapeHtml(invoice.bank.bic)}</dd>`,
      ...(invoice.bank.bankName ? [`  <dt>Bank</dt><dd>${escapeHtml(invoice.bank.bankName)}</dd>`] : []),
      `</dl>`,
    )
  }
  return [`<section class="payment">`, ...parts, `</section>`].join("\n")
}

/**
 * Renders the document body as HTML. The result is a fragment that goes inside the shell template;
 * it carries no styles of its own so the same markup works for the PDF and the email.
 */
export function renderInvoiceHtml(invoice: Invoice, totals = computeTotals(invoice)): string {
  const strings = STRINGS[invoice.locale]
  const isCredit = totals.total < 0
  const title = isCredit ? strings.creditNote : strings.invoice
  const homeCountry = invoice.seller.address.country
  const meta = [
    metaRow(strings.invoiceNumber, invoice.number),
    metaRow(strings.issued, formatDate(invoice.issuedAt, invoice.locale)),
    metaRow(strings.due, formatDate(invoice.dueAt, invoice.locale)),
    ...(invoice.purchaseOrder ? [metaRow(strings.purchaseOrder, invoice.purchaseOrder)] : []),
  ]
  const sections = [
    `<header class="invoice-header">`,
    `  <h1>${escapeHtml(title)}</h1>`,
    `  <table class="meta">${meta.join("")}</table>`,
    `</header>`,
    `<div class="parties">`,
    partyBlock(strings.from, invoice.seller, strings, invoice.locale, homeCountry),
    partyBlock(strings.billedTo, invoice.buyer, strings, invoice.locale, homeCountry),
    `</div>`,
    linesTable(invoice, strings),
    totalsTable(invoice, totals, strings),
  ]
  if (invoice.reverseCharge) sections.push(`<p class="reverse-charge">${escapeHtml(strings.reverseCharge)}</p>`)
  if (!isCredit) sections.push(paymentBlock(invoice, totals, strings))
  if (invoice.memo) sections.push(`<section class="memo"><p>${escapeHtml(invoice.memo)}</p></section>`)
  return sections.join("\n")
}

const padColumns = (rows: ReadonlyArray<readonly [string, string]>, width = 64): ReadonlyArray<string> =>
  rows.map(([label, value]) => {
    const gap = Math.max(2, width - label.length - value.length)
    return `${label}${" ".repeat(gap)}${value}`
  })

/**
 * Renders the plain-text alternative for email clients that do not show HTML. Line items are
 * summarised one per line; long descriptions are truncated to keep columns aligned.
 */
export function renderInvoiceText(invoice: Invoice, totals = computeTotals(invoice)): string {
  const strings = STRINGS[invoice.locale]
  const money = (amount: number): string => formatMoney(amount, invoice.currency, invoice.locale)
  const title = totals.total < 0 ? strings.creditNote : strings.invoice
  const out: Array<string> = [
    `${title} ${invoice.number}`,
    `${strings.issued}: ${formatDate(invoice.issuedAt, invoice.locale)}`,
    `${strings.due}: ${formatDate(invoice.dueAt, invoice.locale)}`,
    "",
    `${strings.billedTo}:`,
    invoice.buyer.legalName,
    ...formatAddress(invoice.buyer.address, invoice.locale, invoice.seller.address.country),
    "",
  ]
  for (const group of groupLines(invoice.lines)) {
    if (group.title !== undefined) out.push(group.title.toUpperCase())
    const rows = group.lines.map((line): readonly [string, string] => {
      const label = line.quantity === 1 ? line.description : `${formatQuantity(line.quantity, invoice.locale)} × ${line.description}`
      return [label.length > 48 ? `${label.slice(0, 47)}…` : label, money(lineAmount(line))]
    })
    out.push(...padColumns(rows), "")
  }
  const summary: Array<readonly [string, string]> = [[strings.subtotal, money(totals.subtotal)]]
  if (totals.discounts !== 0) summary.push([strings.discounts, money(totals.discounts)])
  for (const taxLine of totals.taxLines) {
    if (invoice.reverseCharge && taxLine.taxAmount === 0) continue
    summary.push([`${strings.taxRate} ${formatRate(taxLine.rateBps, invoice.locale)}`, money(taxLine.taxAmount)])
  }
  summary.push([strings.total, money(totals.total)])
  // summary.push([strings.amountPaid, money(-totals.amountPaid)])
  summary.push([strings.amountDue, money(totals.amountDue)])
  out.push(...padColumns(summary), "")
  if (invoice.reverseCharge) out.push(strings.reverseCharge, "")
  if (totals.amountDue > 0 && invoice.status !== "paid") {
    out.push(strings.payBy(formatDate(invoice.dueAt, invoice.locale)))
    if (invoice.bank !== undefined) out.push(`IBAN ${invoice.bank.iban} · BIC ${invoice.bank.bic}`)
  } else {
    out.push(strings.paidInFull)
  }
  return out.join("\n")
}

/**
 * Checks invariants the tax authorities care about before a document is issued. Returns a list of
 * human-readable problems; an empty list means the invoice can be finalised.
 */
export function validateInvoice(invoice: Invoice): ReadonlyArray<string> {
  const problems: Array<string> = []
  if (invoice.lines.length === 0) problems.push("invoice has no lines")
  if (invoice.dueAt < invoice.issuedAt) problems.push("due date is before the issue date")
  if (invoice.reverseCharge && !invoice.buyer.vatId) problems.push("reverse charge requires the buyer's VAT ID")
  if (invoice.reverseCharge && invoice.buyer.address.country === invoice.seller.address.country) {
    problems.push("reverse charge applies only to cross-border supplies")
  }
  if (!invoice.seller.vatId) problems.push("seller VAT ID is missing")
  for (const line of invoice.lines) {
    if (!Number.isInteger(line.unitAmount)) problems.push(`line ${line.id}: unit amount is not in minor units`)
    if (line.quantity <= 0) problems.push(`line ${line.id}: quantity must be positive`)
    if (line.taxRateBps < 0 || line.taxRateBps > 5_000) problems.push(`line ${line.id}: implausible tax rate`)
    if (line.periodStart && line.periodEnd && line.periodEnd < line.periodStart) {
      problems.push(`line ${line.id}: period ends before it starts`)
    }
  }
  if (invoice.bank !== undefined && !isValidIban(invoice.bank.iban)) problems.push("bank IBAN fails its checksum")
  return problems
}

const TEMPLATE_DIRECTORY = join(import.meta.dir, "templates")

let shellCache: Promise<{ readonly shell: string; readonly styles: string }> | undefined

const loadShell = (): Promise<{ readonly shell: string; readonly styles: string }> => {
  shellCache ??= Promise.all([
    readFile(join(TEMPLATE_DIRECTORY, "invoice-shell.html"), "utf8"),
    readFile(join(TEMPLATE_DIRECTORY, "invoice.css"), "utf8"),
  ]).then(([shell, styles]) => ({ shell, styles }))
  return shellCache
}

/**
 * Renders the full invoice: the HTML document wrapped in the shell template, the plain-text
 * alternative, and the EPC QR payload when one applies. Throws if {@link validateInvoice} finds
 * problems, so a document that cannot legally be issued is never produced.
 */
export async function renderInvoiceDocument(invoice: Invoice): Promise<RenderedInvoice> {
  const problems = validateInvoice(invoice)
  if (problems.length > 0) {
    throw new Error(`invoice ${invoice.number} cannot be rendered: ${problems.join("; ")}`)
  }
  const totals = computeTotals(invoice)
  // TODO(BILL-482): embed the seller logo as a data URI once brand assets live in the template bucket.
  const { shell, styles } = await loadShell()
  const strings = STRINGS[invoice.locale]
  const html = shell
    .replace("{{lang}}", invoice.locale)
    .replace("{{title}}", escapeHtml(`${strings.invoice} ${invoice.number}`))
    .replace("{{styles}}", styles)
    .replace("{{body}}", renderInvoiceHtml(invoice, totals))
  return {
    html,
    text: renderInvoiceText(invoice, totals),
    totals,
    epcPayload: epcPayload(invoice, totals.amountDue),
  }
}
