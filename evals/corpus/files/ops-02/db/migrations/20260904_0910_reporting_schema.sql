-- 20260904_0910_reporting_schema.sql
--
-- Creates the `reporting` schema that backs the finance dashboards and the
-- monthly board pack. Everything here is derived from the operational
-- `billing` and `accounts` schemas; nothing in `reporting` is a
-- source of truth, and every table can be rebuilt by calling the
-- reporting.rebuild_all procedure defined at the end of section 4.
--
-- Layout:
--   1. schema and date helpers
--   2. dimensions (currency, fx rates, date, customer, plan)
--   3. facts (invoice lines, payments, refunds)
--   4. refresh procedures
--   5. views used by Looker and the board pack export
--   6. grants and column comments
--
-- Amounts are stored as integer minor units in the invoice currency plus a
-- USD-normalised column computed with the daily ECB rate (reporting.fx_rates).

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

------------------------------------------------------------------------------
-- 1. Schema and date helpers
------------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS reporting;

COMMENT ON SCHEMA reporting IS
    'Derived finance reporting tables. Rebuildable from billing and accounts.';

-- Fiscal year starts on February 1st. Returns the fiscal year label, e.g. FY27
-- for any date between 2026-02-01 and 2027-01-31.
CREATE OR REPLACE FUNCTION reporting.fiscal_year(d date)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
    SELECT 'FY' || to_char(
        CASE WHEN extract(month FROM d) >= 2
             THEN d + interval '1 year'
             ELSE d
        END,
        'YY'
    );
$$;

-- Q1 is February to April, Q4 is November to January.
CREATE OR REPLACE FUNCTION reporting.fiscal_quarter(d date)
RETURNS smallint
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
    SELECT (((extract(month FROM d)::int + 10) % 12) / 3 + 1)::smallint;
$$;

------------------------------------------------------------------------------
-- 2. Dimensions
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS reporting.dim_currency (
    code            char(3)     PRIMARY KEY,
    name            text        NOT NULL,
    minor_units     smallint    NOT NULL CHECK (minor_units BETWEEN 0 AND 4),
    is_settlement   boolean     NOT NULL DEFAULT false
);

INSERT INTO reporting.dim_currency (code, name, minor_units, is_settlement) VALUES
    ('USD', 'US Dollar',          2, true),
    ('EUR', 'Euro',               2, true),
    ('GBP', 'Pound Sterling',     2, true),
    ('CAD', 'Canadian Dollar',    2, false),
    ('AUD', 'Australian Dollar',  2, false),
    ('JPY', 'Japanese Yen',       0, false),
    ('CHF', 'Swiss Franc',        2, false),
    ('SEK', 'Swedish Krona',      2, false),
    ('BRL', 'Brazilian Real',     2, false),
    ('INR', 'Indian Rupee',       2, false)
ON CONFLICT (code) DO UPDATE
    SET name = EXCLUDED.name,
        minor_units = EXCLUDED.minor_units,
        is_settlement = EXCLUDED.is_settlement;

CREATE TABLE IF NOT EXISTS reporting.fx_rates (
    rate_date       date            NOT NULL,
    currency        char(3)         NOT NULL REFERENCES reporting.dim_currency (code),
    usd_per_unit    numeric(18, 8)  NOT NULL CHECK (usd_per_unit > 0),
    source          text            NOT NULL DEFAULT 'ecb',
    loaded_at       timestamptz     NOT NULL DEFAULT now(),
    PRIMARY KEY (currency, rate_date)
);

-- Converts minor units in `currency` to USD cents using the rate on `on_date`,
-- falling back to the most recent earlier rate (weekends, bank holidays).
-- Returns NULL when no rate exists on or before the date, so a missing rate
-- surfaces as a gap in the dashboards instead of a silent zero.
CREATE OR REPLACE FUNCTION reporting.to_usd_cents(amount bigint, currency char(3), on_date date)
RETURNS bigint
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
    SELECT CASE
        WHEN c.code = 'USD' THEN amount
        ELSE round(
            amount * 100 / power(10, c.minor_units) * (
                SELECT r.usd_per_unit
                FROM reporting.fx_rates r
                WHERE r.currency = c.code
                  AND r.rate_date <= on_date
                ORDER BY r.rate_date DESC
                LIMIT 1
            )
        )::bigint
    END
    FROM reporting.dim_currency c
    WHERE c.code = to_usd_cents.currency;
