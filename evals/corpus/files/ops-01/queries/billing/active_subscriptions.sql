-- Active subscriptions with their current plan, seat usage and most recent
-- invoice. Used by the billing dashboard "Accounts" tab and by the dunning job
-- to decide which past-due accounts still get a grace period.
--
-- Parameters:
--   :as_of        timestamp the report is evaluated at (usually now())
--   :workspace_id restricts to one workspace, or NULL for all workspaces

WITH latest_invoice AS (
    SELECT DISTINCT ON (i.subscription_id)
        i.subscription_id,
        i.id                AS invoice_id,
        i.status            AS invoice_status,
        i.amount_due_cents,
        i.amount_paid_cents,
        i.due_at
    FROM invoices i
    WHERE i.created_at <= :as_of
    ORDER BY i.subscription_id, i.created_at DESC
),
seat_usage AS (
    SELECT
        m.subscription_id,
        COUNT(*) AS seats_used
    FROM subscription_members m
    WHERE m.removed_at IS NULL
    GROUP BY m.subscription_id
)
SELECT
    s.*,
    p.name                      AS plan_name,
    p.billing_interval,
    p.unit_amount_cents,
    COALESCE(u.seats_used, 0)   AS seats_used,
    li.invoice_id,
    li.invoice_status,
    li.amount_due_cents - li.amount_paid_cents AS outstanding_cents,
    li.due_at
FROM subscriptions s
JOIN plans p ON p.id = s.plan_id
LEFT JOIN seat_usage u ON u.subscription_id = s.id
LEFT JOIN latest_invoice li ON li.subscription_id = s.id
WHERE s.status IN ('active', 'past_due', 'trialing')
  AND s.current_period_end > :as_of
  -- A converted trial keeps its trialing row next to the paid one; only count the paid row.
  AND NOT (s.status = 'trialing' AND s.converted_at IS NOT NULL)
  AND (:workspace_id IS NULL OR s.workspace_id = :workspace_id)
  -- TODO(BILL-412): drop the 14-day past-due grace window once dunning moves to Stripe Billing.
  AND (s.status <> 'past_due' OR li.due_at > :as_of - INTERVAL '14 days')
ORDER BY s.workspace_id, s.created_at;
