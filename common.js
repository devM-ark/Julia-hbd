// Shared helpers for julia.html and index.html
(function () {
  "use strict";
  var cfg = window.APP_CONFIG || {};
  var TIMEOUT_MS = 25000;

  function configured() {
    var u = String(cfg.SUPABASE_URL || "");
    var k = String(cfg.SUPABASE_KEY || "");
    return /^https?:\/\/\S+$/.test(u) && k.length > 10 && !/YOUR-/i.test(u + k);
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // One call to a database function (Supabase turns each into /rest/v1/rpc/<name>).
  // Resolves with the data. Throws Error(message): the message is the code the SQL raised
  // ("closed", "forbidden", "too_early", ...). Errors that come from the server are tagged
  // fromServer so they are not retried.
  async function once(fn, args) {
    var headers = { "Content-Type": "application/json", apikey: cfg.SUPABASE_KEY };
    // legacy "anon" keys are JWTs and also go in Authorization; new "publishable" keys must not
    if (String(cfg.SUPABASE_KEY).indexOf("eyJ") === 0) headers.Authorization = "Bearer " + cfg.SUPABASE_KEY;
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, TIMEOUT_MS);
    try {
      var res = await fetch(String(cfg.SUPABASE_URL).replace(/\/+$/, "") + "/rest/v1/rpc/" + fn, {
        method: "POST",
        headers: headers,
        body: JSON.stringify(args || {}),
        signal: ctl.signal
      });
      var data = null;
      try { data = await res.json(); } catch (e) { /* no JSON body */ }
      if (!res.ok) {
        var err = new Error((data && data.message) || "request_failed");
        err.fromServer = res.status < 500;   // 4xx = a real answer; 5xx (e.g. paused project) = try again
        err.status = res.status;
        throw err;
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  // Reads are retried once. Writes are never retried, so a message can't be saved twice.
  async function rpc(fn, args, opts) {
    if (!configured()) throw new Error("not_configured");
    var tries = opts && opts.retry === false ? 1 : 2;
    for (var i = 0; i < tries; i++) {
      try {
        return await once(fn, args);
      } catch (e) {
        if (e.fromServer) throw e;
        if (i === tries - 1) {
          console.error("Backend unreachable:", e);
          throw new Error("network");
        }
        await sleep(900);
      }
    }
  }

  // Server time is the source of truth: the offset corrects a wrong device clock.
  // The server stamped its time somewhere between our send and receive, so use the midpoint.
  async function getStatus() {
    var t0 = Date.now();
    var s = await rpc("get_status");
    var t1 = Date.now();
    return {
      releaseAt: new Date(s.release_at).getTime(),
      offset: new Date(s.now).getTime() - (t0 + t1) / 2,
      opened: !!s.opened,
      count: Number(s.count) || 0
    };
  }

  function msLeft(st) {
    return st.releaseAt - (Date.now() + st.offset);
  }

  // Renders Days/Hours/Minutes/Seconds tiles into `el`. Calls onZero once at 0. Returns a stop function.
  function startCountdown(el, st, onZero) {
    var labels = ["Days", "Hours", "Minutes", "Seconds"];
    el.innerHTML = labels.map(function (l) {
      return '<div class="cd-tile"><span class="cd-num" data-u="' + l + '">00</span><span class="cd-label">' + l + "</span></div>";
    }).join("");
    var nums = {};
    Array.prototype.forEach.call(el.querySelectorAll(".cd-num"), function (n) { nums[n.getAttribute("data-u")] = n; });

    var timer = null;
    var fired = false;
    function pad(n) { return String(n).padStart(2, "0"); }
    function stop() { if (timer) { clearInterval(timer); timer = null; } }
    function tick() {
      var ms = msLeft(st);
      if (ms <= 0) {
        stop();
        if (!fired) { fired = true; if (onZero) onZero(); }
        return;
      }
      var s = Math.floor(ms / 1000);
      nums.Days.textContent = pad(Math.floor(s / 86400));
      nums.Hours.textContent = pad(Math.floor((s % 86400) / 3600));
      nums.Minutes.textContent = pad(Math.floor((s % 3600) / 60));
      nums.Seconds.textContent = pad(s % 60);
    }
    timer = setInterval(tick, 1000);
    tick();
    return stop;
  }

  window.BD = { rpc: rpc, getStatus: getStatus, msLeft: msLeft, startCountdown: startCountdown, configured: configured, sleep: sleep };
})();
