# Free-plan limits to stay inside

Check these before bulk jobs. All reset daily (UTC) or monthly as noted.

| Service | Free allowance | Notes |
|---|---|---|
| **R2 storage** | 10 GB / month | Photos are copied at max 2000 px wide (about 0.4-0.6 MB each). The Settings button stops at 8 GB per run. Re-check total size in the R2 dashboard before adding more. |
| **R2 Class A** (writes) | 1 million / month | 1 per photo uploaded. About 8,400 photos = 0.8%. |
| **R2 Class B** (reads) | 10 million / month | 1 per image view served by the Worker route `/api/public/img/*`. Fine for now; if traffic grows, serve images from a public bucket domain with CDN caching. |
| **D1 rows written** | 100,000 / day | Counts index writes too. The initial data load alone used the whole day. Never bulk-load more than ~50,000 rows in a day. Resets 00:00 UTC. |
| **D1 rows read** | 5 million / day | Counts rows *scanned*, not returned. A query without a usable index re-reads the whole table (the photo copier did this and used the whole day on 7 Nov). Index anything used in a WHERE on a big table, avoid COUNT(*) inside loops, and never poll. Resets 00:00 UTC. |
| **D1 storage** | 5 GB | The database is about 20 MB. |
| **Workers requests** | 100,000 / day | Website pages are cached by the website, so mostly CRM use plus listing/lead calls. |
| **Workers CPU** | 10 ms per request (free) | Photo copying streams data so it should be fine; if it errors, the $5/month Workers Paid plan removes this. |
| **Zero Trust (Access)** | 50 users | Plenty. |

If any limit is hit: D1/Workers return errors until the reset time. Upgrading to Workers Paid removes the D1 and Workers limits within minutes.

## Measured D1 reads per action (local test on the real data, 9 Nov)
| Action | Rows read |
|---|---|
| Open CRM (lookups + features) | ~250 (was ~1.3 million) |
| Dashboard | 9 (cached 1 h; 12.7k when refreshed) |
| Contacts page | ~400 (first load of the hour ~10k) |
| Contact search (press Enter) | ~16k |
| Property list / property page / contact page | ~140 / ~30 / ~25 |
| Website listings feed | ~4.5k, then cached 5 min |

The CRM shows "DB reads today" in the header and **stops itself at 4.2M** reads (limit is 5M). Public website listings and enquiries keep working after that.
Rules: no COUNT(*) per request, no polling, no per-keystroke search, index every WHERE/ORDER BY on a table over ~1,000 rows, check with EXPLAIN QUERY PLAN before shipping a query.
