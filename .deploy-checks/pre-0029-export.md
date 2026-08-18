# Pre-0024–0029 deploy export (production, before this deploy)

- Date: 2026-08-18 (this pass)
- Trigger: `gsk hosted d1_query` confirmed working again after being
  `resource_not_found`; user directed prepare-then-hold before this
  deploy touches production.
- Export: `gsk hosted d1_export` — 24 tables, 5780 records.
- Download URL: https://www.genspark.ai/api/files/s/4aMkF1tG
  (auth-protected, visibility follows project — not a public link)
- Deploy scope for THIS deploy: migrations 0024-0029 only. 0030 is
  explicitly HELD BACK per user instruction (recreate-and-copy over
  756 live expected_devices rows; deploy separately once tooling has
  proven itself further).
