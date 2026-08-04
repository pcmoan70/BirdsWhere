# Plan — Move filtering & sort into the fetch (species) list; slim the detections popup

Date: 2026-08-04

## Goal (user request)
- Put the **filter controls** (day/date window, ★/◉/🟠/🟡 species-mode, 👤 observer) at the **top of the
  fetch/species list**, plus a **sort/layout control** (By date/name/2nd name/count…).
- Make the fetch list take over as much filtering/controls as possible.
- Reduce the **detections popup** to "detections at one location": **remove filtering**, keep
  **navigation, save point, and the sort ("By date", …)**.

## Current architecture (verified)
- **Global detection filters** (shared by map dots + legend + detlist), all GeoState-persisted:
  `detRecencyDays / detDateRange / detMonths` (time), `detStarFilter / detRareFilter / detYearFilter /
  detLifeFilter` (mode), `detObsFilter` (observer). Gated via `detDatePasses`, `detObsPasses`,
  `detPassesStar/Rare/Year/Life/Group`, `detIsVisible`.
- **Filter bar is portable**: `detFilterTogglesHtml()` + `detFilterPanelsHtml()` render into
  `#detlist-filters-bar` / `#detlist-filters-wrap`; `wireDetFilters(parentEl)` queries relative to the
  parent → reusable in another container.
- **Detlist opens two ways**: `openDetListModal({lat,lon,meters})` = one dot (detListNear set);
  `openDetListModal()` (☰ `det-list-btn`) = whole map (detListNear = null). Sort = `detListSort`
  (date/name/name2/count/rarity). Header actions: coords, save, nav, route.
- **Species-list own filters (separate, NOT synced to the global set):** `speciesAgeFilterDays` (n(d)
  header cycle), `spFilters{star,rare,year,life,hidden}` (5 flag-column header toggles), `spRareSet`.
  Its n(d) counts are RAW (ignore global filters). Sort = `speciesListSort` (name/sci/prob/dist/count/
  recent). Footer: checklist, PDF, CSV.

## Refinement (2026-08-04): fetch list must also show full record detail
The fetch list needs a **detailed record layout** — everything the detections popup shows (observer
names, clickable source links, counts, dates), grouped like the popup — in addition to the summarized
species views. So its layout dropdown gains **"By observation"** (the record-level detail, reusing the
detlist body renderer) alongside the summarized species sorts.

- Layout dropdown on the fetch list: **By observation** (detail records) · By probability · By name ·
  By 2nd name · By count · By most-recent · By distance (the last group = the species table, sorted).
