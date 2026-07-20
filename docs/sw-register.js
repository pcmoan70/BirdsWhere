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

    function showUpdateBar(worker) {
      if (!worker || document.getElementById("sw-update-bar")) return;
      var bar = document.createElement("div");
      bar.id = "sw-update-bar";
      bar.style.cssText = "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:99999;" +
        "background:#0f1b24;color:#fff;padding:10px 14px;border-radius:10px;box-shadow:0 4px 18px rgba(0,0,0,.35);" +
        "font:14px/1.3 system-ui,-apple-system,sans-serif;display:flex;gap:12px;align-items:center;max-width:92vw;";
      var msg = document.createElement("span"); msg.textContent = "New version available";
      var go = document.createElement("button"); go.textContent = "Reload";
      go.style.cssText = "background:#2f6f4f;color:#fff;border:none;border-radius:7px;padding:6px 14px;font:inherit;font-weight:600;cursor:pointer;";
      var x = document.createElement("button"); x.textContent = "×"; x.setAttribute("aria-label", "Dismiss");
      x.style.cssText = "background:transparent;color:#fff;border:none;font-size:20px;line-height:1;cursor:pointer;padding:0 2px;";
      go.addEventListener("click", function () { go.disabled = true; msg.textContent = "Updating…"; try { worker.postMessage({ type: "skipWaiting" }); } catch (e) {} });
      x.addEventListener("click", function () { if (bar.parentNode) bar.parentNode.removeChild(bar); });
      bar.appendChild(msg); bar.appendChild(go); bar.appendChild(x);
      document.body.appendChild(bar);
    }

    navigator.serviceWorker.register("sw.js").then(function (reg) {
      // An update already installed on a previous visit and is waiting.
      if (reg.waiting && navigator.serviceWorker.controller) showUpdateBar(reg.waiting);
      // A new update is downloading now → show the banner once it has installed.
      reg.addEventListener("updatefound", function () {
        var nw = reg.installing; if (!nw) return;
        nw.addEventListener("statechange", function () {
          if (nw.state === "installed" && navigator.serviceWorker.controller) showUpdateBar(nw);
        });
      });
    }).catch(function (e) {
      console.warn("Service worker registration failed:", e);
    });
  });
}
