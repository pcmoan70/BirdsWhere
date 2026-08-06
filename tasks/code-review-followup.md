# Code Review — follow-up plan

Living plan from the multi-agent reviews (2026-06-18, refreshed after the v452–v457
fixes). Items marked `[verified]` were spot-checked against the code this pass.

## ✅ Done
**Top 4 perf (v452–v455):** GeoState parse-cache · detSelectionActive once/render ·
H3 paint memoization (`h3Shape`/`h3ResOf`) · species p90/median quickselect.
**Parallel batch (v456):** Drive-sync push ignores `updatedAt`-only diff + reload
guard keyed on remote stamp · aggregate reuse `pg`/`snLower` + `resetSciIndex()` ·
`visibleSpecies` memo · `sw.js trim()` serialized.
**Cleanups (v457):** removed dead `muted` branch · precomputed legend/blocked-list
sort names · `aggregateRecords` returns `dedupTotal` (dropped 2 sum-loops) ·
consolidated one inline `csvEsc` · removed the dead "Submit to eBird" stub button ·
`Date.now()` hoisted · removed dead `ensureDetWait`/`fcLatest` · `onDetMarkerClick`
dead args dropped.

---

## 🐛 Bugs (correctness) — do these first; small + high value

- [ ] **B1 [verified] Timed-out source reported as a hard failure** — `app.js:1893`:
  `var fi = failed.indexOf(s.name)` searches an array of `{name,error}` objects for a
  string → always −1 → the splice never runs, so a timed-out source stays in BOTH
  `timedOut` and `failed`, and `reportFetchErrors` pops an error dialog for a mere
  timeout (the comment says it shouldn't). → `failed.findIndex(f => f.name === s.name)`.
- [ ] **B2 [verified] Points panel has no close path** — `closeDropdowns()`
  (`app.js:10582`) hard-codes `["hidden-panel","checklists-panel","settings-panel"]`,
  omitting `mp-panel` (a `.dd-panel`, wired at 7441); and `mp-toggle` lacks the
  `dd-toggle` class so the outside-click handler doesn't close it either. → Add
  `"mp-panel"` to the list (and/or give the toggle `dd-toggle`).
- [ ] **B3 [verified] GBIF dedup misses blank-observer sources** — `aggregate.js:156,162`
  only register/drop a dup when `r.observer` is truthy. iNat/Artsobs/Laji often have a
  blank observer (Laji always), so their GBIF republish double-counts (Laji is saved
  only by the `LAJI_GBIF_KEY` skip). → Drop the `&& r.observer` guard (fold observer as
  `""` into the key) so species+location+count still dedups.
- [ ] **B4 Corroboration ring uses raw observer string** — `app.js:~4937-4941`:
  `obsByLoc` counts `r.observer.trim()` whole, so `"A | B"` counts as ONE observer (no
  ≥2 ring) — inconsistent with the `detObsRealNames` split used in hover/legend. → Use
  `detObsRealNames(r.observer)` when populating `obsByLoc`.
- [ ] **B5 iNat fetch truncates on a transient error** — `fetch.js:~226`:
  `fetchInatAll` does `await (await fetch(...)).json()` with no `resp.ok` check; a 429/5xx
  ends paging silently (unlike GBIF's retry/backoff). → Check `resp.ok`; retry transient
  statuses (ideally via a shared `fetchJson` helper — see #8).
- [ ] **B6 Transient total-failure cached as "no sightings"** — `app.js:~1909`:
  `allSightingsCache[ck] = pr` keeps the resolved promise even when every source failed
  (guardFetch swallows to `[]`), so one network blip = empty result for the rest of the
  session at that point. → On all-failed, delete the cache entry so a retry re-fetches.
- [ ] **B7 Historic recovery double-fetches + resets the progress bar** — `fetch.js`
  `fetchGbifHistoric`: the completeness-recovery bisection re-fetches both halves
  (re-counting + re-paging, discarding `recs`), and each recursive `fetchGbifAll` settles
  its own `prog` to 100% so the bar jumps 0→100 several times. → Thread a shared progress
  accumulator; dedup recovered records against `recs` (or skip the already-complete part).
- [ ] **B8 Nordic fallback box balloons at high latitude** — `geo.js` `nearCountry`:
  `dLon = mk/(111·cos lat)` isn't clamped, so near the pole the NO box extends far east
  into SE/FI (offline-first-load window only). → Clamp the degree margin (mirror
  `gbifGeometry`'s `cos > 0.01`).

---

## 🟠 Design (medium effort/risk)

- [ ] **#5 Sightings cache key omits config (partly mitigated)** — `fetchAllSightingsAt`
  (`app.js:~1864`) keys on `lat,lon:rkm` only. The `AppSources` setters now flush
  `allSightingsCache` via `onConfigChange`, so source toggles / gbif-days / keys ARE
  covered — BUT `histSightingsCache` is NOT flushed by `onConfigChange`, `setFetchTimeoutSec`
  clears only `allSightingsCache`, and a `speciesGroup` change flushes neither. → Route ALL
  invalidation through one `invalidateSightings()` (both caches), call it from
  `onConfigChange` + timeout + group changes; optionally fold a config signature into the key.
- [ ] **#6 Source registry + retire the legacy fetch stack** — `runDirectSource`/`testSourceKey`
  /key-storage are parallel `if (s.id===…)` ladders; the legacy `gbifRecent`/`inatRecent`/
  `ebirdRecent` (used only by `showRecent`) duplicate the `AppFetch` adapters AND lack the
  `signal`/timeout/retry the new path has. → One registry `{fetch,norm,probe,keyGetter}`;
  fold `showRecent` onto `AppFetch` with a species filter; delete the legacy trio.
- [ ] **#8 Consolidate duplication** — two CSV builders (`fieldChecklistCsv`/`fieldRecordCsv`),
  two PDF scaffolds (`exportFieldPdf`/`exportSpeciesPdf`), two species-list renderers
  (`renderSpeciesList`/`renderSpeciesInCountry`), the open-blank-tab idiom ×3
  (`openWikipedia`/`openBirdLife`/…), and inconsistent per-adapter fetch error handling.
  → Extract `recordCsv`, `printableHtml`, `buildSpeciesTableHtml/Csv`, `openDeferred`, and a
  shared `fetchJson({signal,retries})` in `fetch.js` (also fixes B5).
- [ ] **#9 Break up god functions** — `applyRemote` (~120 lines), `renderSpeciesList` (~160).
  → per-collection merge helpers + `reRenderAfterSync()`; pull table/CSV/PDF builders out.
- [ ] **gdrive reads localStorage past the GeoState cache** — `localStateStr()` re-reads
  `localStorage` directly (dual source of truth now that GeoState caches). → Expose
  `GeoState.rawString()`/`key()` and use it (also the app.js direct readers at 2126/2280/5206).
- [ ] **Aggregator family coupling** — `aggregateRecords` calls injected `recordFamily`/
  `saveFamIndex` and encodes the `"x:"` extras-key contract implicitly shared with app.js.
  → Return harvested families in the result; let app.js own the index update.
- [ ] **inference-worker reads output[0] by position** (`inference-worker.js:62`) → read by
  the known output name / assert a single output.

---

## 🔵 Performance (medium; some need care)

- [ ] **#2c Duplicated detection walks per legend click** — `rebuildDetLayers` and
  `updateDetLegend` each call `recolorDetections()` + `recomputeRareMax()` and walk all of
  `detPlot`; nearly every legend toggle calls BOTH back-to-back. Also `nDet` mixes
  `_visibleCount` with `rows.length` (overcounts hidden-but-listed species). → Recolor/recompute
  once per interaction (dirty-flag/generation guard); derive `nDet` from the `eachDrawableRow` pass.
- [ ] **#2b Single-point add does global work** — `plotDetections` (non-deferred) runs
  `recolorDetections`+`recomputeRareMax`+`detDrawableCount` and may `rebuildDetLayers()` (all
  markers) for one new point (`app.js:~4985`). → Incremental: render only the new species' group
  unless a family was newly learned. (Riskiest; stage behind manual map testing.)
- [ ] **#3c paintRangeH3 rescans the whole cache for `max`** every paint (`app.js:~7900`). → Track
  per-`(tag,res)` running max where cells are written; invalidate on resolution change.
- [ ] **#3b paintOverlay fires per inference chunk** (`app.js:~8228`) — hundreds of full repaints
  for an "all-48" precompute. → rAF-coalesce intermediate repaints; full paint on completion.
- [ ] **#4b Offload species aggregation to the worker** — the O(nSpecies×cells) extraction in
  `speciesAggsAcrossCells` still runs on the main thread. → compute max/p90/median in the worker.
- [ ] **renderDetGroup double-walks rows** — builds `obsByLoc` in a pre-pass then rebuilds the
  same `lk` per row in the draw loop. → single pass / compute `lk` once.
- [ ] **Field views re-read the full blob + re-filter per species** — `renderFieldList`,
  review cards (`entriesInGroup`), and `buildChecklistItems`/`refreshChecklists` each call
  `getFieldChecklists`/`getFieldRecord` repeatedly and re-filter `rec.log` per species. → build a
  per-key entry map once per render; resolve each record once per refresh.
- [ ] **saveH3Cache eviction is O(n²)** — re-`JSON.stringify`s the whole blob each loop. → track
  running length / batch-delete.
- [ ] **Unbounded caches** — `countryCache`/`nearCountryCache` (geo.js), `allSightingsCache`
  (app.js) grow without a cap over a long session. → size/LRU cap.
- [ ] **gbifDatasets()/directSources() rebuilt per call** on the fetch path. → memoize vs the
  GeoState change-stamp, or read once per run.

---

## 🟢 Small cleanups
- [ ] `mergePointSets` native `confirm()` → `modalConfirm` (fullscreen-exit bug; needs async thread).
- [ ] Centralize reverse-geocode caching (`placeCache`/`placeDetailCache`/`fieldNameCache`) + one
  in-flight request per rounded point; give `nearbyPlaces` a cache + abort.
- [ ] Prune non-current-resolution H3 keys when `hiResFactor` changes (cache grows on toggles).
- [ ] `updateMapCsv` no-ops for range/richness yet is called each paint — drop the dead branch.
- [ ] Review count: normalize a recorded `0` vs no-count `X` consistently for the eBird CSV.
- [ ] `sw.js` LRU re-stamp on hit is also unawaited/unserialized (the trim path was fixed) —
  chain delete→put or skip re-stamp.

---

## Notes
Per fix: `node --check` + a targeted node harness where logic is testable; bump `sw.js VERSION`;
keep the SW `SHELL` in sync for new files; one commit per concern (or per file when parallelizing).
**Next lowest-hanging:** the verified bugs **B1, B2** (one-liners) and **B3/B4** (small, real
correctness) — then **#8**'s `fetchJson` helper (also closes B5). Parallelizable by file:
B1/B2/B4/B6 (app.js — serialize), B3 (aggregate.js), B5/B7/B8 (fetch.js/geo.js).
