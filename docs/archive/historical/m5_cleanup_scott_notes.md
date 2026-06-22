# M5 cleanup — Scott meeting notes

Generated: `2026-05-04T23:18:17.158174+00:00`

## Bucket A — pre-apply ambiguities (Scott decides)

### A1. Blank or N/A status (4)

| Client | Tab | Current Gregory | CSV value |
|---|---|---|---|
| Clyde Vinson | USA | `churned` | `N/A` |
| Rachelle Hernandez | USA | `churned` | `N/A` |
| Scott Stauffenberg | USA | `churned` | `N/A` |
| Vaishali Adla | USA | `churned` | `N/A` |

### A2. Aleks-owned rows (4)

- **Alex Crosby** (USA) — current owner `Scott Chasing`
- **Colin Hill** (USA) — current owner `null`
- **Jose Trejo** (USA) — current owner `Scott Chasing`
- **Ming-Shih Wang** (USA) — current owner `Scott Chasing`

### A3. Name-ambiguous CSV rows (0)

_(none)_

### A4. NPS Standing CSV-vs-Gregory (59)

_(Path 1 owns `clients.nps_standing`; CSV's NPS Standing column is Scott's read. Surfaced for eyeball — never auto-applied.)_

| Client | Tab | Gregory NPS Standing | CSV NPS Standing |
|---|---|---|---|
| Abel Asfaw | USA | `(not loaded)` | `Neutral` |
| Ajalynn Domingo | USA | `(not loaded)` | `Neutral` |
| Allison Jayme Boeshans | USA | `(not loaded)` | `Neutral` |
| Amaan Mehmood | USA | `(not loaded)` | `Promoter` |
| Amanda S. | USA | `(not loaded)` | `Detractor / At Risk` |
| Andrew Hsu | USA | `(not loaded)` | `Neutral` |
| Anthony Palumbo | USA | `(not loaded)` | `Neutral` |
| Ashan Fernando | USA | `(not loaded)` | `Neutral` |
| Austin Burke | USA | `(not loaded)` | `Promoter` |
| Avery Walker | USA | `(not loaded)` | `Promoter` |
| Brendan Groves | USA | `(not loaded)` | `Promoter` |
| Cindy Yu | USA | `(not loaded)` | `Neutral` |
| Cole Coughlin | USA | `(not loaded)` | `Detractor / At Risk` |
| Dadiana Perez | USA | `(not loaded)` | `Promoter` |
| Dhamen Hothi | USA | `(not loaded)` | `Neutral` |
| Dominique Frederick | USA | `(not loaded)` | `Promoter` |
| Edward Molina | USA | `(not loaded)` | `Promoter` |
| Elizabeth Williams | USA | `(not loaded)` | `Neutral` |
| Fernando G | USA | `(not loaded)` | `Promoter` |
| Frank Roselli | USA | `(not loaded)` | `Promoter` |
| Ian Drogin | USA | `(not loaded)` | `Promoter` |
| Intekhab Naser | USA | `(not loaded)` | `Detractor / At Risk` |
| Isabel Bledsoe | USA | `(not loaded)` | `Detractor / At Risk` |
| Jason Hamm | USA | `(not loaded)` | `Promoter` |
| Javi Pena | USA | `(not loaded)` | `Promoter` |
| Jenny Burnett | USA | `(not loaded)` | `Detractor / At Risk` |
| Jerry Thomas | USA | `(not loaded)` | `Promoter` |
| Jonathan Duran | USA | `(not loaded)` | `Promoter` |
| josh glandorf | USA | `(not loaded)` | `Promoter` |
| KC Lantern (Casie Weneta) | USA | `(not loaded)` | `Promoter` |
| Kenan Cantekin | USA | `(not loaded)` | `Promoter` |
| Krish Gopalani | USA | `(not loaded)` | `Neutral` |
| Kristen Lee | USA | `(not loaded)` | `Promoter` |
| Kurt Buechler | USA | `(not loaded)` | `Detractor / At Risk` |
| Luis Malo | USA | `(not loaded)` | `Promoter` |
| Mac McLaughlin | USA | `(not loaded)` | `Promoter` |
| Marcus Miller | USA | `(not loaded)` | `Promoter` |
| Mark Entwistle | USA | `(not loaded)` | `Detractor / At Risk` |
| Mary Kissiedu | USA | `(not loaded)` | `Neutral` |
| Matt Leblanc | USA | `(not loaded)` | `Detractor / At Risk` |
| Michael Shaw | USA | `(not loaded)` | `Detractor / At Risk` |
| Musa Elmaghrabi | USA | `(not loaded)` | `Promoter` |
| Naymuddullah Farhan | AUS | `(not loaded)` | `Neutral` |
| Nicholas V. LoScalzo | USA | `(not loaded)` | `Promoter` |
| Nico Bubalo | USA | `(not loaded)` | `Promoter` |
| Nolan | USA | `(not loaded)` | `Detractor / At Risk` |
| Owen Nordberg | USA | `(not loaded)` | `Promoter` |
| Rahim Ali | USA | `(not loaded)` | `Neutral` |
| Ryan Murphy | USA | `(not loaded)` | `Detractor / At Risk` |
| Sadiq Sumra | USA | `(not loaded)` | `Promoter` |

