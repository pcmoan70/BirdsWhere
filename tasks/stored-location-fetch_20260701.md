# Stored locations → multi-location observation fetch — 2026-07-01

Build on the stored-locations feature (v541): give each location a radius, let the
user select which locations are active, and fetch observations from all selected
locations (each with its radius) in one action — kind to the APIs.

## Data model
Stored location: `{ name, lat, lon, radius, on, at }`
- `radius` (km) — default = recentRadiusKm() ("Sightings radius") at save time.
- `on` — selected for fetch (default true).

## Plan
- [ ] fetchAllSightingsAt(lat, lon, onPartial, radiusOverride) — optional radius; cache key already includes rkm.
- [ ] addStoredLocation(lat, lon, name, radius, on) — carry radius + on.
- [ ] registerLocationPrompt → small dialog: name + radius (default recentRadiusKm()).
- [ ] showStoredLocations panel: per-location checkbox (on/off) + name (fly) + editable radius + ×; a "select all/none"; a "Fetch observations" button.
- [ ] fetchSelectedStoredLocations(): SEQUENTIAL over selected locations — fetch each
      (its radius), plotSightingsResult (accumulates), ~500ms gap between locations,
      progress status "Fetching N/total", final fit + summary. Guard against re-entry.
- [ ] i18n (en+sv) + CSS.

## Kind to APIs
- One location at a time (await each before the next), small delay between locations.
- Reuses the existing per-source rate-limit/backoff/timeout in fetchAllSightingsAt.
- allSightingsCache means re-fetching the same location+radius is free.

## Verify
- node parse; radius default from sightings radius; sequential (not parallel) fetch.