$$;

CREATE TABLE IF NOT EXISTS reporting.dim_date (
    date_key        date        PRIMARY KEY,
    year            smallint    NOT NULL,
    month           smallint    NOT NULL,
    day_of_month    smallint    NOT NULL,
    day_of_week     smallint    NOT NULL,
    iso_week        smallint    NOT NULL,
    month_start     date        NOT NULL,
    month_end       date        NOT NULL,
    fiscal_year     text        NOT NULL,
    fiscal_quarter  smallint    NOT NULL,
    is_weekend      boolean     NOT NULL,
    is_month_end    boolean     NOT NULL
);

CREATE INDEX IF NOT EXISTS dim_date_month_start_idx
    ON reporting.dim_date (month_start);

-- Slowly changing (type 2): one row per account per period in which the
-- reported attributes were stable. Exactly one current row per account.
CREATE TABLE IF NOT EXISTS reporting.dim_customer (
    customer_key        bigserial   PRIMARY KEY,
    account_id          uuid        NOT NULL,
    legal_name          text        NOT NULL,
    billing_country     char(2),
    segment             text        NOT NULL CHECK (segment IN ('self_serve', 'mid_market', 'enterprise')),
    sales_owner_email   text,
    first_paid_at       timestamptz,
    churned_at          timestamptz,
    valid_from          timestamptz NOT NULL,
    valid_to            timestamptz,
    is_current          boolean     NOT NULL DEFAULT true,
    CHECK (valid_to IS NULL OR valid_to > valid_from),
    CHECK (is_current = (valid_to IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS dim_customer_current_uidx
    ON reporting.dim_customer (account_id)
    WHERE is_current;

CREATE INDEX IF NOT EXISTS dim_customer_account_validity_idx
    ON reporting.dim_customer (account_id, valid_from, valid_to);

CREATE TABLE IF NOT EXISTS reporting.dim_plan (
    plan_key            serial      PRIMARY KEY,
    plan_id             uuid        NOT NULL UNIQUE,
    plan_code           text        NOT NULL,
    display_name        text        NOT NULL,
    product_line        text        NOT NULL,
    billing_interval    text        NOT NULL CHECK (billing_interval IN ('month', 'year')),
    list_price_minor    bigint      NOT NULL,
    currency            char(3)     NOT NULL REFERENCES reporting.dim_currency (code),
    is_legacy           boolean     NOT NULL DEFAULT false
);

------------------------------------------------------------------------------
-- 3. Facts
------------------------------------------------------------------------------

-- Partitioned by issue month; the refresh procedure only ever rewrites a
-- bounded date range, which maps onto a handful of partitions.
CREATE TABLE IF NOT EXISTS reporting.fact_invoice_lines (
    issued_on           date            NOT NULL,
    invoice_line_id     uuid            NOT NULL,
    invoice_id          uuid            NOT NULL,
    customer_key        bigint          NOT NULL,
    plan_key            integer,
    service_start       date            NOT NULL,
    service_end         date            NOT NULL,
    line_type           text            NOT NULL CHECK (line_type IN ('subscription', 'usage', 'one_time', 'credit', 'tax')),
    quantity            numeric(14, 4)  NOT NULL DEFAULT 1,
    currency            char(3)         NOT NULL,
    amount_minor        bigint          NOT NULL,
    amount_usd_cents    bigint,
    is_recurring        boolean         NOT NULL,
    PRIMARY KEY (issued_on, invoice_line_id),
    CHECK (service_end >= service_start)
) PARTITION BY RANGE (issued_on);

DO $$
DECLARE
    month_start date;
BEGIN
    FOR month_start IN
        SELECT generate_series(date '2022-01-01', date '2027-12-01', interval '1 month')::date
    LOOP
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS reporting.%I PARTITION OF reporting.fact_invoice_lines
                 FOR VALUES FROM (%L) TO (%L)',
            'fact_invoice_lines_' || to_char(month_start, 'YYYY_MM'),
            month_start,
            (month_start + interval '1 month')::date
        );
    END LOOP;
END;
$$;

CREATE TABLE IF NOT EXISTS reporting.fact_invoice_lines_default
    PARTITION OF reporting.fact_invoice_lines DEFAULT;

CREATE INDEX IF NOT EXISTS fact_invoice_lines_customer_idx
    ON reporting.fact_invoice_lines (customer_key, issued_on);

CREATE INDEX IF NOT EXISTS fact_invoice_lines_service_idx
    ON reporting.fact_invoice_lines (service_start, service_end)
    WHERE is_recurring;

CREATE TABLE IF NOT EXISTS reporting.fact_payments (
    payment_id          uuid        PRIMARY KEY,
    invoice_id          uuid,
    customer_key        bigint      NOT NULL REFERENCES reporting.dim_customer (customer_key),
    attempted_on        date        NOT NULL,
    attempted_at        timestamptz NOT NULL,
    status              text        NOT NULL CHECK (status IN ('succeeded', 'failed', 'pending', 'canceled')),
    method              text        NOT NULL,
    card_brand          text,
    card_last4          char(4),
    failure_code        text,
    failure_message     text,
    attempt_number      smallint    NOT NULL DEFAULT 1,
    currency            char(3)     NOT NULL,
    amount_minor        bigint      NOT NULL,
    amount_usd_cents    bigint,
    processor           text        NOT NULL DEFAULT 'stripe',
    processor_ref       text
);

CREATE INDEX IF NOT EXISTS fact_payments_attempted_on_idx
    ON reporting.fact_payments (attempted_on, status);

CREATE INDEX IF NOT EXISTS fact_payments_customer_idx
    ON reporting.fact_payments (customer_key, attempted_at DESC);

CREATE TABLE IF NOT EXISTS reporting.fact_refunds (
    refund_id           uuid        PRIMARY KEY,
    payment_id          uuid        NOT NULL REFERENCES reporting.fact_payments (payment_id),
    customer_key        bigint      NOT NULL REFERENCES reporting.dim_customer (customer_key),
    refunded_on         date        NOT NULL,
    reason              text        NOT NULL,
    currency            char(3)     NOT NULL,
    amount_minor        bigint      NOT NULL CHECK (amount_minor > 0),
    amount_usd_cents    bigint
);

------------------------------------------------------------------------------
-- 4. Refresh procedures
------------------------------------------------------------------------------

CREATE OR REPLACE PROCEDURE reporting.refresh_dim_date(p_start date, p_end date)
LANGUAGE sql
AS $$
    INSERT INTO reporting.dim_date (
        date_key, year, month, day_of_month, day_of_week, iso_week,
        month_start, month_end, fiscal_year, fiscal_quarter, is_weekend, is_month_end
    )
    SELECT
        g.d::date,
        extract(year FROM g.d)::smallint,
        extract(month FROM g.d)::smallint,
        extract(day FROM g.d)::smallint,
        extract(isodow FROM g.d)::smallint,
        extract(week FROM g.d)::smallint,
        date_trunc('month', g.d)::date,
        (date_trunc('month', g.d) + interval '1 month - 1 day')::date,
        reporting.fiscal_year(g.d::date),
        reporting.fiscal_quarter(g.d::date),
        extract(isodow FROM g.d) IN (6, 7),
        g.d::date = (date_trunc('month', g.d) + interval '1 month - 1 day')::date
    FROM generate_series(p_start, p_end, interval '1 day') AS g(d)
    ON CONFLICT (date_key) DO NOTHING;
$$;

CREATE OR REPLACE PROCEDURE reporting.refresh_dim_customer()
LANGUAGE plpgsql
AS $$
DECLARE
    v_now    timestamptz := clock_timestamp();
    v_closed integer;
    v_opened integer;
BEGIN
    -- Close the current row for accounts whose reported attributes moved.
    UPDATE reporting.dim_customer dc
    SET valid_to = v_now,
        is_current = false
    FROM accounts.accounts a
    LEFT JOIN accounts.account_owners o
           ON o.account_id = a.id
          AND o.role = 'sales'
    WHERE dc.account_id = a.id
      AND dc.is_current
      AND (
          dc.legal_name IS DISTINCT FROM a.legal_name
          OR dc.billing_country IS DISTINCT FROM a.billing_country
          OR dc.segment IS DISTINCT FROM a.segment
          OR dc.sales_owner_email IS DISTINCT FROM o.email
          OR dc.churned_at IS DISTINCT FROM a.churned_at
      );
    GET DIAGNOSTICS v_closed = ROW_COUNT;

    -- Open a new current row for every account without one: brand new
    -- accounts start at their creation time, changed accounts continue from
    -- the moment their previous row was closed.
    INSERT INTO reporting.dim_customer (
        account_id, legal_name, billing_country, segment, sales_owner_email,
        first_paid_at, churned_at, valid_from, valid_to, is_current
    )
    SELECT
        a.id,
        a.legal_name,
        a.billing_country,
        a.segment,
        o.email,
        fp.first_paid_at,
        a.churned_at,
        coalesce(prev.closed_at, a.created_at),
        NULL,
        true
    FROM accounts.accounts a
    LEFT JOIN accounts.account_owners o
           ON o.account_id = a.id
          AND o.role = 'sales'
    LEFT JOIN LATERAL (
        SELECT min(p.succeeded_at) AS first_paid_at
        FROM billing.payments p
        WHERE p.account_id = a.id
          AND p.status = 'succeeded'
    ) fp ON true
    LEFT JOIN LATERAL (
        SELECT max(h.valid_to) AS closed_at
        FROM reporting.dim_customer h
        WHERE h.account_id = a.id
    ) prev ON true
    WHERE NOT EXISTS (
        SELECT *
        FROM reporting.dim_customer dc
        WHERE dc.account_id = a.id
          AND dc.is_current
    );
    GET DIAGNOSTICS v_opened = ROW_COUNT;

    RAISE NOTICE 'dim_customer: closed % rows, opened % rows', v_closed, v_opened;
END;
$$;

CREATE OR REPLACE PROCEDURE reporting.refresh_dim_plan()
LANGUAGE sql
AS $$
    INSERT INTO reporting.dim_plan (
        plan_id, plan_code, display_name, product_line, billing_interval,
        list_price_minor, currency, is_legacy
    )
    SELECT
        p.id,
        p.code,
        p.display_name,
        p.product_line,
        p.billing_interval,
        p.unit_amount_minor,
        p.currency,
        p.archived_at IS NOT NULL
    FROM billing.plans p
    ON CONFLICT (plan_id) DO UPDATE
        SET plan_code = EXCLUDED.plan_code,
            display_name = EXCLUDED.display_name,
            product_line = EXCLUDED.product_line,
            billing_interval = EXCLUDED.billing_interval,
            list_price_minor = EXCLUDED.list_price_minor,
            currency = EXCLUDED.currency,
            is_legacy = EXCLUDED.is_legacy;
$$;

-- Invoice lines are matched to the customer row that was valid when the
-- invoice was issued, so a segment change does not rewrite past revenue.
CREATE OR REPLACE PROCEDURE reporting.refresh_fact_invoice_lines(p_start date, p_end date)
LANGUAGE plpgsql
AS $$
BEGIN
    DELETE FROM reporting.fact_invoice_lines
    WHERE issued_on BETWEEN p_start AND p_end;

    INSERT INTO reporting.fact_invoice_lines (
        issued_on, invoice_line_id, invoice_id, customer_key, plan_key,
        service_start, service_end, line_type, quantity, currency,
        amount_minor, amount_usd_cents, is_recurring
    )
    SELECT
        i.issued_at::date,
        l.id,
        i.id,
        dc.customer_key,
        dp.plan_key,
        l.period_start::date,
        l.period_end::date,
        l.kind,
        l.quantity,
        i.currency,
        l.amount_minor,
        reporting.to_usd_cents(l.amount_minor, i.currency, i.issued_at::date),
        l.kind IN ('subscription', 'usage')
    FROM billing.invoice_lines l
    JOIN billing.invoices i ON i.id = l.invoice_id
    JOIN reporting.dim_customer dc
      ON dc.account_id = i.account_id
     AND i.issued_at >= dc.valid_from
     AND (dc.valid_to IS NULL OR i.issued_at < dc.valid_to)
    LEFT JOIN reporting.dim_plan dp ON dp.plan_id = l.plan_id
    WHERE i.status IN ('open', 'paid', 'uncollectible')
      AND i.issued_at::date BETWEEN p_start AND p_end;
END;
$$;

CREATE OR REPLACE PROCEDURE reporting.refresh_fact_payments(p_start date, p_end date)
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO reporting.fact_payments (
        payment_id, invoice_id, customer_key, attempted_on, attempted_at,
        status, method, card_brand, card_last4, failure_code, failure_message,
        attempt_number, currency, amount_minor, amount_usd_cents, processor,
        processor_ref
    )
    SELECT
        p.id,
        p.invoice_id,
        dc.customer_key,
        p.attempted_at::date,
        p.attempted_at,
        p.status,
        p.method,
        p.card_brand,
        p.card_last4,
        p.failure_code,
        p.failure_message,
        p.attempt_number,
        p.currency,
        p.amount_minor,
        reporting.to_usd_cents(p.amount_minor, p.currency, p.attempted_at::date),
        p.processor,
        p.processor_ref
    FROM billing.payments p
    JOIN reporting.dim_customer dc
      ON dc.account_id = p.account_id
     AND p.attempted_at >= dc.valid_from
     AND (dc.valid_to IS NULL OR p.attempted_at < dc.valid_to)
    WHERE p.attempted_at::date BETWEEN p_start AND p_end
    ON CONFLICT (payment_id) DO UPDATE
        SET status = EXCLUDED.status,
            failure_code = EXCLUDED.failure_code,
            failure_message = EXCLUDED.failure_message,
            amount_usd_cents = EXCLUDED.amount_usd_cents;

    INSERT INTO reporting.fact_refunds (
        refund_id, payment_id, customer_key, refunded_on, reason, currency,
        amount_minor, amount_usd_cents
    )
    SELECT
        r.id,
        r.payment_id,
        fp.customer_key,
        r.created_at::date,
        r.reason,
        r.currency,
        r.amount_minor,
        reporting.to_usd_cents(r.amount_minor, r.currency, r.created_at::date)
    FROM billing.refunds r
    JOIN reporting.fact_payments fp ON fp.payment_id = r.payment_id
    WHERE r.created_at::date BETWEEN p_start AND p_end
      AND r.status = 'succeeded'
    ON CONFLICT (refund_id) DO NOTHING;
END;
$$;

CREATE OR REPLACE PROCEDURE reporting.rebuild_all(p_start date, p_end date)
LANGUAGE plpgsql
AS $$
BEGIN
    CALL reporting.refresh_dim_date(p_start, p_end + 400);
    CALL reporting.refresh_dim_plan();
    CALL reporting.refresh_dim_customer();
    CALL reporting.refresh_fact_invoice_lines(p_start, p_end);
    CALL reporting.refresh_fact_payments(p_start, p_end);
    REFRESH MATERIALIZED VIEW reporting.mv_board_pack_kpis;
END;
$$;

------------------------------------------------------------------------------
-- 5. Views
------------------------------------------------------------------------------

-- Monthly recurring revenue per account and month. A recurring line
-- contributes to every month its service period overlaps, pro rata by days,
-- which normalises annual plans to a monthly amount.
CREATE OR REPLACE VIEW reporting.v_mrr_monthly AS
WITH months AS (
    SELECT DISTINCT month_start, month_end
    FROM reporting.dim_date
),
recurring AS (
    SELECT
        f.customer_key,
        f.service_start,
        f.service_end,
        f.amount_usd_cents,
        (f.service_end - f.service_start + 1) AS service_days
    FROM reporting.fact_invoice_lines f
    WHERE f.is_recurring
      AND f.line_type = 'subscription'
      AND f.amount_usd_cents IS NOT NULL
)
SELECT
    m.month_start,
    dc.account_id,
    dc.segment,
    round(sum(
        r.amount_usd_cents::numeric
        * (least(r.service_end, m.month_end) - greatest(r.service_start, m.month_start) + 1)
        / r.service_days
    ))::bigint AS mrr_usd_cents
FROM recurring r
JOIN months m
  ON r.service_start <= m.month_end
 AND r.service_end >= m.month_start
JOIN reporting.dim_customer dc ON dc.customer_key = r.customer_key
GROUP BY m.month_start, dc.account_id, dc.segment;

-- Month-over-month MRR bridge: new, reactivation, expansion, contraction and
-- churn. An account is "reactivated" when it paid at some point before the
-- previous month, paid nothing last month, and pays again this month.
CREATE OR REPLACE VIEW reporting.v_mrr_movements AS
WITH by_account AS (
    SELECT
        month_start,
        account_id,
        sum(mrr_usd_cents) AS mrr
    FROM reporting.v_mrr_monthly
    GROUP BY month_start, account_id
),
-- Add a zero row for the month after an account's last revenue month so
-- churn shows up as a movement.
spine AS (
    SELECT b.month_start, b.account_id, b.mrr
    FROM by_account b
    UNION ALL
    SELECT (b.month_start + interval '1 month')::date, b.account_id, 0
    FROM by_account b
    WHERE NOT EXISTS (
        SELECT *
        FROM by_account nxt
        WHERE nxt.account_id = b.account_id
          AND nxt.month_start = (b.month_start + interval '1 month')::date
    )
),
with_prev AS (
    SELECT
        month_start,
        account_id,
        mrr,
        lag(mrr) OVER w AS prev_mrr,
        bool_or(mrr > 0) OVER (
            PARTITION BY account_id
            ORDER BY month_start
            ROWS BETWEEN UNBOUNDED PRECEDING AND 2 PRECEDING
        ) AS paid_before
    FROM spine
    WINDOW w AS (PARTITION BY account_id ORDER BY month_start)
)
SELECT
    month_start,
    sum(CASE WHEN coalesce(prev_mrr, 0) = 0 AND mrr > 0 AND NOT coalesce(paid_before, false) THEN mrr ELSE 0 END) AS new_mrr,
    sum(CASE WHEN coalesce(prev_mrr, 0) = 0 AND mrr > 0 AND paid_before THEN mrr ELSE 0 END) AS reactivation_mrr,
    sum(CASE WHEN prev_mrr > 0 AND mrr > prev_mrr THEN mrr - prev_mrr ELSE 0 END) AS expansion_mrr,
    sum(CASE WHEN prev_mrr > 0 AND mrr > 0 AND mrr < prev_mrr THEN mrr - prev_mrr ELSE 0 END) AS contraction_mrr,
    sum(CASE WHEN prev_mrr > 0 AND mrr = 0 THEN -prev_mrr ELSE 0 END) AS churned_mrr,
    sum(mrr) AS ending_mrr,
    count(*) FILTER (WHERE mrr > 0) AS paying_accounts
FROM with_prev
GROUP BY month_start;

-- Open receivables bucketed by days past due, at the current customer row.
CREATE OR REPLACE VIEW reporting.v_ar_aging AS
SELECT
    dc.account_id,
    dc.legal_name,
    dc.segment,
    dc.sales_owner_email,
    i.id AS invoice_id,
    i.number AS invoice_number,
    i.currency,
    i.due_at::date AS due_on,
    greatest(current_date - i.due_at::date, 0) AS days_past_due,
    i.amount_due_minor - i.amount_paid_minor AS open_minor,
    reporting.to_usd_cents(i.amount_due_minor - i.amount_paid_minor, i.currency, current_date) AS open_usd_cents,
    CASE
        WHEN current_date <= i.due_at::date THEN 'current'
        WHEN current_date - i.due_at::date <= 30 THEN '1-30'
        WHEN current_date - i.due_at::date <= 60 THEN '31-60'
        WHEN current_date - i.due_at::date <= 90 THEN '61-90'
        ELSE '90+'
    END AS aging_bucket
FROM billing.invoices i
JOIN reporting.dim_customer dc
  ON dc.account_id = i.account_id
 AND dc.is_current
WHERE i.status = 'open'
  AND i.amount_due_minor > i.amount_paid_minor;

-- Failed collection attempts in the last 90 days with the customer they
-- belong to. Used by the collections team's daily review in Looker.
CREATE OR REPLACE VIEW reporting.v_payment_failures AS
SELECT
    p.*,
    dc.legal_name,
    dc.segment,
    dc.sales_owner_email
FROM reporting.fact_payments p
JOIN reporting.dim_customer dc ON dc.customer_key = p.customer_key
WHERE p.status = 'failed'
  AND p.attempted_on >= current_date - 90;

-- Collection success rate by month and card brand. Retries of the same
-- invoice count as separate attempts; the first-attempt rate is reported
-- separately because smart retries inflate the overall number.
CREATE OR REPLACE VIEW reporting.v_collection_rates AS
SELECT
    date_trunc('month', p.attempted_on)::date AS month_start,
    coalesce(p.card_brand, p.method) AS instrument,
    count(*) AS attempts,
    count(*) FILTER (WHERE p.status = 'succeeded') AS succeeded,
    count(*) FILTER (WHERE p.attempt_number = 1) AS first_attempts,
    count(*) FILTER (WHERE p.attempt_number = 1 AND p.status = 'succeeded') AS first_attempt_succeeded,
    round(100.0 * count(*) FILTER (WHERE p.status = 'succeeded') / nullif(count(*), 0), 2) AS success_pct,
    round(
        100.0 * count(*) FILTER (WHERE p.attempt_number = 1 AND p.status = 'succeeded')
        / nullif(count(*) FILTER (WHERE p.attempt_number = 1), 0),
        2
    ) AS first_attempt_success_pct
FROM reporting.fact_payments p
WHERE p.status IN ('succeeded', 'failed')
GROUP BY 1, 2;

-- Trailing twelve-month net revenue retention per segment: MRR today from the
-- accounts that were paying twelve months ago, divided by their MRR then.
CREATE OR REPLACE VIEW reporting.v_net_revenue_retention AS
WITH base AS (
    SELECT
        m.month_start,
        m.account_id,
        m.segment,
        sum(m.mrr_usd_cents) AS mrr
    FROM reporting.v_mrr_monthly m
    GROUP BY m.month_start, m.account_id, m.segment
)
SELECT
    cur.month_start,
    prior.segment,
    count(DISTINCT prior.account_id) AS cohort_accounts,
    sum(prior.mrr) AS cohort_mrr_12m_ago,
    sum(coalesce(cur.mrr, 0)) AS cohort_mrr_now,
    round(100.0 * sum(coalesce(cur.mrr, 0)) / nullif(sum(prior.mrr), 0), 1) AS nrr_pct
FROM base prior
LEFT JOIN base cur
  ON cur.account_id = prior.account_id
 AND cur.month_start = (prior.month_start + interval '12 months')::date
WHERE prior.mrr > 0
  AND cur.month_start IS NOT NULL
GROUP BY cur.month_start, prior.segment;

-- Board pack KPIs, one row per month. Materialized because the board export
-- runs it for every month since 2022 and the MRR bridge is expensive.
CREATE MATERIALIZED VIEW IF NOT EXISTS reporting.mv_board_pack_kpis AS
SELECT
    mv.month_start,
    reporting.fiscal_year(mv.month_start) AS fiscal_year,
    reporting.fiscal_quarter(mv.month_start) AS fiscal_quarter,
    mv.ending_mrr,
    mv.ending_mrr * 12 AS ending_arr,
    mv.new_mrr,
    mv.reactivation_mrr,
    mv.expansion_mrr,
    mv.contraction_mrr,
    mv.churned_mrr,
    mv.paying_accounts,
    coalesce(rf.refunded_usd_cents, 0) AS refunded_usd_cents,
    coalesce(cr.success_pct, 0) AS collection_success_pct
FROM reporting.v_mrr_movements mv
LEFT JOIN (
    SELECT
        date_trunc('month', refunded_on)::date AS month_start,
        sum(amount_usd_cents) AS refunded_usd_cents
    FROM reporting.fact_refunds
    GROUP BY 1
) rf ON rf.month_start = mv.month_start
LEFT JOIN (
    SELECT
        month_start,
        round(100.0 * sum(succeeded) / nullif(sum(attempts), 0), 2) AS success_pct
    FROM reporting.v_collection_rates
    GROUP BY month_start
) cr ON cr.month_start = mv.month_start
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS mv_board_pack_kpis_month_uidx
    ON reporting.mv_board_pack_kpis (month_start);

------------------------------------------------------------------------------
-- 6. Grants and comments
------------------------------------------------------------------------------

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reporting_reader') THEN
        CREATE ROLE reporting_reader NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reporting_refresher') THEN
        CREATE ROLE reporting_refresher NOLOGIN;
    END IF;
END;
$$;

GRANT USAGE ON SCHEMA reporting TO reporting_reader, reporting_refresher;
GRANT SELECT ON ALL TABLES IN SCHEMA reporting TO reporting_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA reporting
    GRANT SELECT ON TABLES TO reporting_reader;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA reporting TO reporting_refresher;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA reporting TO reporting_refresher;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA reporting TO reporting_reader, reporting_refresher;
GRANT EXECUTE ON ALL PROCEDURES IN SCHEMA reporting TO reporting_refresher;
GRANT USAGE ON SCHEMA billing, accounts TO reporting_refresher;
GRANT SELECT ON ALL TABLES IN SCHEMA billing, accounts TO reporting_refresher;

-- The materialized view must be owned by the refresher so the nightly job can
-- refresh it without superuser rights.
ALTER MATERIALIZED VIEW reporting.mv_board_pack_kpis OWNER TO reporting_refresher;

COMMENT ON TABLE reporting.dim_customer IS
    'Type 2 customer dimension; join facts on customer_key, filter is_current for "as of now" views.';
COMMENT ON COLUMN reporting.dim_customer.segment IS
    'Sales segment at the time the row was valid; changes open a new row.';
COMMENT ON COLUMN reporting.dim_customer.first_paid_at IS
    'First successful payment across all invoices; NULL for accounts that never paid.';
COMMENT ON TABLE reporting.fact_invoice_lines IS
    'One row per invoice line, partitioned by issue month. Credits are negative amounts.';
COMMENT ON COLUMN reporting.fact_invoice_lines.amount_usd_cents IS
    'Converted at the ECB rate on the issue date; NULL when no rate was available.';
COMMENT ON COLUMN reporting.fact_invoice_lines.is_recurring IS
    'True for subscription and usage lines; drives MRR.';
COMMENT ON TABLE reporting.fact_payments IS
    'Every collection attempt, including failed retries. Refunds live in fact_refunds.';
COMMENT ON COLUMN reporting.fact_payments.attempt_number IS
    'Retry counter from the processor; 1 is the first attempt for the invoice.';
COMMENT ON VIEW reporting.v_mrr_monthly IS
    'MRR per account and month, pro rata by service days.';
COMMENT ON VIEW reporting.v_mrr_movements IS
    'MRR bridge per month: new, reactivation, expansion, contraction, churn.';
COMMENT ON VIEW reporting.v_ar_aging IS
    'Open receivables by aging bucket at the current customer row.';
COMMENT ON VIEW reporting.v_payment_failures IS
    'Failed payment attempts in the trailing 90 days with customer attributes.';
COMMENT ON VIEW reporting.v_net_revenue_retention IS
    'Trailing twelve-month NRR by segment.';
COMMENT ON MATERIALIZED VIEW reporting.mv_board_pack_kpis IS
    'Monthly KPIs for the board pack; refreshed by reporting.rebuild_all.';

COMMIT;
