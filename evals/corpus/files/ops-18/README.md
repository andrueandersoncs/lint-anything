# Northwind Ledger

Ledger is the billing backend for Northwind: subscriptions, invoices, payments
and the finance reporting schema. It exposes a JSON API consumed by the web app
and a gRPC API used by internal services.

## Requirements

- Go 1.23
- Postgres 16
- Docker (for the local stack)
- [`sqlc`](https://sqlc.dev) 1.27 if you change any file under `queries/`

## Quick start

Start the local stack (Postgres, Redis, a Stripe mock) and run the migrations:

```sh
docker compose up -d
make migrate
```

Then run the server:

```sh
go run ./cmd/ledger serve
```

The API listens on `localhost:8080`. Check it is up:

```console
$ curl -s localhost:8080/healthz
{"status":"ok","version":"dev"}
```

## Configuration

Ledger reads its configuration from environment variables. A `.env` file in the
repository root is loaded automatically in development:

```
LEDGER_HTTP_ADDR=:8080
DATABASE_URL=postgres://ledger@localhost:5432/ledger?sslmode=disable
STRIPE_API_BASE=http://localhost:12111
LEDGER_LOG_FORMAT=text
```

| Variable              | Default      | Description                                  |
| --------------------- | ------------ | -------------------------------------------- |
| `LEDGER_HTTP_ADDR`    | `:8080`      | Address the JSON API listens on              |
| `LEDGER_GRPC_ADDR`    | `:9090`      | Address the gRPC API listens on              |
| `DATABASE_URL`        | (required)   | Postgres connection string                   |
| `STRIPE_API_BASE`     | Stripe's API | Override for the Stripe mock in development  |
| `LEDGER_LOG_FORMAT`   | `json`       | `json` or `text`                             |

## Tests

Unit tests need nothing running. Integration tests need the local stack and are
behind a build tag:

```sh
go test ./...
go test -tags integration ./internal/...
```

## Generating code

Queries live in `queries/` and are compiled to Go with sqlc. After editing a
query, regenerate and commit the output:

```sh
sqlc generate
git add internal/db
```

Protobuf definitions live in `proto/`:

```sh
buf generate
```

## Creating a migration

Migrations are plain SQL files in `db/migrations`, applied in filename order.
Name new files with a UTC timestamp:

```sh
make migration name=add_invoice_memo
```

which creates a file like this one:

```sql
-- 20261019_1412_add_invoice_memo.sql
BEGIN;
ALTER TABLE billing.invoices ADD COLUMN memo text;
COMMIT;
```

## Deploying

Merges to `main` deploy to staging automatically. Production deploys are a
manual run of the `deploy` workflow; see `docs/runbooks/` for rollbacks and
database failover.
