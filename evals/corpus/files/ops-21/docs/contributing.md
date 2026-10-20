# Contributing

Thanks for helping out. This guide covers the local workflow, how we write
commits, and what reviewers look for.

## Branches and commits

Branch from `main` and name the branch after the Linear issue, for example
`led-482-invoice-memo`. Keep commits small; each one should build and pass
tests on its own.

Commit messages use a short imperative subject and a body that explains why:

```text
Add memo column to invoices

Finance wants to annotate invoices that were manually adjusted so the
monthly close review can skip them. The memo is free text and is not shown
to customers.

Refs: LED-482
```

## Running checks locally

Before pushing, run the same checks CI runs:

~~~sh
make lint
make test
~~~

If `make lint` complains about formatting, `make fmt` fixes it. Shell scripts
are checked with shellcheck; you can run it on a single file:

```console
$ shellcheck --severity=warning scripts/rotate_logs.sh
$ echo $?
0
```

## Database changes

Migrations must be backwards compatible with the version currently running in
production, because the deploy runs migrations before rolling out new pods.
In practice that means:

- add columns as nullable or with a default;
- never rename a column in one step: add the new one, backfill, switch reads,
  then drop the old one in a later release;
- create indexes with `CREATE INDEX CONCURRENTLY` in their own migration, since
  it cannot run inside a transaction.

A concurrent index migration looks like this:

```sql
-- 20261019_1530_invoices_memo_idx.sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS invoices_memo_idx
    ON billing.invoices (account_id)
    WHERE memo IS NOT NULL;
```

## Reviews

Every pull request needs one approval from a code owner (see `CODEOWNERS`).
Reviewers check, roughly in this order:

1. Does it do what the issue asks, and nothing else?
2. Are failure cases handled and tested?
3. Will it be obvious to the next person why the code is the way it is?

Use the pull request template; fill in the "How to verify" section with the
exact commands or clicks a reviewer can follow, for example:

```yaml
how_to_verify:
  - run: make migrate && go test -tags integration ./internal/billing/...
  - open: http://localhost:8080/admin/invoices?has_memo=true
```

## Releasing

Releases are cut by tagging `main` with `vX.Y.Z`; the `release` workflow does
the rest. Only maintainers can push tags.
