# Changes

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
