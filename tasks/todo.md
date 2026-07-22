# Map Points Feature (v1)

## Decisions
1. **Manual add**: long-press on touch / right-click on desktop → opens a dialog with name, tags, notes.
2. **Tags**: free-form, comma-separated. Tags from imported files merge into the same pool.
3. **Filter**: multi-select OR — chips for each unique tag + "(no tag)"; active chips show only matching points.
4. **Import**: KML + GPX (DOMParser) + **KMZ** via native `DecompressionStream('deflate-raw')` + a minimal local ZIP central-directory parser — no JSZip vendored.

## Data model
- `GeoState.mapPoints` = array of `{ id, lat, lon, name, tags[], note, source, createdAt }`.
- `GeoState.mapPointsFilter` = array of active tag strings (`""` for "(no tag)").

## Tasks
- [ ] Storage helpers: `loadMapPoints`, `saveMapPoints`, `addMapPoint`, `updateMapPoint`, `deleteMapPoint`, `clearMapPoints`.
- [ ] Tag-colour palette + hash function.
- [ ] Leaflet layer group + per-tag marker rendering; filter respect.
- [ ] `map.on("contextmenu", addPointHere)` → opens the point dialog at lat/lon.
- [ ] Marker `.on("click", openPointEdit)` → same dialog, prefilled, with delete button.
- [ ] Header dropdown "Points (N)" mirroring the Checklists one: list of points with chips + distance + delete, "Import file" button, "Clear all", and the filter chip bar with all distinct tags.
- [ ] File-picker accepts `.kml,.kmz,.gpx` and dispatches by extension.
- [ ] Parsers:
  - `parseKml(text)` → DOMParser, walk `Placemark` nodes with `Point/coordinates`. Name from `<name>`, tags merge from folder names + `<ExtendedData>` `<Data name="tags">` + comma-separated `<description>`. Drop placemarks without `<Point>`.
  - `parseGpx(text)` → DOMParser, walk `<wpt lat="" lon="">` nodes. Name from `<name>`, tags from `<type>` and (`<sym>`).
  - `parseKmz(arrayBuffer)` → minimal ZIP central-directory parser → find `*.kml` entry → `DecompressionStream('deflate-raw')` → `parseKml`.
- [ ] i18n: ~12 keys in 15 languages.

## Verification (headless)
- [ ] Right-click on map → dialog opens → save → point appears, persisted to localStorage.
- [ ] Import a synthetic KML (3 placemarks, 2 tags) → 3 points added with merged tag pool.
- [ ] Import a synthetic GPX (2 waypoints) → 2 points added.
- [ ] Import a synthetic KMZ (1 KML inside, deflate-compressed) → 1 point added.
- [ ] Click a tag chip → marker count drops to those matching.
- [ ] Click a point marker → edit dialog opens with prefilled fields, delete works.

## Out of scope (v1)
- Per-tag icon/color customization UI (color is hashed by first tag automatically).
- Export back to KML/GPX (could add later).
- Clustering at high counts (uncluster at hundreds).
- Sync across devices (localStorage only).

---

# Upload Checklist Feature — eBird (v1)

## Decisions (user-confirmed)
1. **Mechanism**: CSV download in eBird Record Format; structure the code so a future API-submit hook can plug in.
2. **Scope**: One checklist = one upload group. User can split/merge log entries into ad-hoc groups in the review screen.
3. **Entry point**: New "Review & upload" button on the field-checklist page → dedicated review page.

## Existing model (no change needed, append-only field on entries)
- `fieldChecklists[id]` = `{ id, title, lat, lon, day, createdAt, log[], seen{} }` (one record per place+day).
- Each `log` entry: `{ id, ts, lat, lon, key, count, act, note }`.
- **Add**: optional `entry.grp` (group key, string). Absent → default group `"a"`. Backward compatible.

## Tasks

### 1. Data
- [ ] `entry.grp` (string) added to log entries. Default group when missing = `"a"`.
- [ ] Add `record.upload[grpKey]` to persist per-group submission metadata (start time, duration, protocol, distance/area, observers, effort comments, submission comments, state, country, location-name override).
- [ ] Helpers: `recordGroups(rec)` → array of group keys present in `rec.log` (+ any orphans from `rec.upload`). `entriesByGroup(rec, grp)` → log entries in that group, sorted by ts. `aggregateSpecies(entries)` → array `{ key, count, breeding, notes, firstTs, lastTs }`.

