# Full review — security, robustness & roadmap — 2026-07-05

Reviewed the whole `docs/` app (currently **sw v561**) across three parallel audits —
**security**, **robustness/correctness of implemented features**, and **new
functionality**. The headline security chain and the top robustness bugs were
spot‑checked against the live code (line refs verified). Builds on the earlier
`tasks/security-audit_20260622.md` (its H1/H2/M3/L5/L6 are re‑confirmed below).

**Ground rules (per `CLAUDE.md`):** vanilla ES5‑style JS, no deps/build; every
user‑visible change bumps `VERSION` in `docs/sw.js`, updates Help/`README.md`, logs to
`CHANGES.md`, and adds a `WHATS_NEW` entry for a real feature; escape all untrusted
strings; localize new UI in all 15 languages; push to `main` to deploy.

---

## Phase 1 — Security (do first)

The app has no backend; the real threat is **client‑side stored XSS → credential
exfiltration**, and there's a concrete, verified chain.

- [x] **1.1 Stored XSS via `javascript:`/`data:` URLs in Blogs / custom country links /
  GBIF datasets** — DONE 2026-07-05 (sw v562): added `linkUrl()`/`safeHref()`, applied at
  the blog/country/GBIF/detection href sinks + all save paths; Artsobs fallback http(s)-
  guarded; BirdWeather station id encoded. *(CRITICAL — verified)*
  `escapeHtml` (`app.js:452`) escapes only `& < > "` — it does **not** neutralise a URL
  scheme. These sinks emit `<a href="'+escapeHtml(url)+'">` from user‑ or sync‑controlled
  URLs: Blogs `app.js:1327`, custom national links `app.js:~7015` + editor row `~1239`,
  GBIF dataset homepage `app.js:~2016`. The only scheme guard today is the interactive
  blog‑add path — it does **not** cover synced/imported data or the country/GBIF save
  paths. `rel="noopener"` does **not** stop `javascript:` execution on click.
  **Fix:** one helper `function safeHref(u){u=String(u||"");return /^https?:\/\//i.test(u)?u:"#";}`
  applied at every `href` sink **and** validated on save (`collectCustomUrls`,
  `addGbifDataset`, `addBlog`). Also `encodeURIComponent` the BirdWeather station id
  (`normalize.js:~192`) and route the Artsobs fallback URL (`normalize.js:104`) through it.

- [x] **1.2 `applyRemote` blind‑copies every remote scalar key into localStorage** — DONE 2026-07-05 (sw v562)
  *(HIGH — verified; the delivery vehicle for 1.1)*
  `app.js:2681‑2682` copies all keys from the remote payload (Drive sync **and** file
  import) into `geomodel-explorer-v1` with no validation — including `blogLinks`,
  `countryLinks`, `gbifDatasets`. This is what turns 1.1 into a **persistent** XSS
  (survives reloads) delivered via a shared backup or a poisoned Drive appdata file.
  **Fix:** validate on merge — run every `*Links`/dataset `url` through `safeHref` before
  persisting; prefer an allow‑list of accepted scalar keys over copying arbitrary ones.

- [x] **1.3 Add a Content‑Security‑Policy** *(HIGH — carried from prior audit H1)*
  No CSP anywhere (`index.html`, GitHub Pages sends none). A CSP neutralises *any* future
  XSS and caps exfiltration destinations — the best defence‑in‑depth even if a sink in 1.1
  is missed. **Fix:** `<meta http-equiv="Content-Security-Policy">` with a tight allowlist
  (self + the tile/API/GSI/EmailJS hosts + `'wasm-unsafe-eval'` for ORT). Enumerate
  carefully or the app breaks — test every source/overlay/sync path. Add
  `<meta name="referrer" content="strict-origin-when-cross-origin">` too (L6).

