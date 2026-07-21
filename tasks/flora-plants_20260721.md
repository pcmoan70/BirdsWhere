# Including flora (plants) — plan — 2026-07-21

The Nordic DBs (Artsobservasjoner, Artportalen, Laji.fi) also carry plant records.
The BirdNET geomodel covers only animals (aves/mammalia/amphibia/insecta), so plants
can never have a habitat-model prediction, range map, richness, or arrival timing.
Goal: support plants as an **observation-only** group — fetch, map, list, filter,
save, share — while cleanly disabling the model-only features for them.

## What already works (no change needed)
- `normalize.js normClass()` already returns "Plantae" for plant records, and the
  Artsobs/Artportalen/GBIF/iNat adapters already carry `cls` + `kingdom`.
- `aggregate.js` routes every non-model species into `extras` (keyed by sci-name),
  which `plotSightingsResult` plots as `x:<sci>` detections.
- The legend, detections list, hover, map dots, and the star/rare/date-range/
  observer filters all already operate on extras. detProb = −1 for extras, so the
  legend's probability sort already falls back to the name (no crash, sane order).
- Nordic DBs fetch ALL taxa (they can't filter by taxon at source) → they already
  return plant rows; they're only dropped later by the class/group filter.

## Decisions (from user, 2026-07-21)
- A) **Dedicated groups only** — add "Plants" (and "Fungi"); keep "All groups" = the
  four animal taxa as today (no plant/fungi flood into animal views).
- B) **Plants + Fungi** in this change.
- C) **Hide** the model-only modes (Range / Richness / Migration) when a no-model
  group is selected — no greyed-out dead controls.

## What's missing / to build
1. **New "Plants" + "Fungi" groups.**
   - Add `GROUP_TAXA.plantae = { gbif: 6, inat: "Plantae" }` (GBIF kingdom key 6) and
     `GROUP_TAXA.fungi = { gbif: 5, inat: "Fungi" }`. This makes GBIF + iNat actually
     fetch them. `groupTaxaList()` returns the one when singular.
   - Add `<option value="plantae">` + `<option value="fungi">` to `#group-select`
     (+ `group.plantae`, `group.fungi` i18n ×15).
   - Group icons already exist (🌿 Plantae, 🍄 Fungi in the class-icon map).
   - eBird/BirdWeather stay excluded (already gated by `groupIsBirds()`).
   - `normClass()` already **normalises** plant classes (Magnoliopsida/Liliopsida)
     to a single "Plantae", so the existing class/group filter (`cls === "plantae"`)
     already works uniformly. Just add a **Fungi** branch to `normClass` (`^fung` /
     kingdom Fungi) so fungal records normalise to "Fungi" the same way.
2. **Gate the model-only features when the active group has no model** (plantae; a
   generic `groupHasModel()` so future kingdoms are easy):
   - Mode selector: disable/hide **Species Range** and **Species Richness** (pure
     model). Keep **Recent** (list) and **Historic** (observation search).
   - Species-list panel: hide the **Probability** + derived stat columns for plant
     rows (they come only from observed `extras`); keep name / count / date / source.
   - Migration/analysis (barchart) tab: not applicable → hide or show a one-line note.
   - Show a small hint when plants are selected: "No habitat model for plants —
     observation search only." (`group.noModelHint` ×15).
3. **Names / colours.**
   - `taxonomy.csv` is animals-only, so plants show the **source common name +
     scientific name** (no 30-language names). Acceptable; note in Help.
   - Family colouring already works from the record's `family` (GBIF/Artsobs give it).
4. **Docs:** README + in-app Help ("Species group" now includes Plants, observation-
   only), CHANGES, What's-new, bump sw VERSION.

## Open scope decisions (ask before building)
- A) **Dedicated "Plants" group only, or also fold plants into "All groups"?**
  Recommend dedicated-only: "All groups" today unions the four animal taxa for the
  GBIF/iNat fetch; adding Plantae there would multiply fetch volume and mix flora
  into animal-centric views. Dedicated keeps it opt-in and fast.
- B) **Plantae (flora) only, or also Fungi (🍄)?** User said flora → Plantae only;
  Fungi is a trivial add later (`fungi = { gbif: 5, inat: "Fungi" }`).

## Risks / notes
- Fetch volume: plant records are dense in the Nordic DBs; the existing draw cap
  (Max points on map) + date filter keep the map usable. The species list can be long.
- The `historic` GBIF search already works for any taxon once the plant taxonKey is
  in the query.
- No new source or dependency; all changes are in app.js/normalize is already done.

## Rough effort
Small-to-medium, mostly in app.js: group option + fetch taxon + feature-gating +
i18n. Pipeline/normalize already plant-aware. ~1 focused session.
