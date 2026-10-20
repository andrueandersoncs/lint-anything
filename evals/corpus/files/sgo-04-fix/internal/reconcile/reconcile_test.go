package reconcile_test

import (
	"strings"
	"testing"
	"time"

	"example.com/books/internal/reconcile"
)

// settlementWindow mirrors the production setting: card payouts land up to
// two days after the ledger records the sale.
const settlementWindow = 48 * time.Hour

const statementHeader = "date,amount,memo\n"

func day(t *testing.T, s string) time.Time {
	t.Helper()
	d, err := time.Parse(time.DateOnly, s)
	if err != nil {
		t.Fatalf("parse date %q: %v", s, err)
	}
	return d
}

func load(t *testing.T, csvRows string) []reconcile.BankLine {
	t.Helper()
	lines, err := reconcile.ParseStatement(strings.NewReader(statementHeader + csvRows))
	if err != nil {
		t.Fatalf("parse statement: %v", err)
	}
	return lines
}

func TestReconcilePairsLineWithEntryOfSameAmountAndDate(t *testing.T) {
	statement := load(t, "2026-03-02,125.00,ACME PAYOUT\n")
	entries := []reconcile.LedgerEntry{
		{ID: "inv-1001", Date: day(t, "2026-03-02"), AmountCents: 12500},
	}

	report := reconcile.Reconcile(statement, entries, settlementWindow)

	if len(report.Matched) != 1 {
		t.Fatalf("matched %d pairs, want 1", len(report.Matched))
	}
	if got := report.Matched[0].Entry.ID; got != "inv-1001" {
		t.Errorf("matched entry %q, want inv-1001", got)
	}
	if len(report.UnmatchedBank) != 0 || len(report.UnmatchedLedger) != 0 {
		t.Errorf("unexpected leftovers: bank %v, ledger %v", report.UnmatchedBank, report.UnmatchedLedger)
	}
}

func TestReconcileAcceptsPayoutWithinSettlementWindow(t *testing.T) {
	statement := load(t, "2026-03-04,40.10,CARD SETTLEMENT\n")
	entries := []reconcile.LedgerEntry{
		{ID: "inv-1002", Date: day(t, "2026-03-02"), AmountCents: 4010},
	}

	report := reconcile.Reconcile(statement, entries, settlementWindow)

	if len(report.Matched) != 1 {
		t.Errorf("matched %d pairs, want 1 for a payout two days after the sale", len(report.Matched))
	}
}

func TestReconcileLeavesPayoutOutsideWindowUnmatched(t *testing.T) {
	statement := load(t, "2026-03-06,40.10,CARD SETTLEMENT\n")
	entries := []reconcile.LedgerEntry{
		{ID: "inv-1002", Date: day(t, "2026-03-02"), AmountCents: 4010},
	}

	report := reconcile.Reconcile(statement, entries, settlementWindow)

	if len(report.Matched) != 0 {
		t.Errorf("matched %d pairs, want none for a payout four days after the sale", len(report.Matched))
	}
	if len(report.UnmatchedBank) != 1 || len(report.UnmatchedLedger) != 1 {
		t.Errorf("leftovers: bank %d, ledger %d; want 1 and 1", len(report.UnmatchedBank), len(report.UnmatchedLedger))
	}
}

func TestReconcileMatchesEachEntryAtMostOnce(t *testing.T) {
	statement := load(t, "2026-03-02,19.99,REFUND REVERSAL\n2026-03-02,19.99,REFUND REVERSAL\n")
	entries := []reconcile.LedgerEntry{
		{ID: "inv-1003", Date: day(t, "2026-03-02"), AmountCents: 1999},
	}

	report := reconcile.Reconcile(statement, entries, settlementWindow)

	if len(report.Matched) != 1 {
		t.Fatalf("matched %d pairs, want 1", len(report.Matched))
	}
	if len(report.UnmatchedBank) != 1 {
		t.Fatalf("unmatched bank lines %d, want the duplicate left over", len(report.UnmatchedBank))
	}
	if leftover := report.UnmatchedBank[0]; leftover.AmountCents != 1999 || leftover.Memo != "REFUND REVERSAL" {
		t.Errorf("leftover line %+v, want the 19.99 refund reversal", leftover)
	}
}

func TestReconcilePrefersEntryClosestInDate(t *testing.T) {
	statement := load(t, "2026-03-03,75.00,ACME PAYOUT\n")
	entries := []reconcile.LedgerEntry{
		{ID: "inv-1004", Date: day(t, "2026-03-01"), AmountCents: 7500},
		{ID: "inv-1005", Date: day(t, "2026-03-03"), AmountCents: 7500},
	}

	report := reconcile.Reconcile(statement, entries, settlementWindow)

	if len(report.Matched) != 1 {
		t.Fatalf("matched %d pairs, want 1", len(report.Matched))
	}
	if got := report.Matched[0].Entry.ID; got != "inv-1005" {
		t.Errorf("matched entry %q, want the same-day inv-1005", got)
	}
}

func TestParseStatementRejectsAmountWithoutCents(t *testing.T) {
	_, err := reconcile.ParseStatement(strings.NewReader(statementHeader + "2026-03-02,125,ACME PAYOUT\n"))
	if err == nil {
		t.Fatal("ParseStatement accepted an amount without a decimal part")
	}
}