- [x] **1.4 Stop persisting the Google OAuth token in localStorage** *(HIGH — prior H2)*
  `gdrive-sync.js:~49,102` caches `gdrive-token` (+expiry) in localStorage; any XSS can
  read it. Scope is `drive.appdata` only, and `teardown()` drops it after each sync, but a
  page closed mid‑sync leaves a ~1h window. Header/`CLAUDE.md` still claim "dropped after
  each sync" — a doc/code mismatch. **Fix:** keep the token in memory only (drop the two
  `setItem`/restore lines); sync is user‑gesture‑driven so a silent re‑auth on reload is
  cheap. Reconcile the docs.

- [x] **1.5 Pin + SRI the EmailJS CDN script; `w.opener=null` on the two blank‑tab opens**
  *(MEDIUM/LOW — prior M3/L5)*
  `index.html:49` loads `@emailjs/browser@4/...` with no `integrity`/`crossorigin` and a
  floating major version — a compromised/rolled CDN build runs in‑origin. **Fix:** pin the
  exact version + `integrity=` + `crossorigin="anonymous"`. (GSI at `:45` can't take SRI —
  document it.) Also `openWikipedia`/`openBirdLife` (`app.js:~1092,~1389`) do
  `window.open("about:blank")` then set `location` without nulling `opener` → reverse
  tabnabbing; add `try{w.opener=null;}catch(e){}`.

---

## Phase 2 — Robustness of implemented features

Real bugs users can hit in normal use (most tied to the recent Blogs and species‑group
work). Verified items the auditor cleared (worker lifecycle, token guards, group
cache‑keying, pinned‑tile protection, IDB hydration) are **not** re‑listed here.

- [x] **2.1 Drive/import merge CLOBBERS `blogLinks`/`blogRemoved` instead of unioning**
  *(HIGH)* `app.js:2679‑2682` — these arrays aren't in the explicit union block, so they
  fall to scalar last‑write‑wins. Add a blog on phone A, sync after B synced → A's blog
  vanishes; deletes don't propagate. **Fix:** union both by `blogKey(cc,url)` (tombstones by
  key) and force onto `newState`, exactly like `interesting`.

- [x] **2.2 Deleting a user‑added blog doesn't stick across sync (no tombstone)** *(HIGH)*
  `removeBlog` (`app.js:~1340`) only writes a `blogRemoved` tombstone for **built‑in** blogs;
  a user‑added link is just filtered out, so a sync resurrects it. **Fix:** record
  `blogRemoved` for every delete and have `blogsFor`'s user‑link loop consult `removed[k]`
  (re‑add already clears the tombstone).

- [x] **2.3 Laji.fi returns ZERO records for every non‑bird group** *(HIGH)*
  `normalize.js:157‑158` sets `cls: isBird ? "Aves" : "Other"`; `aggregate.js:185` drops
  anything whose `cls` ≠ the wanted class, and `"Other"` never matches Mammalia/Amphibia/
  Insecta. So across Finland, mammals/herps/insects from Laji are silently dropped.
  **Fix:** derive a real class from FinBIF informal‑taxon‑group IDs (mirror the existing
  `LAJI_BIRD_GROUPS` table), or emit `cls:""` (blank is kept, name‑match decides).

- [x] **2.4 Silent data loss: map‑points / point‑sets / blogs saves ignore `lastSaveOk()`**
  *(HIGH)* The quota‑trim hook only shrinks `mapDetections`; if quota is hit otherwise, the
  write silently fails and `lastSaveOk()` is false — but only `persistDetSet` checks it.
  `saveMapPoints`/`saveShownState`/`saveDetRowsToCollection`/blog writes don't. **Fix:** after
  those `GeoState.save` calls, surface `t("err.storageFull")` (mirror `persistDetSet`);
  longer term move these bulky collections to IndexedDB like trips/detections.

- [x] **2.5 `detFocusKey` (legend hover/hold‑isolate) sticks when the legend re‑renders
  under the cursor** *(MEDIUM)* Any timer/refresh that rebuilds the legend `innerHTML`
  replaces the hovered row without firing `mouseleave`, so `unfocusDetSpecies` never runs and
  the map stays isolated (rest greyed). Same for the touch press‑hold path. **Fix:** in
  `updateDetLegend`, after computing `keys`, add
  `if (detFocusKey && keys.indexOf(detFocusKey) < 0) detFocusKey = null;`.

