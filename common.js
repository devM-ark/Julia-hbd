// Shared helpers for julia.html and index.html
(function () {
  "use strict";
  var cfg = window.APP_CONFIG || {};
  var TIMEOUT_MS = 25000;

  // ---------- PREVIEW MODE (for designing the pages) ----------
  // Add ?preview=<state> to a page's address and it runs on made-up data: no database calls,
  // nothing is saved, and no Supabase setup is needed. A "PREVIEW" tag shows in the corner.
  //   julia.html?preview=gate      Julia's countdown            (add &t=10 to watch it end in 10 seconds)
  //   julia.html?preview=after     Julia's letters, right away  (add &n=12 for 12 sample letters)
  //   index.html?preview=before    friends: countdown + write form (add &t=10 to watch it end)
  //   index.html?preview=waiting   friends: "waiting for Julia"
  //   index.html?preview=opened    friends: the read-only wall   (add &n=30 for 30 sample messages)
  // Set ALLOW_PREVIEW: false in config.js right before launch.
  var params = new URLSearchParams(location.search);
  var MODES = ["gate", "before", "after", "waiting", "opened"];
  var previewMode = cfg.ALLOW_PREVIEW === false ? "" : (MODES.indexOf(params.get("preview")) >= 0 ? params.get("preview") : "");
  var P = null;

  var SAMPLE = [
    ["Ana", "Happy birthday, Julia! Thank you for always being there. Sana masaya ang araw mo ♡"],
    ["Mark", "Hapi bertday! Libre mo ako ha 😄\nMore years, more laughs, more food."],
    ["Tita Lyn", "Maligayang kaarawan, Julia! Hindi ko makakalimutan yung mga kwentuhan natin tuwing hapon. Lagi kang mag-ingat at huwag magpapagutom. Mahal ka namin! ♡"],
    ["Bestie", "Happy birthday to my favorite person!!!\n\nEto na yung letter na pinaka-matagal kong isinulat. Thank you sa lahat ng tawanan, sa lahat ng iyakan, sa lahat ng 3am na kwentuhan, at sa lahat ng beses na ikaw ang unang nag-reply kahit kailan ako mag-chat.\n\nSana ngayong taon, lahat ng gusto mo, makuha mo. Lahat ng pagod mo, may kapalit. Lahat ng wish mo, matupad.\n\nNandito lang ako palagi. Love you, Julia! ♡♡♡"],
    ["Kuya Ben", "HBD Julia! 🎂"]
  ];
  function makeSamples(n) {
    var out = [];
    for (var i = 0; i < n; i++) {
      var s = SAMPLE[i % SAMPLE.length], round = Math.floor(i / SAMPLE.length);
      out.push({ name: s[0] + (round ? " " + (round + 1) : ""), body: s[1] });
    }
    return out;
  }
  function serverErr(code) { var e = new Error(code); e.fromServer = true; return e; }

  if (previewMode) {
    var t = parseFloat(params.get("t"));
    var future = previewMode === "gate" || previewMode === "before";
    P = {
      release: Date.now() + (future ? (t > 0 ? t * 1000 : ((3 * 24 + 4) * 3600 + 25 * 60 + 12) * 1000) : -60000),
      opened: previewMode === "opened",
      msgs: makeSamples(Math.max(1, Math.min(60, parseInt(params.get("n"), 10) || 5)))
    };
    var tag = document.createElement("div");
    tag.textContent = "PREVIEW · sample data · nothing is saved";
    tag.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:9999;padding:6px 12px;border-radius:999px;background:#68485b;color:#fff;font:600 11px/1.4 system-ui,sans-serif;letter-spacing:.5px;opacity:.85;pointer-events:none";
    document.body.appendChild(tag);
  }

  // Answers the same four calls as the database, from memory, with a short delay like the real thing.
  async function previewRpc(fn, args) {
    await sleep(350);
    var now = Date.now();
    if (fn === "get_status") return { now: new Date(now).toISOString(), release_at: new Date(P.release).toISOString(), opened: P.opened, count: P.msgs.length };
    if (fn === "add_message") {
      if (now >= P.release) throw serverErr("closed");
      var nm = String((args && args.p_name) || "").trim(), bd = String((args && args.p_body) || "").trim();
      if (!nm || nm.length > 40 || !bd || bd.length > 1500) throw serverErr("invalid");
      P.msgs.push({ name: nm, body: bd });
      return { ok: true };
    }
    if (fn === "julia_open") {
      if (now < P.release) throw serverErr("too_early");
      P.opened = true;
      return P.msgs.slice();
    }
    if (fn === "get_public_messages") return now < P.release || !P.opened ? [] : P.msgs.slice();
    throw serverErr("unknown");
  }

  function configured() {
    if (previewMode) return true;
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
    if (previewMode) return previewRpc(fn, args);
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

  window.BD = { preview: previewMode, rpc: rpc, getStatus: getStatus, msLeft: msLeft, startCountdown: startCountdown, configured: configured, sleep: sleep };
})();
