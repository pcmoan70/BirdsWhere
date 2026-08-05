# Column-header filter + sort panels (Species list + By observation)

Chosen interaction (user): **whole header opens a panel** containing BOTH filter controls AND a sort option.

## Part A — Species-list (table) headers: Species, Total, Last, Prob
- [ ] Funnel indicator on each of the 4 headers when that category's filter is active.
- [ ] Click header → open its panel inline in `#sp-filters-wrap` (between header and first rows).
- [ ] Every panel starts with a Sort row: ▲ asc / ▼ desc / ✕ off (drives `speciesListSort` + `sortSpeciesList`).
  - Species → sort col `name`; Total → `count`; Last → `last`; Prob → `prob`.
- [ ] Total panel: lower/upper numeric bounds (`spCountMin`/`spCountMax`, inclusive). Also narrows the MAP.
- [ ] Prob panel: dual-range slider (min/max %), mirrors the hidden `prob-min`/`prob-max`, re-renders list.
- [ ] Species panel: active flag-filter chips (★/◉/🟠/🟡/🚫) + selected-species list (each removable) + "clear all".
- [ ] Last panel: This date / Before / After (when opened from a date) + existing recency/range/months panel.
- [ ] Date cell click (table) opens the Last panel with the clicked date (This/Before/After).
- [ ] Country mode keeps the old header behaviour (name/prob sort, prob-agg cycle) — panels are point/historic only.

## Part B — "By observation" headers: Species, Prob, Source
- [ ] Funnel indicator on Species, Prob, Source headers when their filter is active.
- [ ] Source header → menu listing ALL present sources (active + inactive) as toggles.

## Plumbing
- `spCountMin`/`spCountMax` (min/max), `countHeadLabel`, `detPassesCount`, `applyAgeFilter` countOk, `detHasFilter`, `clearAllFilters`.
- `ico("funnel")`; active predicates; `renderSpHeads()` composes label + funnel.
- Minimal new i18n (symbols + reuse `date.on/before/after`, `menu.removeAllSp`).

## Review (v902)
- Part A done: `spHeadPanel` state + `spHeadPanelHtml`/`wireSpHeadPanel`/`openSpHeadPanel`; panels for Species
  (flag chips + selected list + clear + sort), Total (min/max bounds + sort, also narrows map via
  `spCountMin/spCountMax` → `countInBounds` in `detPassesCount`/`applyAgeFilter`), Prob (dual slider mirroring
  `prob-min`/`prob-max` + sort), Last (This/Before/After + recency/range/months + sort). Header clicks open
  panels (country keeps old sort/agg). Date-cell click opens the Last panel seeded with the date.
- Funnels via `ico("funnel")` + `renderSpHeads()` (label + funnel when `*FilterActive()`).
- Part B done: `obsHeadActive` adds funnels to By-observation name/prob/src headers; Source header opens
  `showSrcFilterList` (all present sources as on/off toggles).
- i18n: added `sort.label/asc/desc/off` × 15 langs; reused existing keys for chips/dates/clear.
- NOT browser-tested here (no browser in env) — user to verify on device.