- [x] **2.6 Plotting a sightings result reads the LIVE `speciesGroup`** *(MEDIUM)*
  `plotSightingsResult` (`app.js:~5719`) filters by the current `speciesGroup`; if the user
  switches group before an in‑flight fetch resolves, bird data is filtered against the mammal
  class (plots nothing) or vice‑versa. **Fix:** capture the group at fetch‑start and pass it
  in (or stamp it on the result and skip on mismatch).

- [x] **2.7 `wantClass` falls back to Aves for unknown groups** *(MEDIUM)*
  `aggregate.js:171` `(GROUP_CLASS[grp] || "Aves")` → a future/stale/typo group silently shows
  birds. **Fix:** fall back to `null` (keep all, name‑match decides).

- [x] **2.8 Offline zoom‑cap upscaling keys off `navigator.onLine` only** *(MEDIUM)*
  `refreshOfflineZoomCap` (`app.js:~4561`) upscales cached tiles only when `onLine===false`;
  on a captive‑portal/dead‑but‑"online" connection, zooming past the downloaded depth shows
  blank tiles. **Fix:** also cap when inside a covering area and tile fetches are erroring
  (drive off the existing `tileerror → scheduleOfflineCheck` hook).

- [x] **2.9 GPS live‑follow survives mode switches** *(MEDIUM)* The mode‑change handler stops
  `fieldGeoWatch` but not the crosshair follow/dead‑zone auto‑pan, so it keeps recentring in
  range/richness. **Fix:** stop follow on mode change (or document it as intended); optionally
  suppress auto‑pan for a few seconds after a manual `dragstart`.

- [ ] **2.10 (LOW) Debounce `emitPartial`** — it re‑runs full `aggregateRecords` per source
  resolution (`app.js:~2215`); coalesce with rAF/short timer. **(LOW) Gate fuzzy match on
  class** when `wantClass` is set, so a blank‑class Nordic record can't be fuzzed onto a bird
  (`aggregate.js:~197`). **(LOW) Surface the trimmed count** when a Drive pull caps
  `mapDetections` (`app.js:~2726`).

---

## Phase 3 — New functionality (roadmap) — RECONSIDERED for model accuracy (2026-07-05)

**Model reality check.** The BirdNET geomodel maps `(lat, lon, week)` → a per‑species
occurrence *score*. What it is genuinely good at, and what it is NOT, must drive the
roadmap — several of the original "big bets" quietly assumed precision the model doesn't
have:

- **Trustworthy:** *broad* "what could plausibly be here this season" (range/richness maps,
  already the app's core), and the *coarse shape* of phenology (is a migrant a spring bird,
  an autumn bird, a summer breeder here?). This is a regional‑scale, season‑scale prior.
- **NOT trustworthy:** absolute probabilities as literal odds; **cross‑species** comparisons
  (systematic over/under‑prediction per species); **week‑to‑week** ranking (wk 19 vs 21 is
  inside the noise); **fine‑site** differences (the model is spatially smooth — a marsh and a
  field 2 km apart get ~the same value); abundance; this‑year conditions; and — worst of all —
  **rarities / vagrants / irruptions**, exactly the birds twitchers chase, which the model
  scores *low by construction*. Non‑bird groups (mammals/insects) are weaker still (sparser
  training).

**Design rule that follows:** prefer features grounded in **real observations** (recent
detections, hotspots, BirdWeather) — the model is best as a *soft prior layered on
sightings*, never a standalone precise predictor, and only ever at **season/region**
granularity with a "modelled likelihood" label. This reprioritises the roadmap: the
observation‑grounded and model‑independent features move up; the model‑precision features are
downgraded, reframed to coarse granularity, or parked.

### Tier A — Model‑INDEPENDENT (ship freely; no accuracy risk)
Pure ergonomics or grounded in captured/observed data. Highest value‑per‑effort.
- [ ] **3.1 Screen wake‑lock** while a checklist or live‑locate is active *(S)* — `navigator.wakeLock`
  on the `fieldGeoWatch` lifecycle; release on close/`visibilitychange`; feature‑detect.
