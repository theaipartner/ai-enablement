# The High-Ticket Funnel — Explained Simply

**Who this is for:** anyone who wants to understand what the sales-dashboard
funnel actually measures — no technical background needed. This is the plain-
English companion to the technical map in
`docs/sales/sales-dashboard-architecture.md`.

We'll build this doc up one stage at a time as we verify each part of the
funnel. It starts at the very top (the ads) and will grow downward toward the
closed sales.

---

## First, the most important thing: this is the HIGH-TICKET funnel only

We run more than one offer. This funnel — and this whole dashboard view — is
**only about the high-ticket offer** (the AI Partner program sold on the
strategy/closing calls).

There is a separate **low-ticket "Digital College"** offer (Base44 / Wix). It
has its own ads, its own leads, and its own sales. **None of that belongs in
this funnel.** Whenever we count something here, we are careful to count only
the high-ticket side and leave Digital College out. (Digital College gets its
own tracking elsewhere.)

So the rule for everything below: **if it isn't high-ticket, it doesn't go in
this funnel.**

---

## Stage 1 — Ads (the top of the funnel)

This is where everything begins: we pay Meta (Facebook/Instagram) to show ads,
people click them, and those clicks become leads. The very first two numbers in
the funnel come straight from our ad spend:

- **Adspend** — how much money we spent on ads.
- **Unique link clicks** — how many *different* people clicked the ad's link to
  go to our landing page. ("Unique" means one person clicking five times counts
  as one, not five.)

### Where these numbers come from

Meta is messy to pull from directly, so the team uses a tool called **Cortana**
that consolidates all our Meta ad data in one place. Our system copies Cortana's
numbers into our own database every 3 hours, and the dashboard reads from our
copy (never from Meta or Cortana live). That way the numbers are always ours and
always consistent.

### Which campaigns we count — and which we don't

This is the key idea, and it's simple:

> **We only count ad campaigns labelled "Closer Funnel."**

Every high-ticket ad campaign has `Closer Funnel` in its name (for example:
*"5/17/26 | ANDROMEDA | CBO | Winning Creatives | … | Booking | Closer
Funnel"*). Those are ours. We add up the adspend and unique link clicks from
**only those campaigns**.

**Everything else is deliberately ignored**, including:

- **Other funnels' campaigns** — e.g. anything for Digital College or older
  "Call Funnel" campaigns. Their spend is not high-ticket spend, so it stays
  out.
- **Noise that Meta/Cortana reports as "campaigns"** but isn't a real ad
  campaign — things like `Bot Traffic`, `facebook.com`, `calendly.com`, or test
  rows. These carry no real spend and aren't counted.

Why be this strict? Because the moment another offer (like Digital College)
starts running its own ads, its spend would otherwise sneak into our high-ticket
numbers and make our cost-per-result look wrong. Counting only `Closer Funnel`
campaigns keeps this funnel honest no matter what else is running.

### A note on all the other ad metrics

Cortana also gives us lots more (impressions, CTR, frequency, cost-per-click,
per-ad lead attribution, and so on). Those exist and we store them — but for the
purpose of *this* doc, the two numbers that matter at the top of the funnel are
**adspend** and **unique link clicks**. We'll leave the rest aside for now.

### Verified

For **May 24 – June 5, 2026**, the high-ticket (Closer Funnel) totals are
**~$10,040 in adspend** and **~2,620 unique link clicks** — confirmed to match
across Cortana's account-level, per-campaign, and per-ad figures (they agree to
the cent), with 100% of current account spend belonging to the high-ticket
funnel. The numbers update through the day as Meta finalizes them.

---

*Next stage to document: what happens to those clicks — opt-ins (leads) at the
top of the funnel proper.*
