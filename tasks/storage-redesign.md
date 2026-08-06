# Storage redesign — per-list units in IndexedDB (lift the localStorage ceiling)

**Why:** the whole app state lives in one localStorage blob (~5 MB browser cap).
Plotted detections + saved trips (each trip embeds a full dot snapshot) push it past
the cap, so new trips silently fail to save and vanish on the next sync. localStorage
is the only bottleneck — Google Drive's appDataFolder handles the full payload fine,
and IndexedDB has far higher limits (fixes PC *and* mobile, which has the same ~5 MB cap).

**Shape:** keep the small data (settings, year/life lists, map points, tombstones) in
localStorage; move the **bulky detection data** (`mapDetections` + each `mapDetectionSet`
trip) into **IndexedDB, one record per list**. Hydrate into memory at boot so the existing
synchronous `GeoState.get` callers keep working. The **Drive sync payload shape is
unchanged** (sync assembles the same JSON), so existing Drive backups stay compatible.
CSV stays a separate export/import *view* (JSON is the lossless store).

**Testing reality:** IndexedDB + Drive can only be verified in a real browser. Each phase
is shippable and must be smoke-tested on PC **and** phone before relying on it. Migration
is non-destructive: localStorage big-fields are removed only **after** the IDB write is
confirmed.

---

## Phase 0 — Safety net ✅ (v458)
- [x] `GeoState.write` reports persist success (`lastSaveOk()`).
- [x] `saveDetSet` shows `err.storageFull` + returns false on unrecoverable quota.
- [ ] (Optional) the manual JSON export already covers everything (it uses buildPayload).

## Phase 1a — Trips in IndexedDB ✅ (v459/v460) — NEEDS PC + PHONE TEST
- [x] `docs/idb.js` → `window.AppIDB` (open/get/put/del/getAll); verified via IDB mock harness.
- [x] Records: `"set:<name>"` = each trip. Tombstones stay in localStorage.
- [x] Boot hydrate `initDetSetStore()` (awaited in init); migrate blob trips → IDB then drop
  from the blob (non-destructive; localStorage fallback if IDB unavailable).
- [x] `saveDetSet`/`deleteDetSet` → IDB record (+ mirror + tombstone); `detSets()` reads the mirror.
- [x] `buildPayload` re-attaches trips (identical Drive JSON); `applyRemote` merges vs the mirror,
  writes merged trips to IDB, keeps them out of the blob. Manual export still includes trips.
- [ ] **TEST (PC + phone):** save a trip that wouldn't fit before · reload (persists) · sync PC→phone
  and phone→PC · delete a trip and confirm it stays deleted after sync.

## Phase 1b — Plotted detections in IndexedDB (only if still over quota after 1a)
- [ ] `mapDetections` (`"dots"` record) — same pattern. Trips were the main bloat, so this is
  likely unnecessary; check the Settings storage readout after 1a before doing it.

## Phase 2 — Per-list polish + CSV
- [ ] Generalise the per-list store to year/life lists + map-point collections (each its own
  record) so nothing bulky remains in the localStorage blob.
- [ ] Add **tombstones for year/life lists** so deletes propagate across sync (trips already
  have them) — addresses "delete lists during syncing".
- [ ] CSV **export per list** (reuse the existing CSV builders) and **import per list**
  (parse → per-list record) — the "easy reuse" the user wanted, kept separate from storage.

## Phase 3 — Per-file Drive sync (optional, later; highest risk)
- [ ] One Drive `appDataFolder` file per list; reconcile the file set on sync; a list deleted
  on one device = its file removed (natural delete, no tombstones). Only changed lists transfer.
- [ ] Decide vs. keeping the single-JSON Drive payload — Phase 1+2 already fix quota + delete,
  so this is a refinement, not required. Skip unless the per-file granularity is wanted.

---

## Notes / order
Ship **Phase 0** immediately (stops silent loss). Then **Phase 1** is the real fix — build
the `idb.js` + migration with node harnesses, wire it, ship, and **test on PC + phone**
before Phase 2. Phase 3 is optional. Per fix: `node --check`, logic harness where testable,
bump `sw.js VERSION`, keep the SW SHELL in sync for `idb.js`, one commit per step.
