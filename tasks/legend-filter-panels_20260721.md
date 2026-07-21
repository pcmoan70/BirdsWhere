# Legend filter subwindows + per-area delete — 2026-07-21

Turn the detection-legend filter buttons into observer-style dropdown subwindows,
and make the red × delete fetched areas one at a time.

## Requests
1. All legend filters become subwindows like the observer one.
2. Days subwindow: presets 1/2/3 days, 1/2/3 weeks, 1/2/3 months, **plus a from–to
   date range** (user chose absolute date range over custom "last N").
3. Star / rare / yearlist filter subwindow: each row = symbol + explanatory text.
4. Red × : 1st click shows a red × on the NE corner of each fetched-area rectangle
   (delete that area's detections + outline); 2nd click on the legend × deletes all.
   (user chose: per-area delete removes that area's detections AND its rectangle,
   computed geometrically from the rectangle bounds — no row tagging.)

## Plan
- [x] `detDateRange()` + `detDatePasses(dateStr)`; swap all `recentEnough(r.date,maxDays)`
      call sites (5330, 5370, 6124, 6604, 6832) to `detDatePasses`. Remove dead `maxDays`.
- [x] Days subwindow `detDaysPanelHtml()` + `detDaysPanelOpen`; preset chips + range inputs.
      Preset click → save detRecencyDays, clear range. Range change → save detDateRange.
      Compact days-button label (1d/2w/3m/∞/⇆).
- [x] Mode subwindow `detModePanelHtml()` + `detModePanelOpen`; rows – / ★ / ◉ / 🟡 with text.
- [x] Panels mutually exclusive (opening one closes the others).
- [x] Per-area delete: `fetchedAreas[]` with bounds+rect; `enter/exitAreaDeleteMode`,
      `addAreaDelMarker`, `deleteFetchedArea(id)` (drop non-_list rows within bounds).
      Red × handler: enter mode if areas & not in mode, else clearDetections.
- [x] clearAllFilters + saveLegendState/loadLegend: include detDateRange; close new panels.
- [x] i18n: det.weeks, det.months, det.dateFrom, det.dateTo ×15.
- [x] CSS for .det-days-panel / .det-mode-panel / chips / .area-del-icon / armed red ×.
- [x] Bump sw VERSION, CHANGES.md, node -c, commit+push.
