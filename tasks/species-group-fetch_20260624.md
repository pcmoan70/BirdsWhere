# Species-group observation fetching — 2026-06-24

Make the observation fetch + filter honour the selected species group
(all / aves / mammalia / amphibia / insecta). Today it's birds-only end-to-end:
GBIF hardcodes taxonKey=212, aggregate defaults wantClass to "Aves" (and
getSpeciesGroup is never even injected), so non-bird groups fetch/keep nothing.

## Plan
- [x] app.js: GROUP_TAXA config + helpers (gbifTaxonParam, inatIconicTaxa, groupIsBirds)
- [x] app.js: inject getSpeciesGroup into AppAggregate.init (currently missing → always "all"→Aves)
- [x] app.js: inject gbifTaxonParam + inatIconicTaxa into AppFetch.init
- [x] app.js: obsSources skips eBird AND BirdWeather for non-bird groups (both are bird feeds)
- [x] app.js: group-key the sightings + historic caches (so switching group refetches)
- [x] fetch.js: GBIF_FILTER drops the fixed taxonKey; fetchGbifAll/gbifCount add gbifTaxonParam()
- [x] fetch.js: fetchInatAll adds &iconic_taxa=<group(s)>
- [x] aggregate.js: wantClass = null for "all" (keep every animal class), else the group's class
- [x] normalize.js: BirdWeather cls = "Aves" (it's BirdNET birds — prevents leak into non-bird groups)

## Per-source behaviour after the change
- GBIF: taxonKey per group (212/359/131/216; all = union). Quality filters unchanged.
- iNaturalist: iconic_taxa per group (Aves/Mammalia/Amphibia/Insecta; all = the four).
- eBird, BirdWeather: bird-only → queried only for Birds / All.
- Artsobs / Artportalen / Laji: no source-side taxon filter (their APIs don't expose a
  simple one), so they fetch all taxa and aggregate.js drops the off-group classes.
  Note: Laji only classifies birds (cls Aves vs "Other"), so it contributes little to
  non-bird groups — acceptable; flagged for a possible later improvement.

## Verify
- node parse check on all three files.
- Confirm getSpeciesGroup now reaches aggregate (the key bug).
