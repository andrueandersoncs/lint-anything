-- Weekly signup cohorts and the share of each cohort still active N weeks
-- later. Feeds the "Retention" chart in the growth Looker model and is
-- materialized nightly into analytics.weekly_retention.

WITH signups AS (
    SELECT
        u.id AS user_id,
        DATE_TRUNC('week', u.created_at) AS cohort_week
    FROM app.users u
    WHERE u.created_at >= DATE '2025-01-06'
      AND u.is_internal = FALSE
      -- Users who never verified their email cannot sign in, so they never had
      -- a chance to be retained.
      AND EXISTS (
          SELECT *
          FROM app.email_verifications v
          WHERE v.user_id = u.id
            AND v.verified_at IS NOT NULL
      )
      -- AND u.country_code NOT IN ('ZZ', 'XX')
),
activity AS (
    SELECT DISTINCT
        e.user_id,
        DATE_TRUNC('week', e.occurred_at) AS active_week
    FROM events.product_events e
    WHERE e.event_name IN ('session_start', 'document_opened', 'search_performed')
      AND e.occurred_at >= DATE '2025-01-06'
),
-- TODO: switch to ISO weeks once the finance calendar is retired
cohort_sizes AS (
    SELECT cohort_week, COUNT(*) AS cohort_size
    FROM signups
    GROUP BY cohort_week
),
retained AS (
    SELECT
        s.cohort_week,
        (EXTRACT(EPOCH FROM a.active_week - s.cohort_week) / 604800)::int AS week_number,
        COUNT(DISTINCT s.user_id) AS retained_users
    FROM signups s
    JOIN activity a
      ON a.user_id = s.user_id
     AND a.active_week >= s.cohort_week
    GROUP BY 1, 2
)
-- , retained_by_plan AS (
--     SELECT s.cohort_week, sub.plan_id, COUNT(DISTINCT s.user_id) AS retained_users
--     FROM signups s
--     JOIN billing.subscriptions sub ON sub.user_id = s.user_id
--     GROUP BY 1, 2
-- )
SELECT
    r.cohort_week,
    r.week_number,
    c.cohort_size,
    r.retained_users,
    ROUND(100.0 * r.retained_users / NULLIF(c.cohort_size, 0), 2) AS retention_pct
FROM retained r
JOIN cohort_sizes c USING (cohort_week)
WHERE r.week_number BETWEEN 0 AND 26
ORDER BY r.cohort_week, r.week_number;
