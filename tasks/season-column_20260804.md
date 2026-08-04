# Plan — "Season" column (now vs peak) + location prediction cache

Date: 2026-08-04

## User intent
- Add a **Season** column to the Species list (and the record tables): for each species at the
  point, classify the current week vs its yearly peak here → **arriving ↑ / at peak ● / leaving ↓ /
  off-season**, sortable, shown as a coloured bar + glyph.
- **Compute strategy (user):** the model returns the WHOLE species vector per query, so keep queried
  values in memory. Query the model at locations on a **discrete grid**; cache the full vector per
  (grid cell, week). On later fetches reuse stored values; only compute a (cell, week) that isn't
  stored yet. The current-week list query and the 48-week Season computation share this cache.

## Design
- `predCache`: `gridKey -> { week(1..48): Float32Array(nSpecies) }`. LRU-capped (≈8 cells).
  - `PRED_GRID_DEG = 0.1` (~11 km): snap lat/lon to grid centre; key = "glat,glon".
  - `predictWeek(lat,lon,week)` → cached full vector (compute+store on miss).
  - `predictAllWeeks(lat,lon)` → ensure all 48 weeks cached (ONE batched runInference for the
    missing weeks), return the cell.
- `seasonByKey` (key → {ratio, phase}) for the CURRENT point; `seasonPointKey` guards staleness.
  - `classifySeason(curve48, cw)`: peak=max, cur=curve[cw], ratio=cur/peak, slope=next-prev(circular).
    phase: ratio<0.15 → off(0); ratio≥0.8 → peak(2); slope≥0 → arriving(1); else leaving(3).
- **renderSpeciesList**: `out = await predictWeek(lat,lon,week)` (was single-week runInference).
  Add an empty Season `<td class="num sp-season" data-key>` to each row. After render + sightings,
  `fillSeasonCells(lat,lon)` runs `predictAllWeeks`, derives season per visible species, writes the
  cell HTML + `data-season` (sort key) + `seasonByKey`, then re-sorts if sorted by season and
  refreshes the record tables.
- **Table plumbing**: `<th id="sp-season-head">` after Dist / before delta head; cols map +
  sortSpeciesList "season" case (data-season) + header click → cycleSpeciesListSort("season").
  Empty `<td>` added to extras (3987) + country (15719) row templates to keep column counts aligned.
- **Record tables** (`spRecRowHtml`): a Season cell reading `seasonByKey[d.key]` (blank until filled).
- **CSS** `.season-cell/.season-bar/.season-glyph` (phase colours). **i18n** `th.season` +
  `season.arriving/peak/leaving/off` (15 langs). Bump VERSION, CHANGES/WHATS_NEW/NOTES.

## Checklist
- [ ] predCache + predictWeek/predictAllWeeks + LRU
- [ ] classifySeason + seasonByKey + fillSeasonCells
- [ ] renderSpeciesList uses predictWeek; season cell placeholder; fill after sightings
- [ ] table header + sort + click handler + extras/country empty cell
- [ ] record-table season cell
- [ ] CSS + i18n (15) + VERSION + docs
- [ ] node --check, deploy
