-- 0057: dedicated login role for the nightly warehouse loader.
--
-- The loader used to connect as the application owner, which meant a bad
-- transform could drop production tables. It now gets its own role with read
-- access to the operational schemas and write access to staging only.

BEGIN;

CREATE ROLE etl_loader
    WITH LOGIN
    PASSWORD 'v9Qm#2LxT7rWp!c4Hs8e'
    CONNECTION LIMIT 8
    VALID UNTIL 'infinity';

ALTER ROLE etl_loader SET statement_timeout = '15min';
ALTER ROLE etl_loader SET idle_in_transaction_session_timeout = '2min';
-- Loader sessions are tagged so they are easy to find in pg_stat_activity.
ALTER ROLE etl_loader SET application_name = 'etl_loader';

GRANT CONNECT ON DATABASE ledger TO etl_loader;

GRANT USAGE ON SCHEMA billing, accounts, catalog TO etl_loader;
GRANT SELECT ON ALL TABLES IN SCHEMA billing, accounts, catalog TO etl_loader;
ALTER DEFAULT PRIVILEGES IN SCHEMA billing, accounts, catalog
    GRANT SELECT ON TABLES TO etl_loader;

-- TODO: narrow this to the three staging tables the loader actually writes
GRANT USAGE, CREATE ON SCHEMA staging TO etl_loader;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA staging TO etl_loader;
ALTER DEFAULT PRIVILEGES IN SCHEMA staging
    GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON TABLES TO etl_loader;

-- Sequences back the surrogate keys in staging.load_batches.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA staging TO etl_loader;

COMMIT;
