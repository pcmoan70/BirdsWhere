# Changes

## 2026-08-06 — Legend n/t totals follow the map view (sw v931)

- With "Filter the legend to the map view" on, the "/t" total in each legend row now also respects the
  current viewport — `detTotalCount` intersects a species' rows with `legendViewBounds` when it's set — so
  panning/zooming recomputes both numbers of n/t (t = total in view), matching the filtered count.

## 2026-08-06 — Total column filter: Total/Observations toggle (sw v930)

- The Total header panel's count range is now `[ ] ≤ (Total|Observations) ≤ [ ]`, with a toggle button
  between the bounds that switches whether the lower/upper limits restrict deduped **Total** specimens or
  the number of **Observations** (distinct observer×date pairs). New `spCountMetric` ("total"|"pairs");
  `detPassesCount`/`applyAgeFilter` read the pairs count via `detSpeciesPairs`/`data-pairs` when on. Empty
  boxes still mean no count restriction.

## 2026-08-06 — Date pane: date + On/Before/After + sort on one line (sw v929)

- In the Last (date range) panel, dropped the "Sort" label and moved the tri-state sort button onto the
  same row as the On/Before/After button; the tapped date is now shown in **bold** (`.sp-date-lbl`).
  Factored the On/Before/After button into `dateRelBtnHtml` (also bolds the date in the Per-observation pane).

## 2026-08-06 — Legend counts now match the Total column (deduped specimens) (sw v928)

- The legend's "n/t" counted RECORDS, while the Species-list Total and the count filter (>N) count
  deduped SPECIMENS — so a species could read e.g. "3" in the legend yet ">5" in the count filter.
  `detVisibleCount` now returns deduped **specimens** passing the active date/observer/source (and
  legend-view) filters; new `detTotalCount` gives the total specimens for the "/t". Factored the shared
  dedup+sum into `specimenTotal`. The legend, the count filter and the Total column now agree.

## 2026-08-06 — Auto-fit floors at ~2.5 km (single observation keeps context) (sw v927)

- Fetching a single observation used to zoom the map all the way in. New `fitBoundsMin(bounds, pad, minKm)`
  never fits tighter than a ~2.5 km box around the centre (still keeps the data's extent when larger).
  Applied to the observation-fetch fits: `plotSightingsResult`, `plotDetections`, the country/list fits,
  and Fetch-on-open (`fitAllDetectionPoints` / `fitToAreas`).

## 2026-08-06 — eBird hotspots: fixed 500 km fetch + hover tip on the checkbox (sw v926)

- The hotspot query uses a fixed 500 km radius (eBird's max) around the view centre; hotspots accumulate/persist across pans via the cache.
- Hover message on the eBird-hotspots row in the layers control (`layer.hotspotsTip`, 15 langs): "eBird returns hotspots within 500 km of the view centre. Pan the map to load more — cached hotspots stay on the map."

## 2026-08-06 — List/map toggle works after Fetch on open (sw v924)

- The list/map toggle needed a clicked point (`currentSpView`), which Fetch on open never sets — so it
  stayed greyed/hidden even with detections on the map. Now `viewToggleAvail()` also returns true when
  there are plotted detections (`hasPlottedDetections`), and the toggle opens a standalone **"By
  observation"** list of all plotted detections (`renderPlottedObsPage`) when there's no per-point list.
- `updateViewToggle()` is now called as detections plot (even during Fetch on open — it only updates the
  button, not the view) and on completion, so the toggle enables in real time. `updateSpMapBtn` keeps it
  enabled on the standalone page; `goToMapView` skips the re-plot there (already on the map).

## 2026-08-06 — Re-fetching a spot after a radius change replaces its outline (sw v923)

- The remembered fetched-area outlines were keyed by spot **+ radius**, so re-fetching a spot after
  resizing the Sightings radius stacked a second rectangle and left the original under it.
  `rememberFetchedArea` now removes any existing outline at the same spot (any radius) before adding the
  new one (`removeFetchedAreasBySpot`), so a spot shows a single outline at the latest radius.

## 2026-08-06 — Fix count mismatches: expanded records + "More of these" (sw v922)

- **Expanded species records now match the Total.** `spDetailRowsFor` read from `detPlot` (the plotted
  map dots — often a subset), while the Total counts `tbody._sightingsAgg[key].rows`. So a species showing
  "20" could expand to 1 record. It now builds the expanded list from the same aggregation the Total uses
  (filtered by the active date/observer/source), falling back to `detPlot` only for extras / no-agg.
- **"More of these" shows counts.** The recent-fetch rows carried no `count` field (GBIF/iNat omitted it,
  eBird stuffed "×N" into the observer cell). Added `count` to `gbifRecent` (individualCount) and
  `ebirdRecent` (howMany, observer moved to its own cell), a **count column** in the panel table, and the
  count to the CSV export.

## 2026-08-06 — "By observation" rows use the state dot (sw v921)

- `spRecRowHtml` (the "By observation" record rows) now draws the species dot via `spListDot` /
  `detSwatch` — the same shapes as the map marker and the species table (★ interesting, rare-here centre
  dot, year/life need-ring, blocked slash) — instead of a plain colour dot.

## 2026-08-06 — Recency window defaults to All (no hidden 30-day filter) (sw v920)

- `detRecencyDays()` now defaults to **0 (all time)** instead of 30. The map, legend and lists showed only
  the last 30 days by default, hiding older fetched observations (the "23/50" in the legend) — and clearing
  an absolute date range fell back to that hidden window. Now every fetched observation shows unless you
  explicitly pick a recency window; clearing a date filter reveals them all.
- (Existing users who had explicitly set a recency keep it — clear filters once to reset to All.)

## 2026-08-06 — Date pane: On/Before/After collapsed into one cycling button (sw v919)

- The three On / Before / After buttons (relative to a tapped date) are now a single button that cycles
  **none (–) → on → before → after → none** on each click. `dateRelRowHtml` renders the current state;
  `cycleDateRel` advances it (via `setDetDateFilter`). Wired in both the table Last panel and the
  Per-observation date pane.

## 2026-08-06 — Date pane: no "all" chip; legend shows all plotted by default (sw v918)

- Removed the "all" chip from the date pane's recency grid — clear the date filter with the funnel-red-×
  (→ all time).
- "Filter the legend to the map view" now defaults **OFF** (`legendInView` default `true`→`false`), so the
  legend lists every plotted species and stays synced with the map (and the By-observation / ☰ lists,
  which already show all) instead of narrowing as you pan/zoom. Still toggleable in Settings.

## 2026-08-06 — Filter by observer list + species lists (sw v917)

- **Observer-list filter:** the observer popup gains "Filter by observer list ▸" — pick a saved observer
  list and it applies as the filter (`setDetObsFilter`). Restores the scope that was on the old 👤 checklist.
- **Species lists:** new saved species lists (`speciesLists` = [{name, keys}]).
  - Build a selection: the species menu now offers **Add to species filter** (alongside Show only) to
    accumulate multiple species (`detSelected`).
  - The **Species** header panel shows saved species lists as chips (tap to apply / tap again or × to
    clear-delete) and a **Save selection as list** button. `applySpeciesList` selects the list's species
    that are observed here; `saveCurrentSpeciesList` prompts for a name.
  - The species **selection now also narrows the species table** (`applyAgeFilter` gained `selOk`), so an
    applied list filters the table, map, legend and By-observation together. `speciesFilterActive()` +
    the Species-header funnel track it.
- i18n: `obs.filterByList`, `menu.addSpFilter`, `sp.speciesLists`, `sp.saveAsList`, `sp.saveListPrompt` (15 langs).

## 2026-08-06 — Observer filtering moved into the observer popup (sw v916)

- Removed the standalone 👤 observer toggle + checklist panel from the "By observation" filter bar
  (`detFilterTogglesHtml` / `detFilterPanelsHtml`). Observer filtering is now done from the observer
  popup (tap an observer's name): `observerActionMenu` gained **Add to observer filter** (build a
  multi-observer filter alongside Show only / Remove / Remove all) and **Observer lists** (opens
  `openObserverEditor`), plus the existing Add-to-list. New i18n `obs.addToFilter` / `obs.editLists` (15 langs).

## 2026-08-05 — Sort: one tri-state button instead of two (sw v915)

- The panels' two sort buttons (▲ asc / ▼ desc) are now a single tri-state button that cycles
  **unsorted (⇅) → ascending (▲) → descending (▼) → unsorted** on each click. `spSortBtnHtml(col, title)`
  renders the current-state glyph; the `wireSpHeadPanel` handler cycles. The Total panel keeps one button
  per metric (Total, Observations).

## 2026-08-05 — Species name search moved into the Species filter panel (sw v914)

- The "Filter species…" search box moved from the always-visible `#sp-controls` bar into the **Species**
  column-header panel (`spSpeciesPanelHtml`), where the other species filters live. Wired in
  `wireSpHeadPanel` (filters on `input` via `filterSpRows`, no panel rebuild → keeps focus); `spNameQuery`
  now stores raw text (lowercased at compare time) so the box shows what you typed. `speciesFilterActive()`
  includes it (funnel on the Species header + the "clear all" button clears it too).

## 2026-08-05 — Total-column filter applies as you type (sw v913)

- The Total column's lower/upper bound inputs now filter on `input` (as you type / on mobile without
  dismissing the keyboard) instead of only on `change` (blur/Enter). `applyBounds` doesn't rebuild the
  panel, so the field keeps focus. Other filters (recency/month/mode/observer/source chips, the name
  search, date pickers) already update immediately; the Prob slider stays on release because re-rendering
  rebuilds the slider mid-drag.

## 2026-08-05 — Date pane controls, "More of these" backdrop, SE crow patch (sw v912)

- **Sweden Artportalen crow fix.** Artportalen files the Swedish Hooded Crow ("kråka") under the lumped
  binomial *Corvus corone* (Carrion Crow), the same as Norway's "kråke". `fixNordicCrowVernacular`
  remaps direct Artsobservasjoner + Artportalen records by vernacular (kråke/kråka → *Corvus cornix*);
  `fixGbifNordicCrow` now also folds SE GBIF *Corvus corone* → *cornix* unless the vernacular says
  "svartkråka" (real Carrion Crow in the far SW). Bumped `SIGHT_CACHE_VER` 6 → 7.
- **Date pane controls.** Removed the sort "–" (off) button — clicking the active direction again turns
  the sort off. The corner **green ×** now just closes the pane (like clicking its header again); a new
  **funnel-red-×** (shown when a date filter is active) clears the date filters and keeps the pane open.
  `clearDateFilters` (clear only) + `closeDatePane` (close only).
- **"More of these" backdrop.** Removed backdrop-click-to-close on the recent-observations modal, so a
  click on the darkened map behind it no longer collapses the view — close it with the ×.

## 2026-08-05 — Species-list name search (browser find-in-page workaround) (sw v911)

- Added a "Filter species…" search box in `#sp-controls` (reuses `ph.filter`). Typing filters the
  species-list table by row text (name / 2nd name / scientific). `spNameQuery` + `filterSpRows()` toggle
  a `.sp-hide-search { display:none !important }` class so it composes with `applyAgeFilter`'s inline
  show/hide (a row shows only if it passes both). Applied from `applyAgeFilter` and the country render;
  shown only in the table layout. Reliable where the browser's Ctrl-F can't scroll a fixed overlay.

## 2026-08-05 — "More of these": copy-to-map keeps the panel open, button disables (sw v910)

- The panel's "Show in map" button copied the points but then closed the panel (`navClose("recent")`).
  Now it keeps the panel open and **disables the button** after copying (guards on `disabled`) so the
  points can't be copied twice. Added a greyed `#recent-map:disabled / .recent-map-done` style.

## 2026-08-05 — "More of these" (was Recent detections): 50 km + hover hint (sw v909)

- Renamed the `menu.recent` item from "Recent detections" to **"More of these"** (all 15 languages).
- `showRecent` now searches a fixed **50 km** radius (was the global Sightings-radius setting): the
  GBIF/iNaturalist/eBird fetch, the external links, and the radius label all use `rkm = 50`.
- Added a hover description (`menu.recentHint`, 15 languages) on the menu item via `moreBtn.title`.

## 2026-08-05 — Observation menu: drop the emoji before the green icons (sw v908)

- In the "this observation" menu, "Show on map" and "Add point to list…" showed a colour emoji
  (🎯 / 📍) next to their green line icon. Switched those two `drmBtn` labels to `tLabel()` so the
  leading emoji is stripped — only the green icon remains. (The strings keep the emoji for tooltips.)

## 2026-08-05 — "Per observation": date pane opens from a date click (sw v907)

- Removed the standalone date/days button from the "Per observation" filter bar
  (`detFilterTogglesHtml(false)`). The date pane now opens by **clicking a date** in the list.
- Clicking a date opens the inline pane with **On / Before / After** that date (`dateRelRowHtml`,
  shared with the table's Last panel) plus the recency/range/months panel and the green clear-×.
- `detFilterPanelsHtml(dateForRel)` wraps the days panel; `wireSpDetail` opens the pane for records
  (`#sp-records`) and keeps the floating menu for a table's expanded sub-rows; `obsDatePanelDate` state.

## 2026-08-05 — Date panel: green × clears all date filters + closes (sw v906)

- Added a green × (top-right of the Last date panel) → `clearDateFilters()`: resets recency to All,
  clears the absolute range and the month-of-year filter, and closes the panel.
- Changed the sort-row "off" glyph from ✕ to "–" so it isn't mistaken for a clear button.

## 2026-08-05 — Species list: status on the dot, not in columns (sw v905)

- Removed the five per-cue status columns (★/◉/🟠/🟡/🚫) from the Species-list table. The colour dot
  before the name now carries the state via the map's `detSwatch` (★ interesting, centre-dot rare-here,
  bronze/yellow need-ring for year/life), plus a red slash for blocked — new `spListDot` / `paintSpDot`.
- Dots repaint in `applyAgeFilter` (rare-here comes from the fetched obs; star/year/life/blocked from live
  state), and on cue toggles via `refreshCueCellsInPlace` (now just calls `applyAgeFilter(true)`).
- Removed `spFlagCells`, the flag-column headers + click handlers, the rare-cell fill, and the dead
  `.spf-head`/`.spf-c` CSS; `spRareSet` now reads rows via `.sp-link`; `sortSpeciesList` sci index fixed
  (columns shifted). Filtering by status remains in the Species header panel.

## 2026-08-05 — Last column shows "days back" under a relative recency window (sw v904)

- When a "last N days/weeks/months" recency filter is active (relative — not an absolute from–to range),
  the Last column now reads as days-back (e.g. "5d") instead of the date. New `daysBackActive()` =
  `!detDateRange() && detRecencyDays() > 0`, used by `lastCellSet` (replaces the retired
  `speciesAgeFilterDays` trigger). Absolute date range / all-time still show the date.

## 2026-08-05 — Total panel sorts by total count or number of observations (sw v903)

- The Total header panel's sort now offers two metrics: **Total** (the de-duplicated specimen count shown
  in the cell) and **Observations** (the "(n)" distinct observer×date pairs), each asc/desc, plus Off.
- `applyAgeFilter` stamps `data-total`/`data-pairs` on each row; `sortSpeciesList` gained `total` and
  `pairs` columns (was sorting by raw record count). Added `sort.obs` i18n for all 15 languages.

## 2026-08-05 — Column-header filter + sort panels (sw v902)

Chosen interaction: clicking a header opens a panel with BOTH filter controls and a sort option.

- Species list (table): the Species / Total / Last / Prob headers now open an inline panel in
  `#sp-filters-wrap` (`spHeadPanel` state; `spHeadPanelHtml`/`wireSpHeadPanel`/`openSpHeadPanel`):
  - Sort row (▲ asc / ▼ desc / ✕ off) on every panel → `speciesListSort` + `sortSpeciesList`
    (columns name / count / last / prob; Total & Last added to `updateSortIndicators`).
  - Total: lower/upper bounds `spCountMin`/`spCountMax` (inclusive) via `countInBounds`, applied in
    `applyAgeFilter` AND `detPassesCount` (so the map dots follow). `countHeadLabel` shows "min–max".
  - Prob: dual-range slider mirroring the hidden `prob-min`/`prob-max`, re-renders the list on release.
  - Species: active status-flag chips (`toggleSpFlag`, factored out of the flag-column handler) + the
    isolated-selection list (each removable) + "clear all species filters".
  - Last: This / Before / After a tapped date, plus the recency/range/months panel (reused).
  - Date cell click seeds the Last panel with that date. Country view keeps the old sort/agg behaviour.
- Funnels: `ico("funnel")`; `renderSpHeads()` sets each header = label + funnel when `*FilterActive()`.
- "By observation": `obsHeadActive` adds funnels to the Species / Prob / Source headers; the Source
  header opens `showSrcFilterList` — every present source as an on/off toggle (all on = no filter).
- i18n: `sort.label/asc/desc/off` added for all 15 languages; chips/dates/clear reuse existing keys.

## 2026-08-05 — Single-observation menu: self-designed icons for status toggles (sw v901)

- The record menu (`drmRenderMain`, opened from a dot/pin/row = the "single observation" popup) drew its
  interesting / this-year / life-list toggles with colour emoji (★ 🟠 🟡). Replaced with monochrome line
  icons from `ico()` — new `star`, `calendar`, `sprout` — so the whole popup uses the app's own icon set.