_(...truncated; 9 more — see full diff)_

### A5. "Owing Money" / unparseable standing (16)

- **Benjamin Baros** (USA) — CSV value `Owing Money`, current Gregory `at_risk`
- **Camilo Corona** (USA) — CSV value `Owing Money`, current Gregory `at_risk`
- **Charles Biller** (USA) — CSV value `N/A (Churn)`, current Gregory `at_risk`
- **Daniel Wajsbrot** (USA) — CSV value `Partial Refund`, current Gregory `at_risk`
- **Emmanuel DharaCharles** (USA) — CSV value `Chargeback`, current Gregory `at_risk`
- **Ethan Evans** (USA) — CSV value `Owing Money`, current Gregory `at_risk`
- **Grayson Carpenter** (USA) — CSV value `Owing Money`, current Gregory `at_risk`
- **Heath Perkins** (USA) — CSV value `Owing Money`, current Gregory `at_risk`
- **Jarrett Fortune** (USA) — CSV value `Refunded`, current Gregory `at_risk`
- **Mishank** (AUS) — CSV value `N/A (Churn)`, current Gregory `null`
- **Muhammad Omer Masood** (USA) — CSV value `Chargeback`, current Gregory `at_risk`
- **Muhammed Mudasser** (USA) — CSV value `Full Refund`, current Gregory `at_risk`
- **Patrick Tobin** (USA) — CSV value `Partial Refund`, current Gregory `at_risk`
- **roula deraz** (USA) — CSV value `Full Refund`, current Gregory `at_risk`
- **Steven Bass** (USA) — CSV value `Chargeback`, current Gregory `at_risk`
- **Taidhg Driscoll** (USA) — CSV value `Full Refund`, current Gregory `at_risk`

### A6. Handover-note targets unresolved (1)

- **Lou (no client by that name in either CSV — spec ambiguous)**

### A8. Email mismatches (2)

