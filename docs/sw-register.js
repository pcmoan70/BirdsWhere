// Register the service worker for offline support. Split out of an inline
// <script> in index.html so the page can ship a strict Content-Security-Policy
// (script-src without 'unsafe-inline') — the main XSS defence-in-depth.
//
// The SW never skipWaiting on install (the app must stay on its local cached code
// until the user chooses to update). So when a new version has installed and is
// waiting, we show a small "Update available — Reload" banner; tapping it messages
// the waiting worker to skipWaiting, and controllerchange then reloads the page.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", function () {
    var reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (reloaded) return; reloaded = true; window.location.reload();
    });

    // Ask a specific worker over a MessageChannel (sw.js replies on the port) for its
    // VERSION and NOTES — used to show the incoming version + a short changelog in the
    // banner. Resolves to {} on any failure so the banner still shows.
    function workerInfo(worker) {
      return new Promise(function (resolve) {
        if (!worker) { resolve({}); return; }
        var ch = new MessageChannel();
        var done = false, finish = function (d) { if (done) return; done = true; resolve(d || {}); };
        ch.port1.onmessage = function (e) { finish(e.data); };
        try { worker.postMessage({ type: "getVersion" }, [ch.port2]); } catch (e) { finish({}); }
        setTimeout(function () { finish({}); }, 1500);
      });
    }

    function showUpdateBar(worker) {
      if (!worker || document.getElementById("sw-update-bar")) return;
      var bar = document.createElement("div");
      bar.id = "sw-update-bar";
      bar.style.cssText = "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:99999;" +
        "background:#0f1b24;color:#fff;padding:10px 14px;border-radius:10px;box-shadow:0 4px 18px rgba(0,0,0,.35);" +
        "font:14px/1.3 system-ui,-apple-system,sans-serif;display:flex;flex-direction:column;gap:8px;max-width:min(92vw,360px);";
      var row = document.createElement("div");
      row.style.cssText = "display:flex;gap:12px;align-items:center;";
      var msg = document.createElement("span"); msg.textContent = "New version available";
      msg.style.cssText = "flex:1 1 auto;font-weight:600;";
      var go = document.createElement("button"); go.textContent = "Reload";
      go.style.cssText = "background:#2f6f4f;color:#fff;border:none;border-radius:7px;padding:6px 14px;font:inherit;font-weight:600;cursor:pointer;flex:0 0 auto;";
      var x = document.createElement("button"); x.textContent = "×"; x.setAttribute("aria-label", "Dismiss");
      x.style.cssText = "background:transparent;color:#fff;border:none;font-size:20px;line-height:1;cursor:pointer;padding:0 2px;flex:0 0 auto;";
      go.addEventListener("click", function () { go.disabled = true; msg.dataset.updating = "1"; msg.textContent = "Updating…"; try { worker.postMessage({ type: "skipWaiting" }); } catch (e) {} });
      x.addEventListener("click", function () { if (bar.parentNode) bar.parentNode.removeChild(bar); });
      row.appendChild(msg); row.appendChild(go); row.appendChild(x);
      bar.appendChild(row);
      // A short changelog (from the waiting worker's NOTES) under the banner.
      var notes = document.createElement("div");
      notes.style.cssText = "font-size:12px;line-height:1.4;color:#c7d2d0;white-space:pre-line;display:none;max-height:38vh;overflow:auto;";
      bar.appendChild(notes);
      workerInfo(worker).then(function (d) {
        if (d && d.version && !msg.dataset.updating) msg.textContent = "New version " + d.version + " available";
        if (d && d.notes) { notes.textContent = d.notes; notes.style.display = ""; }
      });
      document.body.appendChild(bar);
    }

    // updateViaCache:"none" → the browser always fetches sw.js straight from the
    // network on an update check (never from its HTTP cache), so a new deploy is
    // noticed promptly even inside GitHub Pages' ~10-minute cache window.
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then(function (reg) {
      // Show the banner whenever a worker is sitting "waiting" (an update that has
      // installed but not taken over). Safe to call repeatedly — showUpdateBar
      // no-ops if the bar is already up.
      function maybeShow() {
        if (reg.waiting && navigator.serviceWorker.controller) showUpdateBar(reg.waiting);
      }
      maybeShow();   // an update installed on a previous visit and is already waiting
      // A new update installing now → show the banner once it reaches "installed".
      reg.addEventListener("updatefound", function () {
        var nw = reg.installing; if (!nw) return;
        nw.addEventListener("statechange", function () {
          if (nw.state === "installed" && navigator.serviceWorker.controller) showUpdateBar(nw);
        });
      });
      // Desktop browsers keep a tab open for a long time, so the automatic on-load
      // update check may never run again — the new-version banner would never appear
      // (works on mobile only because the app is reopened often). Actively re-check:
      // immediately, whenever the tab regains focus / becomes visible, and on a slow
      // interval as a backstop. Each check re-evaluates the waiting worker too, in
      // case an update landed without firing updatefound in this session.
      var checking = false;
      function checkForUpdate() {
        if (checking) return; checking = true;
        Promise.resolve(reg.update()).then(maybeShow).catch(function () {})
          .then(function () { checking = false; });
      }
      checkForUpdate();
      document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "visible") checkForUpdate();
      });
      window.addEventListener("focus", checkForUpdate);
      setInterval(checkForUpdate, 15 * 60 * 1000);   // every 15 min while the tab stays open
    }).catch(function (e) {
      console.warn("Service worker registration failed:", e);
    });
  });
}
