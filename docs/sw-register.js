// Register the service worker for offline support. Split out of an inline
// <script> in index.html so the page can ship a strict Content-Security-Policy
// (script-src without 'unsafe-inline') — the main XSS defence-in-depth.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("sw.js").catch(function (e) {
      console.warn("Service worker registration failed:", e);
    });
  });
}