### 2. eBird mapping
- [ ] `EBIRD_BREEDING` map: subset of `FIELD_ACTS` → eBird breeding codes (NB, FL, ON, FY, NY, CF, FS, UN, DD, A, C, N, T, P, S, S7, H, F, …). Non-breeding activities pass through as plain text in "Identification details".
- [ ] `ebirdCsv(rec, grpKey)`: produces a string in Record Format (header row + one row per species). Columns:
  `Common Name, Genus, Species, Number, Identification details, Observation Date, Observation Time, State, Country, Location Name, Latitude, Longitude, Protocol, Duration (min), All observations reported, Distance Covered (km), Area Covered (ha), Number of Observers, Effort Comments, Submission Comments`.

### 3. UI — `#review-page`
- [ ] New full-screen page, opened by a new toolbar button on the field-checklist page.
- [ ] Group cards: editable meta + aggregated species list (count/breeding/note editable; expand to show source entries with "Move to group ▾").
- [ ] "+ Checklist" button creates a new group.
- [ ] Per-group "Download eBird CSV" button.
- [ ] Per-group "Submit to eBird API" placeholder (disabled tooltip "partner-only").

### 4. i18n
- [ ] Add ~25 keys to all 15 language blocks in `docs/i18n/strings.js` (English source; translations for sv/de/es/fr/nl/no/it/pl/cs/et/lt/fi/da/pt). Keep CRLF.

### 5. Housekeeping
- [ ] Bump SW to v73, update `last-change.txt`.

### 6. Verification (headless)
- [ ] Aggregation: two `barswa` entries with counts 3 + 2 → one row `count=5`.
- [ ] CSV roundtrip: header row + correct column count per data row.
- [ ] Breeding code mapping: `song` → `S`, `nestbuild` → `NB`.
- [ ] Move entry to new group → species moves between groups.
- [ ] Protocol Traveling shows Distance row.

## Out of scope (v1)
- Tracking which checklists were already uploaded.
- iNaturalist (the review page leaves a `destinations[]` seam).
- State/country auto-detection.
- Per-entry coords in the CSV (eBird Record Format takes one location per checklist).

## Review

Shipped across **v73** (upload) and **v74** (sex toggle).

**v73 — upload feature (`f3cd0b1`)**
- `entry.grp` and `record.upload[grp]` added; recordGroups / entriesInGroup / aggregateForUpload helpers; EBIRD_BREEDING map (19 codes) and ebirdRecordCsv producing valid Record-Format CSVs.
- New `#review-page` (full-screen, modeled on `#entry-page`) with one group card per checklist, editable meta block (protocol/time/duration/distance/observers/all-obs/loc/state/country/notes), aggregated species list with editable count/breeding code/note, expandable per-entry "Move to…" menus.
- "+ Checklist" allocates next free group letter via `nextGroupKey`; the empty group is persisted via `rec.upload[k] = {}`.
- "Submit to eBird" hook in place but only surfaces a stub message — eBird's submit API is partner-only.
- 28 new i18n keys, 15 languages.
- Headless CDP test verified: counts sum (3+2→5), breeding codes (song→S, nestbuild→NB, flyover→F), CSV structure (header + 3 rows), move-to-new-group splits a species across A/B.

**v74 — sex toggle (`70b61b9`)**
- `cd().sex` and `entry.sex` added (cycle order `"" → m → f → p → fl`).
- `setFcSex` and `nextSex` helpers; `.fc-sex-btn` cycle button on each card.
- Sex shown on entry summary lines and editable as a select on the entry-edit page.
- `aggregateForUpload` tracks `sexCounts`; CSV's Identification details now includes `"3 ♂, 2 ♀, 1 ♀?"`-style breakdown when sex info is present.
- `chk.sex` key added in 15 languages.
- Headless verified the 5-state cycle, the CSV aggregation, and the entry-edit round-trip.

## Out of scope (still)
- Tracking which checklists were already uploaded.
- iNaturalist upload (the `destinations[]` seam is in place).
- State/country auto-detection from coords.
- Per-entry coords in the CSV (eBird Record Format takes one location per checklist).

---

# Google Drive sync

Connect the app to a Google account and sync local data (settings, checklists,
map points, eBird key) across devices via the user's Drive **appdata** folder.
Auto sync (open / debounced change / tab-hide / online) + manual "Sync now".
Reuses the existing Export/Import merge logic.

## Tasks
- [x] `app.js`: refactor `exportAppData`/`importAppData` → `buildPayload()` +
      `applyRemote(obj, {incomingWins, interactive})`; add `interactive` flag to
      `mergePointSets`; expose `window.AppData`.
- [x] `state.js`: stamp `updatedAt` in `write()`; add `onChange(cb)` notify hook
      + `bootUpdatedAt()` (load-time snapshot) + `touch()`.
- [x] `gdrive-sync.js` (new): `window.GDriveSync` — GIS auth, Drive REST
      (find/download/create/update in appDataFolder), pull→merge→push, debounce,
      triggers (open / change / tab-hide / online), in-memory token only.
