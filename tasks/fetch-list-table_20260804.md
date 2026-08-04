# Plan — Consolidate fetch-list views into one sortable table + Per observation

Date: 2026-08-04

## Goal (user)
Make the fetch-list views look like the "Species list" table (multi-column, sortable/filterable).
- Merge By species/count/rarity/distance into ONE table: columns Name · 2nd name · Probability ·
  Count (n(d)) · Last date · Distance · **Season** (migration "now vs peak"), each sortable; flags
  (★◉🟠🟡) + source/date clicks are the filters.
- "Per observation" = detailed records grouped by **date → observer → location**.
- Dropdown becomes just **Species list** + **Per observation**.

## Season column (chosen: "now vs peak")
Per species at the point, from a 48-week model pass (like Migration mode): classify the current week vs
the species' yearly peak here → arriving ↑ / at peak ● / leaving ↓ / off-season. Sortable.

## Delivery
- **Deploy 1**: dropdown → {table, observation}; add **Last date** column (sortable); Per-observation
  group by date→observer→location. (No new inference.)
- **Deploy 2**: **Season** column — 48-week inference over the point, phase classification, sortable.

## Notes
- The table already has name/name2/sci/prob/n(d)/dist sortable; rarity = prob/◉ already. So merging =
  adding Last + Season columns + trimming the record-layout options.
