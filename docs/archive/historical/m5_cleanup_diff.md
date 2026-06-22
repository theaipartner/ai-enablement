# M5 cleanup — master sheet vs Gregory diff

Generated: `2026-05-04T23:18:17.158174+00:00`

## Summary

- CSV rows total (after blank-name filter): **188**
- Matched to Gregory clients: **188**
- Unmatched: **0**
- Drake silent-skipped: **0**
- Name-ambiguous (>1 Gregory match): **0**
- Field changes proposed: **85** (Tier 1: 0 / Tier 2: 18 / Tier 3: 67)
- Handover note appends: **9** (8 idempotent skips)
- Cascade-redundant csm_standing skips: **0** (cascade sets at_risk; explicit RPC would duplicate the history row)

## Tier 1 — high-confidence auto-applies

_(none)_

## Tier 2 — eyeball required

### email (2)

| Client | Tab | Current | CSV value | Reason |
|---|---|---|---|---|
| Cheston Nguyen | USA | `cheston@395northai.com` | `cheston.nguyen@gmail.com` | CSV email differs from Gregory primary; not in alternate_emails |
| Yeshlin Singh | AUS | `yeshlin_singh@yahoo.com` | `yeshlinp@gmail.com` | CSV email differs from Gregory primary; not in alternate_emails |

### csm_standing (16)

| Client | Tab | Current | CSV value | Reason |
|---|---|---|---|---|
| Benjamin Baros | USA | `at_risk` | `Owing Money` | financial-only standing (no CSM tier) — eyeball |
| Camilo Corona | USA | `at_risk` | `Owing Money` | financial-only standing (no CSM tier) — eyeball |
| Charles Biller | USA | `at_risk` | `N/A (Churn)` | financial-only standing (no CSM tier) — eyeball |
| Daniel Wajsbrot | USA | `at_risk` | `Partial Refund` | financial-only standing (no CSM tier) — eyeball |
| Emmanuel DharaCharles | USA | `at_risk` | `Chargeback` | financial-only standing (no CSM tier) — eyeball |
| Ethan Evans | USA | `at_risk` | `Owing Money` | financial-only standing (no CSM tier) — eyeball |
| Grayson Carpenter | USA | `at_risk` | `Owing Money` | financial-only standing (no CSM tier) — eyeball |
| Heath Perkins | USA | `at_risk` | `Owing Money` | financial-only standing (no CSM tier) — eyeball |
| Jarrett Fortune | USA | `at_risk` | `Refunded` | financial-only standing (no CSM tier) — eyeball |
| Mishank | AUS | `null` | `N/A (Churn)` | financial-only standing (no CSM tier) — eyeball |
| Muhammad Omer Masood | USA | `at_risk` | `Chargeback` | financial-only standing (no CSM tier) — eyeball |
| Muhammed Mudasser | USA | `at_risk` | `Full Refund` | financial-only standing (no CSM tier) — eyeball |
| Patrick Tobin | USA | `at_risk` | `Partial Refund` | financial-only standing (no CSM tier) — eyeball |
| roula deraz | USA | `at_risk` | `Full Refund` | financial-only standing (no CSM tier) — eyeball |
| Steven Bass | USA | `at_risk` | `Chargeback` | financial-only standing (no CSM tier) — eyeball |
| Taidhg Driscoll | USA | `at_risk` | `Full Refund` | financial-only standing (no CSM tier) — eyeball |


## Tier 3 — Scott meeting items (defer auto-apply)

### nps_standing (59)

