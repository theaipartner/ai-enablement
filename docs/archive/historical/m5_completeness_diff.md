# M5 cleanup — completeness diff

Generated: `2026-05-04T23:17:20.036228+00:00`

## Summary

- Autocreates planned: **8**
- Fill-gap plans: **180**
- Anomalies: **0**

**Applied counts:**
  - `autocreated`: 8
  - `autocreated_with_placeholder_email`: 5
  - `filled_country`: 180
  - `filled_phone`: 92
  - `filled_slack_user_id`: 1
  - `filled_start_date`: 180
  - `primary_csm_assigned`: 5
  - `slack_channels_inserted`: 29
  - `standing_history_seeded`: 3
  - `status_history_seeded`: 8

## Autocreates (8)

| Name | Tab | CSV row | Email | Email synth? | Status (CSV → Gregory) | Country | Owner |
|---|---|---|---|---|---|---|---|
| Vaishali Adla | USA | 45 | vaishali_adla+import@placeholder.invalid | yes (placeholder) | `N/A` → `churned` | USA | Nabeel Junaid |
| Scott Stauffenberg | USA | 81 | scott_stauffenberg+import@placeholder.invalid | yes (placeholder) | `N/A` → `churned` | USA | Nabeel Junaid |
| Clyde Vinson | USA | 87 | clyde_vinson+import@placeholder.invalid | yes (placeholder) | `N/A` → `churned` | USA | (no owner) |
| Rachelle Hernandez | USA | 132 | rachelle_hernandez+import@placeholder.invalid | yes (placeholder) | `N/A` → `churned` | USA | (no owner) |
| Matthew Gibson | USA | 180 | leandeavor@gmail.com | no | `Active` → `active` | USA | Nico Sandoval |
| Melvin Dayal | AUS | 2 | mel2.kar3@hotmail.com | no | `Churn (Aus)` → `churned` | AUS | Lou Perez |
| Mishank | AUS | 8 | mishank+import@placeholder.invalid | yes (placeholder) | `Churn (Aus)` → `churned` | AUS | (no owner) |
| Anthony Huang | AUS | 10 | anthony@techmanual.io | no | `Churn (Aus)` → `churned` | AUS | Lou Perez |

## Fill-gap plans (180)

**Counts per field:**

- `country`: 180
- `phone`: 92
- `slack_user_id`: 1
- `start_date`: 180
- `slack_channels` inserts (zero-row clients): 26
- `placeholder.invalid` replacements (subset of email fills): 0
- `country` conflicts (skipped fills): 0
- `slack_user_id` collisions (skipped fills): 0

**Per-client fill detail:**

