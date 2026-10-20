# Runbook: failing over the ledger primary

Use this when the ledger primary (`ledger-primary.db.internal`) is unhealthy
and Patroni has not promoted a replica on its own within five minutes, or when
you need a planned switchover for maintenance.

**Pager:** #ops-oncall. **Owner:** Platform team.

## 1. Confirm the situation

Check what Patroni thinks the cluster looks like from any database host:

```console
$ patronictl -c /etc/patroni/patroni.yml list
+ Cluster: ledger ----------+---------+---------+----+-----------+
| Member     | Host         | Role    | State   | TL | Lag in MB |
+------------+--------------+---------+---------+----+-----------+
| ledger-db1 | 10.20.1.11   | Leader  | running |  7 |           |
| ledger-db2 | 10.20.2.11   | Replica | running |  7 |         0 |
| ledger-db3 | 10.20.3.11   | Replica | running |  7 |        12 |
+------------+--------------+---------+---------+----+-----------+
```

If the leader shows `running` and the application is still failing, the
problem is probably not the database. Check the API error rate dashboard before
going further.

Replication lag on each replica, from the primary:

```sql
SELECT application_name, state, replay_lag
FROM pg_stat_replication
ORDER BY replay_lag DESC NULLS LAST;
```

## 2. Pick a candidate

Choose the replica with the lowest lag. A replica more than 64 MB behind will
lose committed transactions on promotion; if every replica is that far behind,
stop and escalate to the database owner.

## 3. Switch over

For a planned switchover, Patroni handles fencing the old primary:

```sh
patronictl -c /etc/patroni/patroni.yml switchover ledger \
  --leader ledger-db1 --candidate ledger-db2 --force
```

For an unplanned failover where the leader is unreachable:

```sh
patronictl -c /etc/patroni/patroni.yml failover ledger --candidate ledger-db2 --force
```

Patroni updates the `ledger-primary` DNS record through the consul-template
hook. Applications reconnect on their next pool refresh, which takes up to 30
seconds. You can watch the record change with:

    watch -n2 dig +short ledger-primary.db.internal

## 4. Verify

From a bastion, confirm writes go to the new primary:

```sh
psql "host=ledger-primary.db.internal dbname=ledger user=oncall" \
  -c "SELECT pg_is_in_recovery(), inet_server_addr();"
```

`pg_is_in_recovery()` must be `f`. Then check the API error rate has returned
to its baseline and that the nightly backup job's next run is scheduled
against the new host.

## 5. Rebuild the old primary

Once the old primary is reachable again, reinitialise it as a replica. This
wipes its data directory:

    patronictl -c /etc/patroni/patroni.yml reinit ledger ledger-db1

Leave a note in the incident channel with the timeline and the replica lag at
promotion time.