- [x] `app.js`: add Connect/Disconnect/Sync-now UI to `#sync-wrap`; wire handlers;
      bump `updatedAt` on eBird-key write; call `GDriveSync.init()` at end of init.
- [x] `index.html`: load `gdrive-sync.js` after `state.js`; add GIS client script.
- [x] `sw.js`: add `gdrive-sync.js` to SHELL precache; bump VERSION (v178→v179).
- [x] `i18n/strings.js`: add `gdrive.*` strings to `en` + `sv` (others fall back
      to English per the file's documented contract).
- [x] Verify: merge direction/union unit tests (7/7); headless page render shows
      the new UI with no console errors; GeoState/GDriveSync runtime surface
      checks (12/12). OAuth round-trip needs the user's Client ID (prerequisite).

## Prerequisite (user, one-time)
Google Cloud project → enable Drive API → OAuth consent (External, scope
`drive.appdata`) → Web OAuth client ID with the Pages origin + `http://localhost:8000`
as authorized JS origins. Paste the Client ID into the app.

## Known limitation
Union-merge does not propagate **deletions** (an item deleted on one device can
reappear from another). Matches today's Export/Import behavior; proper fix needs
tombstones (out of scope). Surface in a UI hint.

## Review

Built as a thin transport+auth layer over the existing Export/Import merge.

- **state.js** — `write()` now stamps `updatedAt = Date.now()` and notifies
  `onChange` listeners; `bootUpdatedAt()` returns the change-stamp as it was at
  page load (captured before init churn) so the open-time pull isn't fooled into
  thinking local is newer; `touch()` bumps the stamp for out-of-store changes.
- **app.js** — `exportAppData`/`importAppData` refactored into reusable
  `buildPayload()` + `applyRemote(obj,{incomingWins,interactive})`, exposed as
  `window.AppData`. `mergePointSets` gained an `interactive` flag (off for sync →
  always union, never prompts). File Export/Import behavior is byte-for-byte
  unchanged (`incomingWins:true, interactive:true`). Settings panel gained
  Connect / Sync-now / Disconnect + an optional client-ID field; eBird-key edits
  `touch()` the stamp; `GDriveSync.init()` runs last in init.
- **gdrive-sync.js** (new) — `window.GDriveSync`. GIS browser token flow,
  `drive.appdata` scope only, token kept in memory (never persisted). Drive REST
  find/download/create/update of `migration_calendar.json` in the hidden app
  folder. `sync()` = pull → direction-aware merge → push: collections always
  union; scalar settings follow `remoteStamp > bootUpdatedAt && !localDirty`. A
  pull that changed already-rendered scalars triggers a one-time reload.
- **index.html / sw.js** — load order + GIS script tag; precache + VERSION v179.
- **i18n** — `gdrive.*` in `en` + `sv`.

### Known limitations
- **Deletions don't propagate** (union merge) — surfaced in the settings hint.
  Proper fix needs tombstones (out of scope).
- **GIS ties tokens to a user gesture**, so a background token refresh can fail
  silently; the UI then shows "reconnect" and a tap on Connect/Sync now recovers.
- Other languages show English `gdrive.*` text (intentional fallback).

### User prerequisite (one-time, cannot be automated)
Create a Google Cloud OAuth Web client (Drive API enabled, consent scope
`drive.appdata`, JS origins = Pages origin + `http://localhost:8000`) and paste
the Client ID into Settings — or hard-code it in `gdrive-sync.js`
(`DEFAULT_CLIENT_ID`).

---

# Maintenance tool: named detection sets ("trips")

User asks: turn the plotted detection dots/stars into a named, stored set, and
organise synced data as **named blobs** you can **delete wholesale** (trips).

## Design
A saved set = a snapshot of the currently-plotted dots/stars under a name,
stored and synced as `GeoState.mapDetectionSets = [{ name, createdAt,
detections: <mapDetections shape>, interesting: [keys] }]`. Deleting a set
removes that whole blob; a tombstone list `mapDetectionSetsDel = [names]` makes
the deletion propagate across devices (and free the Drive blob) — the normal
detection merge only ever unions, so without a tombstone a delete would bounce
back from the other device.

## Tasks
- [x] Refactor `saveDetections` to share a `serializeDetPlot()` helper.
- [x] Data: `detSets()`, `saveDetSet(name)`, `loadDetSet(name)` (union into the
      working set + adopt stars + fit bounds), `deleteDetSet(name)` (+ tombstone).
- [x] Sync: `mergeDetectionSets` (union by name; same name → union rows + stars)
      minus tombstones; wire into `applyRemote` (sets + tombstone list).
- [x] UI: a "Saved sets" modal (mirror the Data-sources modal) listing sets with
      Load + delete ×, and a "Save current detections as…" action. Entry button
      in Settings → Share-between-devices.
- [x] i18n `dset.*` (en + sv); CSS reuse the sources-modal box.
- [x] Bump SW version (v250); `node --check`; verify headless.

## Review
Shipped in **v250**. A saved set = a named snapshot of the plotted dots/stars,
stored/synced as `mapDetectionSets`. Entry point: Settings → Share between
devices → "🗂 Saved sets…", opening a modal with "💾 Save current detections…"
and a row per set (species·dots count, Load, delete ×). Load unions the set into
the working plot and adopts its stars (never discards what's already shown), then
fits the map to it. Delete writes a tombstone (`mapDetectionSetsDel`) so the
removal propagates across devices — the only place the detection data uses
deletion semantics rather than pure union. `applyRemote` merges sets by name
(union rows + stars), drops tombstoned names, and unions tombstone lists.
Verified: headless DOM render of the new modal; standalone tests of the
set-merge, tombstone-survival, and (separately) the GBIF dedup + colour
determinism + Artsobs URL helpers — all PASS.


---

# Species-list status column (★ / ◉ / 🟡🟠 / 🚫) + Fågelkartan link

## Decisions (user-confirmed)
- New status column header cycles the FILTER: all → ★ starred → ◉ rare →
  🟡 not on year list → 🟠 not on life list → 🚫 blocked.
- "Species" header becomes a pure A–Z / Z–A / off sort (its 7-state combined
  cycle is retired).
- Rarity = same rule as the map legend (count ≤ rarePct% of the commonest
  species), but computed from the list's own fetched counts so it lands as soon
  as the observation data arrives.
- Fågelkartan link goes under the map popup's 📍 Location submenu, county level
  (SE /lan/<slug>/, NO /no/fylke/<slug>/).

## Tasks
- [x] `spFlagsHtml(key, rare)` + `spRareSet(agg)` + `syncFlagsHead()`.
- [x] New `<th id="sp-flags-head">` + `<td class="sp-flags">` in both renderers
      and in `prependExtraSightings`.
- [x] `nameLinkHtml(label, noStar)` — suppress the ★ prefix in this table only.
- [x] `applySightings` computes the rare set, refreshes the flag cells.
- [x] `applyAgeFilter` also applies the ◉ rare filter (same `display` property).
- [x] `sortSpeciesList` sci-column index 2 → 3.
- [x] Header handlers: flags → filter cycle; species → `cycleSpeciesListSort("name")`.
- [x] `AppGeo.regionInfo` (zoom=8, own cache) + `fagelkartanUrl` / `fkSlug` /
      bundled 21 län + 15 fylke slug sets; button in `locSub`.
- [x] CSS, i18n (en + sv), What's new, CHANGES, README, sw v677.

## Verification
- [x] `node --check` on app.js / geo.js / i18n/strings.js
- [x] Headless (Chrome via puppeteer-core), counts stubbed for determinism:
      status column 31/31, Fågelkartan 14/14.
- [x] All 36 generated fagelkartan.se county URLs return 200 live.

## Lesson
This was first built against a **165-commit-stale** local `main` (v519 vs the
remote's v676) and had to be redone. The stale base also hid the fact that the
"Location ▸" submenu (v590) already existed — the first attempt put the link in
the wrong place. **Check `git fetch && git status` before starting work.**

## Follow-up: "rare here" over-flagged (v678)

User reported the ◉ showing for many clearly non-rare species. Measured against
live fetches rather than assumed:

| | Stockholm | Oslo |
|---|---|---|
| species with observations | 165 | 172 |
| flagged by `≤5% of max` | 53 (32%) | 59 (34%) |
| flagged by rank percentile | 23 (14%) | 12 (7%) |

Root cause was the *shared* `detIsRare` rule (map legend + list), not the list
wiring: counts are steeply long-tailed, so "≤5% of the commonest species" lands
at ≤8 records and catches a third of the list. Not a bug I introduced — I
inherited it when reusing the rule.

- [x] `rareThreshold(counts)` — one shared rank-percentile definition.
- [x] `detIsRare` + `spRareSet` both use it; `detRareMax` → `detRareThr`.
- [x] Settings hint reworded (en + sv).
- [x] Unit tests for the threshold (7/7: outlier-magnitude robustness, quiet
      locations where the old rule could never flag, monotonicity, tie
      behaviour) + status-column suite still 31/31.

Known/accepted: species tied at the threshold all qualify, so the set can exceed
rarePct% (Stockholm 23 species share one record → all flagged).
