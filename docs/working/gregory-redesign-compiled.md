# Gregory redesign — compiled per-page changes

This document compiles the Phase 1a (per-surface vision) and Phase 1b (cross-surface synthesis) findings into a per-page reference Drake can read end-to-end and make decisions from. It is the input to spec-writing, not a spec itself.

**Status:** working draft, 2026-05-12. Director-compiled from Cowork's Phase 1a + 1b reports.

**Scope:** five Gregory surfaces. `/login` was excluded per Drake's call (already polished).

---

## Part 1 — Cross-cutting decisions

These apply across every page. Each one is decided once, then referenced per-page.

### 1.1 — Detail-page template (`<GregoryDetail>`)

All three detail pages converge on one structure, top-to-bottom:

1. **HeaderBand** — eyebrow (e.g. `CLIENT · DETAIL`) + serif title (entity name) + state pills + right-aligned actions
2. **Glance row** — inline-editable toggles, dropdowns, or pills that answer "what's the current state?"
3. **Workflow content** — sections that answer "what should I do about this?"
4. **History / context** — what led here
5. **Configuration / details** — editable-but-rarely-edited fields, collapsed by default
6. **DiagnosticsCollapse** — raw / dev-facing dump (JSON metadata, internal IDs, etc.), collapsed-by-default for CSMs, expanded-by-default for Drake

The structure is identical; what differs per page is which sections fill which slots.

**Implication:** build `<GregoryDetail>` as a slotted shell component. Pages don't reinvent chrome; they fill slots.

### 1.2 — List-page template (`<GregoryList>`)

Less tightly convergent than detail pages, but shared shape:

1. **HeaderBand** — same primitive as detail pages
2. **Optional MetricCardRow** — conditional (only `/clients` gets the TodayDigest, `/ella/runs` has its existing metric cards; `/calls` likely doesn't need one)
3. **FilterBar** — search + FilterChipRow (3 primary chips + overflow) + DateRangePicker (where applicable) + SavedViews dropdown on the right
4. **Table** — SortableColumnHeader on every column, VirtualizedTable when row count >200, inline-editable cells where appropriate, RowHoverPreview for content peek
5. **Pagination** — load 100 initially, "Load 100 more" button at bottom

### 1.3 — Empty-state rule

Three tiers, applied per section:

- **Hide entirely** when purely informational and would render all em-dashes. *Examples:* Profile & Background SWOT with no fields populated; Upsells with zero items; Conversation Pivots with zero items.
- **Stub** when actionable and the empty state itself communicates something. *Examples:* "No concerns currently surfaced — health score 72 (green)"; "No open action items" + an "Add" affordance.
- **Show full structure** when at least one field is populated.

**Section headers never appear without content underneath**, unless the empty state itself is actionable.

### 1.4 — Diagnostics-collapse rule

What goes in a collapsed Diagnostics block:

- Raw JSON dumps (`overall_reasoning` raw form, `trigger_metadata`)
- Internal IDs (UUIDs, slack user/channel IDs)
- Ingestion metadata (source, external_id, ingested_at)
- Confidence scores, model names, model-routing details
- Raw anomaly letter codes (after human-readable labels have been surfaced above)

**Display rules:**
- Collapsed by default for CSMs.
- Expanded by default for Drake. Per-user preference or role-based default.
- Always at the bottom of detail pages. Never above the fold, never interleaved.

### 1.5 — Inline-editable convention

- **Visual cue:** cell looks readable on first glance. Subtle hover state (cursor + faint border) indicates editability.
- **Save behavior:** optimistic update with on-blur persistence. New value shows immediately; small spinner/checkmark/error icon conveys state. No row-level "Save" button.
- **Error handling:** on save failure, revert + inline error tooltip with retry. Don't toast.
- **Computed fields don't get the affordance** (health score, sentiment, computed counts).

### 1.6 — Sentiment-tier classifier (Drake-decide)

Cowork's sketch rule:

- **Green** if `call_review.sentiment_arc` ends positive AND no individual segment is negative below threshold
- **Yellow** if mixed, or ends neutral
- **Red** if ends negative OR shows downward trajectory across 3+ segments

**Used by:** `SentimentPill` on `/calls` list, `/calls/[id]` header, `/clients/[id]` recent-calls list.

**Drake-decide:** Director will pull 5-10 real call_review records and validate this rule produces sensible buckets. If the data shape doesn't support the rule cleanly, fallback is an explicit `sentiment_tier` field populated at review-generation time.

### 1.7 — Anomaly-code translations (Drake-decide, Director-drafted)

For `/ella/runs` and `/ella/runs/[id]`. Translations Director proposed:

- **A** → "Escalation flag leaked to client" (the `[ESCALATE]` token reached Slack)
- **A'** → "Escalation flag in logs only" (caught before send; detector worked)
- **B** → "Wrong-user identification (legacy bug)"
- **B'** → "Triggered by non-channel-member"
- **C** → "Errored"
- **D** → "Unusually long/short response"
- **E** → "Bare mention (no question)"

**Drake-decide:** confirm or refine these labels. Once locked, they drive the `AnomalyCodeLabel` primitive.

### 1.8 — Header pattern

- **Eyebrow:** small uppercase muted text, two-word taxonomy (`CSM · CLIENTS`, `CALL · DETAIL`, `ELLA · RUN`)
- **Serif title:** existing "All clients." / "Run detail." treatment — keep that
- **State pills:** directly below title or right of it on detail pages
- **Actions:** right-aligned (counts on lists, action buttons on details)

### 1.9 — What was missed in Phase 1a (added by Phase 1b)

- **Mobile / responsive:** desktop-first stays; enforce "doesn't fall apart below 1024px" baseline. Single-column reflow below ~900px is cheap. No mobile-only features this cycle.
- **Loading states:** skeleton over spinner everywhere. HeaderBand renders immediately; inner sections skeleton.
- **Error states:** per-section, not full-page. API failure on edit handled by InlineEditableField primitive.
- **Accessibility:** real `<h1>` on HeaderBand serif. Keyboard navigation on inline-editable cells (tab/enter/escape). ARIA labels on pills. Color-only signaling needs redundant text/shape encoding.
- **Backlinks:** `/calls/[id]` should link to primary client's detail page from HeaderBand, not buried in participants. Same for `/ella/runs/[id]` → originating client.
- **Permalink-able sections:** `/clients/123#concerns` etc. Helps CSMs share specific items via Slack.

### 1.10 — Primitive census (build order)

**Choke-point primitives (build first — unlock the most downstream work):**

- `HeaderBand` — every page
- `EmptyStateAwareSection` — every detail page
- `DiagnosticsCollapse` — every detail page (and JSON-dump removal)
- `InlineEditableActionItemRow` — `/clients/[id]` + `/calls/[id]`

**Decoupled work** (no dependencies, parallelizable):

- AnomalyCodeLabel dictionary (Drake content)
- SentimentTierClassifier rule (Drake decision)

**Full primitive list** (22 total per Cowork's 1b) is in Cowork's 1b report and not repeated here.

---

## Part 2 — Per-page proposed changes

### 2.1 — `/clients/[id]` (client detail page)

**Current state:** 9 stacked collapsible sections in data-model order (Identity & Contact → Lifecycle & Standing → Concerns nested → Financials → Activity & Action Items → Profile & Background → Adoption & Programs → Upsells → Notes).

**Cowork's read:** the highest-value content (Concerns, Action items, Trustpilot/toggle state) is scattered or buried. "Why this score" renders raw JSON. Empty SWOT rows take full visual weight on most clients. Tags display prominently when empty.

**Proposed reorganization (top to bottom):**

1. **HeaderBand**
   - Eyebrow: `CLIENT · DETAIL`
   - Serif title: client full name
   - Status pill + Journey stage pill (currently empty 0/97 — see Drake-decide below)
   - Right-aligned: Health score numeral (tier-colored) + "Last computed X" timestamp

2. **Glance row** (inline-editable strip below HeaderBand)
   - **Trustpilot status** (inline-editable, 5-state vocab) — promoted per existing Drake intention
   - NPS Standing pill (inline-editable)
   - CSM Standing pill (inline-editable)
   - **Director recommends NOT promoting Accountability + NPS toggles** (Cowork's instinct was right but it underweighted the call). These stay in their existing section but become inline-editable. Reasoning: they're flipped maybe twice/quarter per CSM, mostly system-driven via the cascade. Top-of-page real estate doesn't pay back.

3. **Workflow content** — Concerns + open Action items
   - **Cowork suggested side-by-side**; Director recommends **vertical stack** with the option to revisit. Reasoning: at 1280px+ side-by-side reads fine; at typical laptop widths (1100-1280) variable-length narrative columns will cramp. Vertical is the safer default. Revisit if Drake has a multi-screen setup.
   - **Concerns** — SeverityNarrativeCard primitive per concern (high/medium/low severity pill + narrative + source-call link). Empty state: stub copy ("No concerns currently surfaced — health score X (green/yellow/red)").
   - **Action items** — `InlineEditableActionItemRow` primitive. Toggle status, owner dropdown, edit text in place. Empty state: stub with "Add action item" affordance.

4. **History** — Recent calls list
   - Chronological, last 5 visible, expander for full history
   - Each row: title + date + duration + SentimentPill (green/yellow/red, sourced from call review)
   - Click → `/calls/[id]`

5. **Financials** — single thin row of three numbers (contracted, collected, arrears). Not section-headered — too thin to deserve a heading.

6. **Configuration / details** (collapsed by default)
   - **Identity & Contact** — full name, email, alt emails, phone, country, time zone, birth year, location, occupation, Slack channel id, Slack user id, signup date
   - **Profile & Background** — niche, offer, traffic strategy, SWOT. EmptyStateAwareSection: if all fields null, render only a "+ Add background" affordance instead of six labeled em-dashes
   - **Adoption & Programs residual** — GHL adoption, Sales group candidate, DFY setting (Trustpilot moved to glance row; Accountability + NPS stay inline-editable in this section)
   - **Notes** — free-text, full-width

7. **Upsells** — only render when count > 0. Hide entirely otherwise.

8. **DiagnosticsCollapse** (collapsed by default for CSMs, expanded for Drake)
   - **HealthScoreBreakdown** — structured table (signal name | value | weight | contribution) + `overall_reasoning` rendered as paragraph
   - Raw "Why this score" JSON (the current dump, demoted)
   - Other internal IDs / ingestion metadata if any

**Tags display:** removed entirely per Drake intention. Schema column preserved for `needs_review` gating.

**"Pipeline pending" metric cards:** removed. They're placeholders.

**Primitives required:**

- `HeaderBand` (cross-cutting)
- `InlineEditableToggleRow` / `InlineEditableField` (for Trustpilot in glance row)
- `SeverityNarrativeCard` (Concerns)
- `InlineEditableActionItemRow` (action items)
- `SentimentPill` (recent calls list — Sprint 4 dependency)
- `EmptyStateAwareSection` (multiple sections)
- `DiagnosticsCollapse` (footer)
- `HealthScoreBreakdown` (replaces JSON dump)

**Drake-decide questions:**

1. ✅ Trustpilot promoted to glance row. Accountability/NPS stay in section as inline-editable.
2. **Journey stage is empty 0/97 across active clients.** Three possibilities: data was wiped, manual-entry field nobody fills in, or pipeline gap. Director recommends: **defer this question**, hide the column on `/clients` list until populated (see 2.2), but keep it on the detail HeaderBand because when it IS populated it's high-value information. The deferred resolution determines whether a future `/pipeline` kanban surface is buildable.
3. **Recent calls section size.** Cowork assumes pre-touchpoint use case (CSM opens before a call). If retrospective is also a major use case, Recent calls deserves more height. **Drake to confirm primary use case.**
4. **`overall_reasoning` paragraph rendering.** Confirm no CSM actually reads the raw JSON (Director suspects not, but worth verifying before demoting).
5. **Concerns + Action items vertical vs side-by-side.** Director recommends vertical; Cowork suggested side-by-side. Drake's call.

---

### 2.2 — `/clients` (client list)

**Current state:** 9 filter dropdowns + 9-column table (Name / Status / Journey stage / Primary CSM / CSM Standing / NPS Standing / Trustpilot / Health score / Meetings this mo). 97 rows rendered with default filters; 188+ exist total. Default sort: Health score ascending.

**Cowork's read:** Journey stage column is dead weight (0/97 populated). Health score yellow pill is doing no work when 51/97 are tier-banded yellow. 9 filter dropdowns is too many. No saved views — CSMs re-apply the same 2-filter setup hundreds of times. No sort on most columns.

**The kanban question:** Cowork explored 3 kanban variants and a 4th non-kanban option:
- **Option A** — kanban replaces table (rejected: 93 cards in one "active" column is worse than table for triage)
- **Option B** — kanban as alternate view via toggle (rejected: low-use, maintenance debt)
- **Option C** — separate `/pipeline` surface (blocked on `journey_stage` data being populated; defer)
- **Option D** — saved views + today digest + density tweaks (Cowork's actual recommendation, Director agrees)

**Proposed changes (Option D + cleanup):**

1. **HeaderBand**
   - Eyebrow: `CSM · CLIENTS`
   - Serif title: `All clients.`
   - Right-aligned count: existing pattern

2. **TodayDigest row** (above filter bar)
   - 3-4 card-counters with clickable filter-application:
     - "5 of your clients dropped a health tier this week"
     - "3 with new high-severity concerns"
     - "8 with no meeting in 30+ days"
     - "X at-risks needing follow-up"
   - Each card click applies the corresponding filter to the table below
   - **Drake-decide:** exact counters worth surfacing — these are Director's first-draft suggestions

3. **FilterBar** (compressed)
   - Search input (existing)
   - **3 primary filter chips:** Primary CSM, Status, CSM Standing
   - **Overflow menu** for: NPS Standing, Trustpilot, Needs review, Accountability, NPS toggle, Country
   - **SavedViews dropdown** on the right
   - DateRangePicker not needed here (no inherent date axis)

4. **Table**
   - **Drop Journey stage column** until data is populated (Drake-decide: backfill or delete?)
   - **Health score:** replace yellow/green pill with thin colored bar OR just numeral-colored. The pill is visual noise when 51/97 are the same tier.
   - **SortableColumnHeader** on every column, not just Health score
   - **VirtualizedTable** when row count exceeds 200 (not urgent today, but anticipates growth)
   - Inline-editable cells (Status, Journey stage when populated, CSM Standing, Trustpilot) — already shipped per existing work

5. **Pagination** — load 100, "Load 100 more" button

**Primitives required:**

- `HeaderBand` (cross-cutting)
- `TodayDigest` (new, medium complexity)
- `SavedViews` (new, medium complexity)
- `FilterChipRow` + overflow (new, medium complexity)
- `SortableColumnHeader` (extend existing)
- `VirtualizedTable` (medium complexity; defer until row count demands it)
- `InlineEditableField` (existing)

**Drake-decide questions:**

1. **Journey stage column fate.** Currently 0/97 populated. Options: hide column entirely until populated, keep column as visual reminder of the data gap, delete column from schema. Director recommends **hide from list, keep on detail HeaderBand for future, investigate backfill as separate task**.
2. **TodayDigest counters.** Director suggested 4 examples; Drake confirms which actually matter to CSMs.
3. **SavedViews vs the existing filter chips.** Director assumes CSMs have a stable handful of views they re-apply. Confirm — if Scott uses ad-hoc filtering more than expected, SavedViews matters less.
4. **Default sort.** Currently Health score ascending. Director's read: this is correct for daily triage but wrong for weekly roster review. Confirm Scott's primary use is triage.
5. **Trustpilot vocab** — 5 values (yes/no/ask/asked/—) seems like a lot for a binary-feeling field. Confirm whether `asked` and `ask` are semantically distinct states.
6. **Kanban deferred entirely** for V1; revisit as `/pipeline` surface once journey_stage is populated. Drake confirm.

---

### 2.3 — `/calls` (call list)

**Current state:** 8-column table (Date / Title / Category / Primary client / Duration / Confidence / Participants / Retrievable). 697 rows fully rendered. Default filter includes all categories.

**Cowork's read:** Confidence and Retrievable are dev-facing system flags, not CSM-facing. No sentiment surfaced. No CSM column. Internal and sales calls clutter the list. 697 rendered rows is perf/scan problem.

**Proposed changes:**

1. **HeaderBand**
   - Eyebrow: `CSM · CALLS`
   - Serif title: `All calls.`
   - Count: existing

2. **FilterBar**
   - Search input (existing)
   - **Category chips** (existing), with **default filter set to `category=client`** (not "all")
   - **DateRangePicker** (new) for time-bounded queries
   - SavedViews dropdown on right (Sprint 5 dependency)

3. **Table — column changes**
   - **Drop Confidence column** (move to call detail's Diagnostics)
   - **Drop Retrievable column** (move to detail's Diagnostics)
   - **Add Sentiment column** — green/yellow/red SentimentPill (depends on sentiment-tier classifier rule, see 1.6)
   - **Add CSM column** — derived from participants matched to team_members
   - **Title becomes dominant column** (currently sized similar to others; CSMs remember calls by content not date)
   - **NeedsReviewIndicator** inline pill for low-confidence rows (replacing the Confidence column's diagnostic purpose)

4. **Hide internal + sales calls by default** — preserve in DB, just not surfaced. Category chips remain available to re-enable.

5. **Pagination** — top 100 + "Load 100 more"

6. **RowHoverPreview** (medium complexity, Sprint 4-5 dependency) — tooltip on row hover surfaces top win + top pain point + top action item from the call review. Saves a click for "did I commit to anything?"

**Primitives required:**

- `HeaderBand` (cross-cutting)
- `SentimentPill` + classifier rule (Sprint 4 dependency)
- `CSMAvatarOrLabel` (new, small)
- `NeedsReviewIndicator` (new, small)
- `DateRangePicker` (small)
- `FilterChipRow` (cross-cutting)
- `SortableColumnHeader` (cross-cutting)
- `SavedViews` (cross-cutting)
- `RowHoverPreview` (medium; defer)
- `VirtualizedTable` (urgent at 697 rows)

**Drake-decide questions:**

1. **Sentiment-tier classifier rule.** Director will pull 5-10 real call_review records to validate Cowork's sketch produces sensible buckets. Locks once validated.
2. **CSM column derivation rule.** Which participant counts as "the CSM"? Host? First team-member participant? Most-speaking? Director suggests: host first, fallback to first team_member by alphabetical name. Drake's call.
3. **"Hide internal/sales by default"** assumes CSMs rarely want internal/sales in this list. Confirm Scott doesn't use `/calls` to find sync recordings.
4. **"Sales" category** wasn't found in chip row by Cowork. Confirm whether it's a real category, folded into external, or never wired.

---

### 2.4 — `/calls/[id]` (call detail page)

**Current state:** 7 sections top-to-bottom (Metadata → Classification → Participants → Summary → Call review → Action items → Transcript).

**Cowork's read:** Metadata at top is data-model order, not workflow order. Classification before review is redundant. Summary and Call review duplicate purpose. Fathom URLs in Summary are visually noisy. No sentiment surfaced at top. Action items are display-only.

**Proposed reorganization:**

1. **HeaderBand**
   - Eyebrow: `CALL · DETAIL`
   - Serif title: call title
   - Below title: date+time, duration (kept here, not in metadata), category pill, **SentimentPill (new)**, primary client link, CSM (Host) — `CSMAvatarOrLabel`
   - Right-aligned: "Open recording" button

2. **Workflow content — Call review (the spine of the page)**
   - **SentimentArc visualization** at the top of the review (new primitive, medium complexity)
   - **Wins / Pain points / Conversation pivots / Dodged questions** — each rendered as `SeverityNarrativeCard` stacks
   - Each item: narrative + supporting quote + `QuoteToTimestampLink` (when source_timestamp present)
   - **EmptyStateAwareSection** rules: hide Conversation pivots if zero, hide Dodged questions if zero, etc.

3. **Action items** — `InlineEditableActionItemRow` primitive (same as on `/clients/[id]`)

4. **Participants** — compact table (existing pattern, restyled)

5. **Configuration / details** (collapsed by default — DiagnosticsCollapse)
   - Source, External id, Ingested at, Confidence, Retrievable, Call type, Method
   - Duration is NOT here — promoted to HeaderBand

6. **Transcript** — bottom, button-gated as today

**Removed:** Summary section entirely. The Call review covers wins/pains/pivots already; the only unique Fathom content is "Next steps" which should be reconciled into Action items by ingestion (separate concern — see Drake-decide).

**Primitives required:**

- `HeaderBand` (cross-cutting)
- `SentimentPill` + classifier rule (Sprint 4 dependency)
- `SentimentArc` (new, medium)
- `SeverityNarrativeCard` (cross-cutting)
- `InlineEditableActionItemRow` (Sprint 2)
- `QuoteToTimestampLink` (new, small)
- `EmptyStateAwareSection` (cross-cutting)
- `DiagnosticsCollapse` (cross-cutting)
- `CSMAvatarOrLabel` (cross-cutting)

**Drake-decide questions:**

1. **Drop Summary entirely** — Director agrees with Cowork's more-aggressive read. The Fathom "Next steps" content needs separate ingestion-pipeline reconciliation with Action items so we don't lose data. **Director recommends:** ship the UI drop now; deal with the data-flow question separately. Drake's call.
2. **Sentiment-tier classifier rule** — same as 2.3.
3. **Pulling "Next steps" out of Fathom Summary into Action items** — requires ingestion pipeline to dedupe. Verify upstream behavior.

---

### 2.5 — `/ella/runs` (Ella audit log list)

**Current state:** 5 metric cards (Today / Status Mix / Cost / Anomalies / Surface) + filter row (Date range / Channel / Speaker role / Status / Anomaly flags / "Show anomalies only") + 7-column table (When / Channel / Real author / Status / Anomalies / Input / Tokens · Cost). 50 of 128 rows visible.

**Cowork's read:** Anomaly letter codes (`A`, `B'`, etc.) are unreadable without a legend — biggest Nabeel-blocker. "Surface: Ella V2 / `agent_name='ella' only`" is dev-facing footnote presented as KPI. Status MIX shows "success 127 / error 1" but most "success" rows are skipped runs — masks the real signal. "unresolvedunresolvable" is dev jargon-as-UI. Per-row cost in fractions of a cent is noise.

**The audience question:** Cowork proposed **Option B — split into two surfaces**:
- **`/ella`** — new Nabeel-facing dashboard (3-4 metric cards, "sent today" feed, "flagged for review" feed). No anomaly codes, no token columns, no jargon.
- **`/ella/runs`** — existing surface stays as Drake-facing audit log, cleaned up but technical.

Director agrees with split-over-toggle.

**Proposed changes to `/ella/runs` (the audit log, Drake-facing):**

1. **HeaderBand**
   - Eyebrow: `ELLA · AUDIT`
   - Serif title: `Run history.`
   - Right-aligned count

2. **Top metric strip — keep but clean up**
   - Remove "Surface: Ella V2" card (dev-facing footnote)
   - **Status MIX → Decision MIX:** split into Sent / Skipped / Escalated / Errored buckets
   - Today / Cost / Anomalies cards: keep but plain-English

3. **FilterBar**
   - DateRangePicker (existing)
   - Channel, Speaker role, Status (kept)
   - **Anomaly flags → Decision pill + Decision dropdown** (replace letter-code filter with human filter)
   - "Show anomalies only" toggle (kept)

4. **Table**
   - **AnomalyCodeLabel** column replaces raw letter codes — uses the dictionary in 1.7
   - Real author cleanup: `unresolved/unresolvable` → "Couldn't identify speaker"; `advisor` → "CSM"
   - Channel column: drop slack-id duplication ("#Trevor Heck (C0AEEPVK36W) → Trevor Heck" becomes "#Trevor Heck")
   - **DecisionPill column** (Sent / Skipped / Escalated / Errored)
   - Cost: roll up day/week, not per-row in fractions of a cent
   - Tokens column: combine input/output + cost in one cell more compactly (existing pattern, just tighter)

5. **Pagination** — load 50, "Load 50 more"

**Primitives required:**

- `HeaderBand` (cross-cutting)
- `AnomalyCodeLabel` + dictionary (Drake content)
- `DecisionPill` (new, small)
- `FilterChipRow` (cross-cutting)
- `DateRangePicker` (existing)
- `SortableColumnHeader` (cross-cutting)

**Drake-decide questions:**

1. **Anomaly-code dictionary** — Director drafted in 1.7. Drake refines or accepts.
2. **Decision bucket model** — Director assumes 4 buckets (Sent / Skipped / Escalated / Errored). Confirm whether `Escalated` is a real outcome in the data, or if skip-flavors should be more granular ("Skipped: haiku decision" vs "Skipped: client was acknowledging" — these may matter for diagnostics).

---

### 2.6 — `/ella` (NEW Nabeel-facing dashboard)

**Current state:** does not exist.

**Cowork's read:** Nabeel and CSMs need a simple "is Ella doing okay?" view. Drake's audit log is the wrong shape for that audience — too dense, jargon-heavy, dev-facing.

**Proposed surface:**

1. **HeaderBand**
   - Eyebrow: `ELLA · STATUS`
   - Serif title: `Ella, this week.` (Director's draft — Drake refines)
   - Date range selector (default: last 7 days)

2. **Metric strip** (3-4 cards, big numbers)
   - **Messages sent this period** (only respond-decisions counted)
   - **Cost this period** (rolled up to dollars and cents, not fractions)
   - **Flagged for review** (count of runs with any anomaly)
   - Optionally: **Average response time** if relevant data exists

3. **"Ella sent" feed** — chronological list of respond-decisions
   - Per row: channel + author + Ella's outgoing message (excerpt or full) + timestamp + cost
   - Click → `/ella/runs/[id]` for full detail

4. **"Flagged for review" feed** — runs with anomalies
   - Per row: channel + author + AnomalyCodeLabel (plain-English) + timestamp
   - Click → `/ella/runs/[id]`

**No anomaly letter codes, no token columns, no jargon.**

**Primitives required:**

- `HeaderBand` (cross-cutting)
- `AnomalyCodeLabel` + dictionary
- `DateRangePicker` (existing)
- A feed-row primitive for "Ella sent" and "flagged" feeds (new, small — may be a specialized variant of an existing row pattern)

**Drake-decide questions:**

1. **Is this surface worth building** vs just-simplify-existing `/ella/runs` with a toggle? Cowork argued split; Director agrees split. Drake's final call — split adds maintenance surface.
2. **Discovery:** how do CSMs and Nabeel land on `/ella` vs `/ella/runs`? Top nav links? Internal Slack share?

---

### 2.7 — `/ella/runs/[id]` (individual run detail)

**Current state:** 6 sections (Run header → Input → Surrounding context → Ella's response → Haiku decision placeholder → Trigger metadata JSON).

**Cowork's read:** "Pre-passive-monitoring run. (Haiku decision lands once Batch 2.3 ships)" placeholder is visible noise on every page. Run ID UUID is the page's first sub-heading-equivalent content. Channel field duplicates client name. The most decision-useful field (`haiku_reasoning`) is buried in JSON. The actual decision isn't surfaced as a top-line pill.

**Proposed reorganization:**

1. **HeaderBand**
   - Eyebrow: `ELLA · RUN`
   - Serif title: derived from channel + author + decision (e.g. `Skipped: Trevor Heck's acknowledgment`)
   - **Decision pill** (Sent / Skipped / Escalated / Errored) prominently
   - **Trigger pill** (@mention / passive monitor)
   - Status pill (success / error)
   - Backlink to originating client's detail page (`CSMAvatarOrLabel`-style link)
   - Cost as small footer text below pills
   - Right-aligned: "View in Slack" link if applicable

2. **What was said** — input message in `ChatBubble` visual
   - If thread context exists, render surrounding messages as smaller bubbles
   - Triggering message highlighted with arrow

3. **What Ella did** — `ChatBubble` in Ella's color showing reply
   - **If skipped:** neutral block with human-readable skip reason as headline ("Skipped: client was acknowledging a CSM, not asking a question")
   - **If escalated:** captured handoff_reasoning rendered as the body
   - **If errored:** error block

4. **Why Ella decided this** — first-class section
   - Promote `haiku_reasoning` (or equivalent decision-rationale) from JSON to rendered paragraph
   - Render as `SeverityNarrativeCard` (just a single card)

5. **DiagnosticsCollapse** (collapsed for Nabeel-style users, expanded for Drake)
   - Run ID, model name, exact tokens
   - Raw anomaly flags with letter codes
   - Full `trigger_metadata` JSON
   - "Haiku decision" status (when applicable — hide entirely until populated, not a placeholder)

**Removed:** "Pre-passive-monitoring run" placeholder. Hide entirely until Batch 2.3 ships.

**Primitives required:**

- `HeaderBand` (cross-cutting)
- `DecisionPill` (new, small)
- `ChatBubble` (new, small)
- `SeverityNarrativeCard` (cross-cutting)
- `DiagnosticsCollapse` (cross-cutting)
- `AnomalyCodeLabel` + dictionary

**Drake-decide questions:**

1. **`haiku_reasoning` field stability** — assumes it's a populated, stable field on `agent_runs`. If only filled post-Batch-2.3, the layout has a hole for pre-2.3 runs. Confirm or design fallback.
2. **Chat-bubble visualization opinion** — Cowork's idea. Risk: "too consumer-friendly" for an internal tool. If so, fallback to labeled blocks but preserve decision-first IA. Drake's call.
3. **Decision bucket model** — same as 2.5.

---

## Part 3 — Build plan

### 3.1 — Honest timeline reality check

Cowork proposed 6 sprints at ~1 week each = ~6 weeks. Director estimate compressed for Drake's velocity: 8-12 working days for the full plan. **End-of-week constraint is 2-3 days remaining.** We can't ship everything by Friday. Honest scoping below.

### 3.2 — End-of-week scope (Drake's 2-3 day window)

**Tier 1 — definitely ship by Friday:**

1. **Sprint 1 foundations** — HeaderBand standardization, EmptyStateAwareSection primitive, DiagnosticsCollapse primitive + application to existing JSON dumps on `/clients/[id]` and `/ella/runs/[id]`. Low-risk visible wins everywhere.
2. **Tag display removal + Pipeline-pending card removal on `/clients/[id]`** — cleanup using the new EmptyStateAwareSection.
3. **`/ella/runs` jargon cleanup** — AnomalyCodeLabel dictionary applied, "Surface" card removed, "unresolvedunresolvable" relabeled, channel column de-duplicated, "Haiku decision N/A" placeholder removed. Doesn't require new dashboard surface.
4. **`/calls/[id]` quick wins** — drop Summary section, move metadata to bottom (DiagnosticsCollapse), promote sentiment + classification to top header (sentiment pill stub OK if classifier rule isn't locked yet).

**Tier 2 — ship if Tier 1 lands cleanly:**

5. **InlineEditableActionItemRow** primitive build + apply on `/clients/[id]` only (defer `/calls/[id]` application to next week).
6. **`/clients/[id]` reorg** — apply the full reorg from 2.1 using the primitives built in Tier 1.

**Tier 3 — defer to next week explicitly:**

- Sentiment-tier classifier rule + SentimentPill application (`/calls` list + `/calls/[id]` header)
- `/calls` list reorg (column changes, default filter, RowHoverPreview)
- SavedViews + TodayDigest on `/clients` list
- `/ella` Nabeel-facing dashboard (new surface)
- `/ella/runs/[id]` reorg (ChatBubble + Decision pill structure)
- VirtualizedTable on `/calls`

### 3.3 — Drake's pre-spec decisions

These can be made tonight or tomorrow morning, in parallel with Sprint 1 work:

1. **Confirm cross-cutting rules** in Part 1: empty-state tiers, diagnostics-collapse behavior, inline-editable convention, header pattern
2. **Confirm Tier 1 scope** — which of items 1-4 are in, which are out
3. **Anomaly-code dictionary** — accept Director's drafts (1.7) or refine
4. **Glance row promotion: Trustpilot only** (Director's lean) **vs all three toggles** (original intention)
5. **Per-page Drake-decide questions** — flagged throughout Part 2

### 3.4 — Drake's deferred decisions (block Tier 3 / next week)

These don't block Tier 1 work, can be decided next week:

1. **Sentiment-tier classifier rule** — Director will pull sample call_reviews to validate Cowork's sketch
2. **Journey stage column fate** — investigate (a) wiped vs (b) never populated vs (c) pipeline gap
3. **`/ella` dashboard go/no-go** — split-into-two surface decision
4. **SavedViews + TodayDigest content** — exact counters worth surfacing
5. **Kanban / `/pipeline` surface** — explicitly deferred until journey_stage is populated

---

## Part 4 — Open questions for our next conversation

Director needs Drake's input on the following before drafting any specs. Roughly grouped by urgency:

### Need answered to start Tier 1 specs:

1. Confirm Tier 1 scope (items 1-4 in 3.2)
2. Anomaly-code dictionary — accept or refine (1.7)
3. Trustpilot-only promotion vs all three toggles (2.1 Drake-decide #1)
4. Drop Summary section on `/calls/[id]` — confirm aggressive removal (2.4 Drake-decide #1)

### Need answered for Tier 2 specs:

5. Concerns + Action items layout: vertical or side-by-side (2.1 Drake-decide #5)
6. Journey stage column fate on `/clients` list (2.2 Drake-decide #1)
7. CSM column derivation rule on `/calls` list (2.3 Drake-decide #2)

### Can wait for next week:

8. Sentiment classifier rule validation
9. `/ella` dashboard go/no-go
10. ChatBubble vs labeled blocks on `/ella/runs/[id]` (2.7 Drake-decide #2)
11. TodayDigest counter content (2.2 Drake-decide #2)
12. Discovery for `/ella` if it's built (2.6 Drake-decide #2)

---

**End of compiled document.** Ready for Drake review and decision-making.