- [ ] **3.2 Haptic (+optional tone) on record/increment** *(S)* — `navigator.vibrate(15)`; a
  double‑buzz when the logged species is a year/life **need** or **rare‑local** (both from
  real data, not the model). Android‑only; setting‑gated.
- [ ] **3.4 Share a checklist/trip as a link + QR** *(M)* — encode the trip snapshot (real
  logged points) into `?trip=…`, QR to canvas, `navigator.share({url})`.
- [ ] **3.6 Group‑appropriate checklist activity rows** for mammals/insects *(M)* — swap the 54
  bird codes for a short per‑group set when `speciesGroup !== aves`; eBird export stays bird‑only.
- [ ] **3.10 Compass + distance arrow to a dot / hotspot / target** *(M)* — bearing to a **real
  observation/hotspot** location (`deviceorientation` + `haversineKm`); distance‑only fallback;
  suppress live arrow above walking speed.
- [ ] **3.11 Track/breadcrumb recording** for eBird traveling effort *(L)* — `watchPosition` →
  polyline (IDB), distance/duration into the eBird‑CSV export. Battery‑aware, opt‑in.
- [ ] **3.12 Inline Xeno‑canto call preview** *(M)* — play the top XC recording via `new Audio()`
  from the species card. External data; attribution + offline caveat.

### Tier B — OBSERVATION‑grounded "smart" features (trustworthy — real sightings, not model precision)
These are the genuinely valuable "intelligent" features, because they run on real recent
detections, not model guesses.
- **What already exists (do NOT rebuild):** the map dots **already indicate both** rare and
  target. `detIsRare` marks a plotted species with ≤ `rarePct`% (default 5%) of the commonest
  plotted species' record count (black‑centre dot + legend ◉ Rare filter), and year/life
  **needs** already carry the yellow "needs" edges (`detNeedWeight`/`detEdgeStyle`). Two
  limits of the existing cue: it's **passive** (you must have already fetched the data and be
  looking at the map), and "rare" is **relative to what you plotted**, not absolute local
  scarcity — a rarity you haven't fetched yet isn't flagged until you pull it.
- [ ] **3.9a "Refresh detections here" — one tap at current GPS** *(S, RECOMMENDED)* — the cheap,
  defensible core: a button that re‑runs the recent‑detections fetch at the live position and
  re‑plots, so "what's here now" updates as you move **without** a background timer or
  notifications. The existing rare‑dot + needs‑edge styling then does the flagging. No
  battery/background/iOS caveats. This is the part actually worth building.
- [ ] **3.9b Proactive notification/haptic layer** *(L, OPTIONAL — smaller delta than it looks)* —
  ONLY adds attention delivery on top of 3.9a: a page‑visible timer + `Notification`/vibrate when
  a **needs** or rare‑local species appears within radius, so you learn of it without watching
  the map. NOT a new detection capability (the dots already show it). Gated behind heavy caveats:
  no true background on iOS PWAs (foreground/near‑foreground only), continuous‑GPS + polling
  battery cost, rate‑limit, banner‑only while driving. Build only if "I miss things because I
  have to keep looking/fetching" is a real pain — otherwise skip.
- [ ] **3.14 Seed a checklist from a nearby BirdWeather station** *(M)* — pull the station's
  recent detections (`fetchBirdweatherAll`) as **unchecked, "acoustic‑unconfirmed"** rows.
- [ ] **3.B1 Model × observation confidence cue** *(M, NEW)* — where a species is **both**
  reported nearby **and** modelled‑plausible here‑this‑season, show a subtle "in range" tick;
  where it's **reported but the model says very unlikely** here, show a small "unusual —
  worth a second look" hint (possible rarity *or* mis‑ID). Uses the model only as a coarse
  yes/no prior on real records — its most defensible use. Label clearly; never hide a record.

