# Security audit & hardening plan — 2026-06-22

Scope: the whole in-browser app under `docs/`. No backend exists; the threat model
is **client-side**: XSS / DOM injection, third-party API data flowing into the DOM,
credential & OAuth-token handling, supply chain (CDN scripts), and the service worker.

## Summary

The app is in good shape on the things that usually go wrong here:

- **Output escaping is consistent.** All ~80 `innerHTML` writes and the print/PDF
  `document.write` path route untrusted strings (species names, observer names,
  observation notes, place names) through `escapeHtml()`. Spot-checked the highest-risk
  sinks (detection hover balloon `app.js:4984-5028`, recent-checklist table `2638-2643`,
  detection-row data-attrs `4647-4656`, place picker `8902-8907`) — all escaped.
- **External links can't carry a `javascript:`/`data:` scheme.** Every observation `url`
  in `normalize.js` is built as `"https://<fixed-host>/..." + id`, so the scheme is always
  ours. `openExternal()` uses `noopener`.
- No `eval`, no `new Function`, no string-`setTimeout`.

So the remaining issues are **missing defense-in-depth layers**, not active holes. None
is a confirmed live exploit today; each one is what limits the blast radius *if* a single
escaping bug ever slips in, or hardens against abuse/supply-chain.

## Findings (most important first)

### H1 — No Content-Security-Policy (highest value)
There is no CSP (`index.html` has no `<meta http-equiv="Content-Security-Policy">`, and
GitHub Pages sends no security headers). A CSP is the single biggest win: it neutralises
*any* future XSS (blocks inline/injected script execution) and limits where data can be
exfiltrated to. Cost: must enumerate a correct allowlist or the app breaks.

### H2 — Google OAuth access token persisted in localStorage (~1 h)
`gdrive-sync.js:39-50,102` caches `gdrive-token` + expiry in `localStorage` so reloads skip
the OAuth UI. localStorage is readable by any same-origin script — so any XSS (see H1) can
exfiltrate a live Drive token. Two notes:
- Blast radius is limited: scope is `drive.appdata` only (this app's own folder, not the
  user's whole Drive).
- **Doc/code mismatch:** `CLAUDE.md` and the file header say the token is "dropped after
  each sync", but the code persists it for ~1 h across reloads. Decide which is true and
  align them.

### M3 — CDN scripts: no SRI + floating version (supply-chain)
`index.html` loads EmailJS as `cdn.jsdelivr.net/npm/@emailjs/browser@4/...` — a floating
major (`@4` resolves to the latest patch) with **no `integrity=`**. A compromised/replaced
CDN artifact would run with full page privileges. (Google GSI `accounts.google.com/gsi/client`
genuinely can't take SRI — Google serves a rotating bootstrap — so that one is accept-and-document.)

### M4 — EmailJS public key + IDs in source, no abuse controls
`app.js:6842-6844` ships `EMAILJS_PUBLIC_KEY` / service / template IDs. These are *designed*
to be public for the browser SDK, so this is not a secret leak. But without EmailJS-side
domain allowlisting / quota protection, the key can be lifted and used to burn your sending
quota / send through your template. Mitigate in the EmailJS dashboard, not in code.

### L5 — Reverse tabnabbing on two link paths
`openWikipedia` (`app.js:975`) and `openBirdLife` (`1179`) do `window.open("about:blank")`
*without* `noopener`, then set `w.location.href` to the external URL. The opened page keeps a
`window.opener` handle and could redirect our tab. Targets are reputable (Wikipedia/BirdLife),
so risk is low — but it's an easy fix (null out `w.opener`).

### L6 — No `Referrer-Policy`
No referrer policy is set, so outbound API/tile requests may leak the full referrer URL.
Low impact (URL carries no secrets), but trivial to tighten.

### L7 — Service worker caches opaque cross-origin responses
`sw.js:260` caches `type === "opaque"` responses (required for offline map tiles). Over HTTPS
on GitHub Pages this is safe; noting it only for completeness — no change recommended.

## Hardening plan (staged, lowest-risk-of-breakage first)

- [ ] **Step 1 — Quick wins (no behaviour risk).**
  - [ ] Add `<meta name="referrer" content="strict-origin-when-cross-origin">` (L6).
  - [ ] Fix tabnabbing (L5): after `window.open`, set `try { w.opener = null; } catch(e){}`.
  - [ ] Pin EmailJS to an exact version and add `integrity=` + `crossorigin="anonymous"` (M3).
  - [ ] Resolve the OAuth-token doc/code mismatch (H2): either stop persisting the token
        (in-memory only) or update `CLAUDE.md` + the file header to state the ~1 h cache honestly.
  - [ ] Dashboard-only: enable EmailJS domain allowlist / rate limit (M4). No code change.

- [ ] **Step 2 — CSP in report-only mode (H1).** Add a `Content-Security-Policy-Report-Only`
      meta/header with a first-draft allowlist, ship it, exercise every feature (map tiles,
      all six observation sources, Drive sync, EmailJS, Wikipedia/Wikidata/BirdLife links,
      the inference worker + ORT wasm), and collect violations. Draft allowlist to validate:
  - `default-src 'self'`
  - `script-src 'self' https://accounts.google.com https://cdn.jsdelivr.net` (+ whatever the
    ONNX/worker bootstrap needs — verify whether `'wasm-unsafe-eval'` is required for ORT)
  - `worker-src 'self' blob:`
  - `connect-src 'self'` + every API host: eBird, GBIF, iNaturalist, Artsobservasjoner,
    Artportalen, Laji.fi, BirdWeather, Nominatim, Wikipedia/Wikidata, Google APIs (Drive),
    EmailJS, and the tile servers.
  - `img-src 'self' data: https:` (map tiles), `style-src 'self' 'unsafe-inline'` (inline
    SVG/style usage — confirm whether it can be tightened), `frame-ancestors 'none'`,
    `base-uri 'self'`, `object-src 'none'`.

- [ ] **Step 3 — Enforce CSP.** Once report-only is clean, flip to enforcing
      `Content-Security-Policy`. Re-test the full feature matrix.

- [ ] **Step 4 — Reduce the OAuth-token window (optional, after H2 decision).** If keeping
      persistence, consider shortening the cached lifetime or storing only in memory so a
      reload re-auths silently via GSI rather than reading a token off disk.

- [ ] **Step 5 — Docs + deploy.** Update `README.md` / `ARCHITECTURE.md` (security section),
      log to `CHANGES.md`, **bump `VERSION` in `docs/sw.js`**, and push to `main`.

## Notes / caveats
- GitHub Pages cannot set HTTP response headers, so CSP/Referrer-Policy must go in
  `<meta http-equiv>` tags. `frame-ancestors` and a few directives are header-only and are
  silently ignored in a meta tag — accept that limitation or front the site with a proxy/CDN
  if header-level control is ever needed.
- CSP is the one change that can break the app subtly (a missed `connect-src` host kills a
  data source). That's why it goes out report-only first. Do **not** skip Step 2.