| Client | Tab | Fills | Channel insert | Anomalies |
|---|---|---|---|---|
| Abel Asfaw | USA | phone='+1 347-985-3858', start_date='2026-01-14', country='USA' | — | — |
| Adam Macdonald | USA | phone='+1 203-921-7494', start_date='2025-11-19', country='USA' | — | — |
| Adarsh Sivasubramani | USA | start_date='2025-09-02', country='USA' | — | — |
| Adeeb Mohammed | USA | phone='+1 203-979-2666', start_date='2026-03-07', country='USA' | — | — |
| Ajalynn Domingo | USA | start_date='2025-08-03', country='USA' | — | — |
| Alex Crosby | USA | start_date='2025-12-07', country='USA' | — | — |
| Allison Jayme Boeshans | USA | phone='+1 714-393-1984', start_date='2026-02-03', country='USA' | — | — |
| Amaan Mehmood | USA | phone='+1 484-747-5094', start_date='2026-01-26', country='USA' | — | — |
| Amanda S. | USA | phone='+1 586-275-8676', start_date='2025-11-12', country='USA' | — | — |
| Ameet Kumar | USA | phone='+1 518-645-4909', start_date='2026-03-07', country='USA' | — | — |
| Andrew Hsu | USA | start_date='2025-09-20', country='USA' | — | — |
| Andy V | USA | start_date='2025-12-23', country='USA' | — | — |
| Anica Green | USA | start_date='2025-07-24', country='USA' | — | — |
| Annie Yang | USA | phone='+1 201-616-6104', start_date='2026-02-19', country='USA' | — | — |
| Anthony Palumbo | USA | start_date='2025-07-03', country='USA' | — | — |
| Art Nuno | USA | phone='+1 949-500-4933', start_date='2026-04-04', country='USA' | — | — |
| Ashan Fernando | USA | start_date='2025-06-17', country='USA' | — | — |
| Austin Burke | USA | phone='+1 630-853-0560', start_date='2025-11-19', country='USA' | — | — |
| Avery Walker | USA | phone='+9711 480-652-7276', start_date='2025-08-05', country='USA' | — | — |
| Barre Ali | USA | start_date='2025-06-26', country='USA' | — | — |
| Basem Romio | USA | start_date='2025-08-27', country='USA' | C09CKPWPMC4 | — |
| Benjamin Baros | USA | start_date='2025-09-25', country='USA' | — | — |
| Braden Threlkeld | USA | start_date='2025-07-27', country='USA' | C097Q3KV1PW | — |
| Bradley Crocker | USA | start_date='2025-08-19', country='USA' | — | — |
| Brendan Groves | USA | phone='+1 267-733-7022', start_date='2026-01-19', country='USA' | — | — |
| Brian Arellano | USA | phone='+1 408-394-4540', start_date='2026-03-16', country='USA' | — | — |
| Brian Kenny | USA | start_date='2025-08-08', country='USA' | — | — |
| Brooke Gorman | USA | phone='+1 609-992-6276', start_date='2026-01-31', country='USA' | — | — |
| Camilo Corona | USA | start_date='2025-09-26', country='USA' | — | — |
| Charles Biller | USA | start_date='2025-10-22', country='USA' | — | — |
| Charles Retzer | USA | start_date='2025-08-06', country='USA' | — | — |
| Cheston Nguyen | USA | start_date='2025-07-09', country='USA' | C095M97K4UT | — |
| Chikezie Igwebuike | USA | start_date='2025-10-05', country='USA' | — | — |
| Chris Ferrente | USA | start_date='2025-07-11', country='USA' | — | — |
| Chris Hainlen | USA | phone='+1 903-605-6398', start_date='2026-04-27', country='USA' | C0AVDP5R9H9 | — |
| Christian Brooks | USA | start_date='2025-10-22', country='USA' | — | — |
| Cindy Yu | USA | phone='+1 972-877-3497', start_date='2025-09-16', country='USA' | — | — |
| Cole Coughlin | USA | start_date='2025-08-01', country='USA' | — | — |
| Colin Hill | USA | start_date='2025-07-23', country='USA' | — | — |
| connor savage | USA | start_date='2025-07-23', country='USA' | C097VJRM9T2 | — |
| Connor Tierney | USA | start_date='2025-08-05', country='USA' | — | — |
| Cyan Misencik | USA | start_date='2025-07-16', country='USA' | — | — |
| Dadiana Perez | USA | phone='+1 561-789-3412', start_date='2026-01-27', country='USA' | — | — |
| Daniel Wajsbrot | USA | start_date='2025-08-10', country='USA' | — | — |
| Dante Newton | USA | start_date='2025-12-08', country='USA' | — | — |
| Darin Goodrum | USA | phone='+1 316-322-5868', start_date='2026-03-18', country='USA' | — | — |
| David De Los Santos | USA | start_date='2025-09-14', country='USA' | — | — |
| DeJuan Buchanan | USA | phone='+1 463-290-0887', start_date='2026-04-24', country='USA' | Brendan Groves | — |
| Dhamen Hothi | USA | phone='+1 209-850-5549', start_date='2026-02-16', country='USA' | — | — |
| Dinesh | AUS | start_date='2025-11-10', country='AUS' | — | — |
| Dominique Frederick | USA | phone='+1 718-216-8701', start_date='2026-04-07', country='USA' | — | — |
| Edward Molina | USA | phone='+1 619-948-7660', start_date='2025-09-03', country='USA' | — | — |
| Elan Kamen | USA | start_date='2025-07-21', country='USA' | — | — |
| Elizabeth Williams | USA | phone='+1 678-332-0909', start_date='2026-03-18', country='USA' | — | — |
| Emmanuel DharaCharles | USA | start_date='2025-09-19', country='USA' | C09FC41H3C4 | — |
| Eric Brown | USA | start_date='2025-11-01', country='USA' | C09Q2KGFXEH | — |
| Eric Washington | USA | phone='+1 813-509-7767', start_date='2025-09-30', country='USA' | C09J702HP8S | — |
| Ethan Clark | USA | start_date='2025-06-12', country='USA' | — | — |
| Ethan Evans | USA | start_date='2025-08-15', country='USA' | — | — |
| Evan Bautista | USA | start_date='2025-08-29', country='USA' | C09D5H0E14H | — |
| Ewan Bain | USA | start_date='2025-08-09', country='USA' | — | — |
| Fabio dirico | AUS | slack_user_id='U09SBPR7H0A', start_date='2025-11-05', country='AUS' | C09S9MRHTK8 | — |
| Fernando G | USA | phone='+1 262-577-4223', start_date='2025-11-19', country='USA' | — | — |
| Franco De Klerk | USA | start_date='2025-10-15', country='USA' | — | — |
| Frank Roselli | USA | phone='+1 914-439-5404', start_date='2026-03-26', country='USA' | — | — |
| Giovanni Gregorio | USA | start_date='2025-08-12', country='USA' | C09AB9Q4S3G | — |
| Grayson Carpenter | USA | start_date='2025-09-01', country='USA' | — | — |
| Guillermo Budde | USA | start_date='2025-10-07', country='USA' | — | — |
| Hannah Carter | USA | phone='+1 801-989-1545', start_date='2025-08-12', country='USA' | C09A0SQPXL3 | — |
| Hazel Castillo | USA | phone='+1 972-345-9647', start_date='2025-09-21', country='USA' | — | — |
| Heath Perkins | USA | start_date='2025-08-23', country='USA' | — | — |
| Ian Drogin | USA | phone='+1 530-306-7139', start_date='2025-10-22', country='USA' | — | — |
| Ian Hoorneman | USA | start_date='2025-08-30', country='USA' | — | — |
| Intekhab Naser | USA | phone='+1 443-722-3876', start_date='2025-09-20', country='USA' | — | — |
| Isabel Bledsoe | USA | start_date='2025-10-06', country='USA' | C09KB99K4BW | — |
| Isaiah Mobit | USA | start_date='2025-08-03', country='USA' | — | — |
| James Cowley | USA | phone='+1 810-938-4087', start_date='2026-04-10', country='USA' | — | — |
| James Tran | AUS | start_date='2026-09-02', country='AUS' | — | — |
| Jarrett Fortune | USA | start_date='2025-07-11', country='USA' | — | — |
| Jason Hamm | USA | phone='+1 267-250-9026', start_date='2025-10-09', country='USA' | — | — |
| Javi Pena | USA | phone='+1 786-326-3656', start_date='2025-09-22', country='USA' | — | — |
| Jeff Depew | USA | start_date='2025-07-13', country='USA' | — | — |
| Jenny Burnett | USA | phone='+1 315-651-2469', start_date='2026-02-17', country='USA' | — | — |
| Jerry Thomas | USA | start_date='2025-06-27', country='USA' | — | — |
| Jim Buddle | USA | phone='+1 856-426-3664', start_date='2026-04-08', country='USA' | — | — |
| Joel Barrera | USA | phone='+1 408-712-3843', start_date='2026-04-24', country='USA' | C0B0L1D4REC | — |
| John Keever | USA | phone='+1 512-822-3241', start_date='2026-03-22', country='USA' | — | — |
| Jonathan Duran | USA | phone='+1 530-580-0011', start_date='2025-11-20', country='USA' | — | — |
| Jordan Lucas | USA | phone='+1 973-715-1822', start_date='2025-09-21', country='USA' | — | — |
| Jose Trejo | USA | start_date='2025-09-29', country='USA' | — | — |
| josh glandorf | USA | phone='+1 512-783-5556', start_date='2025-11-24', country='USA' | — | — |
| Josh Jeanes | USA | phone='+1 319-427-1174', start_date='2026-04-17', country='USA' | — | — |
| Justin J. Fogg | USA | start_date='2025-09-20', country='USA' | — | — |
| KC Lantern (Casie Weneta) | USA | phone='+1 714-308-1354', start_date='2026-02-27', country='USA' | — | — |
| Kenan Cantekin | USA | start_date='2025-08-04', country='USA' | — | — |
| Kevin Black | USA | phone='+1 434-981-7125', start_date='2025-10-10', country='USA' | — | — |
| Kevin Hartley | USA | phone='+1 850-426-2804', start_date='2025-10-20', country='USA' | — | — |
| KEVIN ROY | USA | phone='+1 410-231-1310', start_date='2026-04-21', country='USA' | C0AUF6DHG92 | — |
| Kevin Taheryan | USA | start_date='2025-07-29', country='USA' | — | — |
| Krish Gopalani | USA | phone='+1 917-907-0862', start_date='2026-02-24', country='USA' | C0AGYKHESUA | — |
| Kristen Lee | USA | phone='+1 201-790-4240', start_date='2026-02-09', country='USA' | — | — |
| Kurt Buechler | USA | phone='+1 707-815-5851', start_date='2026-03-15', country='USA' | — | — |
| Kylie Goldsmith | USA | start_date='2025-10-18', country='USA' | — | — |
| Le-Minh Khieu | USA | start_date='2025-09-01', country='USA' | — | — |
| Lenrico Williams | USA | start_date='2025-09-01', country='USA' | — | — |
| Luis Malo | USA | phone='+1 619-757-5393', start_date='2026-01-24', country='USA' | — | — |
| Lumiere Valentine | USA | start_date='2025-10-08', country='USA' | — | — |
| Mac McLaughlin | USA | phone='+1 267-994-6638', start_date='2025-11-03', country='USA' | — | — |
| Madison Adam | USA | start_date='2025-07-27', country='USA' | — | — |
| Marcus Blackmon | USA | start_date='2025-10-17', country='USA' | — | — |
| Marcus Miller | USA | phone='+1 720-681-2417', start_date='2025-09-12', country='USA' | — | — |
| Mark Dawson | USA | phone='+1 804-971-5915', start_date='2026-04-10', country='USA' | C0ASD3DLMSN | — |
| Mark Entwistle | USA | phone='+1 252-573-0824', start_date='2026-03-16', country='USA' | — | — |
| Mary Kissiedu | USA | phone='+1 202-361-1462', start_date='2025-08-29', country='USA' | — | — |
| Matt Leblanc | USA | start_date='2025-07-19', country='USA' | — | — |
| Maurya Yenugachenna | USA | phone='+1 925-389-4486', start_date='2026-01-21', country='USA' | — | — |
| Michael Garner | USA | phone='+1 614-354-8040', start_date='2026-04-08', country='USA' | — | — |
| Michael Shaw | USA | phone='+1 507-458-9430', start_date='2025-09-18', country='USA' | — | — |
| Ming-Shih Wang | USA | start_date='2025-09-25', country='USA' | — | — |
| Moctar Toure | USA | phone='+1 323-861-1464', start_date='2026-04-09', country='USA' | — | — |
| Mohammed Nawaz | USA | phone='+1 516-813-8305', start_date='2026-04-15', country='USA' | — | — |
| Mubeen Siddiqui | USA | start_date='2025-07-22', country='USA' | C097VJUBBDW | — |
| Muhammad Omer Masood | USA | start_date='2025-09-22', country='USA' | — | — |
| Muhammed Mudasser | USA | start_date='2025-10-22', country='USA' | — | — |
| Musa Elmaghrabi | USA | phone='+1 949-522-1804', start_date='2025-08-22', country='USA' | — | — |
| Nate Simon | USA | start_date='2025-11-21', country='USA' | — | — |
| Naymuddullah Farhan | AUS | start_date='2025-11-18', country='AUS' | — | — |
| Nic Kieper | USA | phone='+1 920-205-8228', start_date='2026-03-24', country='USA' | — | — |
| Nicholas V. LoScalzo | USA | phone='+1 913-620-6803', start_date='2026-01-12', country='USA' | — | — |
| Nico Bubalo | USA | phone='+1 630-815-9636', start_date='2026-03-20', country='USA' | — | — |
| Nicolas Cabrera | USA | phone='+1 520-470-9751', start_date='2025-09-01', country='USA' | — | — |
| Nolan | USA | phone='+1 603-459-3272', start_date='2025-11-17', country='USA' | — | — |
| Owen Nordberg | USA | start_date='2025-07-10', country='USA' | — | — |
| Patrick Tobin | USA | start_date='2025-08-08', country='USA' | — | — |
| Patrika Cheston | USA | phone='+1 646-776-1020', start_date='2026-03-23', country='USA' | — | — |
| Raga Mamidipaka | USA | start_date='2025-08-25', country='USA' | — | — |
| Rahim Ali | USA | start_date='2025-07-22', country='USA' | — | — |
| Ric Underwood | USA | phone='+1 786-213-7272', start_date='2026-03-29', country='USA' | — | — |
| Rifat Chowdhury | USA | phone='+1 860-796-6128', start_date='2026-04-11', country='USA' | — | — |
| Rob Traffie | USA | phone='+1 623-363-9487', start_date='2026-02-10', country='USA' | — | — |
| Robert Ferruggia | USA | phone='+1 908-500-3687', start_date='2026-04-16', country='USA' | — | — |
| Robert Haskell | USA | start_date='2025-07-14', country='USA' | — | — |
| Rocky Manrique | USA | phone='+1 404-983-6520', start_date='2025-09-15', country='USA' | — | — |
| roula deraz | USA | start_date='2025-11-29', country='USA' | — | — |
| Rubin Linder | USA | phone='+1 925-819-1356', start_date='2026-02-04', country='USA' | C0ADY6NTKHN | — |
| Ruphael G | USA | phone='+1 617-308-9898', start_date='2025-11-22', country='USA' | — | — |
| Russell Broadstone | USA | phone='+1 949-291-7439', start_date='2025-11-03', country='USA' | — | — |
| Ryan Murphy | USA | phone='+1 310-210-9777', start_date='2026-02-22', country='USA' | — | — |
| Saadat Arif | USA | start_date='2025-08-25', country='USA' | — | — |
| Saavan Patel | USA | phone='+1 734-431-5076', start_date='2025-12-31', country='USA' | — | — |
| Sadiq Sumra | USA | phone='+1 347-433-4708', start_date='2025-09-14', country='USA' | — | — |
| Salman Rahman | USA | phone='+1 213-817-4179', start_date='2026-03-30', country='USA' | — | — |
| Samantha Bellisfield | USA | start_date='2025-07-24', country='USA' | — | — |
| samee s | USA | phone='+1 571-435-1523', start_date='2025-11-30', country='USA' | — | — |
| samhealy09@gmail.com | USA | phone='+1 703-673-8774', start_date='2025-10-01', country='USA' | C09J5S16145 | — |
| Samuel Michel | AUS | start_date='2025-11-27', country='AUS' | — | — |
| Sarah Cherney | USA | phone='+1 720-507-1542', start_date='2025-08-22', country='USA' | — | — |
| Sean Mullaney | USA | start_date='2025-08-13', country='USA' | — | — |
| Sean Rounds | USA | phone='+1 949-525-5867', start_date='2025-08-16', country='USA' | C09APUUGX5Y | — |
| Shivam Patel | USA | phone='+9711 469-479-5420', start_date='2025-07-25', country='USA' | — | — |
| Shyam Srinivas | AUS | start_date='2025-11-25', country='AUS' | — | — |
| Sierra Waldrep | USA | phone='+1 256-566-0001', start_date='2026-04-23', country='USA' | C0AVBEBE5ND | — |
| Sonal Patel | USA | start_date='2025-07-30', country='USA' | — | — |
| Srilekha Sikhinam | USA | phone='+1 848-313-5807', start_date='2026-03-06', country='USA' | — | — |
| Steven Bass | USA | start_date='2025-10-07', country='USA' | — | — |
| Sung Yi | USA | start_date='2025-09-20', country='USA' | — | — |
| Sunny Ghanathey | USA | start_date='2025-07-15', country='USA' | — | — |
| Swapnil Napuri | USA | phone='+1 732-997-8241', start_date='2026-04-29', country='USA' | C0B08QELQMD | — |
| Taidhg Driscoll | USA | start_date='2025-09-29', country='USA' | — | — |
| Temitomi Arenyeka | USA | start_date='2025-09-15', country='USA' | C09FC41H3C3 | — |
| Thomas Oh | USA | start_date='2025-08-25', country='USA' | — | — |
| Tina Hussain | USA | phone='+1 847-481-9171', start_date='2026-03-11', country='USA' | — | — |
| Tom Sauer | USA | phone='+1 608-332-4004', start_date='2026-01-31', country='USA' | — | — |
| Trevor Heck | USA | phone='+1 804-426-3411', start_date='2026-02-10', country='USA' | — | — |
| Vid | USA | phone='+1 630-303-6795', start_date='2025-10-30', country='USA' | — | — |
| Yash Verma | USA | start_date='2025-07-28', country='USA' | — | — |
| Yeshlin Singh | AUS | start_date='2025-11-16', country='AUS' | — | — |
| Yogesh Dhaybar | USA | phone='+1 470-240-9312', start_date='2026-04-26', country='USA' | C0AVD0D9ZPC | — |
| Yohann Navarro | USA | phone='+1 971-206-1718', start_date='2025-11-29', country='USA' | — | — |
| Zach Roberts | USA | start_date='2025-10-27', country='USA' | — | — |

## Anomalies (0)

_(none)_

