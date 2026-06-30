# ADR 0001: Foundational Stack Choices

**Date:** [project start]
**Status:** Accepted
**Decision makers:** Engineering

## Context

We are building an internal AI enablement system for a coaching/consulting agency, with the expectation that the same system will later be deployed to other agencies as a productized offering. The immediate focus is shipping two agents (Slack Bot, CSM Co-Pilot) by end of April. The longer-term target is a demonstrable B2B product by week 14.

We need to choose a technology stack that:
- Is fast to build in
- Supports the AI/ML workflows at the core of the product
- Is portable and non-locking — we can swap components later
- Works for a solo developer now and a small team soon

## Decisions

### 1. Python as the primary backend language

**Choice:** Python 3.11+ for agents, ingestion, evals, and data work.

**Alternatives considered:** TypeScript/Node, Go.

**Rationale:**
- Every major AI/ML library has best support in Python (Anthropic SDK, embedding tools, data processing)
- Most tutorials, examples, and community resources assume Python
- Solo dev productivity is higher in Python for this domain
- TypeScript remains available for the frontend where it's idiomatic

**Tradeoffs accepted:** Python is slower at runtime than Go, and the Python/TypeScript split means some context-switching for the developer. Both are acceptable costs.

### 2. Supabase as the database

**Choice:** Supabase (hosted Postgres + pgvector) as the single source of truth.

**Alternatives considered:** Raw Postgres on a cloud provider, MongoDB, Pinecone + separate relational DB.

**Rationale:**
- Postgres is the boring, right choice — mature, well-understood, portable
- pgvector support means embeddings and relational data live in one database (simpler than maintaining a separate vector store)
- Supabase provides auth, realtime, and client libraries that accelerate early development
- Migration off Supabase to raw Postgres is straightforward if needed — we're not locked into proprietary formats

**Tradeoffs accepted:** Some vendor dependency on Supabase's platform features. Mitigated by keeping schema and data in standard Postgres format.

### 3. n8n for orchestration

**Choice:** n8n (self-hosted) for agent workflow orchestration, scheduling, and HITL routing.

**Alternatives considered:** Zapier, Make, custom orchestration in Python.

**Rationale:**
- n8n is open source and self-hostable — we own the infrastructure
- Supports code nodes natively (Python/JavaScript), so complex logic doesn't require escape hatches
- Flat pricing (vs. per-operation pricing of Zapier/Make) scales better
- Industry-standard for AI agent orchestration in 2026 — ecosystem is mature
- Workflows as JSON exports means they're version-controllable and portable

**Tradeoffs accepted:** Self-hosting adds ops overhead vs. managed alternatives. Mitigated by starting with n8n cloud for speed and migrating to self-hosted later if economics warrant it.

### 4. Vercel for hosting

**Choice:** Vercel for Next.js frontend and serverless Python functions.

**Alternatives considered:** AWS, Railway, Fly.io, Cloudflare.

**Rationale:**
- First-class Next.js support (zero-config deployments)
- Python serverless functions work well for agent endpoints
- Familiar developer experience, fast iteration
- Environment variable management is solid

**Tradeoffs accepted:** Serverless function limits (execution time, memory) may force us to move long-running agents elsewhere eventually. Acceptable for V1.

### 5. Claude (Anthropic) as the primary LLM

**Choice:** Claude via Anthropic API. Sonnet as default model, Opus for complex reasoning, Haiku for simple/cheap tasks.

**Alternatives considered:** OpenAI GPT-4, Gemini, open-source models via Bedrock.

**Rationale:**
- Strong reasoning quality at competitive cost
- Tool use and structured output support
- Long context windows useful for agent workflows
- One API, three model sizes means we can tune cost/quality per agent

**Tradeoffs accepted:** Vendor dependency on Anthropic. Mitigated by keeping prompts model-agnostic where possible — swapping to another provider would require prompt adjustments but not structural changes.

### 6. Per-client deployment model (future)

**Choice:** When we deploy the system to B2B clients, each client gets a separate Supabase project and environment config. Single codebase, deployed per-client, not multi-tenant SaaS.

**Alternatives considered:** Multi-tenant SaaS with row-level security, forked repo per client.

**Rationale:**
- Per-client Supabase projects give clean data isolation without complex RLS engineering
- Config-driven deployment scales to 20-50 clients without major re-architecture
- Forking the repo per client would be unmaintainable past 5 clients
- Matches the "done-for-you consulting" product framing — we deploy for each client, not sell them a SaaS login

**Tradeoffs accepted:** Requires deployment automation to scale. Will need to invest in this before client count grows.

## Consequences

- All backend code is Python; TypeScript only for frontend
- All data flows through Supabase; no direct external tool calls from agents
- n8n is the orchestration layer; Zain's workflows get imported into our instance
- Deployment model is Vercel-first, with flexibility to move compute elsewhere later
- Claude is the default LLM; prompts should be written to be portable across models where reasonable

## Review

Revisit this ADR if:
- Any stack component becomes a significant performance or cost bottleneck
- We hit scale thresholds that require re-architecture (likely not before 10+ B2B clients)
- A meaningfully better alternative emerges for any layer
