# Fulfillment

The customer-success (CSM) side of the system — the counterpart to [`../sales/`](../sales/README.md).
Sales tracks the funnel up to a closed deal; fulfillment is everything after: keeping paying clients
healthy and giving the CSM team leverage.

## What it does (the goal)

Turn the raw signals of an account — calls, Slack activity, NPS, meeting cadence — into things a CSM
can act on:

- a per-client **health score** they can scan,
- **call reviews + summaries** so nobody re-watches an hour of recording,
- **Ella**, a Slack agent that answers client questions and flags messages that need a human,
- **dashboards** that surface what needs attention today.

The one-line shape: *ingest everything into Supabase, let agents reason over it, surface the result to
CSMs in the dashboard and in Slack.*

## Principles (why it's shaped this way)

1. **Supabase is the source of truth.** Every external signal is mirrored into Supabase. Agents read
   from Supabase, never from the external tool directly.
2. **External tools are replaceable adapters.** Only the `ingestion/` layer touches Fathom, Slack, etc.
   Swapping one is a contained rewrite.
3. **Fail soft.** Ingestion and agents degrade gracefully — escalate to a human, or skip — rather than
   break a delivery path. An uncertain agent escalates; it never guesses confidently.
4. **Data hygiene over completeness.** A missing field is a known gap; a stale one is a confident lie.
   Verify who owns a field before ingesting it. (See [conventions.md](conventions.md).)
5. **Storage vs. retrieval.** Raw transcripts and payloads are stored verbatim and never mutated; the
   chunks/summaries/reviews derived from them are disposable and rebuildable. (See
   [metadata-conventions.md](metadata-conventions.md).)
6. **Retrievability is gated.** What an agent can surface to a *client* (via Ella) is a deliberate,
   human-promotable decision — never an automatic side effect of ingestion. (See
   [metadata-conventions.md](metadata-conventions.md) §6–7.)
7. **Everything is audited.** Agent executions (`agent_runs`), inbound webhooks/crons
   (`webhook_deliveries`), and client-state changes (the `*_history` tables) all leave a trail.

## Map — where to find things

| You want… | Read |
|---|---|
| the system shape + how data flows | [architecture.md](architecture.md) |
| the rules (dashboard UI, call titling, data hygiene) | [conventions.md](conventions.md) |
| the KB ingestion metadata contract | [metadata-conventions.md](metadata-conventions.md) |
| a specific agent's behavior | `../agents/<agent>.md` |
| a specific table | `../schema/<table>.md` |
| how to run or operate something | `../runbooks/` |
| why a design call was made | `../decisions/` (ADRs) |
| the historical shipped-state log | git history + `../archive/` |

This folder describes the **durable shape and rules**. It deliberately does **not** track point-in-time
status (what shipped when, current row counts) — that lives in git history. Docs that go stale are worse
than no docs, so anything here should be true as long as the code is.
