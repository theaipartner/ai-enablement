# Collaboration

How work is divided between Drake (engineering) and Zain (technical ops / no-code).

This document exists so everyone knows what to pick up, what to hand off, and how handoffs happen. Clear boundaries let both people move fast without stepping on each other.

## Drake (Engineering)

Owns the core technical system: code, database, agents, deployments.

- Python codebase (agents, ingestion pipelines, shared utilities, evals)
- Database schema and migrations
- Git repository (reviews all PRs, merges to main)
- Supabase project and environment configuration
- Vercel deployments
- TypeScript frontend
- Anthropic API integration and prompt engineering
- Architecture decisions (ADRs)
- Documentation standards and structure

## Zain (Technical Operations)

Owns no-code workflows, integrations at the account level, and operational data prep.

- n8n workflow design (exported as JSON, handed to Drake for import)
- Airtable setup and configuration (if/where used)
- Account-level setup of integrations (Fathom API keys, Slack app configuration, CRM permissions, etc.)
- Manual data cleanup, tagging, and preparation when needed
- Running ingestion jobs and monitoring them day-to-day
- QA testing of agent outputs — flagging incorrect responses for eval dataset building
- Maintaining runbooks for recurring operational tasks

## Handoff Protocols

### n8n Workflows

Zain builds and tests workflows in his own n8n instance. When a workflow is ready:

1. Zain exports the workflow as JSON
2. Zain sends the JSON to Drake (Slack, or committed to a shared `orchestration/drafts/` directory)
3. Drake reviews for:
   - Correct use of APIs and endpoints
   - No hardcoded secrets (credentials must use environment references)
   - Reasonable error handling
   - Clear naming
4. Drake imports to the production n8n instance and commits the final JSON to `orchestration/`
5. Drake runs a smoke test before enabling the schedule

### Data Prep Tasks

When Zain does manual data work (cleaning, tagging, categorizing):

1. Work happens in a staging table or separate sheet — never directly in production tables
2. When complete, Zain notifies Drake with the location of the staged data
3. Drake reviews and runs the migration to production tables

### QA Findings

When Zain finds an agent producing bad output:

1. Zain logs the finding in the shared QA tracker (tool TBD — likely a simple Airtable or Supabase view)
2. Entry includes: agent name, input, actual output, expected output, severity
3. Drake reviews weekly to prioritize fixes and to build eval golden datasets

## What Zain Does Not Have Access To

By design, for both security hygiene and clean responsibility boundaries:

- Direct write access to the production Supabase database (read access for specific tables is fine)
- Admin on the GitHub repo
- Admin on the Vercel project
- Direct deployment capability
- Ability to modify the Python codebase

Zain's work integrates into the system through the handoff protocols above. This is standard practice and not personal.

## What Drake Does Not Handle

- Day-to-day n8n workflow maintenance once workflows are in production
- Routine ingestion monitoring
- Manual data cleanup
- Account-level integration configuration (unless there's a technical blocker)

## Escalation

If either side is blocked waiting on the other for more than 24 hours, escalate in our Slack channel. The system only works if handoffs are fast.

## Updating This Document

Update this doc when:
- A new area of work emerges and we need to decide who owns it
- A handoff protocol isn't working and needs revision
- A new collaborator joins and needs a clear picture of responsibilities