### Tier C — Model as a COARSE prior (reframed; season/region only, heavy caveats)
Kept but deliberately down‑scoped so they don't imply precision the model lacks.
- [ ] **3.3′ "In season here" indicator** (was "best week to visit") *(S/M)* — instead of a
  precise peak *week*, show a coarse phenology band for the species at the point: e.g.
  spring‑passage / summer / autumn‑passage / winter / year‑round, derived by smoothing the
  48‑week curve into seasons. Honest at the granularity the model supports; most useful for
  migrants. Label "modelled season."
- [ ] **3.5′ "Possible this season" needs summary** (was "possible this week") *(M)* — scope the
  needs‑edges to the active group and add a header count of year/life needs the model puts in
  range **this season** at map centre. Word it "in season," not "present."
- [ ] **3.13 Offline "target pack"** *(L)* — precompute + cache the area‑centre 48‑week
  prediction with the offline map download, so the "what could be here this season" list works
  with no signal. (Coarse‑prior use; fine per‑cell grids not worth the storage or the accuracy.)

### PARKED — demand precision the model doesn't have
- **3.7 "When should I go?" best‑*week* ranker** — ranking individual weeks is inside the model's
  noise. *Salvage:* only the coarse season view survives → folded into **3.3′**. Do NOT ship a
  week‑by‑week "best day/week to visit" claim.
- **3.8 Multi‑site "where's best this week" comparator** — the model is spatially smooth, so
  nearby candidate sites score ~identically; a ranking would be noise presented as signal.
  *Salvage:* comparing **distant regions** (>tens of km) or **habitat‑distinct** areas is
  marginally defensible, but the honest version is "these are all in‑range this season" — not a
  winner. Drop the fine‑site ranking.
- **Model "anomaly/out‑of‑range" flag on observed species (old 3.14 idea)** — the model's
  low‑probability output is least reliable exactly for the rare/vagrant birds this would flag;
  it would over‑flag. *Salvage:* only the gentle "unusual — second look" hint in **3.B1**, framed
  as a prompt, never an assertion.

---

## Suggested execution order

1. **Phase 1.1 + 1.2 together** — the verified stored‑XSS → token/key‑exfiltration chain.
   Smallest, highest‑value: one `safeHref` helper + validation in `applyRemote`. Ship first.
2. **1.3 CSP** (defence‑in‑depth) and **1.4** (shrink blast radius), then **1.5**.
3. **Phase 2.1–2.4** — the HIGH robustness bugs (blog sync clobber/tombstone, Laji non‑bird,
   silent quota loss) that bite in normal use. Then 2.5–2.9.
4. **Phase 3 (reconsidered):** **Tier A** model‑independent quick wins (wake‑lock, haptics,
   share/QR, compass‑to‑a‑real‑dot) + **3.9a** "refresh detections here" first — all low‑risk,
   no model‑accuracy exposure. Then **Tier B** observation‑grounded (3.14, **3.B1** the model×
   observation cue) and the reframed **Tier C** coarse‑prior features (3.3′ "in season", 3.5′).
   **3.7/3.8 stay PARKED** (they present model noise as a ranking); **3.9b** notifications only
   if the "I keep missing things" pain is real.

## Verification (no test harness in this repo)

- Serve locally (`cd docs && python -m http.server 8000`) and exercise each fixed path.
- **1.1/1.2:** import a JSON backup containing `blogLinks:[{cc:"GB",url:"javascript:alert(1)",…}]`
  → confirm the link renders as `#`/is dropped and nothing executes; re‑test the country/GBIF
  paths.
- **2.1/2.2:** two‑profile Drive sync — add/delete a blog on each, confirm union + tombstones.
- **2.3:** Finland point in Mammals mode → Laji contributes mammal records.
- **2.5:** hover a legend row, trigger a legend refresh (recency toggle) → focus clears.
- Bump `sw.js VERSION`, update `CHANGES.md`/Help, add `WHATS_NEW` entries for shipped features.

> Note: `tasks/security-audit_20260622.md` remains the deeper security write‑up; this plan
> supersedes its status (H1/H2/M3/L5/L6 still open) and adds the NEW‑1/NEW‑2 stored‑XSS chain.