- When "By observation" is chosen, the panel renders the detlist-style grouped record list (reuse
  `renderDetListModal`'s body via a shared `renderRecordList(container, rows, layout)`), scoped to the
  fetch point; otherwise it renders the model-prediction species table as today.
- The detlist popup keeps the same layouts (its "By date" == "By observation" detail); optionally rename
  its "By date" → "By observation" for consistency.

## Refinement (2026-08-04): date-header click → quick date filter
In the detailed record list (By observation / By date), the **date header is clickable** → a small menu
**On this date · Before this date · After this date** that sets the global `detDateRange`:
- On → `{from: date, to: date}` · Before → `{to: date}` · After → `{from: date}` (clears recency/months
  as appropriate), then refresh map + legend + list. Applies wherever the detailed list is shown (fetch
  list and the popup).

## Refinement (2026-08-04): filter by source
Add a **source filter** mirroring the observer filter: a new global `detSrcFilter` (null = all, or a Set
of source names), predicate `detPassesSrc(r)`, a panel listing the **sources present in the current
selection** (checkboxes + All/None, computed from the visible rows like `detObsPanelHtml`), and a toggle
in the filter bar. Applied in `collectVisibleDetections` + the n(d) re-derivation, on map + list.

## Refinement (2026-08-04): explanatory hover tooltips
Every active/clickable element in the lists (date header, observer name, species name, source, the
record row itself, filter toggles) should carry a short **title** tooltip saying what it does — e.g.
date → "Filter by this date", observer → "Add observer to a list", species name → "Species info &
actions", source → "Filter by source". Do this as a pass over the shared record renderer + fetch list.

## Refinement (2026-08-04): layout switches grouped↔flat; minimal new elements
- **Layout dropdown drives arrangement of the detail records**: grouped-by-date (default, "By
  observation") and grouped-by-species stay; ADD **flat** orderings — by distance, by rarity, by count,
  by name — that list records without date grouping.
- **Make as few new UI elements as possible.** Prefer contextual, in-list placement over new controls:
  filter by **date** (click the date header — done), by **source** (click the source shown on a record),
  by **observer** (click the observer) — these ARE the "column"/value filters. Only genuinely-new element
  is the layout dropdown; the filter toggle bar is a relocation, not new. Source filter therefore is
  primarily click-the-source (with the multi-select pick-list reachable the same way the observer one is).

## Target design
### A. Species/fetch list = filter + sort hub
- New **controls bar** at the top of `#species-panel` (under the coords line):
  - **Filter toggles** reused from the detlist: ⏱ day/date/months · ★◉🟠🟡 mode · 👤 observer · (× clear).
    Rendered via the existing `detFilterTogglesHtml/PanelsHtml` into new containers, wired on the panel.
    These drive the GLOBAL filters → map + legend + list all reflect them.
  - **Sort dropdown**: By probability · By name · By 2nd name · By count (n(d)) · By most-recent · By
    distance → sets `speciesListSort` (column headers stay, kept in sync).
- Species-list rows now **respect** the global filters: n(d) re-derived from each species' rows passing
  `detDatePasses`+`detObsPasses`; row visibility uses `detPasses*`+hidden. Retire the redundant
  `speciesAgeFilterDays` cycle and the 5 flag-column toggles (icons stay as status indicators).

### B. Detections popup = one-location detail only
- Keep: place title, copy-coords, Save as list, Navigate, Add to route, and the **sort select**
  (By date/species/2nd name/count/rarity) + grouped body.
- Remove: the filter toggle bar + panels, the search box, "Select N on map".
- It becomes read-only w.r.t. filters (just displays what the global filters currently allow).

## Phases
1. Generalise the filter bar + a sort control into the species-panel (new containers, wire on panel).
   Nothing removed yet — both lists temporarily host the bar.
2. Make the species-list honour the global filters (n(d) re-derivation + visibility); retire its own
   age/flag filters.
3. Slim the detlist: remove filter bar/search/select; keep sort + actions; resolve the ☰ whole-map entry.
4. i18n (sort labels), docs (README/CHANGES/What's-new/help), VERSION bump, manual test.

## Decisions — CONFIRMED (2026-08-04)
- **D1 = List respects the filters.** n(d) counts + observation-derived columns + row visibility reflect
  the global day/date/mode/observer filters (map stays in sync).
- **D2 = Keep the 5 flag columns as extra shortcuts.** They stay as list-local toggles (spFilters);
  the new top bar adds the global mode/day/observer on top. List visibility = spFilters AND global
  detPasses* (both apply). Accept the small ★◉🟠🟡 redundancy.
- **D3 = Remove the whole-map ☰ button** (`det-list-btn` → `openDetListModal()` with no arg). The popup
  is only ever per clicked dot now.
- **D4 = Sort dropdown + keep clickable column headers** (kept in sync).
- **D5 = Unify the n(d) "age" with the global day/date window.** Retire the n(d) header age cycle
  (`speciesAgeFilterDays`); the top-bar day filter is the single day control.

## (Original decision list — for reference)
- **D1** Should the fetch-list rows/counts RESPECT the moved filters (recommended), or should the
  controls only steer the MAP while the list stays raw? (Coherence vs. much less code/risk.)
- **D2** The 5 status-flag columns (★◉🟠🟡🚫) in the fetch list — drop them as filter toggles (the new
  ★◉🟠🟡 mode + hidden cover it) and keep the icons as status only? Or leave them as extra shortcuts?
- **D3** The whole-map ☰ button (all plotted detections, all points): remove it (fetch list is now the
  all-detections view) or keep it as a filter-less list?
- **D4** Sort: add a dropdown IN ADDITION to the clickable column headers, or is the dropdown enough?
- **D5** Unify the fetch list's n(d) "age" with the global day/date window (recommended) — confirm.

## Risks
- Reconciling the species-list's own filters with the global set is the riskiest part (touches
  applyAgeFilter, spRareSet, sortSpeciesList, applySightings n(d) rendering, the flag-header handlers).
- Scope mismatch: the fetch list is per-fetch-point; the whole-map detlist spans every fetched point.
  With multiple fetched points the fetch list ≠ all plotted dots (ties into D3).
