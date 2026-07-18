# Optimization pass (behavior frozen) — 2026-07-18/19

Goal: optimize for speed, then reduce code overlap + size, homogenize UI. No test
suite → only ship changes that provably cannot alter behavior; stage the risky ones.

## Deep analysis (2 parallel agents)

### Speed hotspots (biggest → smallest)
1. **GeoState.write re-serialises the WHOLE blob (incl. up to 15k `mapDetections`
   rows) on every save** — incl. `save({view})` on every moveend and every
   settings toggle. THE elephant. Safe full fix = move `mapDetections` out of the
   localStorage blob (own key / IndexedDB) so the hot blob is tiny. RISKY (touches
   Drive sync, capped-write self-heal, direct localStorage reads, `lastSaveOk`
   synchronous contract). → STAGED. Did the safe partial: debounce the moveend
   view save.
2. **collectVisibleDetections / hover** — `map.distance` + `L.latLng` alloc per row
   over all plotted rows on every marker mouseover. → FIXED (bbox pre-filter).
3. **computeDetProbs** — ~40 column inferences per plotted-set change. Batching to
   one `raw` pass = 1 forward pass but `nPoints×12012` transfer (~MBs) → NOT clearly
   a win on mobile; column calls return tiny arrays. Left as-is.
4. **renderDetGroup** — two passes re-running the same 3 filters + rebuilding the
   location key twice. → FIXED (single filter pass, key computed once, count reuse).
5. **updateDetLegend** — double `recolorDetections` when paired with
   rebuildDetLayers; per-species GeoState.get in sort. Minor (cache landed already);
   recolor-dedup needs a dirty flag (colour correctness risk) → left.
6. **aggregateRecords** — per-record getTaxByCode() ref call. Negligible → left.

### Duplication / overlap
- `weekOfToday` duplicated the model-week formula of `weekOfDate`. → FIXED.
- `todayStr` duplicated `fmtDateFile`. → FIXED.
- `csvEsc` copied in analysis.js — needs ctx injection, saves 1 line → skipped (risk > gain).
- haversine (app `haversineKm` vs geo `_distM`), clamp pattern (~40 sites),
  days-since (~10 sites, differing rounding) → deliberately NOT deduped (coupling /
  behaviour-sensitive).

## Done this pass (sw v639) — all behaviour-preserving
- [x] moveend view save debounced (600ms + flush on hide/unload) — kills per-pan 15k-row serialize.
- [x] collectVisibleDetections: cheap bbox reject before map.distance (hover path).
- [x] renderDetGroup: one filter pass feeds the draw pass; location key computed once.
- [x] weekOfToday → weekOfDate; todayStr → fmtDateFile (dedup + size).

## Staged (need care / sign-off; higher risk, no tests)
- [ ] Move `mapDetections` out of the localStorage blob (the real GeoState win).
- [ ] Homogenise UI builders (anchored menus, modals, control-rows) into shared
      factories — the main code-SIZE lever, but broad interactive-code refactor.
- [ ] recolorDetections dirty-flag dedup.
