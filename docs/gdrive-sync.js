/**
 * Google Drive sync — keeps the user's data (settings, checklists, map points,
 * eBird key) in step across devices through their Drive *appdata* folder, a
 * hidden per-user area the app can read/write but the user never sees.
 *
 * This module is only the transport + auth layer. The actual snapshot building
 * and merge live in app.js and are reached through window.AppData:
 *   - AppData.buildPayload()                  → the JSON we store in Drive
 *   - AppData.applyRemote(obj, {incomingWins, interactive})  → merge a remote copy in
 * Collections (checklists/pins/lists) are always unioned; scalar settings follow
 * `incomingWins`, decided here by comparing change-stamps.
 *
 * Auth uses Google Identity Services (the browser token model): a short-lived
 * access token held only in memory — never persisted. We only request the
 * `drive.appdata` scope (no email/profile), so nothing identifies the user and
 * the OAuth verification path stays light. Because GIS ties token grants to a
 * user gesture, a token may need the user to click (Connect / Sync now); when a
 * background sync can't get one it degrades quietly to a "reconnect" state.
 *
 * Exposed as window.GDriveSync (no module system; loaded via <script>).
 */
window.GDriveSync = (function () {
  "use strict";

  // The deployer's OAuth Web client ID. Leave "" to let users paste their own
  // in Settings (the public build can hard-code one here instead). It is public
  // by design — the browser token flow uses no client secret.
  var DEFAULT_CLIENT_ID = "309967713424-o0vgr5cgb1t8bvc9pk78br2mmo4v8kkm.apps.googleusercontent.com";

  var SCOPE = "https://www.googleapis.com/auth/drive.appdata";
  var FILE_NAME = "migration_calendar.json";
  var PUSH_DEBOUNCE_MS = 4000;       // coalesce bursts of local edits into one push
  var LS_CONNECTED = "gdrive-connected";
  var LS_FILE_ID = "gdrive-file-id";
  var LS_CLIENT_ID = "gdrive-client-id";
  var LS_TOKEN = "gdrive-token";       // cached access token + expiry (appdata scope,
  var LS_TOKEN_EXP = "gdrive-token-exp"; // ~1 h) — reused across reloads so a page load
                                       // doesn't trigger a fresh OAuth request every time.

  var connected = (function () { try { return localStorage.getItem(LS_CONNECTED) === "1"; } catch (e) { return false; } })();
  var fileId = (function () { try { return localStorage.getItem(LS_FILE_ID) || ""; } catch (e) { return ""; } })();

  var tokenClient = null;
  // Restore a still-valid token so a reload reuses it (no OAuth UI) instead of
  // re-authenticating on every startup — the main cause of the OAuth flash.
  var accessToken = (function () { try { return localStorage.getItem(LS_TOKEN) || null; } catch (e) { return null; } })();
  var tokenExpiry = (function () { try { return +localStorage.getItem(LS_TOKEN_EXP) || 0; } catch (e) { return 0; } })();
  var tokenResolve = null, tokenReject = null;

  var syncing = false;               // re-entrancy guard
  var armed = false;                 // ignore GeoState writes from this session's init churn
  var localDirty = false;            // a real user change happened this session → local scalars win
  var pushTimer = null;
  var lastStatus = "idle";           // idle | syncing | error | reconnect
  var statusListeners = [];

  // ---- small helpers --------------------------------------------------------
  function clientId() {
    if (DEFAULT_CLIENT_ID) return DEFAULT_CLIENT_ID;
    try { return localStorage.getItem(LS_CLIENT_ID) || ""; } catch (e) { return ""; }
  }
  function localStateStr() { try { return localStorage.getItem("geomodel-explorer-v1") || "{}"; } catch (e) { return "{}"; } }
  function snapshot() { return { connected: connected, hasClientId: !!clientId(), status: lastStatus, busy: syncing }; }
  function emit(s) { lastStatus = s; for (var i = 0; i < statusListeners.length; i++) { try { statusListeners[i](snapshot()); } catch (e) {} } }

  // ---- Google Identity Services / token -------------------------------------
  function waitForGis() {
    return new Promise(function (resolve, reject) {
      var tries = 0;
      (function check() {
        if (window.google && google.accounts && google.accounts.oauth2) return resolve();
        if (tries++ > 100) return reject(new Error("Google library not loaded"));
        setTimeout(check, 100);
      })();
    });
  }

  function initTokenClient() {
    if (tokenClient || !clientId()) return;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId(),
      scope: SCOPE,
      callback: function (resp) {
        if (resp && resp.access_token) {
          accessToken = resp.access_token;
          tokenExpiry = Date.now() + ((+resp.expires_in || 3600) * 1000) - 60000;
          try { localStorage.setItem(LS_TOKEN, accessToken); localStorage.setItem(LS_TOKEN_EXP, String(tokenExpiry)); } catch (e) {}
          if (tokenResolve) { tokenResolve(accessToken); }
        } else if (tokenReject) { tokenReject(new Error("no access token")); }
        tokenResolve = tokenReject = null;
      },
      error_callback: function (err) {
        if (tokenReject) { tokenReject(err || new Error("auth failed")); }
        tokenResolve = tokenReject = null;
      }
    });
  }

  // Resolve with a usable access token. `interactive` (a user gesture) may show
  // the Google popup with prompt:'' — chooser/consent only as needed. Otherwise
  // use prompt:'none': Google returns a token silently if the user is already
  // signed in and has consented, or fails WITHOUT any UI — so background syncs
  // and page loads never pop the account chooser.
  function ensureToken(interactive) {
    return new Promise(function (resolve, reject) {
      if (accessToken && Date.now() < tokenExpiry) return resolve(accessToken);
      if (!tokenClient) return reject(new Error("not initialized"));
      tokenResolve = resolve; tokenReject = reject;
      try { tokenClient.requestAccessToken({ prompt: interactive ? "" : "none" }); }
      catch (e) { tokenResolve = tokenReject = null; reject(e); }
    });
  }

  // ---- Drive REST -----------------------------------------------------------
  // `interactive` flows from the call site (gesture vs background) all the way
  // down so a token request never shows UI during an automatic sync.
  async function driveFetch(url, opts, interactive) {
    var token = await ensureToken(interactive);
    opts = opts || {}; opts.headers = opts.headers || {};
    opts.headers["Authorization"] = "Bearer " + token;
    var r = await fetch(url, opts);
    if (r.status === 401) {            // token rejected → drop it and re-auth (same context)
      accessToken = null; tokenExpiry = 0;
      token = await ensureToken(interactive);
      opts.headers["Authorization"] = "Bearer " + token;
      r = await fetch(url, opts);
    }
    return r;
  }

  async function findFile(interactive) {
    var q = encodeURIComponent("name='" + FILE_NAME + "'");
    var r = await driveFetch("https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&fields=files(id,modifiedTime)&q=" + q, {}, interactive);
    if (!r.ok) throw new Error("Drive list failed (" + r.status + ")");
    var j = await r.json();
    return (j.files && j.files[0]) || null;
  }

  async function downloadFile(id, interactive) {
    var r = await driveFetch("https://www.googleapis.com/drive/v3/files/" + id + "?alt=media", {}, interactive);
    if (!r.ok) return null;
    try { return await r.json(); } catch (e) { return null; }
  }

  async function createFile(payloadStr, interactive) {
    var boundary = "migcalsyncboundary";
    var body =
      "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" +
      JSON.stringify({ name: FILE_NAME, parents: ["appDataFolder"] }) +
      "\r\n--" + boundary + "\r\nContent-Type: application/json\r\n\r\n" +
      payloadStr + "\r\n--" + boundary + "--";
    var r = await driveFetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
      method: "POST",
      headers: { "Content-Type": "multipart/related; boundary=" + boundary },
      body: body
    }, interactive);
    if (!r.ok) throw new Error("Drive create failed (" + r.status + ")");
    return await r.json();
  }

  async function updateFile(id, payloadStr, interactive) {
    var r = await driveFetch("https://www.googleapis.com/upload/drive/v3/files/" + id + "?uploadType=media&fields=id", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: payloadStr
    }, interactive);
    if (!r.ok) throw new Error("Drive update failed (" + r.status + ")");
    return await r.json();
  }

  // ---- sync orchestration ---------------------------------------------------
  async function sync(interactive) {
    if (!connected || syncing || !clientId() || !navigator.onLine) return;
    syncing = true; emit("syncing");
    try {
      var meta = await findFile(interactive);
      if (meta && meta.id !== fileId) { fileId = meta.id; try { localStorage.setItem(LS_FILE_ID, fileId); } catch (e) {} }
      var remote = meta ? await downloadFile(meta.id, interactive) : null;

      // Direction: let remote scalar settings win only when the remote copy has
      // advanced past what THIS device last saved (its load-time stamp) AND the
      // user hasn't edited anything here this session. Otherwise local wins.
      var remoteStamp = remote && remote.state ? (+remote.state.updatedAt || 0) : 0;
      var incomingWins = !!remote && remoteStamp > window.GeoState.bootUpdatedAt() && !localDirty;

      var before = localStateStr();
      if (remote) window.AppData.applyRemote(remote, { incomingWins: incomingWins, interactive: false });
      var changed = localStateStr() !== before;

      // Push when there's no remote yet, or the merged result differs from it
      // (local-only collections, or our scalars winning).
      var merged = window.AppData.buildPayload();
      var needPush = !remote ||
        JSON.stringify(merged.state) !== JSON.stringify(remote.state) ||
        (merged.ebirdKey && merged.ebirdKey !== (remote.ebirdKey || ""));
      if (needPush) {
        var str = JSON.stringify(merged);
        if (fileId) { await updateFile(fileId, str, interactive); }
        else { var created = await createFile(str, interactive); fileId = created.id; try { localStorage.setItem(LS_FILE_ID, fileId); } catch (e) {} }
      }

      localDirty = false;
      emit("idle");

      // A pull that overwrote scalar settings the UI already rendered needs a
      // reload to show them. Guarded so it can happen at most once per load
      // (after reload local == remote, so no further reload).
      if (changed && incomingWins) {
        try {
          if (!sessionStorage.getItem("gdrive-reloaded")) {
            sessionStorage.setItem("gdrive-reloaded", "1");
            location.reload();
          }
        } catch (e) {}
      }
    } catch (e) {
      emit("reconnect");
    } finally {
      syncing = false;
    }
  }

  function scheduleSync(delay) {
    if (!connected) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(function () { pushTimer = null; sync(false); }, delay == null ? PUSH_DEBOUNCE_MS : delay);
  }

  function flush() {
    if (!connected) return;
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    sync(false);
  }

  // ---- public API -----------------------------------------------------------
  return {
    // Called once by app.js at the end of init.
    init: function () {
      // A write after init armed = a genuine user change → local scalars win + push.
      window.GeoState.onChange(function () { if (armed) { localDirty = true; scheduleSync(); } });
      window.addEventListener("online", function () { scheduleSync(500); });
      document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") flush(); });

      var arm = function () { armed = true; };
      if (connected) {
        // Silent attempt on load (prompt:'none'); never pops the chooser. If a
        // token can't be obtained without UI, sync() fails quietly → "reconnect".
        // Deferred a couple of seconds so the GIS auth iframe isn't part of the
        // busy startup — on mobile Chrome it can briefly flash as a dark overlay
        // (the CSS rule for accounts.google.com iframes also keeps it invisible).
        setTimeout(function () {
          waitForGis()
            .then(function () { initTokenClient(); return sync(false); })
            .catch(function () { emit("reconnect"); })
            .then(arm, arm);
        }, 2500);
      } else {
        arm();
      }
    },

    // User pressed "Connect Google" (a gesture — required for the token popup).
    connect: function () {
      if (!clientId()) { emit("error"); return Promise.reject(new Error("no client id")); }
      return waitForGis()
        .then(function () { initTokenClient(); return ensureToken(true); })
        .then(function () {
          connected = true; try { localStorage.setItem(LS_CONNECTED, "1"); } catch (e) {}
          emit("idle");
          return sync(true);
        })
        .catch(function (e) { emit("reconnect"); throw e; });
    },

    disconnect: function () {
      try { if (accessToken && window.google && google.accounts && google.accounts.oauth2) google.accounts.oauth2.revoke(accessToken, function () {}); } catch (e) {}
      accessToken = null; tokenExpiry = 0; connected = false; fileId = "";
      try { localStorage.removeItem(LS_CONNECTED); localStorage.removeItem(LS_FILE_ID); localStorage.removeItem(LS_TOKEN); localStorage.removeItem(LS_TOKEN_EXP); } catch (e) {}
      emit("idle");
    },

    // Manual "Sync now" (a gesture, so it can acquire a token if needed).
    syncNow: function () {
      if (!connected) return Promise.resolve();
      if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
      return waitForGis().then(function () { initTokenClient(); return sync(true); });
    },

    setClientId: function (id) {
      try { localStorage.setItem(LS_CLIENT_ID, (id || "").trim()); } catch (e) {}
      tokenClient = null;   // rebuild against the new id on next use
      emit(lastStatus);
    },

    onStatus: function (cb) { if (typeof cb === "function") { statusListeners.push(cb); cb(snapshot()); } },
    getState: snapshot
  };
})();
