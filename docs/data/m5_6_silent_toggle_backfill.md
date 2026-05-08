# M5.6 silent-toggle backfill — 17-client snapshot

These 17 clients had `csm_standing = 'at_risk'` before the M5.6 backfill. The backfill flipped `accountability_enabled` and `nps_enabled` from `true` (column default) → `false` on these rows without writing a `client_standing_history` row, because `csm_standing` did not change.

Static snapshot captured 2026-05-03 immediately before applying migration `0022_status_cascade.sql`. Cross-check against the recovery SQL query in `docs/known-issues.md` § "M5.6 silent-toggle backfill — 17 clients flipped accountability/nps without history row."

| status  | full_name        | client_id                            |
|---------|------------------|--------------------------------------|
| churned | Ian Hoorneman    | 7cfc997e-566e-4cfa-8073-afcf13daa9d0 |
| churned | Isabel Bledsoe   | d94ca03d-f821-4acf-904b-70216f38f069 |
| churned | Lumiere Valentine | 6acb08ab-8838-4e79-bf88-662160244ae8 |
| churned | Marcus Blackmon  | 950d4553-e0d2-4467-aeee-d33fd8c5f35f |
| churned | Rubin Linder     | a50b8443-a3fe-4354-8e21-bc16abd120c4 |
| churned | Sung Yi          | dd6b9ed1-b8b4-4c89-ade6-7e3988e4381f |
| ghost   | Patrika Cheston  | 2f459f19-e4f3-4bf7-add1-3740872f6bd8 |
| paused  | Adeeb Mohammed   | 9a463625-a9de-48ab-919a-192efad991c6 |
| paused  | Amanda S.        | 3891c584-8292-4d18-a842-88cf97112313 |
| paused  | Andy V           | 996c821e-a9a2-424f-99d7-1df5c4817ee7 |
| paused  | Eric Brown       | 4edea32c-d4d1-472e-b439-d3fc45ef3396 |
| paused  | Justin J. Fogg   | 39deedc9-1373-4a62-9604-289b956cc7bb |
| paused  | Ming-Shih Wang   | 7ceef331-2b1c-43c4-92fa-40116bc5710b |
| paused  | Mubeen Siddiqui  | 9e0af483-dd8b-4f41-881a-a21989044619 |
| paused  | Sean Rounds      | d79866b8-9905-465d-9f78-cf43f38803ff |
| paused  | Sonal Patel      | e74f7dcf-fb10-4f46-9f9b-50ae0592f3f9 |
| paused  | Temitomi Arenyeka | ef2c023e-d563-4a50-a8bd-42e2186415c0 |

**Distribution:** 6 churned, 1 ghost, 10 paused, 0 leave.

If the recovery SQL query in `docs/known-issues.md` is run today against the post-M5.6-apply state, it should return exactly these 17 client_ids. If the count diverges later, that means: (a) one of the 17 had its `csm_standing` cleared and re-set (creating a real history row, removing it from the silent-toggle set), (b) a CSM has manually flipped `accountability_enabled` or `nps_enabled` back to `true` (the row no longer matches the recovery query's filter), or (c) a future cascade re-fire on one of the 17 (a status transition between negative values) wrote a fresh history row. All three are expected lifecycle outcomes; this snapshot is the immutable "as of M5.6 apply" reference.
