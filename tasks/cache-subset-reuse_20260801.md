# Cache subset-reuse (group + historic range/months)

Goal: reuse a broader cached fetch when the new request is a subset, instead of refetching.
User choices: (1) make "All" include Plants & Fungi so All→Fungi can filter; (2) cache records
and reuse subsets for historic range/month narrowing.

## Key findings
- `groupTaxaList("all")` = 4 animal classes only → "All" never fetched plants/fungi.
- `aggregateRecords` (aggregate.js ~196) UNCONDITIONALLY drops kingdom plant/fungi/etc. — blocks
  "All" from keeping them AND looks like a latent bug in Plants/Fungi mode (drops their records too).
- Recent fetch cache = persisted aggregate keyed by lat,lon,rkm,group,days.
- Historic fetch cache = in-memory, wiped each fetch.
- The cached AGGREGATE already holds per-species `rows` (with dates + src) → we can derive a
  narrower result by FILTERING the aggregate (by class for group; by date/month for historic).
  No raw-record cache needed.

## Part 1 — group subset reuse (recent path)  ✅ DONE (v804)
- [x] `groupTaxaList("all")` += plantae, fungi (so GBIF taxonKey + iNat iconic_taxa fetch them).
- [x] `aggregateRecords`: group-aware kingdom/class filter — animal group keeps its class & drops
      non-animals (unchanged); plantae/fungi keeps that kingdom (FIX); "all" keeps animals+plants+fungi.
- [x] `filterAggByGroup(out, group)` in app.js: keep agg entries whose model class matches, extras
      whose cls matches; recompute bySrc + dedupTotal.
- [x] `fetchAllSightingsAt`: for a subgroup, if a fresh persisted "all" entry exists (same
      lat,lon,rkm,days), return filterAggByGroup(all.out, group) — no network.
- [x] Bumped SIGHT_CACHE_VER 3→4 (aggregation logic changed).

## Part 2 — historic range/month subset reuse  ✅ DONE (v805)
- [x] `histAggCache[lat,lon:rkm:group] = {from,to,months,out}` (NOT wiped; capped ~4; stored only
      on a COMPLETE, non-aborted, non-empty fetch).
- [x] `filterHistAgg(out, from, to, months)`: filter each species' rows by date range + month-of-year,
      recompute count/latestTs/bySrc; drop empty species.
- [x] `histCovers(cached, from, to, reqMonths)`: broader→narrower containment check.
- [x] `plotHistoricAgg(out, grp)` factored out of plotHistoricRecs so reuse can plot from an
      aggregate (no raw records).
- [x] `fetchHistoricSightingsAt`: covered request → filter + plot (accumulate, same as fresh) + return,
      no network. Key insight: a fresh narrower fetch ALSO accumulates dots (doesn't clear), so reuse
      matches existing behaviour — no risky display-filter coupling needed.
- [x] New i18n `hist.reused` (15 langs).

NOTE: reuse plots by accumulation (matches fresh-fetch behaviour). To NARROW the shown dots to the
subset, use the detlist month chips / date-range display filters (already shipped).

## Caveats to surface
- Truncation: "All" now shares GBIF/iNat paging budget across 6 kingdoms → a class can be
  under-sampled vs a dedicated fetch. Derived subgroup may show slightly fewer than a direct fetch.
- Only broader→narrower reuses; narrower→broader fetches.