| Client | Tab | Current | CSV value | Reason |
|---|---|---|---|---|
| Abel Asfaw | USA | `(not loaded)` | `Neutral` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Ajalynn Domingo | USA | `(not loaded)` | `Neutral` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Allison Jayme Boeshans | USA | `(not loaded)` | `Neutral` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Amaan Mehmood | USA | `(not loaded)` | `Promoter` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Amanda S. | USA | `(not loaded)` | `Detractor / At Risk` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Andrew Hsu | USA | `(not loaded)` | `Neutral` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Anthony Palumbo | USA | `(not loaded)` | `Neutral` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Ashan Fernando | USA | `(not loaded)` | `Neutral` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Austin Burke | USA | `(not loaded)` | `Promoter` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Avery Walker | USA | `(not loaded)` | `Promoter` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Brendan Groves | USA | `(not loaded)` | `Promoter` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Cindy Yu | USA | `(not loaded)` | `Neutral` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Cole Coughlin | USA | `(not loaded)` | `Detractor / At Risk` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Dadiana Perez | USA | `(not loaded)` | `Promoter` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Dhamen Hothi | USA | `(not loaded)` | `Neutral` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Dominique Frederick | USA | `(not loaded)` | `Promoter` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Edward Molina | USA | `(not loaded)` | `Promoter` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Elizabeth Williams | USA | `(not loaded)` | `Neutral` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Fernando G | USA | `(not loaded)` | `Promoter` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Frank Roselli | USA | `(not loaded)` | `Promoter` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Ian Drogin | USA | `(not loaded)` | `Promoter` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Intekhab Naser | USA | `(not loaded)` | `Detractor / At Risk` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Isabel Bledsoe | USA | `(not loaded)` | `Detractor / At Risk` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Jason Hamm | USA | `(not loaded)` | `Promoter` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Javi Pena | USA | `(not loaded)` | `Promoter` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Jenny Burnett | USA | `(not loaded)` | `Detractor / At Risk` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Jerry Thomas | USA | `(not loaded)` | `Promoter` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Jonathan Duran | USA | `(not loaded)` | `Promoter` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| josh glandorf | USA | `(not loaded)` | `Promoter` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| KC Lantern (Casie Weneta) | USA | `(not loaded)` | `Promoter` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Kenan Cantekin | USA | `(not loaded)` | `Promoter` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Krish Gopalani | USA | `(not loaded)` | `Neutral` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Kristen Lee | USA | `(not loaded)` | `Promoter` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Kurt Buechler | USA | `(not loaded)` | `Detractor / At Risk` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Luis Malo | USA | `(not loaded)` | `Promoter` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Mac McLaughlin | USA | `(not loaded)` | `Promoter` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Marcus Miller | USA | `(not loaded)` | `Promoter` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Mark Entwistle | USA | `(not loaded)` | `Detractor / At Risk` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Mary Kissiedu | USA | `(not loaded)` | `Neutral` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Matt Leblanc | USA | `(not loaded)` | `Detractor / At Risk` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Michael Shaw | USA | `(not loaded)` | `Detractor / At Risk` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Musa Elmaghrabi | USA | `(not loaded)` | `Promoter` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Naymuddullah Farhan | AUS | `(not loaded)` | `Neutral` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Nicholas V. LoScalzo | USA | `(not loaded)` | `Promoter` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Nico Bubalo | USA | `(not loaded)` | `Promoter` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Nolan | USA | `(not loaded)` | `Detractor / At Risk` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Owen Nordberg | USA | `(not loaded)` | `Promoter` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Rahim Ali | USA | `(not loaded)` | `Neutral` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Ryan Murphy | USA | `(not loaded)` | `Detractor / At Risk` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Sadiq Sumra | USA | `(not loaded)` | `Promoter` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Salman Rahman | USA | `(not loaded)` | `Promoter` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Samantha Bellisfield | USA | `(not loaded)` | `Neutral` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Samuel Michel | AUS | `(not loaded)` | `Detractor / At Risk` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Shivam Patel | USA | `(not loaded)` | `Neutral` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Srilekha Sikhinam | USA | `(not loaded)` | `Neutral` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Tina Hussain | USA | `(not loaded)` | `Neutral` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Tom Sauer | USA | `(not loaded)` | `Promoter` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Trevor Heck | USA | `(not loaded)` | `Promoter` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |
| Vid | USA | `(not loaded)` | `Neutral` | NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball |

### primary_csm (4)

| Client | Tab | Current | CSV value | Reason |
|---|---|---|---|---|
| Alex Crosby | USA | `Scott Chasing` | `Aleks` | Aleks-owned (M4 Chunk C carry-over — Scott reassignment) |
| Colin Hill | USA | `null` | `Aleks` | Aleks-owned (M4 Chunk C carry-over — Scott reassignment) |
| Jose Trejo | USA | `Scott Chasing` | `Aleks` | Aleks-owned (M4 Chunk C carry-over — Scott reassignment) |
| Ming-Shih Wang | USA | `Scott Chasing` | `Aleks` | Aleks-owned (M4 Chunk C carry-over — Scott reassignment) |

### status (4)

| Client | Tab | Current | CSV value | Reason |
|---|---|---|---|---|
| Clyde Vinson | USA | `churned` | `N/A` | CSV status is blank or N/A — needs Scott decision |
| Rachelle Hernandez | USA | `churned` | `N/A` | CSV status is blank or N/A — needs Scott decision |
| Scott Stauffenberg | USA | `churned` | `N/A` | CSV status is blank or N/A — needs Scott decision |
| Vaishali Adla | USA | `churned` | `N/A` | CSV status is blank or N/A — needs Scott decision |