- `.drm-toggle .drm-ico-svg` now dims (0.4) when off and is full on/hover (the monochrome equivalent of the
  emoji's grayscale/opacity states). The Hidden row keeps its red/green via the existing `drm-will-*` rules.
- `SP_FLAG_GLYPH` (list flag columns, legend, hover swatches) is unchanged — only the menu switched.

## 2026-08-05 — Species-list date panel opens from the "Last" header (sw v900)

- Replaced the separate date toggle (v898) with a click on the **"Last" column header**: it now opens the
  date-range panel (`openDetPanel("days")` → inline in `#sp-filters-wrap`) instead of cycling the old
  `speciesAgeFilterDays` recency. Removed `spTableFilterBarHtml()`; `#sp-filters-bar` is empty in the
  table layout again. Clicking a date cell in the list still opens the same panel.

## 2026-08-05 — Default map = Voyager, labels = More (sw v899)

- Changed the unset defaults: `get("basemap", …)` now defaults to `"voyager"` (was `"streets"`) and
  `labelsMode()` defaults to `"more"` (was `"off"`). New installs open on Voyager with the vector
  place-name overlay on; users who already saved a basemap/label choice keep it (GeoState override wins).

## 2026-08-05 — Species-list: date-range selection (as in "By observation") (sw v898)

- The Species-list (table) layout now offers the same date filtering as the "By observation" record view:
  - `spTableFilterBarHtml()` adds a days/date toggle (date-only — the table keeps its flag columns +
    Last-column age cycle) to `#sp-filters-bar`; its `detDaysPanelHtml()` panel drops into `#sp-filters-wrap`,
    between the header controls and the first table rows. Wired via the existing `wireDetFilters`.
  - Clicking a Last-column date in a species row opens that same inline panel (`openDetPanel("days")` +
    `scrollSpFiltersIntoView`); a date inside an expanded record sub-row still opens the compact
    On/Before/After menu for that record.
  - `applyAgeFilter` now derives Total, the "(pairs)" suffix, the Last cell and row visibility from the
    rows passing `detDatePasses` (+ observer/source filters) — so the chosen window actually narrows the
    table, and the "N hidden" recency note matches the Total. Previously the Total counted all fetched
    rows regardless of the window.

## 2026-08-05 — Map-point popup: gate all external reference links behind Experimental (sw v896–v897)

- In the map-point popup (`bindPointPopup`), the external reference links now require the Experimental
  toggle (Settings): the national portals from `natServicesFor` (Artsobservasjoner, Artportalen, Laji,
  ornitho, BirdLife orgs, the eBird-region fallback), the BirdLife country factsheet button, the
  "Worldwide" continent submenu (`continentServices` — BirdLife DataZone, EuroBirdPortal, …), and
  (v897) the Birding Places link and the country Blogs button.
- Always-visible: the species list. With Experimental off, that's all the popup shows.

## 2026-08-05 — Offline maps: all basemaps + place-name labels (sw v895)

- The vector-label overlay (v894) is network-only (vector tiles + glyphs), so it can't be pre-cached.
  Made offline coverage complete without it:
  - New `rasterLabelsUrl(bm)` / `rasterLabelsLayer(bm)` — the aligned CARTO raster labels as a cacheable
    Leaflet tile layer. `applyLabelsOverlay` now renders the **vector** overlay when online and these
    **raster** labels when offline (`isOfflineNow()` = `navigator.onLine === false` or tiles erroring);
    `syncLabelsConnectivity()` swaps them on an actual connectivity flip (guarded — no needless rebuilds).
  - `offlineLayers()` caches the raster labels (for both "on" and "more") for any label-capable basemap,
    instead of trying to cache the un-cacheable vector overlay.
  - Downloaded areas now record `labels` (the mode at download). `refillOfflineArea` re-fetches the raster
    labels + the matching base variant (`baseUrlFor`/`offlineLayerFor` gained an optional labels override).
  - Base tiles already covered every raster basemap; labels now do too — so offline shows names on all
    supported map types.

## 2026-08-05 — Vector place-name labels (MapLibre GL), yr.no-style (sw v894)

- Studied yr.no's map: it renders **vector tiles** with **MapLibre GL** (OpenMapTiles schema) + Kartverket
  `stadnamn` overrides, so names appear/disappear by zoom + rank with collision avoidance (local names
  surface as you zoom in). Adopted the same idea for the "More place names" overlay:
  - Vendored **MapLibre GL 4.7.1** + `maplibre-gl-leaflet` (`docs/vendor/maplibre/`), loaded after Leaflet.
  - New `vectorLabelsStyle(mode)` — a labels-ONLY style (place / water_name / mountain_peak symbol layers,
    zoom-stepped min-zooms, local `name` with latin fallback, white halo) over **OpenFreeMap** vector tiles
    (no API key). `applyLabelsOverlay` now renders this via `L.maplibreGL` into a dedicated `labelsPane`
    (z 350, above base tiles, below data dots) for label-free bases (Voyager `_nolabels`, Satellite), and
    falls back to the raster CARTO labels when MapLibre is unavailable. "more" lifts min-zooms by 1.
  - Tiles/glyphs are network (online-only enhancement, like the old raster labels); the library is precached
    for offline shell. CSP already permits `https:` connect + `blob:` workers, so no CSP change.

## 2026-08-05 — Species-list "Last" date opens the full filter menu even as "days back" (sw v893)

- The species list's Last date already opened the full date-filter menu (On/Before/After/Range + active ×)
  via the `sp-tbody` `.dl-date-click` handler — but only while showing a date. When the recency filter is
  active the cell shows "days back", which wasn't clickable; `lastCellSet` now wraps it in the same
  `.dl-date-click` chip (with the record's date), so the full menu opens there too.

## 2026-08-05 — Fix Annual-max/top comparison blowing past 100% (Svalbard "9000%") (sw v892)

- The current-week probability uses the grid-snapped prediction cache (v856), but `computeComparison` ran
  the annual 48-week pass at the EXACT lat/lon — so `current ÷ peak` compared two different locations and
  could exceed 1 (e.g. Svalbard showed "9000%"). `computeComparison` now uses `predictAllWeeks(lat,lon)` (the
  same grid-snapped cell, shared with the Season column's cache), so the peak always includes the current
  week and the ratio is ≤ 100%. Added a defensive `Math.min(1, …)` clamp on the ratio too.

## 2026-08-05 — Checklist button visible again (sw v891)

- Reverted v868: the Checklist button (foot of the species list) is a standard feature again, always shown
  (`applyExperimentalUi` no longer hides it). Removed the Checklist mention from the Experimental hint (en/sv).

## 2026-08-05 — Species filter menu mirrors the observer pattern (sw v890)

- The species menu's selection filter (`drmRenderMain`, `detSelected`) now works like the observer menu:
  when the species is part of the active filter it shows **Remove from species filter** (drops just it) and
  hides "Show only this species"; when any selection is active it also shows **Remove all species filters**.
  i18n `menu.removeSpFilter` / `menu.removeAllSp` (15 langs).

## 2026-08-05 — Observer menu tidy-up (sw v889)

- When "Remove from observer filter" is shown (observer is in the active filter), "Show only this observer"
  is hidden (redundant). And the clear-filter option now reads "Remove all observer filters" (`obs.removeAll`,
  15 langs) whenever a filter is set, instead of "All observers". Guarded the (now-optional) only-button handler.

## 2026-08-05 — Observer menu: remove an observer from the active filter (sw v888)

- `observerActionMenu`: when the clicked observer is part of the active observer filter, a new "Remove from
  observer filter" option drops just that observer (`detObsFilter.delete`, → All when it was the last one).
  i18n `obs.removeFilter` (15 langs).

## 2026-08-05 — Date-filter red-× indicator; version-based update button (sw v887)

- **Active date-filter × .** `showDateFilterMenu` now flags the option matching the active `detDateRange`
  (On / Before / After / Range) with a red × (`.drm-active` + `.drm-clear-x`); tapping the × clears just
  that date filter (`setDetDateFilter("","")`), tapping the rest re-applies it.
- **Update button on version mismatch.** `sw-register.js` now also does a DIRECT version check: it reads the
  running SW version and fetches `sw.js` (`cache:no-store`), and whenever the server's `VERSION` differs it
  lights up the Settings "Reload to update" button (and calls `reg.update()` to install the new SW). Runs on
  load, focus/visibility and the 15-min interval. `SWUpdate.apply()` hardened to find a waiting worker (or
  reload) when the button was lit before the install finished.

## 2026-08-05 — Total after dedup + "(N)" observations; Add-as-point editor (sw v886)

- **Total after de-duplication.** New shared `dedupedSpecimenTotal(rows)` sums specimens (no count = 1)
  over the filter-passing rows, counting a cross-database duplicate (same observer/place/date/count from
  ≥2 sources) ONCE when the dedup setting is on. Used by the list Total, the map count filter
  (`detSpeciesCount`) and the extras rows, so they agree — and it re-dedups the list's aggregation rows
  (which `detDupHidden`, holding only the plotted copies, doesn't cover).
- **"(N)" distinct observations.** The Total cell now reads `31(3)` — `distinctObsDatePairs(rows)` gives the
  count of distinct observer × date pairs. `setPairsSuffix` renders the `.det-pairs` suffix (model + extras).
- **Add-as-point → full editor.** The record-location menu's "Add as point" (now with the `dotsplus` icon)
  opens `openPointEditor` at the spot (name / list picker / colour / save) instead of dropping a loose pin.

## 2026-08-05 — Clear controls in one bar; count filter affects the map (sw v885)

- The clear-observations × and clear-filters funnel-× are now one leaflet-bar (`ClearControl`): the funnel
  sits directly **below** the ×, both at the standard control size (dropped the oversized 40px funnel).
  Merged `updateClearPtsBtn`/`updateFilterClearBtn` into `updateClearGroup` (thin aliases kept); fixed the
  stale `clearPtsCtrlEl` re-append reference to `clearGroupEl`.
- **Total-column count filter now narrows the MAP too.** New `detPassesCount(k)` / `detSpeciesCount(k)`
  added to `detIsVisible` and the legend species filter; the Total header cycle rebuilds the map dots +
  legend; `detHasFilter` includes `spCountMin` (so the funnel-× shows and clears it).

## 2026-08-05 — Column headers don't jump to map; funnel-× clear-filters button (sw v884)

- **No view jump from headers.** Cycling a sort header to OFF called `refreshCurrentView()` → `renderSpeciesList`,
  which drops to the map-first view. `sortSpeciesList` now handles the "off" state as an in-place natural
  (probability-desc) reorder, and `cycleSpeciesListSort` always sorts in place — never re-renders. Same fix
  applied to `hideSpecies`/`unhideSpecies` (use `refreshCueCellsInPlace`). The list⇄map view only changes via
  the top-right toggle now.
- **Clear-filters funnel-×.** New `filterXSvg()` (a funnel with a red ×). A large one appears on the right of
  the map (`filterclear-ctrl`, below the clear-points ×) and the legend's clear-filters button now uses the
  same icon — both shown only while `detHasFilter()`. Tap clears every filter (`clearAllFilters`, which now
  also resets the Total/Last column filters + refreshes their header labels). `updateFilterClearBtn` runs from
  `updateDetLegend`. CSS `.filterclear-btn` / `.filterx-ico`.

## 2026-08-05 — Split the n(d) column into Total (count filter) + Last (recency filter) (sw v883)

- The old combined **n(d)** header (which cycled a day filter) is split into two independent column filters:
  - **Total** (renamed, `th.total`): a pure total-specimens count with a header cycle **any → >0 → >1 → >5**
    (`spCountMin`). List-only. Removed the "(days)" suffix from the cell.
  - **Last**: the header now cycles a **recency** filter **unlimited → ≤1d → ≤3d → ≤7d → ≤14d → ≤21d**
    (`speciesAgeFilterDays` re-scoped), which also drives the global map/legend recency window. While active,
    the Last cells show **days back** (`lastCellSet` → `.sp-daysback`) instead of the date. (The Last column
    is no longer a sort target — it's a filter now.)
- `applyAgeFilter` restructured to apply both filters from `fc` (total specimens) + `flatest` (model rows) or
  `data-count`/`data-last` (extras, which now carry `data-count`). i18n `th.total` (15 langs); CSS `.sp-daysback`.

## 2026-08-05 — Counts = total specimens; add-to-list icon; green Show-on-map pin (sw v882)

- **Counts (n(d)) = total specimens.** Corrects v880's direction: the per-species count is the SUM of
  individual counts (a record with no count = 1), not the number of records. Reverted `applyAgeFilter` (`fc`)
  and `plotSharedDetections` to sum specimens, and the extras rows now compute specimens from `e.rows`
  (they aren't touched by `applyAgeFilter`). The `dedupTotal` / "unique: N" grand total stays a **record**
  count (unique observations) — a different, correctly-labelled number.
- **Add-to-list icon.** New `ico("dotsplus")` — a "+" with a scatter of dots — on the observation menu's
  **Add to list…** (`detmenu.addList`).
- **Show-on-map pin.** `detmenu.focusMap` and `locmenu.find` now use the green map-pin `ico("pin")` (inherits
  the menu's `--brand` teal-green), instead of no icon / the nav arrow.

## 2026-08-05 — New "add to route" icon (nav arrow + plus) (sw v881)

- New `ico("navplus")` — a navigation/send arrow with a "+" — for the **Add to route** action. Applied to
  the observation menu (`drmRenderMain`), the record-location menu (`showLocPointMenu`), the single
  map-point popup (`mp-route`) and the detections-list header (`#detlist-route`, which previously faked it
  with a `＋` span next to the plain nav icon; removed the now-dead `.detlist-plus` CSS). Labels use
  `tLabel(...)` so the icon isn't doubled by the string's leading "＋".

## 2026-08-05 — Fix species-list counts + date off-by-one; startup reporting note (sw v880)

- **Counts (n(d)).** `applyAgeFilter` (and the shared-map `plotSharedDetections`) summed INDIVIDUALS
  (`parseInt(r.count)||1`) while the canonical `bump` / `filterHistAgg` / `dedupTotal` count RECORDS — so
  the displayed n(d) jumped to a flock-inflated number. Both now count **records (observations)**, matching
  everything else.
- **Date off-by-one.** `lastDateLabel` / `lastDateCellHtml` formatted the "Last" timestamp with
  `new Date(ts).toISOString()` (UTC), which shifts the day back one in +UTC zones (Norway UTC+2:
  2026-07-27 → 2026-07-26). New `localISODate()` uses local calendar components; `bump` / `bumpExtra` /
  `filterHistAgg maxTs` now store `latestTs` as the date's LOCAL midnight so display/sort/age all agree.
  (Verified: Oslo now shows 2026-07-27; the old code showed 2026-07-26.)
- **Startup note.** The intro splash (`#perf-modal`) now carries a highlighted line: this map only shows
  what others have carefully reported — to contribute, register with a national (Artportalen.se,
  Artsobservasjoner.no …) or international (eBird.org, Observation.org …) service. i18n `popup.reportNote`
  (15 langs); CSS `.perf-report-note`.

## 2026-08-05 — Map clear-× uses the legend's arm-and-delete sequence (sw v879)

- The on-map red × (top-right `clearpts-btn`) cleared all detections in one click. It now mirrors the
  legend's red ×: first click **arms** per-area delete (a red × on each fetched area) when there are areas
  to pick from; the next click (or when there are none) clears everything. `updateClearPtsBtn` reflects the
  shared `detAreaDeleteMode` (armed → pulsing red fill + "click again" title, same `detClearPulse` as the
  legend). CSS `.clearpts-btn.armed`.

## 2026-08-05 — Status dots count queued + in-progress fetches (sw v878)

- The fetch-queue dots now count a fetch from the moment it's **queued** (start of `renderSpeciesList`,
  through the inference / list build) until it settles — not only while the network request is in flight.
  Moved the `fetchDotsAdd()`/`fetchDotsDone()` out of `augmentRowsWithSightings` and into `renderSpeciesList`
  with a single-release ticket (`releaseDot`) fired on the supersede bail, the catch, or the fetch promise
  settling. So a period appears the instant you trigger a fetch and the count reflects queued + in-progress.

## 2026-08-05 — Blinking in-flight-fetch dots in the status line (sw v877)

- The blinking fetch-queue dots now live in the **status field above the map** (`#status-dots` appended to
  `#demo-status`), not as a map overlay — one "." per in-flight fetch ("..." = 3 still to finish).
  `renderStatusDots()` re-appends them after every `setStatus`/`setStatusHtml` so status-text updates don't
  wipe them; `fetchDotsAdd()`/`fetchDotsDone()` bump the count on fetch start/settle. (Supersedes the v876
  map overlay.)

## 2026-08-05 — GBIF origin: read associatedReferences (Artsobservasjoner) (sw v875)

- Artsobservasjoner via GBIF carries no `datasetName`, a bare-UUID `occurrenceID`, and its
  `mobil.artsobservasjoner.no` link in **`associatedReferences`** — so `gbifOrigin` showed a bare "GBIF".
  Two fixes: (1) scan `associatedReferences` too, and (2) don't stop at a truthy-but-non-URL `occurrenceID`
  — iterate the URL-candidate fields and take the first that yields a host (stripping www/mobil/m
  sub-domains). Artsobservasjoner records now read `Artsobservasjoner[GBIF]`; other Norwegian datasets show
  their platform host instead of "GBIF".

## 2026-08-05 — Dedup keeps the direct-source copy over a GBIF republish (sw v874)

- The "Deduplicate detections" setting's cross-database dedup (`ensureDedup`) picked the first record with a
  URL as the keeper — but GBIF records also have URLs, so a GBIF copy could win. It now scores each record
  in a duplicate group (non-GBIF +2, has-url +1) and keeps the highest, so a **direct-source** entry beats a
  **GBIF republish** of the same sighting (fresher + native link). (The always-on aggregate.js dedup already
  drops GBIF records that match a native one; this aligns the setting-based layer with it.)

## 2026-08-05 — Add Italy, Austria + France GBIF bird datasets (sw v873)

- Added four national GBIF datasets to `DEFAULT_GBIF_DATASETS` after a GBIF-API gap analysis:
  - **AIRONE Wintering Birds (IT)** `a722377c…` — ~2.75M birds w/coords, ~111k in 2025 (live). Gated to IT.
  - **Salzburg biodiversity DB (AT)** `c1492854…` — ~654k, ~11k in 2025 (live). Gated to AT.
  - **Oiseaux des Jardins (FR)** `e0876b81…` (~6.5M) + **Faune-Occitanie (FR)** `c3710778…` (~3.9M) — GBIF
    copy ends ~2022, so `historicOnly: true` + gated to FR (Historic date-range fetches only, like eBird EOD).
- README GBIF list refreshed (also now lists naturgucker/IE/ZA/AU/Pl@ntNet/eBird EOD, which were missing).
- Rationale: most other national portals (UK BirdTrack, ornitho.*, Trektellen/EURING) aren't queryable live
  GBIF datasets, and US/CA/UK/ES/PL/CZ are already dominated by eBird/iNaturalist/Observation.org.

## 2026-08-05 — Identify GBIF records that carry no datasetName (sw v872)

- Some GBIF records (e.g. Observation.org) have no `datasetName`, so the source showed as a bare "GBIF"
  with no platform. `normGbif` now derives the origin via new `gbifOrigin(o)`: `datasetName`, else the host
  of the record's own URL (`occurrenceID` / `references`, e.g. `observation.org`), else `rightsHolder` — so
  `srcLabel` reads e.g. `Observation.org[GBIF]`. Added `shortOrigin` mappings: unanchored `observation.org`
  + `observation international` (the "Stichting Observation International" rights holder).

## 2026-08-05 — Remove the NatGeo base map (sw v871)

- Dropped the **NatGeo** (Esri) base map added in v870 (config entry, dropdown option, `basemap.natgeo`
  i18n ×15, README). A saved `natgeo` choice migrates to Streets via `setBasemap`'s unknown-key guard.

## 2026-08-04 — Replace Light/Dark base maps with 4 new layers (sw v870)

- Removed the **Light** and **Dark** (CARTO) base maps. Added four free, no-key layers: **Voyager**
  (CARTO Voyager — clean colour map), **CyclOSM** (trails + hillshade), **Esri Topo** (Esri World Topo) and
  **NatGeo** (Esri NatGeo World Map). Dropdown order: Voyager · Streets · CyclOSM · Topographic · Esri Topo ·
  NatGeo · Satellite.
- `setBasemap` migrates a removed/unknown saved choice (old Light/Dark) to Streets. The labels overlay now
  supports **Voyager** (swaps to `voyager_nolabels`) + Satellite; `baseUrlFor` / `labelsSupported` /
  `applyLabelsOverlay` / offline fallbacks updated off the removed layers. i18n `basemap.voyager/cyclosm/esritopo/natgeo` (15 langs); README updated.

## 2026-08-04 — Split Artportalen[GBIF] multi-observer records (sw v869)

- Artportalen via GBIF publishes co-observers as one COMMA-separated string, but the app splits observers
  on "|"/";" (comma stays intact because it appears inside "Last, First" names) — so those records read as a
  single blob observer. `normGbif` now homogenises via `gbifObserver(o)`: arrays join with " | ", and an
  Artportalen dataset's comma-separated string is converted to the "|" convention. Each observer now splits
  out, so per-observer filtering and adding individuals to observer lists work on such records.

## 2026-08-04 — Checklist button moved behind Experimental (sw v868)

- The field **Checklist** button (foot of the species list) now shows only when Experimental is on.
  New `applyExperimentalUi()` toggles `#sp-checklist-btn` visibility; called at boot and when the
  Experimental setting changes. Updated the Experimental hint (en/sv) to list the Checklist.

## 2026-08-04 — Don't drop superseded point fetches — all plot their dots (sw v867)

- Triggering several recent (point) fetches in a row used to lose the earlier ones: `applySightings`
  discards a fetch's results once a newer fetch has taken over the `sp-tbody` token, so the older fetch's
  detections (already downloaded — recent fetches aren't aborted) were thrown away. Now `augmentRowsWithSightings`
  detects the superseded case and still plots that fetch's final result in the background
  (`plotSightingsResult` with `plotNoFit`, restoring `obsStatusActive`) — the dots accumulate via
  `plotDetections` like any other fetch, so every triggered fetch ends up on the map.
- Note: this covers the recent map-first flow (`mapFetch`); Historic remains a single deliberate range fetch
  (a new one still aborts the previous).

## 2026-08-04 — Year/life-list edges toggle also hides the legend + list halos (sw v866)

- The "list edges" toggle (`listEdges`) turned off the year/life-list rings on the map dots, but the
  legend and detection-list swatches kept showing them (`detNeedClass` wasn't gated). `detNeedClass` now
  returns no halo when `listEdgesOn()` is false, so the yellow/bronze rings disappear from the legend and
  the detection/record lists too. The toggle now runs `detFiltersRefresh()` so open lists update at once.

## 2026-08-04 — Fix: cue-filter toggles stay on the list (no jump to map) (sw v865)

- Toggling a species-list cue filter (★ / ◉ / 🟠 year / 🟡 life / 🚫 hidden) no longer jumps to the map.
  The non-rare toggles called `refreshCurrentView()` → `renderSpeciesList()`, which in Species-List mode
  resets to the map-first view (`sp.style.display = "none"`). They now re-apply the filter in place via
  `refreshCueCellsInPlace()` (rare already did, via `applyAgeFilter`), falling back to the full refresh only
  when in-place can't handle the mode (e.g. country). The map dots/legend still follow the filter.

## 2026-08-04 — Date menu: explicit "Range…" popup (sw v864)

- The date-filter menu (`showDateFilterMenu`) gained a **Range…** item opening `showDateRangeModal` — a
  small `createModal` popup with from–to `<input type="date">` fields (prefilled with the active range, or
  the tapped date as the start), Cancel / Apply. Apply calls `setDetDateFilter` (tolerates a reversed
  range; both empty clears the filter). New i18n `date.range` / `date.apply` (15 langs); CSS `.date-range-modal`.

## 2026-08-04 — Source column in the record tables (sortable + filterable) (sw v863)

- The expanded per-species records and the "Per observation" table now have a **Source** column
  (`srcLabel(d)`, e.g. `Observation.org[GBIF]`): a new `src` option in `spRecRowHtml`, a `spObsHeadCell("src")`
  header in both tables (`spDetailTableHtml` / `buildSpObsHtml`, ncols +1), and a `src` case in `spObsCmp`
  for sorting. Each source is a clickable `.dl-src-click` chip → `showSrcFilterMenu` (only / hide / all),
  wired in `wireSpDetail` and added to the row-click guard. Reuses the existing `th.source` string.

## 2026-08-04 — GBIF records show their originating platform + [GBIF] (sw v862)

- `srcLabel(r)` now renders a GBIF record's source as `<platform>[GBIF]` (e.g. `Observation.org[GBIF]`)
  using the origin dataset → platform map (`shortOrigin`), instead of just the platform name. Falls back
  to plain `GBIF` when the origin is unknown / is GBIF itself. Applied everywhere `srcLabel` is used
  (record rows, source-filter chips) plus the recent-sightings badge and the map-point popup.

## 2026-08-04 — Points panel: shorter "Load" label + dots icon on Save points (sw v861)

- The Points panel's "Import shared file" button now shows the short label **Load** (reusing the existing
  `points.load` string; the full "Import shared file" stays as the hover tooltip).
- "Save points" now leads with a small **scatter-of-dots** icon (new `ico("dots")`, mirroring the header
  Points icon) instead of the generic save/disk icon.

## 2026-08-04 — Fix: species-name click in Per observation no longer jumps to the map (sw v860)

- In "Per observation", the species name sits inside the record row, so a click fired BOTH the
  `.sp-link` menu AND the row's `focusPointOnMap` — switching straight to the map. The row click handler
  now ignores clicks on `.sp-link` / `.dl-date-click` / `.sp-obs-filter` / `.sp-loc-click`, so tapping the
  name just opens the species menu and stays in the list; the map jump happens only via a map action in
  that menu (or a background tap on the row).

## 2026-08-04 — Probability column next to Season in the species list (sw v859)

- Moved the **Probability** column so it sits directly before **Season** in the Species-list table (order
  is now …n(d) · Last · Dist · Probability · Season), so the two coloured bars read together. Reordered the
  header + the main / extras / country row templates consistently; all cell access is by id/class so sort
  and the no-model/country hiding are unaffected.

## 2026-08-04 — "Show on map" places the marker + reveals the map (sw v858)

- New shared `focusPointOnMap(lat,lon)`: closes the record menu / records modal / full-screen list,
  drops the point marker (`setPointMarker`) at the location, then centres the view on it. Replaces the
  four ad-hoc "focus" handlers that only did `setView` (no marker, and didn't close the list page):
  `drmRenderMain` "Show on map", `showLocPointMenu` "Find on map", the `.dl-focus` 🎯 button, and the
  Per-observation row-background jump.

## 2026-08-04 — Scope Season to the Species-list table only (sw v857)

- The Season column now shows ONLY on the non-expanded **Species list** table. Removed it from the record
  tables (`spRecRowHtml` cell, `spDetailTableHtml` / `buildSpObsHtml` headers, `spObsCmp` sort case) and
  dropped the now-unused `seasonByKey` map + the record-table refresh in `fillSeasonCells`.

## 2026-08-04 — Season column (now vs peak) + location prediction cache (sw v856)

- **Prediction cache.** New `predCache` keyed by a discrete grid cell (`PRED_GRID_DEG` 0.1°) → per-week
  full species vectors (the model returns the whole vector per query, so one entry serves all species).
  `predictWeek(lat,lon,week)` (cached; used by the species list now) and `predictAllWeeks(lat,lon)`
  (batch-computes only the missing weeks in one run). LRU-capped (`PRED_CELL_CAP` cells). The list's
  current-week query and the Season 48-week computation share it; re-sorts / layout switches reuse it.
- **Season column.** `classifySeason(cell,idx,week)` → now-vs-peak `ratio` + phase (off / arriving ↑ /
  at peak ● / leaving ↓) using circular week neighbours for the slope. `fillSeasonCells` runs after the
  list renders (async, gen-guarded), writes each row's `.sp-season` cell (`seasonCellHtml`: glyph + % +
  coloured bar) and `data-season` sort key, and populates `seasonByKey` (shared with the record tables).
  New `<th id="sp-season-head">` (sortable via `cycleSpeciesListSort("season")`); empty cell added to the
  extras + country row templates; hidden in country-view / no-model. Record tables (`spRecRowHtml`,
  `spDetailTableHtml`, `buildSpObsHtml`, `spObsCmp`) gained a sortable Season column too.
- i18n `th.season` + `season.off/arriving/peak/leaving` (15 langs); CSS `.season-cell/.season-bar/.season-glyph`.

## 2026-08-04 — Record-table actions + species-list coloring in the observation records (sw v855)

- **Location → map actions.** In a species' expanded records, the observation's Location is now a
  clickable `.sp-loc-click` opening `showLocPointMenu` (Find on map / Add as point / Add to route).
  Reuses `addMapPoint` + `addToRoute`. i18n `locmenu.find/add/added/hint` (15 langs).
- **Observer → add to list.** The record tables' observer-name clicks now call `observerClickMenu`
  (filter-only / all / add-to-observer-list) instead of the filter-only `showObsFilterMenu` (removed as
  dead). Consistent with the legend/detlist observer clicks.
- **Species name reopens the species menu in Per observation.** `spRecRowHtml` wraps the species name in
  `.sp-link` again (regression fix) — and the link now carries the record's lat/lon/date/url so the unified
  menu also shows the "this observation" (find/route/list) section. The global `.sp-link` handler reads
  those attributes.
- **Row-background click → species + location menu.** In the expanded Species-list records, clicking the
  row background opens `showDetRowMenu` (species info + this-observation actions). Per observation keeps the
  quick jump-to-map on a background click.
- **Coloured probability bar.** The record tables render probability as a `.prob-cell`/`.prob-bar`
  (probHueColor), black text on white — matching the Species-list table instead of a plain % / species pill.

## 2026-08-04 — Soft-delete species (grey tombstone) + collapse historic controls (sw v854)

- **Delete → grey tombstone.** Deleting a species from the map no longer makes it vanish silently:
  `removeDetection` now records the removed species in a new `deletedSpecies` map (key → name) after
  removing its dots. `updateDetLegend` renders those as a grey, struck-through `.det-row-deleted` row —
  name only, **no colour swatch and no ×** — and its early-return keeps the legend alive while only
  tombstones remain. The species table greys the matching row too (`applyAgeFilter` toggles `sp-deleted`).
  Tapping a tombstone forgets the deletion (`delete deletedSpecies[key]`); re-plotting a species
  (`plotDetections`) un-deletes it automatically. `clearDetections` clears all tombstones. Persisted in
  `mapLegend.deleted` (save/load in `saveLegendState`/`loadDetections`, only re-hydrated for keys not
  currently plotted). i18n `det.deletedHint` (15 langs); CSS `.det-row-deleted` / `tr.sp-deleted`.
- **Historic controls collapse to a 📅 button.** After a historic fetch the chosen date range + months
  already show in the description text (`sp-coords`); the collapsed control (`collapseHistRange`) no longer
  repeats the "from – to" text — it's now a compact "📅 <Dates>" button that re-opens the picker, saving a
  row. i18n `hist.change` (15 langs).
- **Expanded per-species records: drop the redundant name, add location.** `spDetailTableHtml` /
  `spRecRowHtml` now omit the species name + 2nd-name columns (they're on the species row above) and add a
  sortable **Location** column (`d.place`, `spObsCmp` "loc" case). i18n `th.location` (15 langs); CSS `.sp-d-loc`.
- **Expand by clicking the row, not a caret.** The ▸/▾ caret (`.sp-exp`) is removed; clicking anywhere on a
  species row that has records toggles its expanded list — except on the active elements (species name → the
  species view; date/count/flag cells → filters). `refreshSpExpansions` marks the open row `sp-open`; the
  `sp-tbody` click handler does the row-level toggle. CSS: `tr.sp-has-det` cursor/hover + `tr.sp-open`.

## 2026-08-04 — Explain when the recency/date window hides detections (sw v853)

- New `#sp-recency-note` in the species panel + `updateRecencyNote()`: when a date filter (recency days /
  date range / months) is active AND dropping some of the fetched records, it shows the window + the hidden
  count — e.g. "Showing last 7 days — 42 detections not shown". Counts `!detDatePasses(r.date)` over the
  fetched agg; hidden when nothing's dropped (so Historic, whose range == the fetch, stays quiet). Called
  from `applyAgeFilter` + `renderSpControls`. i18n `sp.recencyNote` / `sp.lastDays` / `sp.monthsOnly`; CSS.

## 2026-08-04 — Fix: Historic fetch showed zero detections (recency filter) (sw v852)

- A Historic fetch showed **0 detections** in the list: the v847 change made `applyAgeFilter` apply the
  global recency window (`detDatePasses` → `detRecencyDays`, default 30d) to the count, so the older
  historic records were all filtered out (and their species dropped as "filtered out"). `plotSightingsResult`
  only clears recency when *plotting*, which historic doesn't do during the list fetch.
- Fix / harmonise: `renderSpeciesList` now sets the global **date range** to the fetched historic range
  (`{from,to}`, `detRecencyDays: 0`, `detMonths` = the fetched months) for a historic fetch, and clears the
  range (`detDateRange: null`) for a recent fetch. So `detDatePasses` treats both consistently in the list
  and on the map.

## 2026-08-04 — Record tables: separate name columns, count, per-group sort, colour dot (sw v851)

- **Rewrote the record tables** (`spRecRowHtml` + `spObsCmp` + `spObsHeadCell`, replacing `spGroupTableHtml`):
  columns are **colour dot + species name · 2nd name · probability · [date] · distance · count · [observer]**
  — the 2nd name is its **own column** (no more parenthesised name), plus a **count** column (`th.count` = "#").
- **Per-column sorting within groups**: shared `spObsSort` (name/name2/prob/date/dist/count/obs); clicking a
  header cycles asc→desc→off and re-sorts the records **within each date × observer × location group**.
  "Per observation" is now ONE table (`buildSpObsHtml`) with spanning group-separator rows (`.sp-obs-grp`).
- **Consistent colouring**: new `spColorDot(key)` (from `detPlot[key].color`, else a stable `keyHue`) leads
  every record row AND every species-list row; `applySightings` updates the species-list dot to the plotted
  map colour. i18n `th.count`; CSS `.sp-cdot` / `.sp-obs-h` / `.sp-obs-grp`.

## 2026-08-04 — Headers on expand tables; all dates/observers clickable to filter (sw v850)

- **Column headers** on the expanded species records (`spDetailTableHtml`) and the Per-observation group
  tables (`spGroupTableHtml`): Species · 2nd name · Prob · Date · Dist · Observer. New i18n `th.date` /
  `th.obs`; `.sp-detail-tbl thead th` CSS.
- **All dates are click-to-filter**: the species list's **Last** column is now a `.dl-date-click`
  (`lastDateCellHtml`, wired in the `#sp-tbody` handler), and `detRowHtml`'s record date uses the new
  `dateClickHtml`. General `.dl-date-click` style added.
- **Observers filterable**: `observerActionMenu` (from the popup's observer names) now refreshes both
  surfaces via `detFiltersRefresh` and offers **All observers** (clear) alongside **Only this observer**;
  the fetch-list tables use `sp-obs-filter` → `showObsFilterMenu`.

## 2026-08-04 — List filters drive the map; no auto view-switch; Per-obs tabular (sw v849)

- **Flag columns → global filters**: toggling ★/◉/🟠/🟡 now mirrors to `detStarFilter`/`detRareFilter`/
  `detYearFilter`/`detLifeFilter` (+ `rebuildDetLayers`/`updateDetLegend`), so the MAP dots + legend +
  record views narrow to those species too (🚫 hidden stays list-only). `renderSpeciesList` syncs the flag
  state from the global filters on each fetch.
- **n(d) day filter → global recency**: the n(d) header cycle now sets `detRecencyDays` (+ clears the date
  range) so the map narrows to the same window (≤1d = today/yesterday, …).
- **No auto view-switch**: `plotSightingsResult` no longer hides the species panel — the list⇄map view only
  changes when the user taps the header toggle (a re-plot on filter change won't yank you off the list).
- **"Per observation" tabular**: new `buildSpObsHtml` + `spGroupTableHtml` — records grouped by
  date × observer × location, each group a columns table (species · 2nd name · prob · distance); the group
  header's date + observer are clickable to filter.

## 2026-08-04 — Expanded species records as a columns table (sw v848)

- The expand sub-list is now a **columns table** (`spDetailTableHtml` + `wireSpDetail`, replacing the
  freeform `detRowHtml` rows): **species name · 2nd name · probability (per-record `_prob` at that
  location) · date · distance · observer**. Date (`.dl-date-click`) and observer (`.sp-obs-filter`) are
  clickable to filter; tapping a record row jumps the map to it.
- New `showObsFilterMenu` (Only this observer / All observers → `setDetObsFilter`); i18n `obs.only` /
  `obs.all` / `obs.filterHint` (15 langs). CSS `.sp-detail-tbl`.

## 2026-08-04 — Species table respects the observation filters (no empty expands) (sw v847)

- `applyAgeFilter` now applies the **global observation filters** (`detDatePasses` / `detObsPasses` /
  `detPassesSrc`) to each model-species row: it counts only the passing records, updates the **n(d)**
  count + days + **Last** cells to the filtered values, toggles the **expand caret** (`sp-has-det`) on the
  filtered count, and **hides** a species that was observed but has zero passing records. So an expandable
  row can no longer be empty, and the list respects filtering throughout (matching the map + record
  views). Runs from the fetch path, filter changes, and sort.

## 2026-08-04 — Expandable species rows (sub-list of records) (sw v846)

- Each model-species row in the table gains a **▸ expand caret** (`.sp-exp`, shown only on rows with
  detections via `sp-has-det`, set in `applySightings`). Tapping it opens a **sub-row** (`.sp-detail-row`
  / `.sp-detail-cell`, `colspan`) listing that species' individual records via `detRowHtml` (wired with
  `wireRecordList`), sorted per the active list sort (`spDetailRowsFor` → distance/last where relevant,
  else newest-first).
- Expanded state tracked in `spExpanded`; `refreshSpExpansions()` removes + re-inserts the sub-rows fresh
  after `sortSpeciesList` and `applyAgeFilter` (which skip `.sp-detail-row`), so sublists follow sort +
  visibility. i18n `sp.expandHint` (15 langs).

## 2026-08-04 — Consolidate fetch-list layouts; Last column; Per-obs by location (sw v845)

- **Layout dropdown → two options**: `Species list` (the table) and `Per observation`. The By
  species/count/rarity/distance record layouts are folded into the table's sortable columns
  (`SP_LAYOUTS` trimmed; `spRecordLayout()` always `date`).
- **New sortable "Last" column** (most-recent observation date per species): header `sp-last-head`
  (`th.last`), cells in the model/extras/country row templates, filled in `applySightings` from
  `agg.latestTs` (+ `data-last` for sort), `lastDateLabel(ts)` helper; `sortSpeciesList` `last` branch
  (newest first, undated last), cols map + header click.
- **"Per observation" groups by date → observer → location** (`buildRecordListHtml` date layout now keys
  on observer+place; `.dl-loc` shown in the header).
- i18n `th.last` (15 langs).

## 2026-08-04 — Hover point tooltip opens below the point, height-capped (sw v844)

- The on-map hover tooltip (`showDetHover`) now opens **below** the point by default (flipping above only
  when the point is very low on screen), so it can't run off the TOP of the window and hide the newest
  detections (which lead the content, newest-date-first). Direction/offset are set per-hover from the
  point's on-screen position (Leaflet tooltips don't auto-flip).
- Capped the tooltip height (`max-height: 60vh; overflow: hidden`) so a very dense spot stays within the
  window; clipping only drops the oldest (bottom) dates.

## 2026-08-04 — Hover tooltips on the record list's active elements (sw v843)

- Explanatory `title` tooltips on the detailed record list: the record row (`detlist.rowHint` — "Species
  info & actions"), plus the existing date-header (filter by date), source (filter by source), observer
  (add to list), and species-group (expand) hints. Completes the hover-explanation pass for the
  fetch-list/popup record views.

## 2026-08-04 — Slim the popup to per-location; remove whole-map ☰; 2nd-name sortable (sw v842)

- **Detections popup is now per-location only**: removed its filter toggle bar, the species search box and
  "Select N on map" (HTML + `renderDetListModal` logic + the dead init wiring). It keeps the header
  (place title, copy-coords, Save, Navigate, Add-to-route) + the layout sort + the record body, and still
  honours the global filters (now set from the fetch list) via `collectVisibleDetections`.
- **Removed the whole-map ☰** (`det-list-btn`) from the legend head + its handler — the fetch list's
  "By observation" is the all-records view now.
- `updateDetLegendKeepObsScroll` / obs-scroll helpers now target `#sp-filters-wrap` (the filter bar's new
  home) and refresh the fetch list.
- **2nd-name column sortable** in the species list: `sortSpeciesList` gains a `name2` branch (reads the
  `.name2` cell); `cycleSpeciesListSort` default asc; added to `updateSortIndicators` cols + header click;
  `clickable-head` on `#sp-name2-head`.

## 2026-08-04 — Fetch list gains layout dropdown + detailed record views (sw v841)

- **Shared record renderer**: extracted the detlist body into `buildRecordListHtml(rows, layout, openMap)`
  + `wireRecordList(body, reRender)` (layouts: `date`/observation, `name`/species, `name2`, `count`,
  `rarity`, and a new flat `distance`). `renderDetListModal` now uses them (no behaviour change).
- **Fetch list (`#species-panel`)** gained a **layout `<select>`** (`sp-layout`: Species list · By
  observation · By species · By count · By rarity · By distance) and, for the record layouts, the
  **observation filter bar** (`renderSpControls`/`renderSpFilterBar`/`renderSpBody` + `#sp-controls`,
  `#sp-filters-bar`, `#sp-filters-wrap`, `#sp-records`). Record views scope to all plotted observations
  (`collectVisibleDetections`) and respect the global filters; the prediction table keeps its own flag
  columns. Gated to list/historic modes (`speciesPanelPopulated`).
- **Unified filter refresh**: `detFiltersRefresh()` now re-renders the popup AND the fetch list;
  `wireDetFilters` routes through it (`reRenderFilterBar` for panel-open toggles); `clearAllFilters` too.
- New i18n `splay.*` + `detlist.expandHint` in all 15 languages. CSS for `#sp-controls`/`#sp-records`.
- Still to come (plan): slim the popup to per-location + remove the whole-map ☰; table n(d) filter-
  awareness / retire the age cycle; full hover-tooltip pass.

## 2026-08-04 — Filter by data source (click a source in the list) (sw v840)

- **New global source filter** `detSrcFilter` (Set of source labels, or null = all) + `detPassesSrc(r)`,
  applied wherever rows are gated: `collectVisibleDetections`, the dot-draw loop, and `detVisibleCount`
  (so map dots, legend counts and the list all honour it). `detSourcesPresent()` lists the sources in the
  plotted set.
- **Clickable source** in each record row (`srcClickHtml` / `.dl-src-click`) → `showSrcFilterMenu`:
  Only this source · Hide this source (when >1 present) · All sources. Natural in-list placement, no new
  top-bar control. Persisted in `mapLegend.srcFilter` (with a stale-filter heal on load); wired into
  `detHasFilter` + `clearAllFilters`.
- New i18n `src.only` / `src.hide` / `src.all` / `detlist.srcFilterHint` in all 15 languages.

## 2026-08-04 — Date-header click → On/Before/After date filter (sw v839)

- In the detailed detections list, **date headers are clickable** (`.dl-date-click`): tapping one opens a
  small menu (`showDateFilterMenu`) with **On this date / Before this date / After this date**, which sets
  the global `detDateRange` via `setDetDateFilter` (also clearing the month-of-year filter) and refreshes
  map + legend + list through the new shared `detFiltersRefresh()`.
- New i18n `date.on` / `date.before` / `date.after` / `detlist.dateFilterHint` in all 15 languages.
- First increment of the larger plan in `tasks/fetch-list-controls_20260804.md` (move filtering + layout,
  incl. a full-detail "By observation" view and a source filter, onto the fetched species list; slim the
  popup to per-location).

## 2026-08-04 — Clear-× sits below the other right-side map icons (sw v838)

- The red clear-× is now re-appended below the download + overlay-toggle controls (it was added before
  the overlay-toggles control, so Leaflet stacked it between them); it now sits at the bottom of the
  top-right column.

## 2026-08-04 — Red × on the right of the map clears all plotted points (sw v837)

- **New `ClearPointsControl`** (Leaflet control, `position: "topright"`): a red × shown only while
  observations are plotted; one tap calls `clearDetections()` (the legend's clear-the-map action) and
  then hides. Visibility is driven by `updateClearPtsBtn()` (checks `Object.keys(detPlot).length`), called
  from `updateDetLegend()` so it tracks every plot/clear/reload.
- New `.clearpts-btn` CSS (red glyph, white-on-red hover) and i18n `ctrl.clearPoints` across all 15 languages.

## 2026-08-04 — "Show only this species" in the species menu (sw v836)

- **The unified species menu (`drmRenderMain`, opened by tapping any `.sp-link` name — list, legend,
  detections) gained a "Show only this species" action** when the species is plotted (`detPlot[key]`). It
  isolates that species by setting `detSelected = { [key]: true }` (the same selection the legend/map
  honour via `detSelectionActive`), then `saveLegendState` + `rebuildDetLayers` + `updateDetLegend` and
  re-renders the detections list if open. If it's already the only isolated species it flips to
  "Show all species" and clears the selection.
- New i18n `menu.filterSp` / `menu.showAllSp` across all 15 languages.

## 2026-08-03 — List⇄Map toggle survives reload from the map view (sw v835)

- **Fixed the List⇄Map header toggle going missing after a reload/revisit** when you'd been looking at
  the map (not the list page). `currentSpView` is runtime-only, and `restoreSession` only rebuilt it when
  the saved `page === "species"`; if the list page had been closed (`page` cleared to `""`) it restored
  nothing, so `viewToggleAvail()` stayed false. `restoreSession` now re-renders the saved point in list
  mode whenever there's a saved lat/lon and `page` is `"species"` or empty — reopening the list if that's
  where we left off (`urlForceView`), else letting map-first land back on the map. Either way
  `currentSpView` + the toggle come back.

## 2026-08-03 — Clickable red fetch-failure status (sw v834)

- **A failed/timed-out source now shows as red, clickable text** in the status strip; tapping it opens a
  dialog with the per-source reason(s) — `showFetchErrors(failed, timedOut)` (+ a "Manage data sources…"
  shortcut when a free API key is missing). New `.status-err` style; `wireStatusFetchErrs` binds the spans
  (click + Enter/Space) right after each `setStatusHtml`.
- Wired at both completion points: `augmentRowsWithSightings` (recent/historic, list + map-first) and
  `plotSightingsResult` (map plot, incl. the "nothing plotted, all failed" case). Timed-out source chips in
  the plot status are now clickable too.
- **Removed the automatic error pop-up** (`reportFetchErrors`, with its dedupe signature) — the explanation
  is now opt-in via the red text, so a routine failed source no longer interrupts with a dialog.

## 2026-08-03 — Route lists: badge + direct Google Maps directions (sw v833)

- **Points panel marks route lists**: `mpCollRowHtml` takes an `isRoute` flag (`isRouteColl(c)`) and
  renders a small ➤ badge (`.mp-coll-route`) after the name plus an `.is-route` row class; the 🧭 button's
  tooltip switches to "Navigate in Google Maps".
- **The 🧭 on a route list opens directions directly**: the `mp-coll-nav` handler now routes a route list's
  stops through Google Maps (`navigateStops`, extracted from `navigateRoute`) instead of the pin-overlay
  KML (`sendPointsToGoogle`) used for ordinary lists / detection sets.

## 2026-08-03 — Saved routes reload as numbered, navigable routes (sw v832)

- A saved point-list is now recognised as a **route** (`isRouteColl`: the new `c.route` flag set by
  `saveRouteAsList`, or — for older saves — every point's `source === "route"`).
- **Reloading/showing a saved route restores the route UI**: `activeRoute()` = the live basket if it has
  stops, else `shownRouteStops()` (the ticked route lists). `renderRoutePoints` draws numbered stops for
  it and `updateRouteChip` shows the bottom nav bar; both are now refreshed from `renderMapPoints`, and a
  shown route list is skipped in the plain-pin loop (drawn as numbered stops instead). So ticking a saved
  route — or reopening the app with one shown — brings back the numbers + the navigate bar.
- **Saving a route** (`saveRouteAsList`) marks the list `route: true` and **empties the live basket**, so
  the stops live on as the shown saved list (no double-drawn pins). The route bar hides its "Save" button
  for a reloaded saved route (already saved) and its × hides the shown route rather than clearing a basket.
- `navigateRoute` routes `activeRoute()`, so Navigate works for a reloaded saved route too.

## 2026-08-03 — Detections list header/toolbar tidy-up (sw v831)

- **Reverted** the per-record inline ➤/＋➤ buttons from v830 (too noisy on every species row).
- **Header "add to route"**: new `#detlist-route` button (＋ + `ico("nav")`) beside Navigate — adds the
  list's spot (same averaged position Navigate uses, named after the title) to the route via `addToRoute`.
- **Save button icon** changed from the floppy `ico("save")` to the 6-dot points-scatter glyph (the same
  one the Points button uses), signalling "save as a point list".
- **Copy-coordinates moved in front of the place name**: `#detlist-coords` now leads a new
  `.detlist-title-row` (was in the actions row).
- **Search + filters on one row**: `detFilterBarHtml` split into `detFilterTogglesHtml` (the toggle bar,
  rendered into `#detlist-filters-bar` inside the search row) + `detFilterPanelsHtml` (open subwindows,
  full-width in `#detlist-filters-wrap` below). "Filter species" is narrower (`flex: 0 1 200px`) with the
  day / rarity+year-list / observer toggles beside it. `wireDetFilters` now binds on `#detlist-box` so it
  reaches both containers.

## 2026-08-03 — Inline navigate + add-to-route on detection rows (sw v830)

- **Each Detections list (☰) row now has two inline shortcut controls** (spans, like the existing 🎯
  focus), added in `detRowHtml` when the record has coordinates:
  - **➤ navigate** (`.dl-nav`, `ico("nav")`) → `navigatePoints([{lat,lon}])` — a one-stop Google Maps
    route to that record's location.
  - **＋➤ add to route/tour** (`.dl-route`, "+"-prefixed `ico("nav")`) → `addToRoute(lat, lon, name)` —
    drops the spot into the bottom route bar.
  - Both stop propagation so they don't also open the row menu; wired via delegation next to the
    `.dl-focus` handler. The row popup menu still offers "Navigate here" / "Add to route" as well.
- Reuses existing i18n (`nav.here`, `route.add`) — no new keys. CSS: `.dl-nav` / `.dl-route` /
  `.dl-route-plus` mirror `.dl-focus`.

## 2026-08-03 — `location=` accepts coordinates + README examples (sw v829)

- **`location` now also accepts explicit `lat,lon`** (e.g. `?location=60.12312,32.00123`), not just
  `here` — `maybeUrlLocationParam` parses/validates the pair and opens that point directly (no
  geolocation). `here` still geolocates. Unrecognised values are ignored.
- README: expanded the **Shortcut URLs** section with a full parameter table and copy-paste example URLs.

## 2026-08-03 — `?location=here` shortcut URL (sw v828)

- **New deep-link** `?location=here;radius=5;show=list;sortby=time_recent` (semicolon- or `&`-separated;
  `parseSemiParams()` handles both since `URLSearchParams` only splits on `&`). `maybeUrlLocationParam()`
  geolocates, switches to Species-List mode, sets the radius + sort, and renders the point.
  - `location` — `here` (geolocate) is the only value for now; anything else is ignored.
  - `radius` — km, persisted to `recentRadiusKm` (clamped 0.1–150) and reflected in the Settings slider.
  - `show` — `map` (default: map-first, dots stream in via the new `spMapFetch` path) or `list` (opens
    the list page directly via the one-shot `urlForceView` flag consumed in `renderSpeciesList`).
  - `sortby` — `rarity_increasing` (default = probability desc), `rarity_decreasing` (probability asc),
    or `time_recent` (new `"recent"` sort column in `sortSpeciesList`, ordering by `latestTs` desc).
- `init` routes to the new handler when a `location` param is present (and treats it like `?here` for
  skipping session-restore / fetch-on-open); legacy `?here=1` still works.

## 2026-08-03 — Zoom stops land exactly on the H3 grid (sw v827)

- **Phased the zoom-snap ladder onto the real H3 resolutions.** Snapping was to plain multiples of
  `H3_ZOOM_STEP` (phase 0), which had the right spacing but the wrong phase — at a stop an H3 cell could
  be up to ~1.8× off its target on-screen size. The ladder is now `H3_ZOOM_PHASE + k·H3_ZOOM_STEP`,
  where `H3_ZOOM_PHASE` is derived (via `h3ZoomForRes`) from the zoom at which a resolution's average
  edge equals `H3_TARGET_EDGE_PX` (15px). Verified against the h3 lib: every stop matches the exact
  resolution zoom to < 0.001.
- `map._limitZoom` is overridden to snap onto the phased ladder (Leaflet's `zoomSnap` only rounds to
  multiples), so every zoom path — wheel, ± buttons, `setView`, `fitBounds` — settles on-grid. The
  initial view is re-snapped once after the override (the constructor used Leaflet's un-phased rule).
- `minZoom`/`maxZoom` and `offlineZoomLevels` now walk the phased ladder. The deepest stop is H3
  resolution 13 (zoom ≈ 19.33), so offline downloads still resolve to level 19.

## 2026-08-03 — Higher map detail: zoom + offline downloads reach level 19 (sw v826)

- **Raised the map's deepest zoom** `MAX_ZOOM` 18 → 20 so interactive zoom (H3-snapped to ~19.7) and
  area downloads can reach detail level 19 (was effectively ~17, capped by the H3-snapped map max).
- **Offline "Download max zoom"** now offers `19 · maximum (full)` (options 11/13/15/17/19), selected by
  default; `offlineMaxZoom` default + clamp raised to 19. On 19-native basemaps (CARTO/OSM/Esri) area
  downloads now fetch z19 tiles; OpenTopoMap still tops out at its native z17.
- Extended `ZOOM_STEP` with entries for z19–20 so the richness heatmap cell size stays sensible at the
  new deepest zooms (`ZOOM_STEP[z] || 3` already guarded against a miss).

## 2026-08-03 — Dots drop live as a point fetch streams (sw v825)

- **Map-first Species-List fetch with progressive plotting.** Tapping a point in Species-List mode now
  goes straight to the map instead of showing the list first: the observation dots are dropped on as
  each source resolves (`applySightings` calls `plotSightingsResult` per partial when the new
  `spMapFetch` flag is set), rather than only after the whole fetch completes (was the v824 behaviour).
  The list is still rendered but kept hidden (`species-panel` `display:none`) until the header list
  icon is tapped — `updateViewToggle` shows the LIST icon while on the map, and `showListView` opens
  the (already-filling) list on demand.
- Partial plots suppress `fitBounds` via a new `plotNoFit` flag so the view stays put while dots land;
  the final plot fits once. Empty early partials no longer flash "no detections" (guarded on
  `plotNoFit`). The flag is released when the fetch settles so later toggles use the normal fit path.

## 2026-08-03 — Fetch lands on the map · single-icon toggle · clearer status (sw v824)

- **Fetching a point now loads the detections straight onto the map** (Species-List mode): when the
  point fetch resolves with data, it auto-switches to the map view (`goToMapView`), guarded by the
  list generation + still-on-list checks. Toggle to the list any time.
- **List⇄Map switch is now a single icon** showing the view you'd switch TO — a list icon while the
  map is shown, a map icon while the list is shown (was a two-segment control). Reuses `.hdr-icon-btn`
  styling; disabled while on the list until there's data to plot.
- **Status text above the map** is more legible (darker `--ink`, 0.84rem, taller min-height + more
  bottom spacing) so it reads well over the map.

## 2026-08-03 — Distance column in the species list · toggle far-right · drop "Close by" (sw v823)

- **Sortable "Dist" column** in the species list: for each species, the distance from the list's
  point to its **nearest** plotted detection (`nearestDetKm` + `nearbyFmtDist`, filled in
  `applySightings` for model rows and `prependExtraSightings` for extras). Click the header to sort
  (ascending = nearest first; species with no detection sink to the bottom). Added to all three
  row templates (point/historic, and the country list gets an empty aligning cell) + `updateSortIndicators`.
- **Removed the "Close by" map button** and its two settings — that distance-sorted list is now the
  Distance column. `openNearby` is left dead (other `nearby*` helpers stay, still referenced).
- **List⇄Map switch** moved to the **far right** of the top bar (appended after `#fs-wrap`).
- New i18n `th.dist` (15 languages).

## 2026-08-03 — Switching to the List restricts it to the current map view (sw v822)

- When you flip from Map → List with the header switch, `restrictListToView()` now hides every
  species-list row whose species has **no visible plotted detection inside the current map
  viewport** — so the list matches what's on screen. A "In map view: {n} species" status confirms
  the count. One-shot over the rendered rows (interacting with the list re-reveals all, so it's not
  a trap); the initial fetch list is still the full list.
- New i18n `sp.inView` (15 languages).

## 2026-08-03 — Move the List⇄Map switch into the green top bar (sw v821)

- The switch is now relocated into `#site-header` (the green top bar) at init — appended right
  before `#fs-wrap`, with `margin-left:auto` so it sits **immediately left of the Fullscreen icon**
  — instead of the controls row above the map (where the status text shows). Restyled for the green
  bar (translucent-white buttons, white-on-green icons, active = solid white with a brand-green icon).

## 2026-08-03 — Header List⇄Map switch · points icon · checklist moved (sw v820)

- **List ⇄ Map switch** in the header (between the Points and Fullscreen icons), shown while a
  fetched species list is available (Species-List / Historic). Flips between the list page and the
  plotted map, so you can hop back to the list from the map. Replaces the in-list "📍 Map" button.
  `showListView` / `goToMapView` / `updateViewToggle`; nav-stack aware (navOpen/navClose "page").
- **Map-points header icon** changed to 6 scattered dots.
- **Checklist button** moved from the top of the species-list page to the **bottom action row**,
  next to PDF (and CSV, which `relocateCsvButton` already docks there in list mode).
- `updateSpMapBtn` now gates the switch's Map side (disabled until there's data). 2 new i18n keys
  (`view.list/map`) in 15 languages.

## 2026-08-03 — kråke fix (GBIF too) · legend select on PC · BirdLife → Experimental (sw v819)

- **kråke / svartkråke (Norway), round 2:** verified via GBIF that **94% of Norway's "Corvus corone"
  occurrences (26.5k of 28k) come from Artsobservasjoner** — i.e. Hooded Crows filed under the lumped
  name and republished through GBIF (no vernacular carried). The v814 fix only touched the *direct*
  Artsobs source, so those still inflated svartkråke (and no longer deduped against the corrected
  copy). `normGbif` now folds GBIF records with `countryCode === "NO"` and `Corvus corone` →
  `Corvus cornix` (`fixGbifNordicCrow`). Carrion Crow is a genuine NO rarity, so the few real ones
  fold in too — accepted trade-off; SE/DK untouched. `SIGHT_CACHE_VER` 5 → 6.
- **Legend selection on PC:** hover-isolate now defers to an active selection — once you've clicked
  species to restrict the map, passive mouse-hover no longer masks that selection (touch already
  worked, having no hover).
- **BirdLife DataZone** moved behind **Experimental features** in the species menu (with NBN Atlas
  and EuroBirdPortal). English hint updated.

## 2026-08-03 — Extend Shift+hover help to offline / legend / detections list (sw v818)

- Generalised the Shift+hover help to a reusable `data-help="<i18n key>"` (+ optional
  `data-help-title`) attribute so it also covers **re-rendered** UI. `initMapHelpTips` now
  delegates on `[data-help]` and positions near the cursor.
- Added help to: the **offline-maps download** button (`maphelp.offline`), the **legend top row**
  (`maphelp.legend`), and the **detections-list** header (`maphelp.detlist`, titled via the existing
  `detlist.title`). The 3 map buttons now carry `data-help` too.
- 3 new i18n keys in 15 languages (long → the popover scrolls).

## 2026-08-03 — Shift+hover help on the map function buttons (desktop) (sw v817)

- On a PC, holding **Shift** while hovering the **Locate/crosshair**, **Close by**, or **Place
  search** control shows a scrollable popover explaining that control's interactions.
  `initMapHelpTips()` delegates on document (controls are created later); shows on
  Shift+mouseover, follows Shift keydown while hovering, hides on Shift keyup / leaving both the
  control and the popover / window blur. Disabled on touch (`hover: hover` gate).
- The popover (`.map-help-pop`) is a card, `max-height: 60vh; overflow-y: auto`, so long text
  scrolls; move onto it (still holding Shift) and wheel-scroll.
- New `MAP_HELP` map (selector → title/body keys) — extensible to more controls. 3 new i18n keys
  (`maphelp.cross/nearby/search`) in 15 languages.

## 2026-08-03 — "Experimental features" toggle gates NBN Atlas / EuroBirdPortal (sw v816)

- New Settings toggle **Experimental features** (`experimental`, default off, in Display & language).
  When on, `drmRenderMain` shows the less-polished species-menu references — **NBN Atlas** and
  **EuroBirdPortal** — which are hidden by default. Extensible: the gate (`experimentalOn`) is the
  home for future try-it-out links/features.
- Toggling it closes any open species menu so the gated links refresh. 2 new i18n keys
  (`ctrl.experimental(+Hint)`) in 15 languages. Help updated.

## 2026-08-03 — Group-aware photo links (iNaturalist for all; Macaulay birds-only) (sw v815)

- Species menu's external references are now chosen by group. New URL helpers `inatPhotosUrl`,
  `powoUrl`, `adwUrl`.
  - **iNaturalist photos** added for **every** species — the one photo source that works beyond
    birds (mammals, plants, fungi, insects, amphibians).
  - **Macaulay Library** now shows **only for birds** (was a near-useless `q=` search for others).
  - **Kew POWO** added for **plants**; **Animal Diversity Web** for **mammals**; **Xeno-canto**
    (audio) restricted to animals (dropped for plants/fungi).
- The Information section now renders for **non-model species too** (plants/fungi extras): they
  reach it via a sci name (derived from the `x:<sci>` key), so they finally get photo/reference
  links. Model-only actions (range/migration/distribution map) stay gated to model species.
- Class resolved via `detClassOf` (works for plotted extras) / `taxByCode`. 3 new i18n keys
  (`menu.inat/adw/powo`) in 15 languages, reusing each locale's "Photos" descriptor. Help updated.

## 2026-08-03 — Fix Norwegian "kråke" folding into svartkråke (Corvus corone) (sw v814)

- **Root cause (verified against the live APIs):** Artsobservasjoner records the Hooded Crow
  (vernacular "kråke", the common Scandinavian crow) under the binomial **`Corvus corone`** — which
  internationally, and in the model, is the *Carrion* Crow (**svartkråke**, genuinely scarce in
  Norway). So every kråke exact-matched svartkråke and inflated it. (GBIF is unaffected — it resolves
  the split correctly to `Corvus cornix`.)
- **Fix 1 (`normalize.js`):** `fixNorwegianSci` remaps an Artsobservasjoner record whose ScientificName
  is `Corvus corone` and whose Norwegian `Name` is `kråke` to **`Corvus cornix`** (Hooded Crow).
  "svartkråke" and all other names are left untouched. Applies to the recent fetch and the historic
  Nordic top-up.
- **Fix 2 (`aggregate.js`):** general subspecies-trinomial handling — `labelBySubspecies` matches
  "Genus species subspecies" to the model's split species "Genus subspecies" (e.g. `Corvus corone
  cornix` → `Corvus cornix`) before the epithet fallback (which used to grab the middle word = the
  nominate).
- `SIGHT_CACHE_VER` 4 → 5 so pre-fix cached results are re-aggregated.

## 2026-08-02 — Hover a species name → tight sci/2nd-name popup (sw v813)

- Hovering any species name (`.sp-link`, anywhere) now shows a small tight popup: the **scientific
  name** (italic) when "Scientific names" is on, and on a **second line** the **2nd-language name**
  when a 2nd name is set. Independent of each other; no popup if neither applies.
- Delegated `mouseover`/`mouseout` on `.sp-link`, hover-capable devices only (taps on touch still
  just open the species menu). Reads `data-sci` + derives the 2nd name from `data-key`
  (`labelsByKey` → `secondName`). New `.sp-hovertip` styles.

## 2026-08-02 — "2nd name" setting always available (sw v812)

- The **2nd name** (second-language) control in Settings was only shown in Species List / Range
  modes (`updateModeVisibility` gated it on `listish`), so it "disappeared" in Historic / Migration /
  Richness. It's a display preference used app-wide (species lists, the detections list sort, species
  menus), so it's now always visible. "Compare to" stays list/range-only.

## 2026-08-02 — Remove Fågelkartan from Norway's national databases (sw v811)

- Dropped the `NO` "Fågelkartan" entry (it pointed at the Swedish `fagelkartan.se/no/`); the
  Swedish (`SE`) Fågelkartan entry is unchanged. Existing users can also remove it via
  Settings → National databases.

## 2026-08-01 — Place-labels overlay no longer doubles up the map's names (sw v809)

- The "Place labels" overlay printed CARTO's labels-only tiles ON TOP of `light_all`/`dark_all`,
  which already bake names in — so On duplicated them and couldn't be denser. Now, when labels are
  on, the CARTO base switches to its **`_nolabels`** variant (`baseUrlFor`), so the overlay is the
  **only** set of names. `More` (zoomOffset +1) is now genuinely denser than the plain map.
- Skipped on **streets/topo** (`labelsSupported`): OSM/OpenTopoMap have no labels-free tiles, so the
  overlay would just print a second, misaligned set — their built-in names are left as-is.
- The label-mode change now re-applies the base (`setBasemap`) so the `_all`↔`_nolabels` swap
  happens; `offlineLayers`/`offlineLayerFor` updated to cache/rebuild the matching variant (labels
  overlay cached in the aligned "on" mode). Help text updated.

## 2026-08-01 — Refresh the map hint when the crosshair turns off (sw v808)

- `setCrosshairState(0)` now resets the status line to `modeHint()`. Cycling the crosshair
  off (grey) previously left the stale "GPS follow on" / "Read cursor on" text over the map;
  it now shows the current mode's guidance again. (States 1/2 already updated it.)

## 2026-08-01 — Shorter update button label (sw v807)

- `settings.updateReady` shortened "Reload to update to {v}" → "Update to {v}" (all 15 languages);
  the button still shows the ↻ prefix, so it reads "↻ Update to vNNN".

## 2026-08-01 — Fetch-on-open showcases the result when idle (sw v806)

- On a Fetch-on-open load, `plotSightingsResult` now plots in the **background** (no per-location
  view fit, no surfacing the map) while `autoOpenPlotting` is set.
- Interaction is tracked from boot via `armFetchOnOpen()` (capture-phase pointerdown / mousedown /
  touchstart / wheel / keydown → `fooEngaged`), armed **before** the 1.2 s delay so an early tap counts.
- At completion, if the user **hasn't** engaged and something was plotted: surface the map, **fit all
  visible detection points** (`fitAllDetectionPoints`, area-box fallback), and **maximize the legend**
  (`detLegendMini = false`). If they **have** engaged, nothing is disturbed — the dots just accumulate.
- The manual "Fetch observations" button keeps its existing fit-to-areas behaviour.
- Help note added (English).

## 2026-08-01 — Historic date-range / month subset cache reuse (sw v805)

- New `histAggCache[lat,lon:rkm:group] = {from, to, months[], out}` keeps the broadest COMPLETED
  historic result per spot/radius/group (not wiped between fetches; capped ~4; stored only when the
  fetch finished un-aborted with data).
- `fetchHistoricSightingsAt`: when a new request's date range **and** month-of-year set fall inside a
  cached one (`histCovers`), it filters the cached aggregate (`filterHistAgg` — filter each species'
  rows by date + month, recompute count/latest/bySrc) and returns it **with no network**, showing a
  "Reused cached observations" status.
- `plotHistoricAgg(out, grp)` factored out of `plotHistoricRecs` so the reuse path can plot from an
  aggregate (it has no raw records). Reuse plots by accumulation — the same as a fresh narrower fetch,
  which also accumulates rather than clearing — so there's no change to map behaviour. To *narrow* the
  dots shown, the detlist month-chip / date-range display filters (already shipped) do that.
- New i18n `hist.reused` (15 languages).

## 2026-08-01 — "All" spans every kingdom + group-subset cache reuse (sw v804)

- **"All groups" now fetches plants & fungi too** (`groupTaxaList("all")` += plantae, fungi), so a
  cached "All" result is a true superset of every single group.
- **`aggregateRecords` kingdom filter is now group-aware** (was unconditional): animal groups keep
  their class and drop non-animals (unchanged); **Plants/Fungi keep that kingdom (fixes a latent bug
  that dropped all their records)**; "All" keeps animals + plants + fungi.
- **Group-subset reuse:** `fetchAllSightingsAt`, when asked for a specific group, derives it from a
  still-fresh cached "All" result via `filterAggByGroup(out, group)` (filter agg by model class /
  extras by cls, recompute bySrc + dedupTotal) — **no network**. So All → Birds/Mammals/…/Fungi
  filters instantly.
- `SIGHT_CACHE_VER` 3 → 4 (aggregation changed → old caches ignored).
- **Trade-offs (surfaced):** an "All" fetch is heavier and shares the sources' paging budget across
  more taxa, so in a very dense spot a group can be under-sampled vs a dedicated fetch. Reuse is
  broader→narrower only. Historic range/month subset reuse follows in a separate change.

## 2026-07-31 — Narrower Settings menu (sw v803)

- Compacted the manage/action buttons inside Settings (`.settings-panel .demo-btn` padding
  `7px 16px` → `6px 9px`; `.ico-btn` gap `8px` → `6px`). Their `white-space:nowrap` labels set
  the panel's min width, so trimming the button whitespace lets the menu be narrower.
- Lowered the panel `min-width` 280 → 240 px and horizontal padding 12 → 10 px.

## 2026-07-31 — General "Download — last N days" window (sw v802)

- New Settings field **"Download — last N days"** (`downloadDays`, in Fetching & detections)
  that overrides every source's own day window for a normal fetch. **0 = each source's own
  default** (GBIF/iNat ~90, eBird 30, BirdWeather 7), so the default changes nothing.
- Threaded through `fetchAllSightingsAt`: the effective window is now
  `daysOverride (Fetch-on-open) → downloadDays() → 0/per-source`. GBIF is safely capped at
  `AppSources.GBIF_MAX_DAYS` (~92) when a window is set; eBird stays clamped to 30.
- Fetch-on-open keeps its **own separate** `fetchOnOpenDays`; both number fields are now
  capped at 92 (the GBIF recent limit; use Historic mode for longer). Field max lowered
  from 365 → 92.
- New i18n keys `ctrl.downloadDays(+Hint)` in 15 languages; Help + README updated.

## 2026-07-31 — Settings grouped with horizontal dividers (sw v800)

- Each functional group in Settings now opens with a **full-width horizontal rule**, so the
  groups (View · Fetching & detections · Data sources · Lists & sharing · Storage & offline ·
  Display & language · What's new) read as clearly separated blocks. `.settings-section` now
  uses a `border-top` divider (the `:first-child` rule was dead — the intro `<p>` precedes the
  first section — so the "View" header is targeted via `:first-of-type`).
- **Hotspot min. species** moved from *Fetching & detections* to **View**, next to Map type /
  Place labels, since it governs the eBird hotspots map overlay (id unchanged → no wiring change).

## 2026-07-31 — Actually narrow the "Last days to fetch" input (sw v799)

- The v798 width fix was overridden by `.settings-panel input[type="number"] { width:100% }`
  (equal specificity, defined later). Bumped the selector to
  `.settings-panel .ctrl-subrow input[type="number"]` (specificity 0,3,1) so the ~4-digit
  width (`4.5em`, `flex: 0 0 4.5em`) actually applies — the box no longer stretches.

## 2026-07-31 — Narrow the "Last days to fetch" input (sw v798)

- The Fetch-on-open **"Last days to fetch"** number field is now ~4 digits wide (`4em`,
  `box-sizing: border-box`) instead of stretching, matching the small numeric value.

## 2026-07-31 — Fetch-on-open: ⟳ column header + own "last N days" (sw v797)

- The ⟳ "load on open" control is now **always shown** in the Stored-locations panel, as a
  **column header above the checkbox column** (not a per-row icon). Muted when the master
  toggle is off; the hint then points to the Settings toggle (`loc.loadOnOpenOff`).
- New **"Last days to fetch"** setting (`fetchOnOpenDays`, default 30) shown under the toggle
  **only while it's on**. Threaded through `fetchAllSightingsAt(…, daysOverride)` → the fetch
  context's `c.days`, overriding GBIF's `gbifDays()` and each direct source's own window (eBird
  still clamped to its 30-day API cap). The day window is now part of the cache key
  (`sightCK(…, days)`), so an on-open window is cached separately from a manual fetch — no
  collision; default (no override) keys are unchanged.
- New i18n keys `ctrl.fetchOnOpenDays`, `loc.loadOnOpenOff` (15 languages);
  `ctrl.fetchOnOpenHint` reworded (tense-neutral). Help/README updated.

## 2026-07-31 — "Fetch on open" for stored locations (sw v796)

- New Settings toggle **Fetch on open** (`fetchOnOpen`, under "Reuse downloads"): on a *plain*
  app open (not a shared / `?here` link), auto-fetch + plot the observations for the stored
  locations flagged to load on open. Fires ~1.2 s after boot, non-blocking.
- New per-location flag `openFetch`, edited via a **⟳ "load on open" tick-box column** that
  appears in the Stored-locations panel (🔍-hold) only while the master toggle is on.
- **Reuses the existing persisted, TTL'd sightings cache** (`persistedSightings` / the "Reuse
  downloads (min)" setting) — so within that window the on-open load is served from cache with
  no network; it only refetches when stale. No new cache or TTL was added.
- Implemented by parameterising the existing `fetchSelectedStoredLocations(locsOverride, silent)`
  (sequential, cache-served, plots each result) + a thin `fetchOnOpenLocations()` wrapper; the
  boot hook computes `plainOpen` from the URL params. Debug banner suppressed in silent mode.
- 4 new i18n keys (`ctrl.fetchOnOpen(+Hint)`, `loc.loadOnOpen(+Hint)`) translated into all 15
  languages. Help, README, What's-new updated.

## 2026-07-31 — Month-of-year filter for plotted observations (sw v795)

- New month filter (`detMonths`, GeoState) applied inside `detDatePasses` — the single
  time predicate every plotted detection passes through — so it slices the **map dots, the
  detections list and the legend counts** together. Empty = all months; ANDs with the existing
  recency-day / date-range window.
- **Detections list (☰):** the time-window popover now has a Jan–Dec chip grid
  (`det-month-chip`) under the day presets. Tapping a month toggles it; the filter bar's days
  button turns "on" and shows an `N M` label when a months-only slice is active.
- **Historic mode:** the month toggles above the date range now double as a **live display
  filter** — once observations are plotted, toggling a month re-slices the shown dots/list
  without re-fetching (they still constrain the next fetch). Both controls share the same
  selection (`buildHistMonths` seeds from and writes to `detMonths`).
- `detHasFilter`, `clearAllFilters` (the × clears months too) and `detDaysLabel` updated.
  Reuses the existing `hist.months` label + `histMonthShort` names — no new i18n keys.

## 2026-07-31 — Translate the last English-only UI strings (sw v794)

- 32 keys that had only an English entry (so non-English UIs showed English — e.g. Norwegian
  Settings showing "Per-observation probabilities") are now translated into all 14 non-English
  language blocks: `ctrl.probPerObs(+Hint)`, `ctrl.shareTiny(+Hint)`, `ctrl.updateBanner(+Hint)`,
  the `route.*` set (save/cleared/remove/stop/savePrompt/saved), `alt.*` (loading/value/na),
  `share.noneVisible`, `share.shortening`, `settings.updateReady`, `settings.updateApplying`,
  `obs.filterOnly`, `obs.addToListAct`, `detlist.sumIndiv`, `fetch.clickErr`, `bc.detWeek`, and
  the `srcshort.*` source descriptions.
- Verified via a key-diff script: 0 keys now missing from any of the 14 real language blocks.

## 2026-07-31 — Historic fetch fills the species list progressively (sw v793)

- During a **Historic** fetch the species-list detection counts now update **per month batch**
  instead of only at the end, so the list grows as data arrives (matching the map dots, which
  already plotted month by month).
- `fetchHistoricSightingsAt` gained an `onPartial` callback: after each month's batch (when it
  added records) it re-aggregates everything gathered so far and pushes it through
  `applySightings(..., false)` — the same progressive-fill path the recent (multi-source) fetch
  already uses. `augmentRowsWithSightings` now passes `onPartial` to the historic branch too.
- No new strings; the stale-guard token in `applySightings` drops updates from a superseded search.

## 2026-07-31 — Range/Migration from an observation use its week + mark the detection (sw v792)

- Opening **Species Range / Distribution** from an observation now sets the **week** to the
  observation's week (`setWeekFromDate`), so the map shows the distribution for **when it was seen**.
- Opening **Species Migration** now **marks the detection week** on the timeline — a **blue** frame
  (`.bc-det`, `detWeek` threaded through `renderAnalysis` → `analysisCtx` → `renderTimelineTab`) — while
  the **current week** keeps its existing **black** frame. New `bc.detWeek` string; Help note added.

## 2026-07-31 — Macaulay Library link narrowed to the observation's season (sw v791)

- The species menu's **Macaulay Library** link now appends a **`beginMonth`/`endMonth`** month range
  (the observation's month ±1, clamped so it never wraps the year) so the photos/audio match the time
  of year the bird was seen — e.g. `…?taxonCode=retpip&beginMonth=6&endMonth=7`. No date → the current
  month's window. Documented in Help (about.html) + README.

## 2026-07-31 — Keyboard-active item shows a bold frame (sw v790)

- The keyboard-navigation "active" highlight (`.kb-active`) is now a **bold green frame** (outline)
  around the button, keeping its own fill/label readable, instead of a solid green fill.

## 2026-07-31 — Keyboard navigation on PC (sw v789)

- **Point editor:** a new point focuses the name field (type/Tab straight away); an existing point
  stays unfocused so **[Delete]** removes it immediately. **Enter** in a text field triggers **Save**
  (the green button); **Esc** closes. (Document-level keydown while the editor popup is open, removed
  on `popupclose`.)
- **Popup menus** (map right-click popup + all anchored menus — observer chooser, add-to-list, save-to-
  list, etc.): **↑/↓** move a **green "active" highlight**, **Enter** clicks it, **Esc** closes. New
  reusable `enableMenuKeys`; a **green** `.kb-active` highlight. Moving the **mouse clears the
  highlight**, so hovering/clicking works exactly as before.

## 2026-07-31 — Translate the "+Route" button (sw v788)

- `route.addShort` (the compact route button in the point editor) is now translated in all 15
  languages (short forms, e.g. de "+Route", sv "+Rutt", fr "+Trajet", it "+Percorso", pl/cs "+Trasa").

## 2026-07-31 — Map right-click popup: coords/altitude header on top (sw v787)

- The right-click map popup now leads with a **header**: **coordinates on line 1, altitude on line 2**
  (`.map-choose-head`), above the action buttons. Clicking the header **copies the lat/lon only**
  (altitude is display-only). Altitude still fills in async / shows "Alt: NA" when offline.

## 2026-07-31 — Point editor actions on one tight row; route button "+Route" (sw v786)

- In the point editor (right-click an existing point), the **Save · +Route · Delete** buttons now sit
  on **one no-wrap row**, tightened to fit. The route button is shortened to **"+Route"**
  (`route.addShort`; full "＋ Add to route" kept as its tooltip and in the detections row-menu).

## 2026-07-31 — Reliable startup version + What's-new bold header (sw v785)

- **Startup popup version:** `requestAppVersion` now asks the active service worker over a
  **MessageChannel** (sw.js replies on the port) with a few **retries** if the worker is slow — so the
  running version reliably appears in the startup popup (and the Settings "Reload to update" button
  already shows the incoming version from `sw-register`).
- **What's new:** each entry's **`vNNN · date` is now a bold header above** the descriptive text
  (`.wn-item` stacks; `.wn-head` bold) instead of an inline prefix.

## 2026-07-31 — What's-new list shows the version + refreshed entries (sw v784)

- The Settings **"What's new"** list now shows the **version number alongside the date** (`vNNN · date`)
  when an entry has one — `WHATS_NEW` entries gained an optional `v` field. Also refreshed the top of
  the list (it was stale at 2026-07-28) with the recent major features and their versions.

## 2026-07-31 — Sharing a list/set only carries what's on screen (sw v783)

- The per-list/set 🔗 shares now include **only the points/records inside the current map viewport**,
  not the whole list/set — matching the live-detections "Share" (which already used
  `serializeVisibleDetPlot`). `sharePointList` filters points via `inMapView`; `shareDetSet` filters
  each species' rows to the viewport; both show `share.noneVisible` if nothing is on screen. Pan/zoom
  to frame exactly what you send.

## 2026-07-31 — Observer chooser: "Add to observer list" wording (sw v782)

- The observer-name chooser's add option now reads **"＋ Add to observer list"** (was "Add to a
  list") — `obs.addToListAct`.

## 2026-07-31 — Legend clear/arm × uses the centred geometric × too (sw v781)

- The legend's red **clear/arm ×** (`.det-clear`, which becomes a white × in a red circle when the
  per-area delete mode is armed) now uses the geometric `X_MARK_SVG` + flex centering, matching the
  map delete markers — so the × is dead-centre in both states.

## 2026-07-31 — Red delete-circle map markers: geometric × (dead-centre) (sw v780)

- The white × in the red delete circles (fetched-area `.area-del-icon` and offline-area `.offline-x`)
  is now a **geometric SVG ×** (`X_MARK_SVG`) instead of the `×` glyph, whose baseline made it look
  slightly high even with flex centering. Now perfectly centred.

## 2026-07-30 — Per-observation model probabilities (rarity) with a toggle (sw v779)

Rewrote the plotted-detections probability machinery (`computeDetProbs`). Instead of one inference
over a grid of the whole plotted area at *today's* week, **each observation gets its own model
probability** `P(species, week-of-its-date, its 25 km cell)`:

- **Location** snapped to a `LOC_GRID_DELTA = 25` km grid (lon adjusted by latitude); **week** = the
  model week of the observation's date (or current week if undated). Values are **cached** by
  `idx|week|cell` and computed with one batched raw inference per unique cell — repeats collapse.
- Per species: **MIN** over its observations drives legend + list order (rarest first; non-model
  species sink to the bottom); **MAX** drives the ◉ locally-rare flag (unchanged intent — flagged only
  if even the best-placed sighting is unlikely).
- **Detection list "By rarity"** now shows the rarest **observation** on top: species ordered by their
  min, expanded rows and by-date/observer groups sorted by per-observation probability.
- **Toggle** `probPerObs` (Settings → Fetching & detections, default **on**). **Off** = one lookup at
  the **middle of the fetched rectangle** + the **middle of the date range** (all obs share it).

## 2026-07-30 — Share file extension is now .share (sw v778)

- The share file is now `birdswhere_share-<date>.share` (was `.mcshare`). The import picker still
  **accepts old `.mcshare` files** too (`accept=".share,.mcshare,…"`), and import parses by content
  regardless of extension. Updated the wording in `share.tooBigOfferFile` (all languages) and the
  TinyURL setting hint.

## 2026-07-30 — Rename the shared .mcshare file to birdswhere_share-* (sw v777)

- The too-big-to-paste share file is now named **`birdswhere_share-<date>.mcshare`** instead of
  `migration-share-<date>.mcshare` (display filename only; the `.mcshare` extension and import are
  unchanged).

## 2026-07-30 — A selected point carries into Historic mode (sw v776)

- Selecting a point on the map and then switching to **Historic** no longer clears it — the mode
  switch now captures the selected point and re-places it as the historic point (pin + Fetch enabled),
  so you can Fetch straight away without re-selecting. (`modeEl` change handler carries `marker`'s
  latlng into `placeHistoricPoint`.)

## 2026-07-30 — Centre the × in the red area-delete circle (sw v775)

- The red ×-to-delete markers on fetched-area rectangles now centre the × cleanly (`.area-del-icon`
  uses flex centering + `box-sizing: border-box` instead of `line-height`, which left it slightly off).

## 2026-07-30 — Optional TinyURL shortening for share links (sw v774)

- New Settings → Lists & sharing toggle **"Shorten share links (TinyURL)"** (default **off**). When on,
  `doShare` builds the link in the **hash** form (`#s=`, never sent to the host so no ~8 kB 414 limit),
  shortens it via TinyURL's keyless API (`shortenUrl`), and shares the resulting `tinyurl.com/…` link —
  which has **no fragment**, so it survives share targets that strip `#`. Recipients still import via the
  existing `#s=` path. Applies to links **under ~14 kB** (`TINY_MAX`); larger → the `.mcshare` file. If
  shortening fails/offline it falls back to the plain query link. Off keeps the original behaviour
  (plain `?s=` link + `.mcshare`), nothing sent to a shortener.
- **Privacy:** the setting's hint warns that the shared data payload is sent to TinyURL — a third party —
  and may be exposed to unknown parties. New `ctrl.shareTiny` / `ctrl.shareTinyHint` / `share.shortening`.
- Verified: GitHub Pages/Fastly 414s query strings ≳8 kB; TinyURL preserves the URL fragment on redirect
  (so the hash-form approach works, incl. a 13 kB hash).

## 2026-07-30 — A map click disarms the per-area delete (red ×) mode (sw v773)

- When the legend's red × is armed (each fetched-area outline shows a red × to delete it), a click on
  the **empty map** now disarms it — the red ×'s disappear (`onMapClick` calls `exitAreaDeleteMode` +
  `updateDetLegend` when `detAreaDeleteMode`). Clicking a × still deletes that one area.

## 2026-07-30 — Route: on-map numbered stops (removable) + Save route (sw v772)

- Route stops are now drawn on the map as **numbered pins** (`renderRoutePoints` in a `routeLayer`);
  tapping a pin opens a popup with **🗑 Remove from route** (`removeFromRoute`). Rendered on add /
  remove / clear and restored on load.
- The bottom **route bar** gained a **"Save route"** button — `saveRouteAsList` prompts for a name and
  saves the ordered stops as a point list (shown, and available to re-share/navigate from the Points
  panel). New `route.save` / `route.remove` / `route.stop` / `route.savePrompt` / `route.saved` /
  `route.cleared` strings.

## 2026-07-30 — Point editor: label the route button "Add to route" (sw v771)

- In the Add/Edit-point editor (from the map's right-click "Add point"), the bare **"＋"** route
  button now shows its full label **"＋ Add to route"** (it already had that as a tooltip via
  `route.add`) so its purpose is clear.

## 2026-07-30 — A map click also minimises the Search-place box (sw v770)

- An empty-map click now also closes the floating **"Search place"** box (added `closePlaceSearch` to
  `dismissTransientUI`, and it counts in `isPopupOrMenuOpen` so the dismissing click is consumed) —
  matching how a click already tidies popups/menus/dropdowns and minimises the legend.

## 2026-07-30 — Fix: altitude text overflowed the map-menu button (sw v769)

- The coords+altitude label (`📋 … · Alt: 342 m`) overflowed the fixed-width right-click menu button
  because `.demo-btn` is `white-space: nowrap`. `.map-choose .demo-btn` now wraps
  (`white-space: normal; overflow-wrap: anywhere`), so the label stays inside the button.

## 2026-07-30 — Ground altitude in the right-click map menu (sw v768)

- Right-clicking (long-pressing) the map now shows the **ground altitude** next to the coordinates,
  e.g. `📋 41.20, 2.15 · Alt: 342 m`. Fetched from the keyless **Open-Meteo elevation API**
  (`fetchAltitude`, small in-memory cache, 8 s timeout). **Offline / failed lookup → "Alt: NA"**
  (`navigator.onLine` guard; failures never cached so it retries when back online). Allowed by the
  existing CSP (`connect-src 'self' https:`). New `alt.loading` / `alt.value` / `alt.na` strings.

## 2026-07-30 — GBIF loading line names the datasets in flight (sw v767)

- The observation loading line's GBIF progress now shows **which datasets are being fetched**, e.g.
  `GBIF[2/4](Pl@ntNet|Artsobservasjoner)` — the names in parentheses are the queries still in flight.
  `fetchGbifAll` reports the active dataset names via the `onDataset(done, total, names)` callback
  (each task tagged with `dsName`); `obsRender` appends them after `[done/total]`.

## 2026-07-30 — Pl@ntNet (plants/fungi) + per-group GBIF dataset gating (sw v766)

- Added **per-group gating** for GBIF datasets: a dataset with a `groups` field is only queried when
  the active species group is **"all"** or one of them (`gbifGroupSkip`), and it can carry its own
  `taxa` filter used in "all" mode (`gbifTaxaFor`). The active group is injected into `AppFetch` via
  `gbifGroup`. The taxon filter is now appended per-dataset in `fetchGbifAll` + `gbifCount`.
- Added **Pl@ntNet** `7a3679ef-…` — global plant (+ some fungi) identifications (~2.6M, fresh). It's
  fetched only in the **Plants, Fungi and All** groups (skipped in bird/mammal/etc. modes so it never
  costs a wasted request there); in "All" it uses its own Plantae(6)+Fungi(5) filter so it still
  returns flora. Datasets without `groups`/`taxa` are unaffected.

## 2026-07-30 — Multi-observer records list each observer before the chooser (sw v765)

- Clicking an observer name on a record with **several observers** now first lists **each individual
  observer**; picking one opens that observer's **filter / add-to-list** chooser. A single-observer
  record opens the chooser directly. Refactored into `observerActionMenu` (per-observer filter/add) +
  `observerClickMenu` (single → chooser, multi → people list). Removed the now-unused
  `observerAddToList` and `showObserverPeopleMenu`.

## 2026-07-30 — Observer-click chooser + more GBIF datasets (sw v764)

- **Observer name → chooser.** Clicking an observer name (in the detections list or the 👤 legend
  checklist) now opens a small menu with two actions: **"Show only this observer"** (sets the observer
  filter to that person → map + list + legend update) and **"Add to a list"** (the previous
  add-to-observer-list flow). New `observerClickMenu`; `obs.filterOnly` / `obs.addToListAct` strings.
- **More GBIF bird datasets** (from a global survey of fresh, high-volume citizen-science sources):
  **SABAP2 (ZA)** `906e6978-…` — the #1 fresh bird source in South Africa (~3.5M in 2024–25, ahead of
  eBird there), and **Birdata / BirdLife Australia (AU)** `4bf1cca8-…` — the national bird atlas
  (~1.5M in 2024–25). Both key-free, country-gated. (Considered but deferred: **Pl@ntNet** — a great
  global *plants* source, but it's plant-only + global, so it'd need per-group dataset gating to avoid
  a wasted request in bird/mammal modes.)

## 2026-07-30 — Update banner is opt-in; "Reload to update" button in Settings (sw v763)

- **The "New version available" reload banner no longer appears by default.** When a newer version
  has installed and is waiting, a green **"Reload to update to vNNN" button lights up at the top of
  Settings** — the user reloads at their own will; nothing pops up or force-reloads.
- A **Settings toggle "Auto-show update banner"** (default off) restores the previous behaviour: when
  on, the old banner appears on an available update.
- `sw-register.js` refactored: it no longer auto-shows the banner; it records the waiting worker on
  `window.SWUpdate` ({pending, version, notes, apply(), showBanner(), bannerEnabled, onchange}) and
  notifies the app. `apply()` = skipWaiting → controllerchange reload (unchanged reload path). The SW
  still never skipWaiting on install. **Bumping `VERSION` on every deploy is still required** so the
  update is detected and the button/toggle activates.

## 2026-07-30 — Help: explicit "no data leaves without your action" statement (sw v762)

- Added an up-front line to the Help "Your data stays on your device" section: **no user data ever
  leaves the app without an explicit action from you** (exporting lists/settings, or creating a share
  link); nothing is sent automatically or in the background.

## 2026-07-30 — Collapsed species rows always show total individuals (sw v761)

- In the detections list's per-species view (any sort other than "By date"), the **collapsed species
  row badge now always shows the summed individual count**, not just under "By count". The "By date"
  view is unchanged (per-date/observer record tallies).

## 2026-07-29 — "By count" sorts by summed individuals (sw v760)

- Detections list **"By count"** now orders species by the **sum of individual counts** across their
  records (a record with no count = 1), not the number of records. The per-species badge shows that
  summed total while this sort is active.
- (No change needed for the eBird window: the recent fetch already uses direct eBird for the last 30
  days — eBird's API hard-cap — and GBIF datasets fill back to ~90 days; older = Historic mode's EOD.)

## 2026-07-29 — Translate the detections-list sort options (sw v759)

- The new sort-menu labels (`detlist.sortName`, `sortName2`, `sortCount`, `sortRarity`) were
  English-only in v758 (fallback). Added proper translations across all 15 languages; "By date"
  already used the existing translated `detlist.byTime`.

## 2026-07-29 — Detections-list sort menu + clickable failed-source reason (sw v758)

- **Detections list sort** — replaced the date/species toggle with a sort **dropdown**: *By date*
  (date/observer sections, the old default), *By name*, *By 2nd name* (only when a second language is
  set), *By count*, *By rarity* (model probability, rarest first). The per-species view is sorted by
  the chosen key. New `detName2()` helper + `detlist.sort*` strings; `detListSort` values changed
  (`time`→`date`, `species`→the sort keys).
- **Clickable failed-source reason** — on the species-list "Loaded: …" line, a source shown red
  (timed out, or a hard failure) is now **clickable** and opens the reason (e.g. an HTTP error or
  "timed out"). `showSourceCounts` takes the fetch's `failed` list and renders red sources as
  `.src-fail` chips wired to a `modalAlert`. Answers "why did GBIF go red in Albania?".

## 2026-07-29 — eBird via GBIF for historic; direct eBird stays the recent feed (sw v757)

- Added the **eBird Observation Dataset (EOD)** `4fa7b334-…` as a GBIF dataset flagged
  **`historicOnly`** — it is queried **only** in a Historic date-range fetch, never the recent feed.
  `fetchGbifAll` gained a `historic` argument; it skips `historicOnly` datasets unless
  `fetchGbifHistoric` calls it with `historic=true` (the historic `gbifCount` includes them). So
  Historic mode now gets eBird's deep, key-free global archive, while the **recent** feed keeps using
  the **direct eBird** source (fresher — GBIF's eBird copy lags months). EOD is global but, being
  historic-only, adds no per-fetch overhead to recent lookups and doesn't duplicate direct eBird.
- Note: direct eBird's recent window can't be extended to 90 days — eBird's own API hard-caps
  `back` at **30 days** (`fetch.js` clamps to 30). Recent eBird = ≤30 d (direct); older = EOD.

## 2026-07-29 — Add GBIF bird datasets: naturgucker (DE) + Birds of Ireland (sw v756)

Surveyed the largest openly-published bird occurrence datasets on GBIF per European country
(`taxonKey=212`, human observations, 2018+, faceted by dataset). Findings:

- **eBird Observation Dataset** dominates almost every country but is deliberately **not** added: it
  is global (each dataset = one request on *every* fetch worldwide), duplicates our direct eBird
  source, and GBIF's copy lags eBird's live API.
- **naturgucker (DE)** `6ac3f774-…` and **Birds of Ireland (IE)** `81b551f9-…` added — both are
  actively updated (naturgucker ~15.6M bird records, ~1.4M in 2024–25; Birds of Ireland ~293k). They
  fill Germany (no direct source) and Ireland (no other portal), and are **country-gated** so they
  only cost a request near their own country.
- Skipped **Waarnemingen.be birds** and **Oiseaux des Jardins (FR)**: their GBIF republishes are
  stale (stop ~2018 / ~2022) and those regions are already covered live by Observation.org + eBird.

## 2026-07-29 — Docs: note the model output also ranks lists + drives rarity (sw v755)

- Help (`about.html`, "What the AI model does") and `README.md` now spell out that the model's
  predicted probability is reused beyond the map views: it **orders the species lists** (per-point
  Species List and the plotted-detections legend) and defines **"locally rare"** — a species at or
  below the *Rare species threshold* gets the **◉** icon and filter, regardless of how often it has
  actually been reported.

## 2026-07-29 — Observation details list mirrors the legend species selection (sw v754)

- When a **legend species-selection** is active (isolating some species on the map), the observation
  details list (`renderDetListModal`) now shows **only those species**, matching the dots on screen.
  Rows are still *collected* for all species (`collectVisibleDetections(..., true)`) so the fuzzy
  search can find any species to add — while **searching**, everything stays visible; only when not
  searching are rows filtered to `detSelected`. `detListLastRows` (Save as list / Navigate) follows
  suit.

## 2026-07-29 — Data sources list: one-line descriptions + "Laji" rename (sw v753)

- Each source in the **Data sources** list now shows a short one-line description under its name
  (e.g. GBIF — "An international store of nature datasets"; eBird — "Worldwide bird observation
  platform"; BirdWeather — "AI-based birdsong recognition"). New `srcshort.*` keys (English, with the
  usual English fallback for other languages); shown via `srcRow`/`srcShortDesc`.
- The Finnish source **"Laji.fi (FI)" is now shown simply as "Laji"** — default renamed and existing
  stored copies still on the old default label are migrated on read (custom renames untouched).

## 2026-07-29 — Help: clearer AI-model explanation + data-privacy section (sw v752)

- Rewrote the in-app Help (`about.html`, English) opening as **"What the AI model does"** — it now
  states plainly that the model *predicts* how likely each species is at a place/time of year and
  does **not** report actual sightings (those are a separate live-observation layer overlaid on top).
- Added a **"Your data stays on your device"** section: all points, lists, checklists, stored
  locations, species flags, observer lists and settings live only in the browser (no account, no
  server of ours); data leaves only when the user shares a link/map, exports a file, or uses the
  optional Google Drive backup. Clarified that observation lookups do send the viewed map
  coordinates to third-party databases, but nothing the user has saved.
- Mirrored both points in `README.md` (intro wording + a new "Your data & privacy" section).

## 2026-07-29 — First-run language follows the device (sw v751)

- On first run (no saved language choice), the UI now defaults to the **device's preferred language**
  (`navigator.languages`) when it's one of the 15 supported languages, else English — instead of
  always English. Norwegian Bokmål/Nynorsk (`nb`/`nn`) map to `no`. The language picker still saves
  any explicit choice, which then wins on later visits.

## 2026-07-29 — Map-click popup scrolls instead of overflowing the screen (sw v750)

- The left-click map popup (species list + country / worldwide resources) could grow past the
  viewport when its national-services list is long or the "🌍 Worldwide" submenu is expanded. It now
  gets a Leaflet `maxHeight` (~60% of the window), so Leaflet wraps the content in a **scrollable
  box** once it would overflow. Re-evaluated on `popup.update()`, so expanding the submenu toggles
  the scroll correctly.

## 2026-07-29 — Missing-key error dialog links straight to Manage data sources (sw v749)

- The "Some data sources failed:" dialog, when a source failed for a **missing free API key**, now
  shows a **"Manage data sources…" button** that closes the dialog and opens that settings window
  directly (on its source list). `uiDialog` gained an optional `action` button; the sources-manager
  open logic was extracted into a shared `openSourcesManager()` (reused by the Settings button).

## 2026-07-29 — Settings opens with an app description + About at the top (sw v748)

- The Settings panel now leads with a **short paragraph describing the app** and the **"About & how
  it works" link moved to the very top** (it was previously near the bottom, above "What's new").
  New i18n key `settings.appIntro` across all 15 languages; `.settings-intro` styling added.

## 2026-07-29 — Shared detections link: clear leftover filters so the legend shows them (sw v747)

- Opening a shared **detections** link (or a whole-map share) now clears the recipient's leftover
  legend filters before plotting the imported dots — `plotSharedDetections` calls `clearAllFilters()`
  (species selection, ★/rare/year/life mode, observer filter, recency/date window) instead of only
  resetting the recency window. Previously any of those could hide the imported detections, leaving a
  wrong or empty legend. Point-list shares are unaffected (they don't touch the legend).

## 2026-07-29 — Streets is now the default base map (sw v746)

- New users now start on the **Streets** (OpenStreetMap) base map instead of Light. The default
  fallback for the saved `basemap` setting changed from `"light"` to `"streets"` everywhere it's
  read. Existing users keep whatever they've already selected; anyone can still switch under
  **Map type**.

## 2026-07-29 — Detection list "Navigate" heads to the observations' average position (sw v745)

- The detection list's **"Navigate in Google Maps"** button (`detlist-nav`) now navigates to the
  **average (centroid) position of the observations currently listed** — a single Google Maps
  destination — instead of routing through each dot / the clicked spot the list was fetched from.
  The average is taken over `detListLastRows`, so it honours the list's active filtering (date /
  observer / ★rare/year/life mode / search).

## 2026-07-29 — "Some data sources failed" nudges you to register a free API key (sw v744)

- When the failure dialog ("Some data sources failed:") includes a source that failed **only because
  its free API key isn't set**, it now appends a hint: *"…register one in 'Manage data sources…' for
  more up-to-date data."* Uses the existing `splitFailed().needKey` detection; new i18n key
  `fetch.errKeyHint` across all 15 languages (each pointing at the localized "Manage data sources…"
  label). No hint is shown for purely non-key failures.

## 2026-07-29 — Historic fetch: live observation count in the status line (sw v743)

- While fetching historic records from GBIF, the status line now shows a **live-updating count of
  observations fetched** ("Fetching GBIF — {done}/{total} months · {n} observations"), and the
  progress bar is unchanged. The per-month `hist.progress` string (which already carried the count)
  was being overwritten by the `onProg` callback's count-less "page X of Y" text; `onProg` now drives
  **only the progress bar**, leaving the count-bearing line as the sole status text. (`hist.stagePages`
  is now unused.)

## 2026-07-29 — Colour-save dialog: swatch beside the buttons (sw v742)

- In the "Colour for N points to save?" dialog the swatch sat directly **above** Cancel / Save
  points, so the browser's native colour popup (which opens right below the swatch) covered the
  buttons and you couldn't click them. Moved the swatch to the **left of the action row** (same
  line as the buttons) so the popup drops into empty space below, leaving the buttons clickable.

## 2026-07-29 — Restore the observer filter's "None" state (sw v741)

- v740 over-corrected: making an empty selection mean "all" removed the useful **None** state
  (clear all observers, then tick just a few). Restored — an empty `detObsFilter` Set is once again
  "None" (show nothing), and the scope cycle is back to **All → None → each saved list → All**.
- The genuine v740 fix is kept but narrowed: `reconcileObsFilter` now heals only a **non-empty**
  remembered filter whose observers aren't among the currently-plotted data (→ reverts to All). The
  intentional empty "None" is left alone, so building a few-observer selection works as before.

## 2026-07-29 — Fix: observer filter with no name chosen no longer blanks the map (sw v740)

- The 👤 observer filter could get stuck in a state that hid every detection: an **empty selection**
  (unchecking all observers, or the scope cycle's "None") filtered out *everything* instead of
  showing all, and a **remembered filter** whose observer(s) aren't in the freshly-plotted data left
  the legend empty with no checkbox ticked ("no user name chosen"). Both are fixed:
  - `setDetObsFilter` now treats an empty Set as "no filter" (show all). A Set holding only `""` is
    still the real "(no observer)" bucket.
  - `reconcileObsFilter` (run on every `rebuildDetLayers`) drops a stale filter when none of its
    names — nor the no-observer bucket — appear among the currently-plotted observers. Guarded to do
    nothing when nothing is plotted, so **clearing the map still keeps filters**.
  - The observer scope cycle drops its redundant "None" step (All → each saved list → All).

## 2026-07-29 — Tighter colour dialog: count + "Save points" button (sw v739)

- The "Colour for these points?" dialog is now **tighter** (narrower box, less padding), shows the
  **number of points to be saved** ("Colour for {n} points to save?"), and its confirm button reads
  **"Save points"** instead of "OK". `uiDialog` gained an `okLabel` override and a `ui-modal-tight`
  layout class; `points.pickColor` now takes an `{n}` count across all 15 languages.

## 2026-07-29 — Pick a colour when saving fetched points to a list (sw v738)

- Saving fetched observations to a point-list (the Points panel "Save points" button and the
  observation-list save) now pops an **OK dialog with a colour picker** before filing them, and
  applies that one colour to the whole saved batch — so e.g. each year's saved observations can be
  told apart on the map. Defaults to the last colour used (`mpLastColor`); Cancel aborts the save.
- New generic `modalColorPick`/`uiDialog({color})` OK-Cancel colour dialog; `saveDetRowsToCollection`
  takes an optional `color` applied to each new point. Single-point creation keeps its existing
  inline swatch (unchanged). New i18n key `points.pickColor` across all 15 languages.

## 2026-07-29 — New points default to the last colour picked (sw v737)

- When adding a point, the colour swatch now defaults to the **last colour you chose** (persisted
  as `mpLastColor` in GeoState) instead of the tag-based automatic colour. A run of points shares a
  colour until you change it — e.g. give each year's points a distinct colour within one list. The
  ↺ button still resets a point to its automatic colour, and editing an existing point keeps its own
  colour. `mpColorRow` defaults new (no-id) points to `mpLastColor`; the editor save handler updates
  `mpLastColor` whenever an explicit colour is chosen.

## 2026-07-29 — Share only the detection dots on screen (viewport) (sw v736)

- Sharing detections now includes only the dots inside the current map **viewport** (in addition
  to the active filters/selection) — `serializeVisibleDetPlot` filters by `map.getBounds()`. Pan/
  zoom to frame exactly what the link carries.

## 2026-07-29 — Point sets share only via the per-list 🔗 icon (sw v735)

- Removed the Points panel's top "Share points" button. **User point sets are now shared only
  from the 🔗 share icon next to a saved list's name** (`sharePointList`), which now freezes each
  point's on-screen colour (explicit, else the list colour) so the shared set looks the same and
  imports as coloured triangles.
- Renamed the detections "Share link" button to just **"Share"**, with a hover that explains it
  shares the observations shown on the map.

## 2026-07-29 — Shared points keep their colour; drop the extra Share-link button (sw v734)

- A shared point now carries its **on-screen colour** (explicit colour, else its list/tag colour),
  so it looks the same for the recipient — shown as a triangle in that colour. `packPoints` now
  includes `color`.
- Removed the redundant "🔗 Share link" button from the unsaved-points banner — the panel's
  **Share** button (in-view points) covers it.

## 2026-07-29 — Share points: only those in the current map view (sw v733)

- The Points panel's Share button now shares only the points that fall inside the map's current
  viewport (bounds), so you pan/zoom to pick exactly what goes in the link.

## 2026-07-29 — Points sharing: visible-only default, additive import, triangle pins (sw v732)

- The Points panel's **Share** button now shares only the **points visible on the map** (loose pins
  + shown lists), as a points-only link — not the plotted observations. (Detections have their own
  "Share detections" button.) Removed the combined whole-map share button.
- **Imported shared points are added** to whatever's already on the map (a new shown collection),
  and are drawn as **triangles** so they stand out from your own circular pins.

## 2026-07-29 — Share: pastable link back + only visible; rare-first by-time list (sw v731)

- **Share link** hands back the copyable string again by default. Only when the link would be
  too long for a host to open (GitHub Pages 414s past ~8 KB) does it say so and offer to save
  the `.mcshare` file instead — instead of always downloading a file.
- **Sharing now includes only the observations currently visible on the map** (passing the active
  recency/date, species ★/◉/🟠/🟡 and observer filters + selection), via a new
  `serializeVisibleDetPlot()`. Persistence/sync still keep everything.
- **Detections list, by time**: within each date/observer group, species are now ordered rarest
  first (lowest habitat probability) → common at the bottom, matching the legend.

## 2026-07-29 — Detections list “By species”: sort by most-recent date (sw v730)

- In the detections list's **By species** view, species are now ordered by their most-recent
  observed date, newest first (name breaks ties), instead of alphabetically.

## 2026-07-28 — Update banner shows a short changelog (sw v729)

- The "New version available" banner now shows a few lines of what changed, read from a
  `NOTES` string in `sw.js` (reported alongside VERSION over the MessageChannel). Bumping
  VERSION and refreshing NOTES per deploy keeps it current; the banner falls back to just the
  version if NOTES is empty.

## 2026-07-28 — Download points as GeoJSON; clearer backup filename (sw v728)

- Map points / saved lists can now be exported (and imported) as **GeoJSON** — a lossless,
  JSON-native file that keeps each point's name, tags, note, colour and species key (KML/KMZ
  flatten those). The Map-points format toggle now cycles KML → KMZ → GeoJSON, and import
  auto-detects GeoJSON vs KML/KMZ. (Everything else — all lists, points and settings — is
  already downloadable as one JSON file via Settings → Share between devices → Export.)
- That full-backup file is now named `BirdsWhere_backup_<date>.json` (the internal format id
  is unchanged, so old backups still import).

## 2026-07-28 — Rewrote the English Help/About to match the current app (sw v727)

- Audited the whole app and corrected the English "About" text: added the **Historic** mode and
  renamed the mode to **📍 Recent**; documented the **right-click / long-press map menu** (Add point,
  Save location, Share link, Copy coordinates, Navigate here) and the **National databases** point-popup
  + Settings feature (edit / block / delete); moved the recency/species/observer **filters into the
  Detections list** (with date range, ★/◉/🟠/🟡, Select-on-map, 🔒 no-access source); fixed the legend
  controls, the species menu, plotted-detections hover (spider is pins-only), Add-point/Save-location/
  Navigate locations, Data-sources keys, Species-group, on-map ± detail buttons, and the More/Key
  settings lists. Other languages still to follow.

## 2026-07-28 — Renamed the app to "BirdsWhere" (sw v726)

- The app is now **BirdsWhere**: the browser tab title, the PWA manifest (name/short_name), the
  startup popup title and the in-app name (all 15 languages) all say BirdsWhere. The GitHub Pages
  URL is moving to `https://pcmoan70.github.io/BirdsWhere/` (repo renamed). Internal identifiers
  (IndexedDB store, backup/sync file format) keep the old key so existing saved data and Drive
  backups still load.

## 2026-07-28 — Tall dialogs: scroll the body, keep the title bar + × pinned (sw v725)

- Dialogs taller than the screen (the Help/About text, National databases, GBIF datasets,
  Data sources, saved-lists, blogs, blocked-species) now keep their title bar — and the ×
  close — pinned at the top while the content scrolls, so you can always close them. The
  detections list already worked this way. createModal dialogs (link editor, prompts) also
  cap at 90vh and scroll.

## 2026-07-28 — Shared detections build up exactly like a self-fetch (sw v724)

- Importing a shared map now reconstructs the same `result` a live fetch produces (model species
  in `agg`, others in `extras`, with counts + latest date) and runs it through the **same**
  `plotSightingsResult` pipeline — so the legend and the co-located list build up identically,
  with every species and every date at a location. The recency window is opened to "All" on
  import so historic shared dots aren't hidden by the 30-day default. Still no source fetch.
- Reverted the v723 detection-dot fan-out (map-pin fan-out is unchanged).

## 2026-07-28 — Fan out several species on one spot (detection dots) (sw v723)

- Tapping a detection dot that sits on the exact same spot as other species now **fans them
  out** in a rainbow (each in its species colour, with a name tooltip), like the map-point pins
  already do — so a location with several species (common on shared maps and eBird hotspots) is
  visible, not one dot hiding the rest. A lone species still opens its co-located list; a fanned
  dot opens the spot's detection list. (The data was always there — in the legend, the hover
  card and the list — this makes it visible on the map too.)

## 2026-07-28 — Shared maps: detections join the legend; flag no-access sources (sw v722)

- Imported shared detections now go through the main detection pipeline (`detPlot`) instead of a
  separate flat overlay: they appear in the bottom-left **legend**, and several species at one
  spot **stack / fan-out** (previously one species per location, and missing from the legend).
- No source is fetched when a shared map is opened — the dots come straight from the link.
- In the detections list, a record from a source the recipient **can't access** (a keyed source
  like eBird with no key set here) is shown with a 🔒 and the source **struck through**.

## 2026-07-28 — Background click tidies up (legend + Points panel minimise; popup toggles) (sw v721)

- An empty-map click now closes the Points (point-set) panel and minimises the bottom-left
  legend to its corner chip, alongside popups/dropdowns/menus. If a popup or menu was showing,
  the click only dismisses it (it won't also drop a new point popup); with nothing open, the
  click opens the point popup as before. `closeDropdowns` now also closes the Points panel.

## 2026-07-28 — Navigate moved to the right-click map menu (sw v720)

- The 🧭 **Navigate here** action moved out of the Add-point editor into the right-click
  (long-press) map menu, alongside Add point / Save location / Share link / Copy coordinates.
  The point editor now just has Save, ＋ (add to route) and Delete.

## 2026-07-28 — Location actions moved to the right-click / long-press menu (sw v719)

- The left-click point popup's "Location ▸" submenu (Save location, Share link, Copy
  coordinates) is gone; those actions — plus **Add point** — now open from the right-click
  (long-press on touch) map menu. The left-click popup stays focused on Species list,
  Birdingplaces and the country/continental resources. New i18n key `points.add` (15 langs).

## 2026-07-28 — Nicer birding-blogs list layout (sw v718)

- The birding-blogs list now shows one tidy card per blog (bold name + faint host + delete),
  with row hover, and the Fatbirder directory as a divided footer link (📖) instead of a plain
  row. Replaces the generic offline-row styling.

## 2026-07-28 — Drop the globe button; fold Blogs + BirdLife into the point popup (sw v717)

- Removed the on-map globe "Country" button. Its two unique items — **Blogs** and the
  **BirdLife country factsheet** — now sit in the point popup for the clicked location, below
  the national databases and above the "… & Worldwide" continental submenu. The popup resolves
  the country name (reverse-geocode) so Blogs/BirdLife are country-correct. Removed the now-unused
  openCountryMenu/showCountryMenu.

## 2026-07-28 — Click the map to dismiss open floating windows (sw v716)

- A click on empty map now closes every open floating window — Leaflet popups, header
  dropdowns, anchored row menus, the stored-locations preview and the three legend filter
  subwindows — in every mode (including Richness). Taps on a plotted detection still belong to
  its own popup, and full-screen modals keep closing on a backdrop click as before.

## 2026-07-28 — National databases: edit links in a popup (shared by Add) (sw v715)

- Each row in Settings → National databases now has an **✎ edit** icon. It opens a popup with
  all fields — country/category code, display name and URL — and Save writes the change.
  The same popup is used by **+ Add** for a new link. Editing a built-in's name overrides just
  its label; changing its code/URL replaces the entry (the original is tombstoned so it stays
  gone). Category codes (WLD/EU/AME/OCE) are accepted, so worldwide/continental links are
  editable too.

## 2026-07-28 — National databases: per-continent "… & Worldwide" category (sw v714)

- The single "Europe & Worldwide" submenu that showed everywhere is split into a worldwide
  set (eBird, Observation.org, iNaturalist, GBIF, Avibase, BirdLife DataZone, xeno-canto)
  shown for every country, plus continent-specific groups: Europe (EuroBirdPortal, EBBA2,
  BirdLife Europe & Central Asia, Birdingplaces.eu, Trektellen) and the Americas (American
  Ornithological Society, Partners in Flight, Neotropical Birds). The point popup / Country
  menu now show the submenu for the clicked country's continent — "🌍 Europe & Worldwide",
  "Americas & Worldwide" or "Oceania & Worldwide" — so Europe-only sites no longer appear in
  the Americas or Oceania. In Settings the categories are listed after the countries.

## 2026-07-28 — Update banner shows the incoming version number (sw v713)

- The "New version available" banner now reads the waiting service worker's VERSION over a
  MessageChannel and shows it — e.g. "New version v713 available" — so the popup text
  corresponds to the version being installed. Bumping `VERSION` in `sw.js` (already required
  on every deploy) updates this text automatically; it falls back to the generic wording if
  the version can't be read.

## 2026-07-28 — National databases: use each site's nationalized version (sw v712)

- Where a multinational site runs a per-country version, each country is now assigned that
  localized URL: Observation.org entries point at the country instance (`<cc>.observation.org`
  instead of `observation.org/countries/<cc>/`), and Spain/Portugal use the branded eBird
  portals (eBird España `ebird.org/spain`, eBird Portugal `ebird.org/portugal`). Countries
  without a branded eBird portal keep their `ebird.org/region/<CC>` page, which is already
  the country-specific view.

## 2026-07-28 — National databases: add North America, Central America & Oceania (sw v711)

- Extended the National-databases store beyond Europe: curated links for Canada, the US,
  Mexico, Greenland, Bermuda; Belize, Costa Rica, El Salvador, Guatemala, Honduras,
  Nicaragua, Panama; and Australia, New Zealand, Papua New Guinea, Fiji, Solomon Islands,
  Vanuatu, New Caledonia, French Polynesia, Samoa, Tonga, Guam, Palau, Micronesia, Kiribati
  and the Marshall Islands. Each country lists its eBird region page plus notable national
  bodies (Birds Canada, Audubon, BirdLife Australia, Birds New Zealand, …). 220 links total.

## 2026-07-28 — National databases: one managed store for all country links + block (sw v710)

- The map popups' national/regional bird-site links are now all sourced from the
  **National databases** store (Settings → National databases). Shipped with a curated
  set per European country (from the important-bird-websites list) plus a new **"EU"
  Europe & Worldwide** category (EuroBirdPortal, eBird, Observation.org, Birdingplaces,
  Trektellen, Avibase, EBBA2, BirdLife DataZone/Europe, xeno-canto).
- The point popup and the Country menu render the clicked country's links from the store,
  with the Europe & Worldwide sites under a "🌍 Europe & Worldwide" submenu. The previously
  hardcoded Observation.org / Oiseaux.net / Fågelkartan buttons are folded into the store.
- Each entry in Settings now has **two icons**: **×** deletes it (built-ins included, via a
  tombstone so it stays gone), and **👁/🚫** blocks it — keeping it in the list but hiding it
  from the popups. "+ Add" adds your own (country code + URL + name); "Reset" restores defaults.
- Removed the now-unused per-country Observation.org deep-link and the Fågelkartan county
  slug logic. Note: the universal `<cc>.observation.org` button is gone; Observation.org now
  shows only where the curated list includes it, plus the international site under Europe & Worldwide.

## 2026-07-28 — Point popup: Oiseaux.net link for French territories (sw v709)

- Clicking a point in France or a French overseas territory/department (FR + DOM-TOM:
  GF, GP, MQ, RE, YT, NC, PF, BL, MF, PM, WF, TF) now adds an **Oiseaux.net ↗** link
  to the point popup (the French-language bird encyclopedia). Opens the English section
  (oiseaux.net/en) when the app language is English, otherwise the French site.

## 2026-07-28 — Fix: switching Recent → Historic no longer fires a recent fetch (sw v708)

- Opening a Species list in "Recent" mode suspends at the model-inference await. If the
  user switched the mode dropdown to "Historic" during that await, the inference would
  resolve and the render would resume and fire a recent-observations fetch *after* the
  switch. A render now captures a generation counter (bumped on every render and on any
  mode change) and bails right after its inference await when superseded — so leaving
  Recent mid-render can no longer fire a fetch. In Historic mode nothing fetches until
  the explicit "Fetch" button.

## 2026-07-28 — Legend order from one area-grid inference (fixes big-fetch OOM cleanly) (sw v707)

- The legend's habitat-probability ranking is now computed from a SINGLE inference
  over a 10×10 grid covering the plotted detections' area (100 cells, current week),
  instead of one inference per species over its points. A fixed-size call can't OOM
  the worker no matter how many dots are fetched. Legend order uses each species' MIN
  over the grid (least-likely-anywhere species float to the top); the ◉ rare cue uses
  its MAX (best habitat in the area).

## 2026-07-28 — Fix: large fetches (25 k+ dots) crashed the map/legend (sw v706)

- Fetching a very large number of detections could make the legend vanish and only a
  single dot render. Cause: the habitat-probability pass (used for legend ordering and
  the ◉ rare cue) ran one inference PER species with EVERY point, all at once — the
  worker materialises a batch×12 012 tensor, so a species with thousands of points
  built hundreds of MB and, fired for many species simultaneously, ran the worker (and
  the tab) out of memory. It now samples ≤100 points per species and runs the passes a
  few at a time, keeping memory bounded.

## 2026-07-28 — Legend ☰ button turns green when a filter is active (sw v705)

- Since the filters now live in the detections-list popup, the legend's ☰ (open list)
  button now shows <b>green</b> whenever any filter is active — a cue that filtering is
  on and where to change it.

## 2026-07-28 — Tighter species search (less over-matching) (sw v704)

- The detections-list species search's forgiving "skip-typing" tier was too loose — a
  plain subsequence let scattered letters (a…b…c across the whole name) match. It now
  only tolerates a near-miss: the typed letters must start at the species name's
  matching point and fit within ~2 skipped characters, and the query must be ≥ 4
  letters (shorter ones already match as substrings). "brnswl" still finds "Barn
  Swallow"; loose scatter no longer matches.

## 2026-07-28 — Detections list stays fully searchable after selecting (sw v703)

- The detections list now shows every plotted species even when a map selection is
  active — so after you Select a species, you can keep searching for and selecting
  more, one at a time (the selection isolates the map; the list still lists all). This
  makes the search-and-select stacking actually work.

## 2026-07-28 — Detections list: "Select N on map" to build a species selection (sw v702)

- Typing in the detections-list search now shows a <b>＋ Select N on map</b> button
  that adds every matching species to the legend's map selection (isolating them on
  the map). The search box then clears so the next search's matches <b>stack</b> onto
  the selection — search "swallow" → Select, search "warbler" → Select, and both sets
  show together. Clear the selection with the legend's black ×.

## 2026-07-28 — Time filter: months presets now 1–6 too (sw v701)

- The detections time-window filter's <b>months</b> row now offers 1–6 (30/60/90/
  120/150/180 days), matching the days and weeks rows. Button label reads 4m/5m/6m.

## 2026-07-28 — Detection filters moved to the list popup; filters persist (sw v700)

- The time-window/date-range, species-mode (★ starred · ◉ rare · 🟡 year · 🔴 life)
  and 👤 observer filters have moved from the bottom-left legend into the detections-
  list popup (☰) — a toggle-button bar reusing the same subwindows. The legend keeps
  the species list, the black × (clear all filters, shown when any is active) and the
  red × (clear the map).
- Filters now <b>persist</b> until you turn them off — via the black × (legend or
  popup) or by toggling them off in the list. Clearing the map with the red × no
  longer resets them, so the next fetch re-applies your filters.

## 2026-07-28 — Historic: date-range picker collapses after a fetch (sw v699)

- After a historic fetch the From–To date picker tucks itself away into a compact
  "📅 from – to" bar (tap it to change the range again), freeing space for the map.
  Re-expands when you re-enter Historic mode.

## 2026-07-28 — Cross-source de-dup keys on species + observer + date + place + count (sw v698)

- The de-duplication that drops a GBIF record when the same sighting arrives natively
  (e.g. GBIF's copy of an Artportalen record) now keys on <b>species + observer +
  date + approximate location + count</b> — the observer-based key had been missing
  the <b>date</b>, so two different-day sightings by the same observer at one spot
  with the same count could wrongly merge. All fields must match to merge, so it errs
  toward keeping both copies rather than hiding a real record ("better too many than
  too few"). Cached fetches recompute (cache version bumped).

## 2026-07-28 — Historic: direct-API top-up for the newest months (SE/NO/FI) (sw v697)

- GBIF's copy of the Nordic/Finnish databases lags by weeks, so for the newest ~2
  months of a historic range the fetch now tops up directly from the source's own API
  when the point is in that country: <b>Norway → Artsobservasjoner</b>, <b>Sweden →
  Artportalen</b>, <b>Finland → Laji.fi</b> (only when the source is enabled and its
  key, if any, is set). Those records are plotted with the month too and merged into
  the result; overlaps with GBIF's copy are de-duplicated. Skipped when a month-of-
  year filter is active (the direct APIs don't take it).

## 2026-07-28 — Historic: plot each month on the map as it arrives (sw v696)

- The map now fills in month by month during a historic fetch (newest month first) —
  each batch's dots are plotted as it lands, behind the species list, so you can
  switch to the map and watch it build up rather than waiting for the whole range.

## 2026-07-28 — Historic fetch: parallel month batches, newest-first (sw v695)

- Fetching historic observations was a slow sequential crawl. The date range is now
  split into <b>~1-month batches fetched newest-first, 3 in parallel</b>, so a
  multi-year query completes much faster and the most recent months arrive first. A
  <b>global cap of 8 in-flight GBIF requests</b> keeps the extra parallelism from
  tripping GBIF's rate limiter. The progress bar now advances <b>per month</b> and the
  status shows a <b>running observation count</b>. (Artportalen/Artsobservasjoner data
  already arrives through their GBIF datasets.) Progressive per-month map plotting and
  a direct-API top-up for the newest ~2 months are the next step.

## 2026-07-28 — Detections-list search also filters the map dots (debounced) (sw v694)

- Typing in the detections list's (☰) species search now filters the plotted dots on
  the map too: the list narrows instantly, and ~1.5 s after the last keystroke the
  map and legend narrow to the matching species. Applied only to the map draw +
  legend (not the shared list predicate), so the list stays instant. Clearing the box
  or closing the list restores every dot.

## 2026-07-28 — Fix: remaining regular gaps in the Richness/Range hex overlay (sw v693)

- The heatmap enumerates the H3 cells in view by sampling screen points on a fixed
  step; because H3 cells are distorted (and Mercator scale varies with latitude), a
  fixed step could skip cells in a regular pattern — those cells were never computed
  or drawn. Now every sampled cell's 1-ring neighbours are added, which fills the
  isolated gaps (a skipped cell is always surrounded by found ones). Applies to both
  Species Richness and Species Range.

## 2026-07-27 — Fix: regular "holes" in the Species Richness heatmap (sw v692)

- Over a large area the richness heatmap showed a regular pattern of missing
  hexagons. Cause: richness values were computed on a rectangular lat/lon grid and
  then re-sampled onto the hexagon tiling, and the two grids beat against each other.
  Richness now evaluates the model at each hexagon's <b>centroid</b> and caches it
  per cell — the same per-H3-cell path the Species Range overlay already uses — so
  every visible hexagon has its own value and the tiling is gap-free. Colouring
  (normalise by peak count, then gamma) is unchanged.

## 2026-07-27 — Observation.org link now opens the country's own portal (sw v691)

- The map-point popup's <b>Observation.org ↗</b> link now opens observation.org's
  own site — the country portal at <code>&lt;iso2&gt;.observation.org</code> (e.g.
  <code>no.observation.org</code>), showing that country's recent observations —
  instead of the GBIF-hosted view. Falls back to the international site for a point
  with no country (open sea). Verified the country-subdomain pattern resolves across
  20 countries. Area-level scoping isn't offered: observation.org's per-area browse
  needs region IDs from its API, which is closed to the public (the site also blocks
  automated access), so country is as precise as its own site reliably allows.

## 2026-07-27 — All 15 languages complete (sw v690)

- Filled the 43 UI strings that had been added to English/Swedish over time but never
  propagated to the other 13 languages (they had been falling back to English). Every
  offered language now carries the full 739-key set. Covered keys include the offline-
  map manager, place-name labels, the crosshair/read-cursor tooltips, the species-list
  status/filter cues (★ / rare / year / life / hidden), photo attachments and the
  stored-locations fetch messages. Placeholders and emoji preserved; verified each
  language has exactly the English key set.

## 2026-07-27 — Legend filters to the map view (new setting, default on) (sw v689)

- New Settings toggle <b>"Filter the legend to the map view"</b> (on by default): the
  bottom-left legend lists only species that have an observation inside the current
  map view, and re-lists as you pan/zoom. Off = list every plotted species regardless
  of the viewport (the previous behaviour). Implemented by having detVisibleCount()
  honour the map bounds when the setting is on, and re-rendering the legend on
  moveend/zoomend.

## 2026-07-27 — Observation.org observations from the point popup (sw v688)

- The map-point popup gains an <b>Observation.org ↗</b> link. Observation.org has no
  public download API, but it publishes its full dataset (132 M records) to GBIF, so
  the link opens GBIF's occurrence explorer filtered to observation.org's records for
  the clicked spot — a bounding box the size of the Sightings radius (point-precise,
  no country lookup needed) — and narrowed to the active species group when one is
  chosen. Verified against the GBIF API (dataset 8a863029-…, geometry + taxon filters).

## 2026-07-27 — "New version — Reload" banner now appears on long-open desktop tabs (sw v687)

- The update banner only appeared after a page load ran an update check, so a
  desktop browser left open for a long time (typical on a Windows PC) never noticed
  new deploys — while a phone did, because it's reopened often. The app now actively
  checks for updates on tab focus / becoming visible and every 15 minutes, re-shows
  the banner for an already-waiting version, and registers the worker with
  updateViaCache:"none" so the check always fetches sw.js fresh.
- Note: this only starts working once the PC has loaded this version — do one hard
  reload (Ctrl+F5) to pick it up; after that the banner surfaces future updates on
  its own.

## 2026-07-27 — Share a bare location as a plain URL (sw v686)

- The map popup’s 🔗 Share link (under 📍 Location) now produces a **plain,
  readable** URL for a point — `…/migration_calendar/?lat=59.33017&lon=18.06978
  &zoom=12` — instead of the opaque compressed `?s=` blob. It is about a third
  the length (~66 chars), survives being retyped or hand-edited, and a recipient
  can see where they are being sent before opening it.
- Opening such a link centres the map on the shared spot at the shared zoom and
  drops the point pin, then leaves the readable URL in the address bar (it is
  idempotent and bookmarkable, unlike the one-shot `?s=` import which is
  consumed on load).
- A point never carried anything but its coordinates, so nothing is lost by the
  switch. Existing `?s=` links keep working — the decoder stays for detection
  sets, point lists and whole-map shares, which genuinely need it.
- A malformed `?lat/?lon` is ignored rather than breaking boot.

## 2026-07-26 — Star / year / life toggles no longer re-fetch the whole list (sw v685)

- In the recent (and historic) species list, tagging ★ or adding/removing a species
  from the year/life list now just repaints that row's status icons in place —
  instead of re-running the model and re-doing the observation fetch for the whole
  list. Instant, and it keeps your scroll position. If a status filter is active, a
  row that no longer matches is hidden immediately (no rebuild).

## 2026-07-22 — Fix: the 🟠 column stayed near-empty in the species list (sw v684)

- The two list columns were treated as mutually exclusive: a species missing
  from the life list showed 🟡 only, and its 🟠 was suppressed. That rule comes
  from the **map**, where a marker can carry just one ring so the stronger cue
  has to win — but a table has a column each, and the constraint does not apply.
  Since most rows in a 200-species list ARE lifers, 🟠 was left marking only the
  handful of species on the life list but not this year’s: 38 of 209 in a
  realistic setup, and none at all if you have no life list older than this year.
- The columns are now independent, as the columns’ own filters always were. A
  lifer is missing from this year’s list too, so it carries **both** 🟡 and 🟠.
  Same data as above: **38 → 197** bronze markers.
- This also removes a real inconsistency: the 🟠 filter header already kept every
  species off the year list (lifers included), while the 🟠 column left those
  rows blank — so the filter and the column disagreed about the same question.
  Each column now marks exactly the set its own header filters to, asserted in
  the suite for ★, 🟠 and 🟡.
- The map is unchanged: one ring per marker, strongest cue wins.

## 2026-07-22 — Drop the bird icon from the Fågelkartan link (sw v683)

- The map popup’s Fågelkartan entry now reads plainly as “Fågelkartan ↗”,
  matching Birdingplaces directly above it (neither carries a glyph).

## 2026-07-22 — Fix: the 🟠 year-list cue never appeared (sw v682)

- The year tier was gated on **this year’s list being non-empty**, so in the most
  ordinary situation — you keep a life list but haven’t ticked anything yet this
  year (early January, or you simply don’t maintain a year list) — no 🟠 appeared
  anywhere: not in the species list, not on the map edges, not in the legend.
  Yet every species on your life list is precisely a year tick then.
- The cue is now gated on tracking **any** list. Measured at Stockholm with a
  17-species life list and an empty year list: **0 → 17** bronze markers, life
  markers unchanged at 192. With no lists at all, still nothing is flagged.
- All four consumers — map dot edges, star halo weight, legend/Detections swatch
  classes and the species-list columns — now share a single `detNeedTier()`
  predicate, so colour, ring weight and glyph can no longer drift apart (they
  had four separate copies of the condition).
- Not a bug: with only a year list and no life list you still see no 🟠. Ticking
  a species for the year also adds it to the life list (`reconcileLifeFromYears`),
  so everything else is a genuine lifer.

### Map popup
- **Fågelkartan moved out of the 📍 Location submenu** to the popup’s top level,
  directly below Birdingplaces.

## 2026-07-22 — One year/life colour convention, everywhere (sw v681)

- **🟡 YELLOW = life-list miss (a lifer), 🟠 BRONZE = year-list miss.** Until now
  the app disagreed with itself: the species list used 🟡 for the year list and
  🟠 for the life list, the map legend used 🟡 and 🔴, and the map dot edges used
  the *same* yellow for both, distinguishing them only by rim thickness.
- The convention is now defined once (`NEED_LIFE_COLOR` / `NEED_YEAR_COLOR`,
  `detNeedColor`) and applied to the species-list status columns, the map dot
  edges, the star halos, the legend and Detections-list swatches, and the
  species menu. Verified on a real plot: 315 markers stroked yellow at weight 4
  (lifers) and 119 bronze at weight 2 (year ticks).
- Rim thickness is kept as a secondary cue, but colour now carries the meaning.

### Species menu
- The list actions became **toggles that show their state**: ★ / 🟠 / 🟡 in full
  colour when the species is in that set, greyed out when not — the same read as
  the list columns.
- “★ Mark interesting” / “★ Remove interesting tag” collapse to one **“Interesting”**
  row whose star colours and greys as you click it. Same for the year and life
  lists (six Add/Remove strings become three).
- **“Hidden” now toggles both ways.** Previously it could only hide, so a blocked
  species surfaced via the list’s 🚫 filter could not be unblocked from there.
  Its icon previews the *action*: red when the click will hide the species,
  green when it will bring it back (an inline SVG rather than an emoji, so it
  can actually take those colours).

## 2026-07-22 — Status column split into five filter columns (sw v680)

- The single ⚑ status column becomes **five narrow columns**, one per cue:
  **★** starred · **◉** rare here · **🟡** not on this year’s list · **🟠** not on
  the life list · **🚫** blocked. Each glyph now has a fixed column, so the cues
  line up down the list instead of shifting position from row to row.
- Each column header is its own **filter toggle** — greyed out when inactive,
  full colour (and tinted) when filtering. Replaces the single cycling header.
- The filters are **independent and AND-combined**, mirroring the map legend:
  ★ + 🟠 now lists starred species still missing from the life list, which the
  old one-at-a-time cycle could not express.
- 🚫 inverts rather than narrows: off hides blocked species (the normal case),
  on shows only them for review — the behaviour the old “hidden” cycle step had.
- Toggling ◉ no longer re-renders (it is a row-hiding pass over rows already on
  screen); the others keep the list scroll position instead of jumping to the top.
- Retires the now-unused `th.speciesCycle` string in all 15 locales; adds
  `filter.*` tooltips (en + sv).

## 2026-07-22 — “Rare here” now means the MODEL says it’s unlikely (sw v679)

- Rarity was still derived from **observation counts**, so it measured observer
  effort, not rarity. At rarePct=3 every flagged species was simply one with a
  single report — Hooded Crow at 74% model probability, Lesser Whitethroat (50%),
  Common Cuckoo (49%), Eurasian Hobby (46%), Dunlin (38%) — all marked ◉ purely
  because few people had logged them there.
- **A species is now “rare here” when it was seen at the spot AND the habitat
  model gives it at most rarePct% probability.** How often it was reported is
  irrelevant. One shared `isRareProb()` serves both the map legend’s ◉ dots /
  ◉ Rare filter and the species list’s ◉ column.
- Live result at the new default (10%): Stockholm 7 flagged, rural Värmland 8,
  rural Innlandet 16 — and **no species with model probability ≥25% is flagged
  anywhere**, versus 8 of 17 at Stockholm before.
- This also fixes the opposite error: a twitched scarcity with many reports is
  now correctly rare (Brambling n=27 p=7%, Corn Crake n=25 p=9%, Wood Warbler
  n=37 p=6%). The count-based rule could never flag those.
- Default `rarePct` raised 5 → 10, since it is now read as a probability cutoff
  rather than a share of a count. A saved value is untouched.
- The plotted dots re-render when the per-species probabilities finish computing,
  since those now decide the ◉ styling and not just the legend order.
- Removes the count-percentile plumbing (`rareThreshold`, `detRareThr`,
  `recomputeRareThreshold` and its four call sites). Settings hint reworded
  (en + sv).

## 2026-07-22 — Fix: “rare here” flagged a third of the list (sw v678)

- The rare rule was “detection count ≤ rarePct% of the COMMONEST species’
  count”. Observation counts are steeply long-tailed (at Stockholm the median
  species had 20 records and the top one 174), so the default 5% landed at ≤8
  records and flagged **53 of 165 species** — Great Black-backed Gull, Common
  Swift, Garden Warbler, Eurasian Curlew and other thoroughly common birds.
  Anchoring to one dominant species measures “isn’t among the few most-reported”,
  not “is rare”.
- `rarePct` is now a **rank percentile**: a species is rare when it is among the
  least-reported that % of the species recorded at the spot. Measured on the
  same live data: Stockholm **53 → 23** of ~165, Oslo **59 → 12** of ~170, and
  every remaining flag had a single record (Great Reed Warbler, Savi’s Warbler,
  Red-breasted Flycatcher, Ortolan Bunting, Corncrake, Temminck’s Stint, Smew…).
- Applies to **both** consumers of the rule — the map legend’s ◉ dots and ◉ Rare
  filter, and the species list’s ◉ column — via one shared `rareThreshold()`.
  `detRareMax` is renamed `detRareThr` (it holds a threshold, not a maximum).
- A percentile also can’t be dragged by one mega-reported species, and still
  discriminates where the commonest species has only a handful of records (the
  old rule degenerated there — 1% of a max of 8 can never flag anything).
- Known behaviour: species TIED at the threshold all qualify, so the flagged set
  can exceed rarePct%. At Stockholm 23 species share a single record and all 23
  are flagged — correct, but it is why the figure is 14% rather than 5%.
- Settings → “Rare species threshold (%)” hint reworded (en + sv) to describe the
  new meaning.

## 2026-07-22 — Species-list status column + Fågelkartan link (sw v677)

- **Species-at-location: a status column.** The ★ that used to be glued to the
  front of a starred species' name has moved into its own narrow column left of
  Species, alongside the other per-species cues: ◉ rare here, 🟡 not on this
  year's list, 🟠 not on the life list, 🚫 blocked. (🟠 implies 🟡, so only the
  stronger of the two is drawn — same rule the map dots use.)
- **Each header now acts on its own column.** The status header cycles the
  filter (all → ★ → ◉ → 🟡 → 🟠 → 🚫), and "Species" is a plain A–Z / Z–A / off
  sort — previously one 7-state cycle on the Species header did both.
- ◉ "rare here" is the same rule as the map legend (at most rarePct% of the
  commonest species' count) but read off the list's own fetched counts, so it
  appears as soon as the observations land rather than only after plotting. It
  combines with the n(d) age filter (both hide rows, so they are ANDed).
- **Fågelkartan (SE/NO).** The map popup's 📍 Location submenu now offers a
  fagelkartan.se link for points in Sweden and Norway, resolving to that point's
  county page (/lan/<slug>/ or /no/fylke/<slug>/) via a new county-level
  reverse-geocode (AppGeo.regionInfo, zoom=8, separately cached). All 21 län +
  15 fylke slugs are bundled and the derived slug is validated against them, so
  an unmappable name falls back to the county index instead of a 404.

## 2026-07-22 — Simplify detection location naming to the source's own place (sw v676)

- The detections popup/list header now shows simply the place name the data source
  supplies (an eBird hotspot / BirdWeather station name where present, else the
  record's own place text). Dropped the reverse-geocoding upgrade and the nearby-
  user-point name folding — back to the initial, simpler behaviour.

## 2026-07-21 — Fix: detection popup header shows the location, not a species (sw v675)

- Clicking a detection point opens the co-located detections list, whose header is
  the place name. It was folding in the name of a nearby saved point — and detection-
  saved points are named after the species, so the header could read as a species.
  Those species-marker points (they carry a species key) are now excluded, so the
  header is the location again.

## 2026-07-21 — Tighter offline-maps manager + smaller minimised bar (sw v674)

- The offline-maps manager window is now narrower and less padded (a tighter dock),
  and when minimised it shrinks to a small pill at the bottom-right instead of a
  full-width title bar.

## 2026-07-21 — Map-point list admin moved to its own popup (sw v673)

- Editing, protecting (🔒) and deleting saved map-point lists moved out of Settings →
  Administer lists into a dedicated popup: <b>press-and-hold (or right-click) the
  Points button</b>. It lists each saved list with a protect toggle, a delete ×, a
  whole-list ✎ (colour + tags), and expands to a per-point table (edit / remove).
- Settings → Administer lists now holds the <b>year & life species lists</b> only.

## 2026-07-21 — Revert to base map labels for display (sw v672)

- Reverted the label-free basemaps (v668/v670): the light/dark bases and Streets
  (OSM) again show their <b>own</b> place names for display. The separate "Place
  labels" overlay is now off by default (it mainly helps Satellite, which has no
  names of its own). Finding lesser places is left to the 🔍 place search.

## 2026-07-21 — eBird hotspots are cached and accumulate across panning (sw v671)

- Fetched eBird hotspots are now saved (dedup by location, capped LRU) and every
  cached hotspot is shown — not just the ones in the current view's query. Panning
  around adds new hotspots to the map instead of replacing them, and they persist
  across reloads. Popups are built on click so drawing many stays light.

## 2026-07-21 — Streets base drops OSM labels when the labels overlay is on (sw v670)

- On the Streets (OpenStreetMap) basemap, turning on <b>Place labels</b> now swaps
  the base to a no-labels street map (Carto Voyager) so the overlay's names don't
  double up with OSM's baked-in labels. With labels Off, plain OSM (with its own
  labels) is shown as before.

## 2026-07-21 — Group icons for Plants 🌿 and Fungi 🍄 (sw v669)

- The Plants and Fungi species groups now have their own monochrome group icons (a
  sprout and a mushroom, in the same style as the bird/mammal/etc. icons) instead of
  falling back to the binoculars.

## 2026-07-21 — "Place labels" now actually controls label density (sw v668)

- The light/dark basemaps already carried their own place names, so the labels
  overlay was invisible at "On" (it just redrew them). The light/dark bases are now
  <b>label-free</b> and all place names come from the overlay, so the setting has a
  real effect: <b>Off</b> = none, <b>On</b> = clean native labels, <b>More</b> = a
  denser set (next zoom's names). Offline downloads now cache the labels too, so
  saved areas keep their place names. Existing "Off" users are migrated to "On" once
  so they don't suddenly lose labels.

## 2026-07-21 — Legend time filter: days/weeks 1–6, aligned on a grid (sw v667)

- The time subwindow's <b>days</b> and <b>weeks</b> presets now run <b>1–6</b> (were
  1–3). The preset numbers are laid out on a CSS grid so they line up in columns
  across the days / weeks / months rows.

## 2026-07-21 — Plants 🌿 and Fungi 🍄 species groups (observation-only) (sw v666)

- Added <b>Plants</b> and <b>Fungi</b> to Settings → Species group. GBIF + iNaturalist
  now fetch these kingdoms (GBIF kingdom keys 6/5, iNat iconic taxa), and the Nordic
  DBs already returned them — so their observations now fetch, map, list, filter (star/
  rare/date/observer) and save like any other group. Records are classified by kingdom
  when their class name is obscure (e.g. Magnoliopsida → Plantae).
- There is <b>no habitat model</b> for plants/fungi, so these groups are observation-
  only: the <b>Migration / Species Range / Species Richness</b> modes are hidden, the
  species list's Probability column is hidden, and a one-line hint explains why.
- Scope: dedicated groups only — "All groups" stays the four animal taxa. eBird /
  BirdWeather remain bird-only (skipped for these groups).

## 2026-07-21 — Legend species filter gains a life-list option (sw v665)

- The legend's species subwindow (★/◉/🟡) now has a 🔴 <b>life-list</b> filter —
  show only species <b>not on your life list</b> (lifers still to see), alongside the
  existing 🟡 "not on this year's list". Radio-style like the others; persisted.

## 2026-07-21 — Offline-maps manager moved out of Settings onto the ⤓ button (sw v664)

- Removed the "Manage offline maps…" entry from Settings. The manager now opens by
  <b>press-and-hold</b> (touch OR mouse) or right-click on the map's ⤓ download
  button — a plain tap still downloads the current view. Help text updated (15 langs).

## 2026-07-21 — Per-area delete disarms when you use the rest of the legend (sw v663)

- Arming the red × for per-area delete now turns off as soon as you do anything
  else on the legend — minimise/close it, open another filter, or pick a species —
  so the red area ×'s don't linger. A second click on the red × still deletes all.

## 2026-07-21 — Fix: only fetched areas are deletable (not every map tap) (sw v662)

- The deletable dashed outline was being remembered on every list/historic map
  click, so a plain tap left a persisted, deletable rectangle behind. It's now
  remembered only when a fetch actually plots observations onto the map — matching
  "when a fetch is done, remember the area".

## 2026-07-21 — Fix: map click showed no point menu (regression from v660) (sw v661)

- v660's area-persistence stored the fetched-area bounds as a plain array, but the
  save path called LatLngBounds methods (`.getSouth()` etc.) on it — so every
  list-mode map click threw before the point-options popup could open (no "Species
  list / Recent" menu). Bounds are now normalised to a real `L.latLngBounds`.

## 2026-07-21 — Fix: per-area red × missing after a reload (sw v660)

- The fetched-area outlines (and the area list behind the red ×'s per-area delete)
  were session-only — after any reload the areas were gone, so the legend's red ×
  skipped straight to "clear all" and no per-area crosses ever appeared. The areas'
  bounds now persist with the detections and are restored at boot, so the dashed
  outlines and the two-stage red × survive a reload.

## 2026-07-21 — Legend filters as subwindows + per-area delete (sw v659)

- The detection legend's filter buttons now open dropdown subwindows (like the 👤
  observer one):
  - <b>Time</b>: preset chips for 1/2/3 <b>days</b>, <b>weeks</b> and <b>months</b>,
    an <b>All</b> chip, plus a <b>from–to date range</b> (an absolute range takes
    precedence over the rolling window). The button shows a compact label (1d/2w/3m/∞/⇆).
  - <b>Species</b> (★/◉/🟡): each option is now a row showing its symbol and meaning
    — All, ★ Starred, ◉ Rare, 🟡 Needs this year — instead of a blind cycle button.
- The legend's <b>red ×</b> is now two-stage: with fetched-area outlines present, the
  first click arms per-area delete (a red × appears on each fetched rectangle — tap it
  to remove just that area's detections and its outline); a second click on the legend
  × clears everything (unchanged when there are no areas).
- Internals: a single `detDatePasses()` time predicate now backs the map, legend, list
  and hover; per-area delete is computed geometrically from each rectangle's bounds.

## 2026-07-20 — Render HTML notes on points (imported KML descriptions) (sw v658)

- Point notes can now be flagged as <b>HTML</b> so they render as formatted markup
  (links, lists, tables) in the pin popup instead of showing raw tags. The KML import
  dialog gains a <b>Note contains HTML</b> checkbox — auto-ticked when the imported
  descriptions look like markup (as Google Earth exports do) — and the flag is also
  editable per point (list-point editor) and for a whole list (Edit list).
- The rendered HTML is sanitised via a strict allow-list (script/style/iframe and all
  event handlers/inline styles are stripped, links forced to open safely) — the note
  comes from a user file, so it's never injected raw.
- KML export writes HTML notes in a CDATA block so they round-trip; the flag also
  travels through share links and Drive sync.

## 2026-07-20 — Edit whole point lists + aligned list-row icons (sw v657)

- In the map-points panel, point lists now have an <b>✎ Edit list</b> button that opens
  an editor for the <i>whole</i> list: set one colour and one set of tags applied to
  every point, and optionally rename the list. Renaming migrates the shown/protected
  flags; editing the currently-loaded list updates the on-map pins immediately.
- Fixed the trailing icons in list rows lining up unevenly — the lock/× (and the
  nav/share/edit buttons) now share one fixed 28×26px box so every row aligns.

## 2026-07-20 — Update banner + simplified points Export/Import buttons (sw v656)

- Added an "Update available — Reload" banner. Since the app stays on local cached
  code until a full reload, a newly deployed version waited invisibly; the banner now
  appears when an update is ready and one tap activates it (messages the waiting
  worker to skipWaiting, then reloads). Nothing auto-updates without the tap.
- Map-points export/import is now just two buttons — <b>Export</b> and <b>Import</b> —
  plus a compact <b>KML / KMZ</b> toggle that sets the export format (fixes the
  button text overrunning). Import still auto-detects KML vs KMZ by content.

## 2026-07-20 — Fix: KMZ files greyed out in the import picker (sw v655)

- Removed the file-input `accept` filter (mobile pickers greyed out `.kmz`, which
  often reports as application/octet-stream). The import already validates the file
  by its content (ZIP magic → KMZ, otherwise KML text), so any file is now
  selectable and the right ones are parsed.

## 2026-07-20 — KMZ import + export for map points (sw v654)

- Map points can now be exported as KMZ (a zipped KML) via a new "Export KMZ"
  button, and the import accepts both KML and KMZ (detected by the ZIP signature).
  Uses a tiny built-in single-entry ZIP writer/reader with the browser's
  deflate-raw — no new dependency.

## 2026-07-20 — Data-sources hint + About: routes/navigation docs (sw v653)

- The Data-sources overview hint now also explains that registering a free account
  often unlocks more data, and that many databases offer no public download API —
  with links to Observation.org and the ornitho.de network. (Added a data-i18n-html
  mechanism so translated strings can carry links.)
- Added a "Routes & navigation" section to the About/Help doc (the Navigate action
  + the hand-picked route basket), translated across all 15 languages.

## 2026-07-20 — Clear "API key missing" status instead of "didn't respond" (sw v652)

- When a source that needs a key is missing it, the status strip above the map now
  says e.g. "⚠ eBird: API key missing — add a free key in Settings → Data sources."
  instead of the generic "⚠ eBird didn't respond…", and it no longer pops the
  failure dialog for that case. Genuine failures still show the old message/dialog.

## 2026-07-20 — Drop the solid fetch box; remember fetched areas as thin dashed outlines (sw v651)

- Removed the solid "fixed search box" drawn at a clicked point in list/historic
  mode — only the movable dashed cursor preview remains (now a bit more visible).
- Every fetch (a clicked point, or each stored location) now leaves a THIN dashed
  green outline (no fill) of the area it covered. These accumulate and stay on the
  map until the detections are cleared. The stored-locations selection preview no
  longer lingers after the panel closes.

## 2026-07-20 — Fetched multi-area outline: thin dashed green, kept until cleared (sw v650)

- Fetching from several stored locations now outlines each fetched area with a thin
  dashed green line (no fill), drawn at fetch time and kept on the map until the
  detections are cleared.

## 2026-07-20 — Fetched-area squares persist until detections cleared; subtler dashes (sw v649)

- The area squares drawn for a stored-locations fetch now stay on the map until you
  clear the detections (they're removed by "clear all"), instead of lingering
  indefinitely. Their outline is now dashed and much fainter, and the dashed
  cursor-preview box is toned down too.

## 2026-07-20 — Cross-database detection de-duplication toggle (sw v648)

- New Settings toggle (Fetching & detections → "Deduplicate detections"). When on,
  a sighting registered in TWO databases (e.g. eBird + Artsobservasjoner) with the
  same observer, approximate location (~1 km), date, count and species is shown
  once instead of twice — across the map dots, legend counts, detections list and
  the dot popup. Off by default (shows every source's copy). Applied at display
  time (a hidden-set keyed on the plotted rows), so toggling is instant and no
  re-fetch is needed. Only collapses copies from DIFFERENT sources.

## 2026-07-20 — 2nd-language name in the dot hover/reticle popup too (sw v647)

- The species names in the on-map detection popup (hover, or the red reticle over a
  dot) now also show the second language in parentheses, e.g. "bokfink (Chaffinch)",
  matching the detections list.

## 2026-07-20 — Detections list shows the 2nd-language name in parentheses (sw v646)

- When a second species-name language is selected, the detections list now shows
  it after the primary name, e.g. "bokfink (Chaffinch)" — both in the by-time rows
  and the by-species group headers. Skipped when the two names coincide or the
  species isn't in the model.

## 2026-07-20 — GBIF concurrency 6 + per-dataset progress in the loading line (sw v645)

- GBIF per-dataset query concurrency raised from 4 to 6.
- The "Loading observations…" line now shows GBIF's dataset progress as
  <b>GBIF[done/total]</b> (e.g. GBIF[2/3]) as each dataset query finishes, then the
  usual GBIF ✓ (count) when complete.

## 2026-07-20 — GBIF: query only the configured datasets, not all of GBIF (sw v644)

- Removed the blanket unfiltered GBIF occurrence query (which pulled from ALL of
  GBIF). Now only the configured datasets are queried: global ones (Observation.org,
  Birda) always, and each nation-specific dataset only when the point/radius reaches
  its country. The historic count/range-split logic was rescoped to the same
  datasets so it stays consistent. Result: cleaner, less-duplicated, faster GBIF
  results focused on the curated national portals — at the cost of narrower GBIF
  coverage where no curated dataset exists (iNaturalist and eBird are still fetched
  directly as their own sources).

## 2026-07-19 — Two more national GBIF datasets: Estonia + Bulgaria (sw v643)

- Added country-gated GBIF defaults for Estonia (eElurikkus/EELIS — all species,
  incl. ~156k birds) and Bulgaria (BSPB common-bird monitoring, ~246k birds), both
  verified on the GBIF API. Belgium (Waarnemingen.be) and the Netherlands
  (Waarneming.nl) are already covered by the existing Observation.org dataset.
  Most other listed portals (ornitho network, BirdTrack, DabasDati, birds.cz, …)
  do not openly publish an occurrence feed to GBIF, so couldn't be added.

## 2026-07-19 — Homogenise numeric Settings inputs (sw v642)

- One `wireNumSetting` helper now backs the rare-%, max-points, nearby-count,
  fetch-timeout and reuse-window Settings fields (seed → clamp → save → refresh),
  replacing the repeated per-field boilerplate. (Those integer fields now round a
  typed decimal — the only micro-change.) Dropdown panels were already unified.

## 2026-07-19 — Homogenise the hand-built modal overlays (sw v641)

- One shared `createModal` factory now backs the five centred overlays (offline
  download, offline-cover prompt, observer-lists editor, save-location, country
  menu) — overlay + box + backdrop/Escape dismissal + close in one place, each
  caller just supplies its own content. No behaviour change.

## 2026-07-19 — Homogenise anchored popup menus (sw v640)

- Unified the two DOM popup-menu systems (the species/record menu and the observer
  add-to-list menus) onto one shared primitive (open / position / close + outside-
  click dismissal), removing the duplicated element-tracking, positioning and
  close plumbing. Both now dismiss on an outside click (the observer menu used to
  also close on a click on its own empty area — the only behaviour change).

## 2026-07-19 — Speed pass (behaviour unchanged) (sw v639)

- Map panning no longer re-serialises the whole saved-state blob (up to 15k plotted
  rows) on every move — the view save is coalesced and flushed on hide/unload.
- Hovering detection dots no longer runs a haversine + object alloc over every
  plotted row: a cheap bounding-box test rejects far rows first.
- The detection-marker renderer filters each species' rows once (was twice) and
  computes each location key once.
- Small dedup: weekOfToday now shares weekOfDate's formula; todayStr shares
  fmtDateFile. (See tasks/optimization_20260718.md for the full analysis and the
  staged, higher-risk items.)

## 2026-07-18 — Help/About: document the newer features in all 15 languages (sw v638)

- Added ten new Help sections covering functions that had gone undocumented:
  legend controls & probability ordering, observer filter & lists, the Detections
  list, the 3-state crosshair/read cursor, place search, map points & share links,
  stored locations, offline maps, checklist photos, and the extra Settings items.
  Written in English and translated into all 14 other languages, inserted before
  each language's "Key settings" section.

## 2026-07-18 — Tidy the startup popup + add a description (sw v637)

- The startup popup now opens with a one-line description of what the app does
  (in-browser habitat model + live observations from eBird/GBIF/iNaturalist…),
  translated into all 15 languages. Tightened the spacing and the em-dash title.

## 2026-07-18 — Legend ordered by habitat-model probability (sw v636)

- The map legend now orders species by the BirdNET habitat-model probability, from
  LOWEST to HIGHEST. A species' value is the highest probability among its own
  observations (the geomodel evaluated at each observation's location + week).
  Computed once per plotted set (one column inference per species); ties and
  non-model "extras" fall back to the localised name. Previously alphabetical.

## 2026-07-17 — Show version + last-change in the startup popup (sw v635)

- The startup popup now shows the running app version (reported by the active
  service worker) alongside the last-change date/time, e.g. "v635 · 17-07-2026 22:24".

## 2026-07-17 — Insect-as-bird fix, part 2: invalidate stale cache (sw v634)

- The v633 cross-class fix only affects NEW aggregation; the persistent sightings
  cache (30-min reuse) was replaying the PRE-fix result on re-fetch, so the wrong
  matches persisted. Added a cache schema version (SIGHT_CACHE_VER) — old cached
  results are now ignored and the next fetch re-aggregates with the fix.
- Also hardened the fuzzy scientific-name matchers (epithet / same-genus): even a
  unique candidate is now rejected when the record's known class differs from it,
  not just when several candidates tie.
- NOTE: already-plotted detections restored from a previous session were aggregated
  by the old code — re-fetch the location to refresh them. And because the app now
  only updates on a full reload, fully close/reopen (or hard-reload) to get this.

## 2026-07-17 — Fix: insects no longer shown as birds (cross-class match) (sw v633)

- Aggregation no longer folds a record with a KNOWN class onto a model species of a
  DIFFERENT class. Previously, fetching "all groups" could match e.g. an insect
  (by a shared/near name or common name) onto a bird species, so it inherited the
  bird's class and appeared — with an exotic bird name — when filtering to Birds.
  Such records now land in the extras list under their own name + class, so the
  species-group filter treats them correctly. Matches are only rejected when both
  the record's and the model species' classes are known and differ.

## 2026-07-17 — Source key panel: sign-up + API-key links (sw v632)

- Each keyed source's detail panel (Settings → Sources) now shows two links: "Create
  an account" and "Get a free key" — pointing at the sign-up page and the API-key
  page for eBird, Artportalen (Artdatabanken) and Laji.fi. Shown for keyed sources
  whether or not a key is set (previously only a single key link, and only when unset).

## 2026-07-17 — Reuse window now 30 min + configurable (sw v631)

- The "reuse downloaded observations" window is now **30 min** by default (was 12 h)
  and settable in Settings → Fetching & detections → "Reuse downloads (min)". 0 =
  reuse indefinitely (only refetch on a new place or a changed radius/group/source).

## 2026-07-17 — Reopening reuses downloaded observations (no refetch) (sw v630)

- Location observation fetches are now cached to IndexedDB (the 6 most-recent
  locations, a structured clone of the aggregated result). Reopening the app — or
  re-visiting a place from an earlier session — REUSES the already-downloaded
  detections instead of re-fetching, as long as the source config is unchanged and
  the copy is fresh (< 12 h). A new location, a changed radius/group, or a changed
  source config still fetches; and a cached location now also opens offline.
- Previously `restoreSession()` re-ran the last location's fetch on every open
  because the sightings cache was in-memory only (lost on reload).

## 2026-07-17 — Offline: app stays on local code until a full reload (sw v629)

- The service worker no longer calls `skipWaiting()`. A newly deployed version
  precaches its shell but then WAITS — the running, offline-capable app keeps being
  served entirely from its local cached code, and the new code only takes over on a
  full reload / app restart (or a hard reload, which pulls straight from the server).
  This is what makes the installed app "controlled by local code unless the user
  does a full reload from the server". Live API data is still fetched network-first.
- Audit (no change needed): all user-generated lists persist — observer/life/year
  lists, starred species, map points + collections, stored locations, field
  checklists, recent searches and legend state are in localStorage; saved detection
  sets and checklist photos are in IndexedDB (too bulky for the localStorage cap).

## 2026-07-17 — Hide the species filter box on short detection lists (sw v628)

- The detections list only shows the "Filter species…" search box when there are
  ≥10 detections (i.e. when the list actually scrolls); short lists are just scanned.
  Kept visible if a query is already active so it can still be cleared.

## 2026-07-17 — Add observers to lists from the point-observation list (sw v627)

- In the detections list (by-time view), the observer name in each date/observer
  header is now clickable → a menu to add/remove that observer from your observer
  lists (same menu as the legend).
- When an observation carries several observers (source-separated), the click first
  shows a picker of the individual names; picking one drills into its add-to-list
  menu. BirdWeather station headers stay non-clickable.

## 2026-07-17 — Legend control row no longer wraps (sw v626)

- The legend header (minimise · list · days · mode · 👤 · × filters · × clear · ⚠)
  is kept on a single line (no wrap) and the legend max-width widened 250→340px so
  the red "clear all" × no longer drops to a second line on wider screens.

## 2026-07-17 — Drop the "Filter by observer" title in the legend head (sw v625)

- Removed the "Filter by observer" label from the 👤 panel head so the scope-cycle
  button (All / None / list name) gets the full width for longer list names.

## 2026-07-17 — Observer lists: cycle scope, hover-isolate, search editor (sw v624)

- The 👤 observer filter's head now has a **scope-cycle button** (where "All" was)
  that steps All → None → each saved list → All; its label shows the current scope.
  The separate list-chips row is gone.
- **Hovering** an observer's name now isolates just that observer's records on the
  map (mouse only), the same way hovering a species does.
- **Editor reworked:** nicknames removed; pick the list to edit from a dropdown;
  members shown as a table (not chips); add members via a **fuzzy-search textbox**
  over observers that have observations (click a match to add). The per-list
  "Add observer" dropdown and the all-observers table are gone.
- The observation-popup place name now also **de-duplicates comma-separated tokens**
  (e.g. "Siragrunnen, Sokndal, Teinevigodden, Sokndal" → drops the earlier "Sokndal").
- All new UI strings translated across **all 15 languages** (no English fallbacks).

## 2026-07-17 — Keep observer-list scroll when adding from the legend (sw v623)

- Adding/removing an observer via the name-click menu in the 👤 filter no longer
  jumps the observer checklist back to the top — the scroll position is preserved
  across the legend rebuild.

## 2026-07-17 — Observer-lists editor: pick a list + "+" to add (sw v622)

- The editor now edits **one list at a time**, chosen from a dropdown at the top,
  instead of stacking every list. Adding an observer is a **"+" icon** (opens a
  picker of everyone not yet in the list) rather than a visible per-list dropdown.
  Delete is a 🗑 icon.

## 2026-07-17 — Quick "add to list" from the observer filter (sw v621)

- Clicking an observer's **name** in the 👤 observer filter opens a small menu to
  toggle that observer in/out of each saved list (✓ marks current membership) or
  start a new list containing them. The checkbox still toggles filtering as before.

## 2026-07-17 — Observer lists + nicknames (sw v620)

- Keep named **sets of observers**. In the 👤 observer filter (detection legend)
  saved lists show as chips above the observer checkboxes; tap one to restrict the
  map + list to exactly that list's observers (tap again to clear).
- A new **editor** (the "Lists ✎" button in the panel) lets you create, rename and
  delete lists, add observers to a list (picker of everyone known) and remove them,
  and give any observer a **nickname**. Nicknames are shown in the filter panel in
  place of the raw observer name.
- Stored in `GeoState` as `observerLists` (`[{name, observers[]}]`) and
  `observerNicks` (`{name: nickname}`).

## 2026-07-17 — Detections popup: fold in the user's own place name (sw v619)

- The detections-popup title now includes the name YOU gave the spot when one
  exists nearby (a manually-placed map point, a point in a saved list, or a stored
  location — within 200 m), combined with the map/source place name. The two are
  de-duplicated so a shared string isn't repeated (if either name already contains
  the other, only the richer one shows; otherwise "map name · your name").

## 2026-07-17 — Shift+wheel resizes the Sightings radius (sw v618)

- The "Sightings radius" (the search box drawn on the map) can now be resized with
  Shift + mouse-wheel over the map — scroll up to enlarge, down to shrink — stepping
  through the same stops as the Settings slider. It updates the setting, the slider,
  and redraws the fixed + live area boxes; plain wheel still zooms the map. (Desktop
  mice; touch has no wheel.)

## 2026-07-16 — Offline: stop re-downloading the app code (sw v617)

- The app shell (HTML/JS/CSS/i18n — ~1 MB) is now served **cache-first** instead
  of network-first. Once the app is cached, its code is served straight from the
  device and is **not re-downloaded on every load while online**, which was the
  main source of "excessive downloading" for installed/offline users. Fresh code
  now arrives only when `VERSION` is bumped on deploy (a new service worker
  installs, precaches the new shell, and drops the old cache) — so bumping
  `VERSION` on every user-visible change is now mandatory. Navigations still
  resolve to the cached `index.html`, so share links (`?s=…`) and deep links keep
  opening the cached app offline. (Big model/labels/taxonomy/vendor files were
  already cache-first; only the shell changed.)


## 2026-07-14 — Smaller share links: columnar + coarser coords (sw v616)

- Detection share payloads are now COLUMNAR (each field its own array) and use
  ~11 m (4-decimal) coordinates, which deflates better — about 13% smaller links
  (a 120-obs trip ≈ 1.5k chars, ~54% below the original verbose form). Older v1/v2
  links still import. (A denser-than-base64 alphabet isn't reliably URL-safe, so
  base64url stays; colours are per-species and per-user, so they're kept.)


## 2026-07-14 — Share: file fallback for large shares (sw v615)

- When a share is too big for a URL, it is now handed over as a small file
  (.mcshare) via the native share sheet or a download, instead of just warning.
  The recipient opens it with the new "Import shared file" button in the Points
  panel. Localised in all 15 languages.


## 2026-07-14 — Share the whole map in one operation (sw v613)

- New "Share map" button (Points panel) packs ALL plotted detections + ALL user
  points on the map into a single share link (compact v2 "map" payload). The
  recipient imports both at once (a detection set + a point list), fitted to the
  map. Localised in all 15 languages.


## 2026-07-14 — Share loose user-defined points too (sw v612)

- The working (loose, not-yet-saved) map points now have a 🔗 share button next to
  "Save as list" in the Points panel, so user-placed pins can be shared directly
  (as a points link) without first saving them as a list.


## 2026-07-14 — Shared species names use the recipient's language (sw v611)

- Detection share links now store the language-independent species CODE + class
  (not the sender's display name), so the recipient sees names in THEIR language
  and scientific-name setting (resolved via the shared model). Also makes the URL
  a bit smaller. Saved trips re-localise on the map too.


## 2026-07-14 — Share links carry the source (verify) (sw v610)

- Detection share links now also encode each record's SOURCE (eBird/GBIF/…) and
  a compact link to the original record (the per-source URL prefix is stripped and
  re-added on import), so the recipient can verify each observation at its source.
  A shared/saved trip's dots now open a popup with species, date/count/observer
  and a "source ↗" verify link. Still compact (a 120-obs trip ≈ 1.9k-char URL).


## 2026-07-14 — Compact share links for detections (sw v609)

- Detection-set share links now use a compact encoding (v2): species, dates and
  observers are stored once in dictionaries and each observation is a row of small
  integers with ×1e5 delta coordinates. Roughly halves the URL length (a 120-
  observation trip: ~3240 → ~1470 chars) while ALSO now including observers. Old
  (v1) links still import.


## 2026-07-14 — Clear "Install for offline use" guide (sw v608)

- Added a clear step-by-step "Install for offline use" section to the in-app
  About panel (Settings → About # Changes how it works) and the README, with separate
  iPhone (Safari, iOS 11.3+) and Android (Chrome etc.) steps, version notes, and
  the "load online once" + offline-maps reminders. Localised in all 15 languages.


## 2026-07-12 — Detections popup: single sort toggle (sw v607)

- The "By date / By species" toggle is now a single pill showing only the active
  sort; tapping it switches to the other (its tooltip names what a tap does),
  saving space in the header.


## 2026-07-12 — Detections popup: smarter place name (nearby feature) (sw v606)

- The popup place name now resolves as: the record's explicit named location
  (eBird hotspot / BirdWeather station) → a nearby major geographic feature
  (lake/water/bay/wetland/glacier/peak) within 250 m from OpenStreetMap (Overpass)
  → the reverse-geocoded map name (finer than commune) → the source place. Falls
  back gracefully if Overpass is unavailable.


## 2026-07-12 — Detections popup: place name on its own line (sw v605)

- The place name now gets its own line at the top of the detections popup, with
  the action icons (Save/Navigate/Copy) and the date/species sort toggle on the
  line below. The title font auto-shrinks so the full place name fits on one line.


## 2026-07-12 — Detections popup: precise place name in the title (sw v603)

- The place name shown as the detections-popup title now prefers an explicitly
  named location (eBird hotspot / BirdWeather station); otherwise it reverse-
  geocodes to a name finer than commune level (a specific feature/locality, never
  the municipality/county), via a new AppGeo.placeName. Falls back to the source's
  place, then "Detections".


## 2026-07-12 — Detections popup: show the place name(s) as the title (sw v602)

- The detections popup (opened from a dot) now shows the location's place name(s)
  from the sources as its heading instead of the generic "Detections" (falls back
  to "Detections" when no place name is available). Up to two distinct names shown,
  full list on hover.


## 2026-07-12 — Point editor: drop the colour checkbox, tidier row (sw v601)

- Removed the "custom colour?" checkbox. The swatch starts at the point's
  automatic (tag-based) colour; changing it makes the colour custom, and a ↺ button
  resets it to automatic (on save, a swatch still equal to the auto colour is
  stored as automatic). Colour label + swatch + ↺ sit inline next to the
  coordinate pill. Also translated the "Colour" label in the 13 locales that
  lacked it.


## 2026-07-11 — Manual point editor: drop website links, tighter card (sw v600)

- Removed the national-service website links from the manual point-entry popup
  (they live on the right-side Country button now). Reorganised the card: name/
  tags/note use placeholders instead of caption lines, and the colour row + the
  coordinate copy-pill share one row — so it takes noticeably less space.


## 2026-07-11 — eBird hotspot popup with eBird link + Navigate (sw v598)

- Clicking an eBird hotspot now opens a popup (name + species/last-seen) with an
  "eBird ↗" link to the hotspot page and a "Navigate in Google Maps ↗" option that
  opens driving directions to the hotspot — instead of jumping straight to eBird.


## 2026-07-11 — eBird hotspots: show capped + cache (sw v597)

- Hotspots show again when zoomed out, but when the view is larger than eBird's
  500 km query cap a dashed 500 km circle round the map centre marks the covered
  area and a status line says so — so the partial coverage is clear, not
  confusing.
- Fetched hotspots are cached (0.25° grid + 25 km distance bucket, 1 h) so
  panning around and re-showing the layer reuses results instead of re-querying.


## 2026-07-11 — eBird hotspots: complete coverage, no partial ring (sw v596)

- Replaced the fixed min-zoom with a viewport check: hotspots show whenever the
  whole view fits within eBird's 500 km query cap (centre→corner ≤ 500 km), so
  the dots always cover the entire visible area instead of only a confusing ring
  around the centre when zoomed out.


## 2026-07-11 — eBird hotspots show at more zoom levels (sw v595)

- Lowered the minimum zoom for the eBird hotspots layer from 6.5 to 4.5, so
  hotspots appear when more zoomed out. (eBird still caps the query at 500 km from
  the map centre, so at the lowest zooms coverage is around the centre; the
  all-time-species filter keeps the count sensible.)


## 2026-07-10 — Detection-list navigate button opens Google Maps at the location (sw v592)

- The 🧭 button in the detections popup now opens Google Maps directions to the
  detection's location, instead of downloading a KML and opening the Google My
  Maps import page (which showed no location). Co-located dots collapse to one
  stop. (The My-Maps pin export is still available per saved list/trip in the
  Points panel.)


## 2026-07-10 — Country resources moved to their own button (sw v591)

- The country-related links (Blogs, BirdLife, national observation/registration
  services) moved out of the per-point popup into a new 🌐 "Country" button on the
  right of the map — it resolves the country at the map centre. Point-specific
  items (Species list, Location submenu, birdingplaces) stay in the point popup.
  Localised in all 15 languages.


## 2026-07-10 — Map point popup: "Location" submenu (sw v590)

- The map-point popup groups Save location, Share link and Copy coordinates under
  a single collapsible "📍 Location ▸" entry, keeping the popup tidy. Localised in
  all 15 languages.


## 2026-07-10 — Translate the stored-locations strings (sw v589)

- "Save location" and the rest of the stored-locations feature (saved toast,
  Stored locations panel, radius, Include, All/None, Fetch observations) were only
  in English + Swedish; now translated in all 15 languages.


## 2026-07-10 — Copy a point's coordinates as text (sw v588)

- A single detection point (its detections popup), a tapped map point (its popup),
  and the point editor now offer "Copy coordinates" — copies "lat, lon" (decimal
  degrees) to the clipboard, ready to paste into Google/Apple Maps or a message.


## 2026-07-10 — Share the currently loaded detections (sw v587)

- The Points panel now has a 🔗 Share button next to Save (shown when detections
  are plotted): it shares the observations currently loaded from the data sources
  as a link, without needing to save them as a trip first. The recipient sees them
  with no API keys.


## 2026-07-10 — Share: show a copyable link (sw v586)

- Sharing a point/list/trip now copies the full link to the clipboard AND shows
  it in a copyable dialog, instead of relying on the native share sheet (which
  was silently dropping the long URL on some devices, leaving only the base app
  link). Paste the shown link into any message or app.


## 2026-07-10 — Fix: share link now carries the data (sw v585)

- Share links put the encoded data in a query parameter (?s=…) instead of the URL
  hash (#s=…). The Web Share API and many share targets strip the fragment, so
  recipients were getting just the bare app link. Old hash links still import.

## 2026-07-10 — Share points / locations / detections via URL (sw v584)

- New 🔗 Share on a saved location-list or trip (Points panel per-row), and on a
  map point's popup: builds a self-contained URL (deflated + base64url in the
  hash) that embeds the data, so the recipient sees the points/detections with
  **no API keys** — nothing is re-fetched. Opening such a link imports it (after a
  confirm for lists/trips) and shows it on the map. Localised in all 15 languages.

## 2026-07-09 — Trip dots easier to tap (sw v581)

- A shown trip's detection dots now have a larger, near-invisible tap target and
  reveal the species (tooltip) on tap — a 5 px dot was a tiny touch target, so
  opening a trip point to see its species was hard on a phone. The visible dot is
  unchanged.

## 2026-07-09 — Faster offline/slow-network boot (sw v580)

- The app shell (HTML/JS/CSS/i18n) is now served network-first with a 2 s
  timeout: if the network is slow or dead, the cached shell is served after 2 s
  and refreshed in the background, instead of the boot stalling on failing
  fetches. Fresh-deploy pickup on a healthy connection is unchanged. The API
  cache (observations/geocode) still waits for fresh data.


## 2026-07-08 — Map touch: empty-map tap opens the popup after a tiny delay (sw v579)

- Replaced the minimum-hold gate on the empty-map tap (which rejected normal short
  taps, so nothing happened) with a small delay: a touch on empty map now opens the
  point popup after ~180 ms, and a pan/zoom in that window cancels it, so a fleeting
  graze that's really the start of a pan doesn't pop it up. Normal taps work again.

## 2026-07-08 — Map touch: move the press-delay off the dots onto the empty-map tap (sw v578)

- Reverted the ≥200 ms press gate on detection dots / map-point pins — a normal tap is
  often shorter than that, which made dots almost impossible to open. Dots and pins are
  instantly clickable again. The accidental-touch delay now applies to tapping the EMPTY
  map (opens the point popup / places a location): ≥200 ms. Long-press to register a saved
  location stays ≥500 ms.

## 2026-07-08 — Data sources: "Get a free key" link when no key is set (sw v577)

- In the data-source detail view, a keyed source with no API key entered now
  shows a "Get a free key ↗" link to that provider's signup/keygen page
  (eBird, Artportalen/Artdatabanken, Laji.fi). Localised in all 15 languages.


## 2026-07-08 — Map touch: gate the detection-dot popup too (sw v576)

- The ≥200 ms press gate now also covers the plotted detection dots (not just
  saved map-point pins), so a quick brush on a dot no longer opens its popup.
  Added a touchstart fallback so the press-timing is reliable on Android.


## 2026-07-08 — Map touch: press-duration gates (sw v574)

- Tapping a map point now needs a ≥100 ms press to open its popup, so an
  accidental brush no longer triggers it. Registering a location by long-press
  now requires a deliberate ≥500 ms hold. Mouse/pen clicks are unaffected.


## 2026-07-07 — Close by: fit-to-width names; QR to share the app (sw v572)

- Close by list: each species name now scales its font down to fit on one line
  (no truncation), re-fitting on rotate/resize.
- Settings: added a QR code (static SVG) above the "About & how it works" link
  that encodes the app URL, so you can open/share the app by scanning. Works
  offline (precached); caption localised in all 15 languages.


## 2026-07-06 — Birds close by: show count + days since per row (sw v569)

- Each species row in the "Birds close by" list now shows "n(Nd)" behind the
  name — n = the observation count (blank if unknown) and Nd = days since that
  observation (0d = today). Map-point rows show no meta.


## 2026-07-06 — Birds close by: option to include active map points (sw v568)

- New Settings toggle "Also include active map points": when on, the "Birds close
  by" list also folds in your active map points (working pins + shown saved-list
  points that aren’t detections), sorted by distance alongside the detections and
  marked with a 📍. Off by default. Localised in all 15 languages.


## 2026-07-06 — Birds close by: live recalc on movement (sw v566)

- When GPS live-follow is active and the "Birds close by" list is open, the list
  now recomputes distances against each fresh position fix — but only after the
  position has moved at least 50 m since the last update (ignores GPS jitter).


## 2026-07-06 — "Birds close by" distance-sorted list page (sw v565)

- New feature: a ☰ list button on the top-left of the map opens a full-page,
  big-text list of the plotted bird detections sorted by distance from the
  reference point (blue live cross → red fixed cross → placed pin → map centre).
  Each row shows the species and distance; tapping a row centres the map on it.
  The on-page 📍 button (top-right) toggles back to the map, zoomed to fit the
  listed detections with a margin. The number of rows is configurable in Settings
  ("Birds close by — rows shown"). Localised in all 15 languages.


## 2026-07-05 — Robustness fixes: blogs sync, Laji non-birds, quota, group races (Phase 2, sw v564)

- Blogs now sync correctly: applyRemote UNIONS blogLinks + blogRemoved (by cc|url)
  across devices instead of clobbering, and deleting a user-added blog records a
  tombstone so it stays deleted after a sync (was resurrected).
- Laji.fi (Finland) non-bird records now come through in mammal/amphibian/insect
  mode: the normalizer emits a blank class (kept by the group filter, exact
  name-match decides) instead of "Other" (which was always dropped).
- Silent data loss surfaced: map-points / point-lists / blogs saves now show a
  storage-full toast when a write hits the localStorage quota (was silent).
- Legend hover-isolate no longer sticks when the legend re-renders under the
  cursor (detFocusKey cleared when its row leaves the list).
- Species-group mid-fetch race fixed: the group captured at fetch-start is used
  for aggregation + plotting (aggregateRecords group override + result.group), so
  switching group during an in-flight fetch cannot filter e.g. bird data against
  mammals. wantClass no longer falls back to birds for an unknown group.
- GPS live-follow now stops on a mode switch (no surprise recentres in Range/
  Richness). Offline zoom-cap also upscales cached tiles on a dead/captive "online"
  connection (tile-error flag), not only when navigator reports offline.

## 2026-07-05 — Security hardening: CSP, memory-only OAuth token, SRI (Phase 1.3-1.5, sw v563)

- Added a Content-Security-Policy (+ Referrer-Policy) meta. script-src is locked to
  self + trusted Google/jsDelivr CDNs + wasm-unsafe-eval (ORT), so injected inline/
  remote scripts cannot run — the primary XSS defence-in-depth. Externalised the one
  inline SW-registration script to sw-register.js so no unsafe-inline is needed.
- Google OAuth access token is now kept in MEMORY ONLY (never localStorage); any
  token a prior build persisted is purged on load/teardown. Sync re-acquires on the
  next user-gesture Sync.
- Pinned the EmailJS CDN script to 4.4.1 with an SRI integrity hash + crossorigin.
- Added w.opener=null on the two blank-tab opens (Wikipedia/BirdLife) to stop
  reverse tabnabbing.
  NOTE: verify on device that Drive sync, inference, and map tiles still work under
  the CSP; the connect/img allowlists are broad (https:) by design (custom source
  endpoints).


## 2026-07-04 — Hold the map-download button for the saved offline-maps list (sw v560)

- Press-and-hold (or right-click) the map-download button now opens the "Manage
  offline maps" list; a tap still downloads the current view. (Same manager as
  Settings → Offline maps.)

## 2026-07-03 — Fix: read crosshair no longer closes other popups (sw v559)

- In read mode, opening a target popup could auto-pan the map, firing movestart/
  moveend that re-triggered the reticle — a churn that also closed the stored-
  locations panel (via the map-interaction dismiss) and modals like "recent" (via
  closeModals on popupopen). The reticle now ignores map events for a short window
  after it opens something, so those stay open.
- Also made the magnifying-glass long-press (stored locations) tolerant of finger
  jitter so a slight move no longer cancels the hold.

## 2026-07-03 — Stored locations move to the search (magnifying-glass) button (sw v558)

- Press-and-hold (or right-click) the place-search magnifying-glass button now opens
  the stored-locations list. The crosshair button no longer does that — its tap just
  cycles off → follow → read.

## 2026-07-02 — Place search: recent searches when the box is empty (sw v557)

- Opening the place search (magnifying glass) now lists your last 5 search texts
  when the box is empty; tap one to run it again. The list updates whenever you
  pick a place. (Icon is the magnifying glass from v556.)

## 2026-07-02 — Place search: magnifying-glass icon + broader (fuzzy) search (sw v556)

- The place-name search control now uses a magnifying-glass icon (was a map pin).
- The search no longer hard-restricts to the current map view (bounded=0): the
  viewbox only biases ranking, so matches anywhere — and loose/partial names — are
  returned instead of nothing when the place is off-screen.

## 2026-07-02 — Legend red × clears the whole map (sw v555)

- The detection legend's red × now clears ALL plotted points: the fetched dots
  plus every shown saved list / detection set (previously those were re-injected /
  left as overlays, so they stayed on the map). The lists/sets are only un-ticked
  (kept in storage); loose working map pins are untouched.

## 2026-07-02 — Setting: extra place-name labels on the map (sw v552)

- New Settings → View → "Place labels": Off / On / More. It overlays Carto
  labels-only tiles over the basemap, so place names show even on Satellite/Topo,
  and "More" pulls in the next zoom level's (denser) labels so more names appear.
  Label style (light/dark text) follows the basemap; tiles cache like the basemap.

## 2026-07-02 — Read crosshair: panning dismisses the popup (sw v551)

- In the red "read" state, starting to pan now closes whatever the crosshair popped
  (map-point popup, read-only pin menu, hotspot tooltip) — so you can pan away from
  a dot without tapping its × first; the next centred target opens on settle.
- (Observation dots open the detections-list modal, which is full-screen and blocks
  panning, so that one is still closed with its × — ask if you'd prefer a lighter
  pannable popup there instead.)

## 2026-07-02 — Read crosshair also reveals eBird hotspot info (sw v550)

- When the eBird hotspots overlay is shown, centring the red read-crosshair over a
  hotspot now opens its info tooltip (name + all-time species count) — not the
  external page. Picks the nearest of observation dots / map points / hotspots.

## 2026-07-02 — Read crosshair opens the point's full click popup (sw v549)

- In the crosshair's red "read" state, centring an observation dot now opens the
  same popup as clicking it (the detections list for that spot), matching map
  points (which already opened their click popup). Deduped so it doesn't re-fire
  while the same target stays under the centre.

## 2026-07-02 — Crosshair control: 3-state cycle (off / follow / read) (sw v548)

- The crosshair button now cycles three states on tap:
  - grey = OFF;
  - blue = FOLLOW — recenters on your GPS position, keeping it inside the central
    80% (pans only when you drift into the outer 10% edge band);
  - red = READ — a red crosshair fixed at screen centre; pan a dot under it and its
    info opens. Observation dots show their balloon; a map point opens the SAME
    popup as clicking it.
- Press-and-hold still opens the stored-locations list (unchanged).

## 2026-07-02 — Fixed centre crosshair + centre targeting (sw v547)

- The map crosshair control now toggles a red crosshair fixed at the middle of the
  screen. Pan the map so an observation dot or a map point sits under it and that
  dot's info pops up automatically (checked on each settle, within ~24px of centre).
  Tap the crosshair button again to turn it off.
- NOTE: the crosshair button now toggles this reticle instead of GPS "locate/follow"
  (which fought against panning-to-target). Press-and-hold still opens stored
  locations. GPS follow can be re-added on a separate control if wanted.

## 2026-07-01 — Stored locations: draw selected areas as squares on the map (sw v546)

- Selecting stored locations in the list (hold the crosshair) now draws a green
  square on the map for each selected location — its ± radius fetch box — so you
  can see which areas are active before fetching. Updates as you tick/untick or
  change a radius; empty when nothing is selected.

## 2026-07-01 — Stored locations: per-location radius + multi-location fetch (sw v544)

- Saving a location now lets you set a fetch radius (defaulting to the "Sightings
  radius" setting).
- The stored-locations list (hold the crosshair) gains a checkbox per location
  (include/exclude), an editable radius, an All/None toggle, and a "Fetch
  observations" button.
- Fetch pulls observations from every selected location — each within its own
  radius — and plots them all on the map. It runs the locations sequentially with
  a short gap (and reuses the per-source rate-limiting/backoff + the location cache)
  to be kind to the source APIs.

## 2026-07-01 — Add the missing "Save as list…" button for loose points (sw v543)

- The Points panel's "N unsaved points" banner told users to "use Save as list…",
  but that button did not exist — the only way to file loose points was one-by-one
  in each point's editor. Added a "Save as list…" button to the banner: it files
  all loose pins into a named (new or existing) list and ticks it to show.

## 2026-07-01 — Map points: custom colour + file loose points into a list (sw v542)

- Point editors (new/live pin and saved-list point) now have a colour picker:
  tick "Colour" and pick a swatch to set a point's colour; unticked = auto (by
  first tag, else grey). Markers render the explicit colour when set.
- A loose (unfiled) point can now be saved into a list from its own editor — the
  "Save to list" picker now also shows when editing a loose pin, and choosing a
  list moves the point into it. (New points already had this.)

## 2026-06-30 — Stored locations: save map spots & recall from the crosshair (sw v541)

- Save a map point: tap a point on the map and choose “📍 Save location” in the
  popup (name suggested from the place, editable). Stored in localStorage.
- Recall: press-and-hold (or right-click) the Locate-me crosshair to pop up the
  stored-locations list; tap one to fly there, × to remove. A normal click still
  does Locate-me.

## 2026-06-26 — Legend: press-and-hold to isolate a species on touch (sw v540)

- Restored the touch "hover": press and hold a legend row to isolate that species
  on the map (grey out the rest) while held, lift to restore. A quick tap still
  toggles multi-select (the hold is ignored by the select). Mouse devices keep the
  real hover-to-isolate. Builds on the v539 multi-select fix.

## 2026-06-26 — Fix: legend multi-select showed only the last species on touch (sw v539)

- On a touch device, tapping a legend row fired mouseenter (which isolates that one
  species via detFocusKey) but never mouseleave, so the focus stuck and the map
  drew only the last-tapped species despite several being selected. Hover-focus is
  now bound only on hover-capable devices, and a tap clears any stuck focus — so
  all selected species show together again.

## 2026-06-26 — Offline maps manager: re-download button + purged indicator (sw v538)

- Each saved area in the offline-maps manager now has a ⟳ re-download button that
  re-fetches its tiles (with live count progress in the row) into the same area.
- Areas whose tiles the browser has purged are flagged with a ⚠ amber indicator
  (and amber name), detected by an async cache check when the list renders.

## 2026-06-26 — Offline maps: detect evicted areas & offer re-download (sw v537)

- On startup (when online) the app now checks each saved offline area's tile cache
  and, if the browser has purged the tiles (metadata survives in localStorage while
  CacheStorage is cleared), asks whether to re-download them — rebuilding the exact
  tiles from the stored bbox / zoom / basemap into the same area. Pairs with the
  v536 persistent-storage request so it shouldn't recur after a refresh.

## 2026-06-26 — Offline maps: request persistent storage (anti-eviction) (sw v536)

- The app never called navigator.storage.persist(), so the cached offline-map
  tiles were "best-effort" storage the browser can evict under pressure — which on
  mobile makes downloaded areas stop loading after a while (looking like an expiry,
  though there is no time-expiry in the code). Now we request persistent storage at
  startup and when a download begins (a strong intent signal). Already-evicted
  areas need re-downloading once; persistence then protects them.

## 2026-06-25 — Detections list: left-align species name & activity (sw v535)

- The rows in the on-screen Detections list are <button>s, which default to
  centered text — so the species name and activity (sub-line) rendered centered.
  Added text-align:left to .dl-row so they're left-aligned.

## 2026-06-25 — Checklist PDF: one row per detection, with its photos (sw v534)

- The PDF report now lists ONE ROW PER DETECTION (log entry) instead of one row
  per species, with columns: Species · Date & time · Count · Activity · Longitude ·
  Latitude · Notes (sex shown beside the name). Each detection's attached photos
  appear on a full-width row directly beneath it. The same species can appear on
  several rows; rows are grouped by species name then time. Species seen without a
  logged detection still get a name-only row.
- Tidied the photo "saved" confirmation toast (the temporary diagnostic banner is
  gone) and removed the now-unused fieldSeenRows helper.

## 2026-06-25 — Fix: THE photo bug — input cleared before files were read (sw v533)

- Root cause of photos never being saved: the change handlers did
  `var files = el.files; el.value = "";`. el.files is a LIVE FileList, so clearing
  el.value (added to allow re-picking the same file) emptied it before use — zero
  files reached the storage code, so nothing was ever stored (and every later fix
  was moot). Now the files are copied to an array BEFORE clearing the input. Photos
  finally save, show in the editor/card badge, and appear in the exported PDF.

## 2026-06-25 — Fix: picked photos with empty MIME type were dropped (sw v530)

- Photos were filtered with /^image\//.test(file.type), but on iOS a picked photo
  often has an EMPTY file.type — so it was silently discarded and never stored
  (nothing appeared in the editor, card badge, or PDF, and no error showed). The
  filter now accepts files with an empty/any type (the picker is already image-only),
  and the result is reported on screen ("Saved N photo(s)" or the actual error) so
  failures are visible instead of silent.

## 2026-06-24 — Checklist PDF renders in-app (reliable photos on iOS) (sw v529)

- The checklist PDF no longer opens a new tab / blob document (where iOS Safari
  wouldn't render the photo data-URLs). The report is now shown as a full-screen
  in-app overlay — the photos render there exactly as they do in the editor — with
  a "Print / Save as PDF" button. window.print() then captures only the report via
  scoped @media print rules. This is the reliable path for photos in the PDF on
  iOS. The separate "print the open checklist table" feature is unaffected.

## 2026-06-24 — Fix: photos weren't being saved at all on iOS/Safari (sw v528)

- The image downscaler called createImageBitmap(file, {imageOrientation}) and only
  fell back to the FileReader/canvas path when createImageBitmap was *absent* — but
  Safari/iOS frequently *rejects* that options form (and HEIC inputs), so the photo
  was silently dropped and never stored, showing in neither the editor nor the PDF.
  It now falls back to the FileReader + <img> + canvas path on any failure, so
  photos are actually saved (and then render in the list and the exported PDF).

## 2026-06-24 — Checklist PDF: load the report as a real document (sw v527)

- The report tab was built with document.write(), which on some browsers won't
  render the photos at all (neither inlined data-URLs nor DOM-set src worked). The
  report is now loaded as a real HTML document via a Blob URL (a normal navigation
  that parses the inline photos like any web page) and prints itself once the
  photos have decoded. Falls back to document.write where Blob URLs aren't usable.

## 2026-06-24 — Fix: checklist PDF photos not rendering (sw v526)

- Photos were embedded by inlining each one's base64 data-URL directly into the
  report's document.write() string — several MB of base64 in one write, which some
  (mobile) browsers silently drop, so the species rows showed but the photos didn't
  appear at all. The report now writes small <img> placeholders and sets each
  photo's src via the DOM afterwards (then waits for them to load before printing),
  so the photos render reliably on screen and in the saved PDF.

## 2026-06-24 — Checklist PDF waits for photos before printing (sw v525)

- The checklist PDF already embeds each observation's photos, but it fired the
  print/Save-as-PDF dialog on a fixed 350 ms timer — on mobile that often beat the
  photo data-URLs finishing decoding, so they were missing from the saved PDF.
  writePrintWindow now waits for every embedded image to load (with a 5 s safety
  fallback) before printing, so the photos are reliably captured.

## 2026-06-24 — Checklist ＋ defaults the count to 1 (sw v524)

- Pressing ＋ on a checklist card now logs the observation with a count of 1 when
  no count has been entered (instead of an entry with no count). An explicit count
  set via the # picker is still respected.

## 2026-06-24 — Discoverable 📷 button on each checklist card (sw v523)

- The photo button is now directly on each species card (next to ＋), not only
  buried in the per-entry editor. Tapping it opens the camera/picker and attaches
  the photo(s) to that species' most recent observation (creating one, ticked
  seen, if it has none yet). A 📷N badge on the card shows the photo count.
- The per-entry 📷 button (entry editor) and inline thumbnails remain for managing
  individual observations' photos.

## 2026-06-24 — Photos on checklist observations + in the report (sw v522)

- Each observation entry in a field checklist can now hold photos: a 📷 button on
  the entry row (entry editor) opens the camera / picker, and thumbnails appear
  below the row with an × to remove each.
- Photos are downscaled (longest side ≤1600 px, JPEG) and stored in IndexedDB
  (entries keep only small id references) — field checklists live in localStorage,
  which is far too small for raw photos. Photos are device-local and are NOT part
  of the Google-Drive sync payload.
- The exported checklist report (Save as PDF) now embeds each observation's photos
  inline under its line. The print tab opens in the click gesture (so it isn't
  popup-blocked) and fills in once the photos load from IndexedDB.
- Photos are cleaned up from IndexedDB when their entry is deleted or the list is
  cleared, and carried over when entries are merged.

## 2026-06-24 — Year/life "needs" dots are never capped off the map (sw v521)

- The map draw-cap (newest detMaxPoints, default 5000) picked rows purely by
  date, so when a busy spot exceeded the cap a year/life-list "needs" species
  (the yellow-bordered ones) could be dropped from the map entirely while still
  appearing in the legend. detDrawAllowed now always keeps every "needs" species'
  rows and fills the rest of the budget with the newest of the others, so the
  yellow-bordered points always show on the map.

## 2026-06-24 — Observation fetching honours the species group (sw v520)

- Choosing a species group (All / Birds / Mammals / Amphibians / Insects) now
  actually drives the observation fetch, not just the model prediction list.
  Previously the pipeline was birds-only end-to-end (GBIF hardcoded taxonKey=212,
  and the aggregator's class filter was never even told the group, so it defaulted
  to Aves) — so the non-bird groups returned nothing.
- Per source now:
  - GBIF — class taxonKey per group (Aves 212 / Mammalia 359 / Amphibia 131 /
    Insecta 216; "All" queries the union).
  - iNaturalist — `iconic_taxa` per group (the four above; "All" = all four).
  - eBird & BirdWeather — bird-only feeds, queried only for Birds / All.
  - Artsobservasjoner / Artportalen / Laji.fi — fetch all taxa, then the
    aggregator keeps only the active group's class. (Laji only classifies birds,
    so it adds little to the non-bird groups.)
- The sightings + historic caches are now group-keyed, so switching group
  refetches that class set instead of reusing the previous group's data.

## 2026-06-24 — Fix: observation fetch broken (no detections) (sw v519)

- An incomplete `groupIsBirds()` reference (called but never defined) had slipped
  into obsSources(), throwing a ReferenceError that aborted the whole
  fetchAllSightingsAt pipeline — so Species-at-location returned no detections at
  all. Removed it (and the unrelated group-keyed cache changes) to restore the
  working fetch. The v518 pin-to-map filter is unchanged.

## 2026-06-24 — Pin-to-map respects the "days since" filter (sw v518)

- In Species-at-location, the ▾ "days since" column filter now applies to the
  📍 Map plot too. The list stays complete and filterable; clicking Map now
  transfers exactly the filtered species set — a species is plotted only when its
  most-recent observation is within the selected window (≤1d … ≤4w), using the
  same predicate as the list filter. "Off" and ">0" plot every observed species
  (unchanged). (Supersedes the v517 attempt, which filtered individual rows by a
  date field the aggregated rows don't carry, so the map came up empty.)

## 2026-06-24 — Header controls: uniform height, 20% smaller (sw v516)

- The header-row controls were two different heights — the icon buttons
  (Settings / lists / map-points / fullscreen) at 42px vs. the Mode dropdown and
  the ▾ dropdown at 36px — so the dropdown sat visibly lower. All header controls
  are now a single 34px height (~20% smaller than the old 42px buttons), and the
  button glyphs are unified to 19px so the whole row reads as one size.

## 2026-06-23 — Yellow star halo shows on the map, matching the legend (sw v515)

- The year/life "needs" yellow halo on STARRED species now renders on the map by
  drawing a larger yellow star first, then the species-coloured star centred on
  top. It is driven by the same condition as the legend swatch (detNeedWeight),
  independent of the "list edges" toggle — so a star shown yellow in the legend is
  now always yellow on the map too.

## 2026-06-23 — Legend hover: fix draw-cap hiding focused-but-unselected species (sw v514)

- eachDrawableRow (the draw-cap / allowed-set builder) now honours the hover
  focus too, so hovering an UNSELECTED species shows its dots even when a
  selection is active and the plotted total exceeds the point cap. Hover now
  reliably isolates any species, selected or not.

## 2026-06-23 — Legend hover overrides selection (sw v513)

- Hovering a legend row now isolates that species regardless of the current
  selection: while focused, only the hovered species is drawn (even if it is not
  selected), and all others are hidden. Releasing the hover restores the normal
  selection view.

## 2026-06-23 — Legend hover hides others; on-map star yellow edge (sw v512)

- Hovering a legend row now shows ONLY that species on the map (the others are
  hidden entirely, not greyed/faded).
- Starred species on a year/life "needs" list now show the yellow edge ON THE MAP
  too: a slightly larger yellow star is drawn behind the coloured star so the rim
  follows the star edges (a thin stroke barely showed). Circles unchanged.

## 2026-06-23 — Legend hover-focus: redone via render path, 5%-alpha mute (sw v511)

- The detection-legend hover-focus now works reliably: it sets a detFocusKey and
  re-renders, so the hovered species keeps its true colours and every OTHER
  species is greyed AND faded to ~5% alpha (was an in-place restyle that did not
  take). Guarded so a stale focus key cannot mute everything.

## 2026-06-23 — Detection legend: hover-to-focus + star halo follows the star (sw v510)

- Hovering a species row in the map detection legend now greys out every other
  species' plotted dots, so the hovered species stands out in its true colours
  (restored on mouse-out).
- The year/life-list yellow "needs" halo on a STARRED legend swatch now follows
  the ★ outline (yellow text-shadow) instead of a square box — matching the map.
  Circle/rare swatches keep their round halo.

## 2026-06-23 — Blogs: a few more verified-active personal blogs (sw v509)

- Added verified-active (posted 2026) personal blogs: Ireland ×2 (NI Birds, The
  Irish Bird Blog), Netherlands ×1 (Weblog Robert van der Meer), Faroe Islands ×1
  (Birding Faroes). Birding Top 1000 itself could not be mined (it is now a
  JavaScript-rendered app with no static per-country pages); seeds come from
  web search + a per-blog last-post recency check.

## 2026-06-23 — Blogs: Fatbirder country link + recency-pruned seeds (sw v508)

- The Blogs popup now ALWAYS shows a non-deletable "Birding blogs on Fatbirder"
  link for the point's country (via the Fatbirder country page), and the standalone
  Fatbirder button was removed from the map-point popup.
- Pruned the seeded personal blogs to only those with a post in the last ~year
  (verified 2026-06): dropped dormant ones (fuglekikking 2016, northernbirding
  2017, all SE seeds 2017-2021, birding-dekadent 2016, birdinginspain 2016, etc.).
  Remaining seeds: GB ×3, NO ×2, FI ×2, DE ×1, ES ×1.

## 2026-06-23 — Birding blogs: personal blogs only (sw v507)

- Reworked the Blogs seed to be PERSONAL blogs by individual birders (not official
  organisations/portals/directories). Removed all org pages (BirdLife, Club300,
  Ornitho, Netfugl, Fatbirder, Dutch Birding, etc.) and seeded verified personal
  blogs for GB/NO/SE/FI/DE/ES; other countries start empty for user curation.
  Hint text updated in all 15 languages to say "personal blogs by individual
  birders (not official organisations)".

## 2026-06-23 — Birding blogs per country (sw v506)

- New "Blogs ▸" entry in the map-point popup: opens a per-country list of top
  birding blogs & resources (reverse-geocoded from the clicked point). Users can
  open any link, add their own, and remove ones they don't want; additions/
  removals persist in localStorage (blogLinks/blogRemoved) and sync via the Drive
  payload like other settings. Ships with a curated starter set for ~13 major
  countries (a JS "spec" object, since the app has no YAML parser); every country
  is fully user-curated. Strings localized in all 15 languages.

## 2026-06-23 — External-link arrow on Fatbirder & BirdLife (sw v505)

- The Fatbirder and BirdLife buttons in the map-point popup now show the "↗"
  external-site arrow, matching Birdingplaces and the national-service links.

## 2026-06-23 — "What's new" feature list in Settings (sw v504)

- Added a "What's new" section at the bottom of the Settings panel: a dated list
  of the 10 most recent major features (not bug fixes), newest first. Heading
  localized in all 15 languages (settings.secWhatsNew); entries are a curated
  WHATS_NEW array in app.js (add new features at the top, capped at 10).

## 2026-06-23 — Map popup: birdingplaces.eu link (sw v503)

- The map-point popup gains a "Birdingplaces ↗" link under "📍 Recent" that opens
  birdingplaces.eu centred on the clicked point via its #zoom/lat/lon viewer hash.
  (link.birdingplaces added to all 15 languages; also backfilled offline.minimize/
  offline.expand into the 14 non-English languages.)

## 2026-06-22 — Offline-maps panel: minimize button (sw v502)

- Added a minimize/expand button to the Manage-offline-maps panel. Minimized, it
  collapses to a small bar at the bottom-right (hiding the hint/zoom/list) while
  keeping the coloured area outlines and their on-map × delete handles active —
  so on mobile the panel no longer covers the map and areas are managed directly
  on it. (offline.minimize/offline.expand, en + sv.)

## 2026-06-22 — Offline-maps manager: list legend + side panel (sw v501)

- Builds on the coloured area frames: the Manage-offline-maps list now shows a
  colour swatch next to each area name matching its outline on the map (same
  offlineColor index), as a legend.
- The manager is now docked as a side panel on the right (was bottom-floating),
  still non-blocking so the map stays pannable/zoomable and the on-map × delete
  handles remain reachable.

## 2026-06-22 — Documentation refresh (sw v499)

- Rewrote README.md to match the current app ("Species & Checklists"): live
  observations (eBird/GBIF/iNaturalist/Artsobservasjoner/Artportalen/Laji.fi/
  BirdWeather), field checklist + export, detections plotting, species-card links
  (incl. NBN/EuroBirdPortal), overlays, GPS follow, offline/PWA, 15 languages,
  localStorage+IndexedDB, and the real module layout. Old README omitted the
  entire live-observations half and used the old name/claims.
- Fixed the in-app Help (en): recent counts are NOT gated on the eBird key (GBIF/
  iNaturalist/BirdWeather need none) and come from ALL enabled sources, not just
  three. (Other languages mirror the en Help and still need this correction.)

## 2026-06-22 — Fix: fullscreen button now appears (moved into header) (sw v497)

- The header is built by relocating specific control groups into it; #fs-wrap
  was not in that list, so it was left behind as a stray empty white box above the
  map and the fullscreen button never showed. Now #fs-wrap is appended to the
  header next to the Points button.

## 2026-06-22 — Fullscreen toggle in the header next to Points (sw v496)

- The fullscreen toggle now sits in the header row on the right, next to the
  Points (map-pointer) button and before Settings, sized to match the other header
  icons (22px icon in a 42px button). Shown only where the Fullscreen API exists;
  icon still flips expand/collapse on fullscreenchange.

## 2026-06-22 — Fullscreen button next to the locate control (sw v495)

- Corrected v494: the fullscreen toggle is back on the map in the top-left, right
  next to the locate (crosshair) button and the same size, instead of in the page
  header.

## 2026-06-22 — Fullscreen button moved to the header (sw v494)

- The fullscreen toggle is now an icon button in the top header row (next to
  Points/Settings) instead of a control floating on the map, freeing map space.
  Shown only where the Fullscreen API is available; icon still flips between
  expand/collapse on fullscreenchange.

## 2026-06-22 — Animation no longer moves the week setting (sw v493)

- ▶ Play (migration animation) now renders each weekly frame WITHOUT changing the
  Week control in Settings, and the selected week is reliably restored (repainted)
  when playback stops. Previously the week dropdown cycled during playback and a
  restore edge-case could leave the map on the last animated frame. The persisted
  week setting was already untouched; now the visible control is too.

## 2026-06-22 — i18n: translate all UI strings (no English mixing) (sw v492)

- Filled every missing translation so no language shows English fallback text:
  the 11 recently-added keys (BirdWeather source + thresholds, NBN/EuroBirdPortal
  links, Save points, API-key states, the short data-sources note, storage-full
  message) are now translated in all 13 remaining languages (de, es, fr, nl, no,
  it, pl, cs, et, lt, fi, da, pt). Audited: all 15 languages now have every key.
- Removed the dead long "popup.keys" string (unused since the popup was slimmed).

## 2026-06-21 — Slimmer startup popup + clearer GPS toggle (sw v491)

- Startup popup trimmed to just: the header, one short line "Fetching data from
  some sources requires free keys — see Settings → Data sources", the feedback
  line + button, the Offline-mode button, and OK. Removed the long perf/keys/
  historic paragraphs and the attribution block.
- The live-GPS toggle button now shows a strong filled state (white icon on the
  brand colour) with a soft pulsing ring while tracking, clearly distinct from the
  idle button (was only a faint background tint). Respects prefers-reduced-motion.

## 2026-06-20 — Live GPS: keep the pointer >=30% in from every edge (sw v490)

- The live-locate follow now keeps the GPS pointer AT LEAST 30% in from every
  screen edge (central 40% dead-zone). When it drifts closer, the map pans the
  MINIMUM needed to push it back to the 30% margin — it no longer jumps to
  dead-centre. (Supersedes the v489 3×3 recenter.)

## 2026-06-20 — Live GPS: recenter on a 3×3 dead-zone (sw v489)

- When live locate is active, the map now follows the GPS pointer: it stays put
  while the pointer is within the central third of the screen and re-centers
  (panTo) once the pointer leaves that central cell of a 3×3 grid, so it re-enters
  the middle. The first fix still centers + populates the location modes.

## 2026-06-19 — Point lists: distance/sort from the last selected point (sw v488)

- The point-list distances and the nearest-first sort are now measured from the
  LAST point you selected on the map (a map click, a pin, or a detection dot)
  instead of the map centre. Selecting a point re-measures and re-sorts the lists.
  Falls back to the map centre until a point is selected.

## 2026-06-19 — Remove the Hide button (sw v487)

- Removed the "Hide" button from the map-points popup (it unticked all shown
  lists/trips, which surprised by clearing selections and — when the plot was
  list-sourced — hiding the "Save points" button). Cleaned up its handler and the
  unused points.hide label, and the orphaned saveCollection() (dead since the
  plain-Save removal). Use each list's checkbox to show/hide individually.

## 2026-06-19 — Map-points popup: Save points + Hide on one line (sw v486)

- "Save points" and the (renamed) "Hide" button now share one row; "Save points"
  is no longer full-width (natural width). "Hide" is the former "Clear" — it unticks
  all shown lists/trips (hides their overlays; deletes nothing).

## 2026-06-19 — Map-points popup: single "Save points" with merge/dedupe (sw v485)

- Removed the plain "Save" button from the map-points popup. The remaining save
  is renamed "Save points"; it prompts for which list to save to (an existing one
  or a new one) and, when an existing list is chosen, MERGES the plotted
  detections in and DEDUPES (same species + ~location + date is not re-added).
- Note: this also removes trip (detection-set) creation and the bulk "save loose
  pins" action; existing trips still load. Per-dot "Add to list" is unchanged.

## 2026-06-19 — Fix: adding a detection to an existing list now shows it (sw v484)

- "Add to list" (dot menu) and the bulk save-to-collection now auto-tick (show)
  the target list, so the just-added point appears immediately. Previously, if
  the list was not currently shown, the point was saved to the data but
  renderMapPoints skipped the unshown collection — so it looked like nothing
  happened.

## 2026-06-19 — Stacked dots: show the highest-priority species (sw v483)

- When several species share a map pixel, the visible (top) dot is now the
  highest-priority species by score: +2 life list, +1 year list, +1 starred,
  +1 locally rare. Ties show the alphabetically-first species. (Replaces the
  old "rarest on top, starred wins" heuristic.)

## 2026-06-19 — Acoustic/AI detections get a sound-wave ring (sw v482)

- Map dots from automated acoustic/AI sources (BirdWeather / BirdNET) now draw a
  thin dashed concentric ring in the species colour around the dot — a "sound
  wave" cue distinguishing machine-heard records from human sightings. Composes
  with the rare (black centre) and starred (★) markers; deduped per location.

## 2026-06-19 — Settings reorder (sw v481)

- Settings top order is now: Species group → Sightings radius → Base map →
  Probability range → then the rest (Week, Compare, Fetch timeout, …) in their
  previous order. Sightings radius moved up from the Fetching section.

## 2026-06-19 — BirdWeather detections popup: station in the date header (sw v480)

- In the dot-click "Detections" popup (date-grouped), BirdWeather records now
  group by STATION and show the station name + #id to the RIGHT of the date —
  the slot the observer name uses for other sources — instead of next to each
  species. Each species row keeps its "×N BirdWeather" count.

## 2026-06-19 — Clear the distribution overlay when opening "Recent" (sw v479)

- Selecting the "Recent" function now clears the Species-Range heatmap overlay
  from the map (it used to linger behind the Recent popup when invoked from the
  species menu, which does not change the mode). No-op when no overlay is shown.

## 2026-06-19 — EuroBirdPortal link goes straight to the species (sw v478)

- The species-menu EuroBirdPortal link now deep-links to that species' EBP map
  using its 6-letter code (genus[:3]+species[:3], e.g. Jynx torquilla → JYNTOR):
  https://eurobirdportal.org/embedded/ebp/en/<CODE>/traces/2000 . EBP covers
  ~105 species; an uncovered species shows the empty viewer, and a species without
  a usable binomial falls back to the general viewer.

## 2026-06-19 — BirdWeather row: station name right of the date (sw v477)

- Corrected v476: the BirdWeather row reads "{date} · {station} · ×N BirdWeather"
  — station name/#id to the RIGHT of the date.

## 2026-06-19 — BirdWeather row: station name left of the date (sw v476)

- In the Detections/"Funn" card, a BirdWeather row now reads "{station} · {date} ·
  ×N BirdWeather" — the station name/#id is to the LEFT of the date (was to its
  right), and never next to the species name.

## 2026-06-19 — BirdWeather: station ID + source link, settings in Data-sources card (sw v475)

- Plotted BirdWeather rows now read "{date} · {station name} · #{stationID} · ×N
  BirdWeather", with no sub-line under the species name, and link to that station's
  page on BirdWeather (the source data, scoped to the station). The detection
  count N is shown as "×N".
- The "min detections/day" and a new "min detection confidence" control moved out
  of global Settings into the BirdWeather entry of the **Data sources** card
  (`bwMinDet` 1–20, `bwMinConf` 0–95%). Both reset the sightings cache on change.

## 2026-06-19 — "Species at location" fills in live; pin-to-map anytime (sw v474)

- The species list now populates progressively as EACH source returns, instead of
  waiting for all of them: fetchAllSightingsAt emits a cumulative aggregation after
  every source (onPartial), and the list fills matching rows while leaving an
  hourglass on the rest. The final pass clears empties and shows per-source counts.
- The "📍 Map" button is enabled as soon as any data has arrived, and "pin to map"
  now plots the current snapshot (partial or complete) from currentSpView._result
  instead of re-fetching — so you can pin what has come in at any time.
- (Builds on the v473 cache fix; together these stop pin-to-map from restarting
  the fetch.)

## 2026-06-19 — Fix: "pin to map" no longer re-fetches (sw v473)

- "Pin to map" (and other same-location actions) reuse the cached fetch instead
  of restarting it. Root cause: the cache-eviction-on-failure (Phase 1.1) evicted
  the location cache whenever ANY source failed/timed out — common now with
  BirdWeather + a slow 90-day GBIF window — so the next action re-fetched. Now the
  cache is evicted only on a hard rejection or a NO-data failure; a partial success
  (some sources returned data) stays cached.

## 2026-06-19 — Species card: NBN Atlas + EuroBirdPortal links (sw v472)

- Added two per-species links to the species menu (Information section): **NBN
  Atlas (UK)** (per-species search) and **EuroBirdPortal** (birds only; opens the
  EU week-by-week distribution-map viewer). EuroBirdPortal has no public download
  API (verified) and only an aggregated 105-species/30 km viewer, so it is a link
  only, not a data source.

## 2026-06-19 — BirdWeather: min-detections setting + faster fetch (sw v471)

- New **Settings → "BirdWeather min detections/day"** slider (1–20, default 2): a
  species counts as "here" on a day only with at least that many *confident*
  BirdNET detections (confidence ≥ 0.5) at a station — filtering out one-off
  acoustic mis-IDs.
- Faster fetch: the BirdWeather pager is capped at 4 pages (was 8) since the data
  is collapsed to daily presence anyway; combined with the abort-aware backoff
  this keeps it inside the fetch timeout. `confidence` is now requested per
  detection and the threshold/count applied in `normBirdweather`.

## 2026-06-19 — GBIF honours the fetch timeout (abort-aware backoff) (sw v470)

- GBIF could overshoot the per-source fetch timeout by up to ~8s because the
  retry/backoff `gbifSleep` used a plain timer the abort didn't interrupt — so a
  60s budget became ~68s ("more than the allowed 60s"). `gbifSleep` is now
  abort-aware (resolves the instant the timeout / new-search abort fires), so GBIF
  stops at the budget. Note: the GBIF *recent* window still defaults to 90 days —
  lower "GBIF days" in Settings → Data sources to make recent GBIF fetches faster.

## 2026-06-19 — New source: BirdWeather (live BirdNET acoustic detections) (sw v469)

- Added **BirdWeather** as a data source (global, no API key). It queries the
  BirdWeather GraphQL API by bounding box + date window and collapses the raw
  acoustic detections to one **"present" record per species, station and day**
  (an "is here" signal) — so a station with hundreds of detections shows as one
  daily dot per species, not a swarm. Origin is labelled "BirdNET acoustic" and
  the note carries the day's detection count. Default window 7 days; routed
  through the shared `fetchRetry`. Verified against the live API + aggregation.

## 2026-06-19 — Intro popup: data-source key requirements (sw v468)

- The first-run popup now explains that eBird (global), Artportalen (Sweden) and
  Laji.fi (Finland) need a free personal API key, and that some databases don't
  allow downloading recent observations at all (Observation.org / global,
  DOFbasen / Denmark) so they can't be included. Adds a short call-to-action
  inviting users to suggest openly available databases of fresh observations
  (`popup.keys`, en + sv; other languages fall back to English).

## 2026-06-19 — Data layer + service-worker/sync resilience (Phase 4.3/4.6 + 5, sw v467)

Data layer:
- **4.3** Cross-source dedup now also catches observer-less duplicates: a GBIF
  republish that dropped the observer is matched to the native record by a
  species + location + calendar-day + count key (observer-tagged records still
  dedup precisely by observer). Verified against 6 scenarios.
- **4.6** iNaturalist search radius clamped to 200 km (iNat silently caps there),
  so its scope matches the other sources.

Service worker:
- **5.1** The app's computed range blob (shared `map-pool` cache) is excluded
  from the tile LRU cap + deletion, so tile churn can no longer evict it.
- **5.2** Dropped the racy detached LRU re-stamp on a tile hit — now plain FIFO
  (no delete→put race with concurrent requests / the trim pass).
- **5.3** Kept opaque-tile caching (every cross-origin tile is opaque; not caching
  it would break offline maps); visible CORS/same-origin errors are still not
  cached. Documented the constraint.
- **5.4** `networkFirst`/`cacheFirst` never resolve to `undefined` now: navigations
  fall back to the precached shell, other requests to a synthesized 503 — instead
  of a hard `respondWith(undefined)` error when offline + uncached.

Drive sync:
- **5.5** `findFile` excludes trashed files and binds to the NEWEST match, so two
  app-data files (created concurrently on two devices) can't ping-pong overwrites
  onto a stale copy.
- **5.6** Documented the scalar-settings merge contract (every payload carries
  `updatedAt`; missing/equal stamps → local-wins, which never clobbers the
  current device); collections still always union.

State:
- **5.7** On a total localStorage quota-trim failure, the unpersisted in-memory
  cache is dropped so readers re-parse what actually persisted instead of phantom
  data that vanishes on reload.

## 2026-06-19 — Data layer: shared retry + surfaced source failures (Phase 4.1 + 4.2, sw v466)

- **One shared `fetchRetry` helper** (the per-request timeout + 429/5xx/network
  backoff that previously lived only in `gbifPage`) now backs *every* source
  adapter — GBIF, iNaturalist, eBird, Artsobservasjoner, Artportalen, Laji.fi.
  Rate-limited APIs (eBird, Laji) are no longer aborted by a single 429.
- **Source failures are surfaced, not swallowed.** iNaturalist and
  Artsobservasjoner used to map an error to "0 results"; a first-page / probe
  failure now propagates so the source is flagged (red) in the loading line.
  This also completes the dependency for the Phase 1.1 cache-eviction fix (a
  flagged failure now evicts the location's cache so the next click retries).
- Behaviour-preserving for the happy path; `fetchRetry` control flow verified
  (OK / non-retryable 4xx / 429-then-OK / persistent 5xx / network / aborted).

## 2026-06-19 — Richness worker: skip out-of-group species (Phase 3.1, sw v465)

- The richness reduction in `inference-worker.js` precomputes the in-group
  species indices once per request, so each cell counts only those (~one
  taxonomic class) instead of walking all ~12,012 species. Much faster richness
  sweeps when a single species group is selected. Behaviour-preserving (verified
  identical counts vs the old loop across no-mask / full / random / empty masks).

## 2026-06-19 — Rendering performance (Phase 2.1 + 2.3, sw v464)

- **Repaints coalesced to one per animation frame** (`schedulePaint()`): the
  inference chunk loop and map `moveend` used to fire a full canvas redraw per
  chunk / per move; bursts now collapse to the latest frame. The guaranteed final
  paint stays synchronous so the legend still reads the completed normalisation.
- **In-view H3 cell list memoised** (`h3CellsInView`): keyed by
  (res, zoom, viewport, center), so the several calls per render reuse one result
  instead of re-sampling the screen (thousands of `latLngToCell` wasm calls each).

## 2026-06-19 — Data sources list: aligned columns + clearer key state (sw v463)

- The source list now renders the region and API-key indicators as two
  fixed-width columns so they line up vertically across rows (previously one
  variable-width `· `-joined string).
- The key column now distinguishes three states: **🔑** (key set), **🔑✗** in red
  (key required but missing), and **–** (no key needed). Each has a tooltip
  (`sources.keySet` / `sources.keyMissing` / `sources.nokey`).

## 2026-06-19 — Data sources popup: heading is the back link (sw v462)

- In the per-source **detail** view, the popup heading now reads **"‹ Data sources"**
  and is itself the link back to the source list. The separate "‹ Data sources" back
  button that used to sit *under* the "Data sources" heading is removed.

## 2026-06-18 — Robustness fixes (Phase 1, sw v461)

Correctness/resilience bugs from the speed & robustness review
(`tasks/planfile_20260618.md`, Phase 1):

- **Transient fetch failures no longer poison a location's cache.** A failed or
  timed-out observation fetch (e.g. eBird 401, GBIF timeout) used to be cached as
  that location's permanent answer until a settings change wiped the cache; the
  entry is now evicted on failure/rejection so the next click re-fetches
  (`fetchAllSightingsAt`, `fetchHistoricSightingsAt`).
- **Worker death no longer hangs the UI.** A fatal inference-worker error (e.g.
  wasm OOM) left the computing overlay spinning forever; `worker.onerror` now
  rejects all in-flight inferences so callers' spinners clear.
- **`runInference` guards a null/dead worker** — rejects cleanly instead of
  throwing inside the Promise executor where `.catch()` can't see it.
- **Drive-synced trips surface storage-full** instead of being silently dropped
  on an IndexedDB quota/abort failure (matches `persistDetSet`).
- **IndexedDB open no longer caches a rejected promise forever** — a blocked /
  private-mode first open is retried on the next `get/put/del` (`idb.js`).
