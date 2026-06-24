# Runbooks

How to perform the recurring operational tasks of the system — ingestion, crons, webhooks, deploys,
data seeding, and the like. Each runbook covers one task: what it does, how to run it, its failure
modes, and how to debug it.

**Coverage is intentional, not exhaustive.** These runbooks are kept accurate, but there isn't one for
every subsystem — and the docs overall are *fairly*, not *fully*, comprehensive. **The absence of a
runbook does not mean the absence of the system.** When a runbook doesn't exist for something, the code
is the source of truth: start from the relevant `api/` handler, `ingestion/<source>/` module, or
`agents/<name>/` package, with `docs/fulfillment/architecture.md` (or `docs/sales/`) as the map.

For the cron inventory, see [`cron_schedule.md`](cron_schedule.md) (kept in sync with `vercel.json`).
For adding a brand-new ingestion source, see [`adding_new_ingestion_source.md`](adding_new_ingestion_source.md).
For every account/key the system uses — owner + rotation path — see [`credentials-and-accounts.md`](credentials-and-accounts.md).