_(CSV email differs from Gregory primary AND not in `alternate_emails`. Handle per `docs/runbooks/backfill_nps_from_airtable.md` § Failure modes — per-client triage to alternate_emails. Don't bulk-apply.)_

- **Cheston Nguyen** (USA) — Gregory `cheston@395northai.com`, CSV `cheston.nguyen@gmail.com`
- **Yeshlin Singh** (AUS) — Gregory `yeshlin_singh@yahoo.com`, CSV `yeshlinp@gmail.com`

## Bucket B — post-apply mismatches (Scott confirms)

_(Phase 2 has not run yet. Run with `--apply` to populate this section.)_

## Quick reference — status directives applied

_(no status flips proposed)_


---

## needs_review walkthrough close-out (2026-05-05)

End-of-cleanup audit trail. Drake walked the dashboard's `Needs Review` filter end-to-end on 2026-05-05 and resolved every flagged row. This section captures what actually happened so the trail is auditable; Scott doesn't need to walk through every entry tomorrow.

### 3 client rows soft-archived (Fathom misclassifications)

Discoverable via `WHERE metadata->>'archived_via' = 'm5_cleanup_misclassification_archive'`.

| Client (DB row) | Misclassification type | Calls reclassified | Reroute |
|---|---|---|---|
| Andrés González (`andy@thecyberself.com`) | `external_hiring` | 3 calls → `category='external'`, `primary_client_id=NULL`, `is_retrievable=False` | — |
| Aman (`amanxli4@gmail.com`) | `internal_team` | 1 call → `category='internal'`, `primary_client_id=NULL`, `is_retrievable=False` | — |
| Branden Bledsoe (`brandenbledsoe@transcendcu.com`) | `representative_of_other_client` | 1 call kept `category='client'`; `primary_client_id` repointed to Isabel Bledsoe | Isabel Bledsoe (`d94ca03d-f821-4acf-904b-70216f38f069`) |

Andy + Aman: 4 linked documents flipped to `is_active=false` (defensive over-suppress; 1 was already inactive). Branden: 1 linked document kept active (it's now Isabel's offboarding-call summary, legitimately retrievable for her account).

### 12 merges performed today

Discoverable via `WHERE metadata->>'merged_at' LIKE '2026-05-05%'`. Drake's Slack-mentioned count was "4 merges" — the data shows 12 in the May-5 walkthrough window (03:16–03:43 UTC). Either the 4 referenced a notable subset or the count was rough; the full 12 are listed below for completeness.

| Source row (auto-created duplicate) | Merged into |
|---|---|
| Brooke Gorman | `2fd76c8d-3c76-4646-82da-a1f3a1aef83d` |
| `ataylor2879@gmail.com` | `a2f1517e-f351-4c39-bde6-3478c1b3b319` |
| `mr.andrew.hsu@gmail.com` | `86779b9f-62ec-46d1-93cb-e285e07d61bf` |
| Nathan Simon (×2 source rows) | `66bd4ae8-041e-4160-92c0-abf0fe7a3f14` |
| Robert Traffie (Apple iMIP duplicate — see followups entry) | `cfaac08e-b588-4405-a3d8-7b1377b50806` |
| `kevin@myflowbook.com` | `6cda47f0-4310-482b-b90c-54692a2f9ed9` |
| ruphael getahun | `22dbdbb9-eae8-465f-b819-1b5349b14447` |
| `johnfernandes960@gmail.com` | `2e2663fe-6599-4c6b-b7f5-3b711a11c92b` |
| `naturalnautica13@gmail.com` | `66bd4ae8-041e-4160-92c0-abf0fe7a3f14` (also Nathan Simon — 3 dupes total for him) |
| `salmanr85@outlook.com` | `2c1969b9-dca8-46ca-a2d2-a3e716513fde` |
| `samb@gmail.com` | `4c2736ea-f20b-4af7-8e69-7f3f483c1f0b` |

### ~13 needs_review detags

Drake-driven via the dashboard during the walkthrough. Each detag was a "I confirmed this client matches the canonical row I already had — no merge needed, just clear the flag." Specific clients aren't auditable from current DB state because `clients.tags` has no history table; the tag is either present or absent. Followup logged (`needs_review tag doesn't auto-clear after manual reconciliation`) covering future automation of the detag step.

### End-state

- **188 non-archived clients** (was 191 pre-archive; -3 ✓)
- **188 CSV rows** on the canonical 2026-05-04 master sheet
- **Perfect 1:1 match** between Gregory and the master sheet — zero extras on the Gregory side, zero unmatched on the CSV side
- Reconcile dry-run idempotent (0 Tier 1 changes); cleanup script leaves Gregory in steady state until the next master sheet edit
