// Register the service worker for offline support. Split out of an inline
// <script> in index.html so the page can ship a strict Content-Security-Policy
// (script-src without 'unsafe-inline') — the main XSS defence-in-depth.
//
// The SW never skipWaiting on install (the app must stay on its local cached code
// until the user chooses to update). When a new version has installed and is
// WAITING, we do NOT pop anything up by default — instead we expose the pending
// update on `window.SWUpdate` so the app can light up a "Reload to update" button
// in Settings; the user reloads at their own will. The old auto "Update available"
// banner is opt-in (Settings → auto-show update banner; SWUpdate.bannerEnabled).
if ("serviceWorker" in navigator) {
  // Shared state for the app (Settings button reads this; app.js sets bannerEnabled
  // + onchange). apply() activates the waiting worker → controllerchange reloads.
  var SWUpdate = window.SWUpdate = {
    pending: false, version: "", notes: "", worker: null,
    bannerEnabled: false,   // app.js sets from the user setting (default: no auto banner)
    onchange: null,         // app.js hooks this to refresh the Settings update button
    showBanner: function () {},
    apply: function () { var w = SWUpdate.worker; if (w) { try { w.postMessage({ type: "skipWaiting" }); } catch (e) {} } }
  };
  window.addEventListener("load", function () {
    var reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (reloaded) return; reloaded = true; window.location.reload();
    });

    // Ask a specific worker over a MessageChannel (sw.js replies on the port) for its
    // VERSION and NOTES. Resolves to {} on any failure.
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
      go.addEventListener("click", function () { go.disabled = true; msg.dataset.updating = "1"; msg.textContent = "Updating…"; SWUpdate.apply(); });
      x.addEventListener("click", function () { if (bar.parentNode) bar.parentNode.removeChild(bar); });
      row.appendChild(msg); row.appendChild(go); row.appendChild(x);
      bar.appendChild(row);
      var notes = document.createElement("div");
      notes.style.cssText = "font-size:12px;line-height:1.4;color:#c7d2d0;white-space:pre-line;display:none;max-height:38vh;overflow:auto;";
      bar.appendChild(notes);
      workerInfo(worker).then(function (d) {
        if (d && d.version && !msg.dataset.updating) msg.textContent = "New version " + d.version + " available";
        if (d && d.notes) { notes.textContent = d.notes; notes.style.display = ""; }
      });
      document.body.appendChild(bar);
    }
    SWUpdate.showBanner = function () { if (SWUpdate.worker) showUpdateBar(SWUpdate.worker); };

    // A new version has installed and is WAITING. Record it + tell the app (so the
    // Settings "Reload to update" button activates). Only pop the banner when the
    // user has explicitly opted in — otherwise nothing intrudes; they reload at will.
    function notifyWaiting(worker) {
      if (!worker) return;
      SWUpdate.worker = worker; SWUpdate.pending = true;
      try { if (SWUpdate.onchange) SWUpdate.onchange(SWUpdate); } catch (e) {}
      workerInfo(worker).then(function (d) {
        if (d && d.version) SWUpdate.version = d.version;
        if (d && d.notes) SWUpdate.notes = d.notes;
        try { if (SWUpdate.onchange) SWUpdate.onchange(SWUpdate); } catch (e) {}
        if (SWUpdate.bannerEnabled) showUpdateBar(worker);
      });
      if (SWUpdate.bannerEnabled) showUpdateBar(worker);
    }

    // updateViaCache:"none" → the browser always fetches sw.js straight from the
    // network on an update check, so a new deploy is noticed promptly.
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then(function (reg) {
      function maybeShow() {
        if (reg.waiting && navigator.serviceWorker.controller) notifyWaiting(reg.waiting);
      }
      maybeShow();   // an update installed on a previous visit and is already waiting
      reg.addEventListener("updatefound", function () {
        var nw = reg.installing; if (!nw) return;
        nw.addEventListener("statechange", function () {
          if (nw.state === "installed" && navigator.serviceWorker.controller) notifyWaiting(nw);
        });
      });
      // Desktop tabs stay open for a long time, so re-check for updates: immediately,
      // on focus/visibility, and on a slow interval as a backstop.
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
