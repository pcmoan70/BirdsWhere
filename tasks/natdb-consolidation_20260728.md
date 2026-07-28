# National databases: consolidate all national/regional URLs + block feature — 2026-07-28

## Requirements (user)
1. Add all sites from important_bird_websites_europe.md to their countries under "National databases".
2. Add a category for "Europe & Worldwide" (the Europe-wide + global sites).
3. All these links managed from the "National databases" store (single source of truth).
4. Per-entry: keep the delete icon; ADD a block icon = keep in the list but hide from the popup.
5. "Tidy up" so ALL national/regional URLs live in the store (fold in observation.org / oiseaux / Fågelkartan that were hardcoded in the point popup).

## Design
- Replace one-url-per-country `NAT_LIST_URLS`/`NAT_LIST_KEY`/`natListUrl` (dead) with a flat
  `BUILTIN_COUNTRY_LINKS = [{cc,url,label}]` (all MD sites + SE/NO Fågelkartan + cc "EU" category).
- Stores: `countryLinks` (user adds, existing) + `natBlocked` (["CC|url"]) + `natRemoved` (tombstones so built-ins can be deleted).
- `effectiveCountryLinks()` → built-ins (minus removed) + user extras (minus removed), deduped, carrying label/builtin/blocked.
- `natServicesFor(cc)` → effective for cc, minus blocked, {label,url}; eBird region fallback.
- Settings: grouped-by-country static rows, each with [block toggle][× delete]; "+ Add" (prompt) and "Reset".
- Popups: point popup + country menu render national links from the store (non-blocked) + a
  "🌍 Europe & Worldwide" submenu from cc "EU". Remove hardcoded observation.org/oiseaux/Fågelkartan.

## Tradeoff noted to user
- The universal `<cc>.observation.org` per-country button is dropped; observation.org now appears only where the
  curated list includes it, plus the international site under Europe & Worldwide. Any country can be re-added in the store.
