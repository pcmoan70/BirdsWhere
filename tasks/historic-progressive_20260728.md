# Faster + progressive historic fetch — 2026-07-28

## Requirements (from the user, across messages)
1. Historic fetch is slow → split into ~1-month batches, run a few in parallel (a
   bounded queue).
2. "Historic can also be done on Artportalen and Artsobservasjoner."
3. Plot each month's points on the map AS it arrives (progressive).
4. Order: start with the most recent month, go backwards.

## Findings
- Historic is **GBIF-only** today (`fetchHistoricSightingsAt` → `fetchGbifHistoric`).
- `fetchGbifHistoric` bisects a range by record-count but fetches the halves
  **sequentially** (`await a; await b`) — that's the slowness.
- **Artportalen (SE) + Artsobservasjoner (NO) are ALREADY GBIF datasets** the app
  queries (sources.js DEFAULT_GBIF_DATASETS), country-scoped. So historic already
  includes their data via GBIF. Their DIRECT APIs (artskart / artdatabanken) are used
  only for RECENT (≤90 d) fetches; for past dates GBIF's copy is effectively complete
  (only the newest days may lag GBIF's republish). ⇒ Adding direct-API historic is
  redundant for past dates. (Decision Q below.)

## Done already
- fetch.js: a **global concurrency gate** on `gbifPage` (max 8 in-flight) so splitting
  the work into many parallel batches can't burst past GBIF's rate limiter.

## Plan (core: R1 + R3 + R4)
- app.js: a progressive historic orchestrator (replaces the one-shot fetch on the
  map-plot path):
  - Split [from,to] into calendar-month chunks, **sorted newest→oldest**.
  - Run a bounded pool (~3 parallel) over the chunks.
  - Each chunk → `fetchGbifHistoric(month)` (single range, count-bisecting, gated) →
    normGbif → aggregate → **plot incrementally** (merge into detPlot, rebuildDetLayers)
    so the map fills in month by month, most recent first.
  - Progress: "month i / N".
  - Keep the list's n(d) counts updating too (accumulate into currentSpView._result).
- fetch.js `fetchGbifHistoric` stays a single-range fetcher (the month split + order +
  progressive plot live in app.js, where plotting lives).
- Respect the existing abort (histAbort), the sightings cache, and dedup-by-key.

## Open decision (Q)
Nordic sources: (A) rely on GBIF (already covers Artportalen/Artsobservasjoner; no
extra work) — recommended; or (B) also query their direct APIs per-month for historic
(bigger; marginal benefit only for the most recent days).
