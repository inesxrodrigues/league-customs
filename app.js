(function () {
  "use strict";

  // ===================== constants =====================
  var CFG = window.BALANCER_CONFIG || {};
  var TIERS = ["Iron", "Bronze", "Silver", "Gold", "Platinum", "Emerald", "Diamond", "Master", "Grandmaster", "Challenger"];
  var APEX = { Master: 2800, Grandmaster: 3200, Challenger: 3600 };
  var DIVS = ["IV", "III", "II", "I"];
  var ROLES = ["Top", "Jungle", "Mid", "Bot", "Support"];
  var ABBR = { Top: "TOP", Jungle: "JGL", Mid: "MID", Bot: "BOT", Support: "SUP" };
  var PEN = { secondary: 100, third: 175, fill: 200, off: 250, never: 5000 };
  var RARE_BONUS = 150; // players who rarely play ranked are likely better than their rank
  var MAIN_OPTS = ROLES.concat("Fill");
  var ALT_OPTS = ["None"].concat(ROLES, "Fill");
  var AVOID_OPTS = ["None"].concat(ROLES);
  var BRANCH = CFG.branch || "main";
  var PATH = CFG.path || "players.json";

  var EXAMPLES = [
    ["Nova", "Diamond", "IV", "Mid", "Top", "None", "None"],
    ["Brick", "Gold", "II", "Top", "Jungle", "None", "None"],
    ["Moth", "Silver", "I", "Support", "Bot", "Mid", "None"],
    ["Juno", "Platinum", "III", "Jungle", "Mid", "None", "None"],
    ["Pike", "Emerald", "II", "Bot", "Mid", "None", "None"],
    ["Wren", "Bronze", "I", "Support", "Fill", "None", "None", true],
    ["Atlas", "Gold", "IV", "Fill", "None", "None", "Jungle"],
    ["Sable", "Platinum", "I", "Top", "Support", "None", "None"],
    ["Kit", "Silver", "III", "Bot", "Support", "Mid", "Top", true],
    ["Orrin", "Emerald", "IV", "Jungle", "Top", "None", "None"]
  ];

  // ===================== storage =====================
  var LS = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { /* storage blocked */ } }
  };

  function detectRepo() {
    if (CFG.owner && CFG.repo) return { owner: CFG.owner, repo: CFG.repo, source: "config" };
    var host = location.hostname;
    if (/\.github\.io$/i.test(host)) {
      var owner = host.split(".")[0];
      var seg = location.pathname.split("/").filter(Boolean)[0];
      var repo = seg && !/\.html?$/i.test(seg) ? seg : host;
      return { owner: owner, repo: repo, source: "url" };
    }
    var saved = LS.get("cb.repo", null);
    if (saved && saved.owner && saved.repo) return { owner: saved.owner, repo: saved.repo, source: "saved" };
    return null;
  }

  var REPO = detectRepo();
  var token = LS.get("cb.token", "");

  // ===================== state =====================
  var base = {};                                            // id -> record, as in the repo
  var changes = LS.get("cb.changes", { upserts: {}, deletes: [] }); // local edits not yet saved
  if (!changes.upserts) changes.upserts = {};
  if (!Array.isArray(changes.deletes)) changes.deletes = [];
  var players = {};                                         // merged view: base + changes
  var examples = {};                                        // example players (never saved)
  var lobby = LS.get("cb.lobby", []);                       // [{id, playing}]
  var settings = LS.get("cb.settings", { useRoles: true });
  var current = LS.get("cb.split", null);
  var dbState = { kind: "loading", msg: "Loading players…" };
  var saving = false;
  var addMsg = { text: "", cls: "" };
  var copyText = null;
  var dbFilter = "";
  var dbOpen = false;

  function persist() {
    LS.set("cb.changes", changes);
    LS.set("cb.lobby", lobby);
    LS.set("cb.settings", settings);
    LS.set("cb.split", current);
  }

  function oneOf(v, list, d) { return list.indexOf(v) >= 0 ? v : d; }
  function newId() { return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function clean(r) {
    r = r || {};
    return {
      id: String(r.id || newId()).replace(/[^\w-]/g, "").slice(0, 40) || newId(),
      name: String(r.name == null ? "" : r.name).slice(0, 40),
      tier: oneOf(r.tier, TIERS, "Gold"),
      div: oneOf(r.div, DIVS, "IV"),
      primary: oneOf(r.primary, MAIN_OPTS, "Fill"),
      secondary: oneOf(r.secondary, ALT_OPTS, "None"),
      third: oneOf(r.third, ALT_OPTS, "None"),
      avoid: oneOf(r.avoid, AVOID_OPTS, "None"),
      rare: r.rare === true
    };
  }
  function toMap(data) {
    var out = {};
    var list = data && Array.isArray(data.players) ? data.players : [];
    list.forEach(function (r) { var c = clean(r); out[c.id] = c; });
    return out;
  }
  function rebuild() {
    players = {};
    Object.keys(base).forEach(function (k) { players[k] = Object.assign({}, base[k]); });
    changes.deletes.forEach(function (id) { delete players[id]; });
    Object.keys(changes.upserts).forEach(function (k) { players[k] = clean(changes.upserts[k]); });
    lobby = lobby.filter(function (e) { return players[e.id] || examples[e.id]; });
  }
  function get(id) { return players[id] || examples[id] || null; }
  function pendingCount() { return Object.keys(changes.upserts).length + changes.deletes.length; }
  function touch(p) {
    if (examples[p.id]) return;
    changes.upserts[p.id] = clean(p);
    persist();
    renderDbBar();
  }
  function findByName(name) {
    var n = name.trim().toLowerCase();
    var all = Object.keys(players).map(function (k) { return players[k]; });
    for (var i = 0; i < all.length; i++) if (all[i].name.trim().toLowerCase() === n) return all[i];
    return null;
  }
  function inLobby(id) { return lobby.some(function (e) { return e.id === id; }); }
  function playing() {
    return lobby.filter(function (e) { return e.playing && get(e.id); }).map(function (e) { return get(e.id); });
  }

  // ===================== rating =====================
  function rankRating(p) {
    if (APEX[p.tier] != null) return APEX[p.tier];
    return TIERS.indexOf(p.tier) * 400 + Math.max(0, DIVS.indexOf(p.div)) * 100;
  }
  function rating(p) { return rankRating(p) + (p.rare ? RARE_BONUS : 0); }
  function ratingText(p) { return fmt(rating(p)) + (p.rare ? " (+" + RARE_BONUS + ")" : ""); }
  function rankLabel(r) {
    if (r >= 3600) return "Challenger";
    if (r >= 3200) return "Grandmaster";
    if (r >= 2800) return "Master";
    var t = TIERS[Math.max(0, Math.floor(r / 400))];
    var d = DIVS[Math.min(3, Math.floor((r % 400) / 100))];
    return t + " " + d;
  }
  function playerRank(p) { return APEX[p.tier] != null ? p.tier : p.tier + " " + p.div; }
  function fmt(n) { return Math.round(n).toLocaleString("en-US"); }
  function fit(p, role) {
    if (p.avoid === role) return "never";
    if (p.primary === role) return "main";
    if (p.primary === "Fill") return "fill";
    if (p.secondary === role) return "secondary";
    if (p.third === role) return "third";
    if (p.secondary === "Fill" || p.third === "Fill") return "fill";
    return "off";
  }
  function eff(p, role) {
    var f = fit(p, role), r = rating(p);
    if (f === "main") return r;
    if (f === "secondary") return r - PEN.secondary;
    if (f === "third") return r - PEN.third;
    if (f === "fill") return r - (p.primary === "Fill" ? 50 : PEN.fill);
    if (f === "never") return r - PEN.never;
    return r - PEN.off;
  }
  function rolesSummary(p) {
    var parts = [p.primary];
    if (p.secondary !== "None") parts.push(p.secondary);
    if (p.third !== "None") parts.push(p.third);
    var s = playerRank(p) + " · " + parts.join(" / ");
    if (p.avoid !== "None") s += " · not " + p.avoid;
    if (p.rare) s += " · rarely ranked";
    return s;
  }

  // ===================== balancing =====================
  var PERMS = (function () {
    var out = [];
    (function go(a, rest) {
      if (!rest.length) { out.push(a); return; }
      for (var i = 0; i < rest.length; i++) go(a.concat(rest[i]), rest.slice(0, i).concat(rest.slice(i + 1)));
    })([], [0, 1, 2, 3, 4]);
    return out;
  })();

  function bestTeam(team) {
    var best = null;
    for (var k = 0; k < PERMS.length; k++) {
      var perm = PERMS[k], tot = 0;
      for (var i = 0; i < 5; i++) tot += eff(team[i], ROLES[perm[i]]);
      if (!best || tot > best.total) best = { total: tot, perm: perm };
    }
    var raw = 0;
    team.forEach(function (p) { raw += rating(p); });
    return {
      total: best.total, raw: raw,
      assign: team.map(function (p, i) { return { id: p.id, role: ROLES[best.perm[i]] }; })
    };
  }

  function balance(randomize) {
    var ps = playing();
    if (ps.length !== 10) return null;
    var useRoles = settings.useRoles;
    var out = [];
    (function choose(start, acc) {
      if (acc.length === 4) {
        var idx = [0].concat(acc);
        var A = idx.map(function (i) { return ps[i]; });
        var B = ps.filter(function (_, i) { return idx.indexOf(i) < 0; });
        var a = bestTeam(A), b = bestTeam(B);
        var score = useRoles
          ? Math.abs(a.total - b.total) + 0.5 * ((a.raw - a.total) + (b.raw - b.total))
          : Math.abs(a.raw - b.raw);
        out.push({ a: a, b: b, score: score, key: A.map(function (p) { return p.id; }).sort().join() });
        return;
      }
      for (var i = start; i < 10; i++) { acc.push(i); choose(i + 1, acc); acc.pop(); }
    })(1, []);
    out.sort(function (x, y) { return x.score - y.score; });
    var pick = out[0];
    if (randomize) {
      var curKey = current && validSplit(current) ? keyOf(current) : null;
      var pool = out.filter(function (o) { return o.score <= out[0].score + 60; }).slice(0, 20);
      var fresh = pool.filter(function (o) { return o.key !== curKey; });
      if (fresh.length) pool = fresh;
      pick = pool[Math.floor(Math.random() * pool.length)];
    }
    var blue = pick.a, red = pick.b;
    if (randomize && Math.random() < 0.5) { var t = blue; blue = red; red = t; }
    return { blue: blue.assign, red: red.assign, useRoles: useRoles };
  }
  function keyOf(split) {
    var ps = playing();
    var anchor = ps.length ? ps[0].id : null;
    var red = split.red.map(function (s) { return s.id; });
    var side = red.indexOf(anchor) >= 0 ? red : split.blue.map(function (s) { return s.id; });
    return side.slice().sort().join();
  }
  function validSplit(s) {
    if (!s || !Array.isArray(s.blue) || !Array.isArray(s.red) || s.blue.length !== 5 || s.red.length !== 5) return false;
    var ids = playing().map(function (p) { return p.id; });
    return s.blue.concat(s.red).every(function (x) { return ids.indexOf(x.id) >= 0; });
  }

  // ===================== GitHub =====================
  function b64enc(text) {
    var bytes = new TextEncoder().encode(text), bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function b64dec(b64) {
    var bin = atob(String(b64).replace(/\s/g, ""));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  function apiUrl(withRef) {
    return "https://api.github.com/repos/" + encodeURIComponent(REPO.owner) + "/" + encodeURIComponent(REPO.repo) +
      "/contents/" + PATH.split("/").map(encodeURIComponent).join("/") + (withRef ? "?ref=" + encodeURIComponent(BRANCH) : "");
  }
  function headers(json) {
    var h = { "Accept": "application/vnd.github+json" };
    if (token) h.Authorization = "Bearer " + token;
    if (json) h["Content-Type"] = "application/json";
    return h;
  }
  function httpError(r) {
    return r.json().catch(function () { return {}; }).then(function (j) {
      var e = new Error(j.message || ("HTTP " + r.status));
      e.status = r.status;
      return e;
    });
  }
  function ghGet() {
    return fetch(apiUrl(true), { headers: headers(false), cache: "no-store" }).then(function (r) {
      if (r.status === 404) return { data: { players: [] }, sha: null };
      if (!r.ok) return httpError(r).then(function (e) { throw e; });
      return r.json().then(function (j) { return { data: JSON.parse(b64dec(j.content)), sha: j.sha }; });
    });
  }
  function ghPut(text, sha, message) {
    var body = { message: message, content: b64enc(text), branch: BRANCH };
    if (sha) body.sha = sha;
    return fetch(apiUrl(false), { method: "PUT", headers: headers(true), body: JSON.stringify(body) }).then(function (r) {
      if (!r.ok) return httpError(r).then(function (e) { throw e; });
      return r.json();
    });
  }
  function serialize(map) {
    var list = Object.keys(map).map(function (k) { return clean(map[k]); });
    list.sort(function (a, b) { return a.name.localeCompare(b.name, undefined, { sensitivity: "base" }); });
    return "{\n  \"players\": [\n" + list.map(function (p) { return "    " + JSON.stringify(p); }).join(",\n") + "\n  ]\n}\n";
  }
  function commitMessage() {
    var names = Object.keys(changes.upserts).map(function (k) { return changes.upserts[k].name || "unnamed"; });
    var parts = [];
    if (names.length) parts.push("update " + names.slice(0, 3).join(", ") + (names.length > 3 ? " and " + (names.length - 3) + " more" : ""));
    if (changes.deletes.length) parts.push("remove " + changes.deletes.length + " player" + (changes.deletes.length > 1 ? "s" : ""));
    var s = parts.join("; ");
    return "Players: " + (s || "sync");
  }
  function explain(e) {
    if (e && e.status === 401) return "GitHub rejected the token. It may have expired; add a new one in GitHub settings.";
    if (e && (e.status === 403 || e.status === 404)) return token
      ? "This token can't write to " + REPO.owner + "/" + REPO.repo + ". It needs Contents: Read and write on that repo."
      : "GitHub refused the request. Add a token in GitHub settings.";
    if (e && e.status === 409) return "Someone else saved at the same moment. Try again.";
    if (e && e.status === 422) return "GitHub rejected the file. Check that the branch \"" + BRANCH + "\" exists.";
    return "Couldn't reach GitHub. Check your connection and try again.";
  }

  function load() {
    dbState = { kind: "loading", msg: "Loading players…" };
    var viaApi = REPO ? ghGet().catch(function () { return null; }) : Promise.resolve(null);
    return viaApi.then(function (res) {
      if (res) return { data: res.data, from: "github" };
      return fetch(PATH, { cache: "no-store" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { return d ? { data: d, from: "file" } : null; })
        .catch(function () { return null; });
    }).then(function (res) {
      if (res) {
        base = toMap(res.data);
        dbState = res.from === "github"
          ? { kind: "ok", msg: "Synced with " + REPO.owner + "/" + REPO.repo }
          : { kind: "local", msg: REPO ? "GitHub unreachable; showing the copy of players.json on this site" : "Read-only: repo not set" };
      } else {
        dbState = { kind: "err", msg: "Couldn't load players.json. Your local changes are still here." };
      }
      rebuild();
      renderAll();
    });
  }

  function save() {
    if (!REPO || !token) { openSettings(); return; }
    saving = true;
    renderDbBar();
    var attempt = 0;
    function tryOnce() {
      return ghGet().then(function (remote) {
        var merged = toMap(remote.data);
        changes.deletes.forEach(function (id) { delete merged[id]; });
        Object.keys(changes.upserts).forEach(function (k) { merged[k] = clean(changes.upserts[k]); });
        return ghPut(serialize(merged), remote.sha, commitMessage()).then(function () { return merged; });
      }).catch(function (e) {
        if ((e.status === 409 || e.status === 422) && attempt++ < 2) return tryOnce();
        throw e;
      });
    }
    tryOnce().then(function (merged) {
      base = merged;
      changes = { upserts: {}, deletes: [] };
      persist();
      rebuild();
      dbState = { kind: "ok", msg: "Saved to " + REPO.owner + "/" + REPO.repo };
    }, function (e) {
      dbState = { kind: "err", msg: explain(e) };
    }).then(function () {
      saving = false;
      renderAll();
    });
  }

  function exportFile() {
    var text = serialize(players);
    var url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    var a = document.createElement("a");
    a.href = url;
    a.download = "players.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  // ===================== DOM helpers =====================
  function h(tag, attrs) {
    var e = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.slice(0, 2) === "on") e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, "");
      else if (v !== false && v != null) e.setAttribute(k, v);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null || c === false) continue;
      (Array.isArray(c) ? c : [c]).forEach(function (x) {
        if (x == null || x === false) return;
        e.append(x.nodeType ? x : document.createTextNode(String(x)));
      });
    }
    return e;
  }
  function sel(id, label, opts, value, onchange) {
    var s = h("select", { id: id, "aria-label": label, onchange: function () { onchange(s.value); } },
      opts.map(function (o) { return h("option", { value: o, text: o }); }));
    s.value = value;
    return s;
  }
  var app = document.getElementById("app");

  // ===================== header / database bar =====================
  function renderDbBar() {
    var box = document.getElementById("dbbar");
    if (!box) return;
    box.innerHTML = "";
    var n = pendingCount();
    var stateText, cls = "dbstate";
    if (saving) stateText = "Saving to GitHub…";
    else if (dbState.kind === "err") { stateText = dbState.msg; cls += " err"; }
    else if (n) { stateText = n + " unsaved change" + (n > 1 ? "s" : "") + " in this browser"; cls += " dirty"; }
    else { stateText = dbState.msg; if (dbState.kind === "ok") cls += " ok"; }
    var count = Object.keys(players).length;
    box.append(
      h("div", { class: "line" },
        h("span", { class: "muted", text: "Player database: " + count + " player" + (count === 1 ? "" : "s") })),
      h("div", { class: "line" }, h("span", { class: cls, role: "status", text: stateText })),
      h("div", { class: "line" },
        n ? h("button", { class: "ghost small", onclick: discard }, "Discard changes") : null,
        h("button", { class: "ghost small", onclick: exportFile, title: "Download players.json with your changes" }, "Download"),
        h("button", { class: "small", onclick: openSettings }, token ? "GitHub settings" : "Connect GitHub"),
        h("button", { class: "primary small", id: "save", disabled: !n || saving, onclick: save }, "Save to GitHub"))
    );
  }
  function discard() {
    changes = { upserts: {}, deletes: [] };
    persist();
    rebuild();
    renderAll();
  }

  function header() {
    return h("header", { class: "top" },
      h("div", { class: "intro" },
        h("span", { class: "eyebrow", text: "5v5 customs night" }),
        h("h1", { text: "Customs Balancer" }),
        h("p", { text: "Add tonight's ten by name. Known players load their saved rank and roles from the database, and playing off-role costs rating, so the balancer prefers putting people on their mains." })
      ),
      h("div", { class: "dbbar", id: "dbbar" })
    );
  }

  // ===================== lobby =====================
  function lobbyRow(entry) {
    var p = get(entry.id);
    var ratingEl = h("span", { class: "rating num", text: ratingText(p) });
    var rareBtn = h("button", { type: "button", class: "raretoggle", id: "p-" + p.id + "-rare", "aria-pressed": p.rare ? "true" : "false",
      title: "Turn on for players who rarely play ranked: their rank probably undersells them, so they count " + RARE_BONUS + " higher.",
      onclick: function () {
        p.rare = !p.rare;
        rareBtn.setAttribute("aria-pressed", p.rare ? "true" : "false");
        rareBtn.textContent = p.rare ? "Rarely plays" : "Plays often";
        changed();
      } }, p.rare ? "Rarely plays" : "Plays often");
    var divSel = sel("p-" + p.id + "-div", "Division", DIVS, p.div, function (v) { p.div = v; changed(); });
    divSel.disabled = APEX[p.tier] != null;
    divSel.classList.add("div");
    var tierSel = sel("p-" + p.id + "-tier", "Tier", TIERS, p.tier, function (v) { p.tier = v; divSel.disabled = APEX[v] != null; changed(); });
    tierSel.classList.add("tier");
    var unsavedChip = h("span", { class: "chip unsaved", text: "unsaved" });
    unsavedChip.hidden = !changes.upserts[p.id];
    function changed() {
      ratingEl.textContent = ratingText(p);
      touch(p);
      unsavedChip.hidden = !changes.upserts[p.id];
      renderTeams();
    }
    function roleField(cls, label, key, opts) {
      return h("label", { class: cls, for: "p-" + p.id + "-" + key }, label,
        sel("p-" + p.id + "-" + key, label, opts, p[key], function (v) { p[key] = v; changed(); }));
    }
    var row = h("div", { class: "prow" + (entry.playing ? "" : " off") },
      h("input", { type: "checkbox", id: "p-" + p.id + "-on", "aria-label": "Playing tonight", checked: !!entry.playing,
        onchange: function (e) { entry.playing = e.target.checked; row.classList.toggle("off", !entry.playing); persist(); renderLobbyCount(); renderTeams(); } }),
      h("div", { class: "namecell" },
        h("input", { type: "text", id: "p-" + p.id + "-name", "aria-label": "Name", value: p.name, maxlength: "40", spellcheck: "false",
          oninput: function (e) { p.name = e.target.value; touch(p); unsavedChip.hidden = examples[p.id] ? true : false; },
          onchange: function () { renderTeams(); renderDbPanel(); renderNameList(); } }),
        examples[p.id] ? h("span", { class: "chip ex", text: "example" }) : unsavedChip
      ),
      tierSel,
      divSel,
      ratingEl,
      h("button", { class: "icon rm", "aria-label": "Remove " + p.name + " from the lobby", title: "Remove from lobby (stays in the database)",
        onclick: function () { lobby = lobby.filter(function (e) { return e !== entry; }); persist(); renderAll(); } }, "×"),
      h("div", { class: "roles" },
        roleField("", "Main", "primary", MAIN_OPTS),
        roleField("", "2nd role", "secondary", ALT_OPTS),
        roleField("", "3rd role", "third", ALT_OPTS),
        roleField("avoid", "Won't play", "avoid", AVOID_OPTS),
        h("label", { class: "rare", for: "p-" + p.id + "-rare" }, "Ranked games", rareBtn))
    );
    return row;
  }

  function renderLobbyCount() {
    var el = document.getElementById("lobbycount");
    if (el) el.textContent = lobby.length + " in lobby · " + playing().length + " playing";
  }
  function renderNameList() {
    var dl = document.getElementById("db-names");
    if (!dl) return;
    dl.innerHTML = "";
    Object.keys(players).map(function (k) { return players[k]; })
      .filter(function (p) { return !inLobby(p.id) && p.name.trim(); })
      .sort(function (a, b) { return a.name.localeCompare(b.name); })
      .forEach(function (p) { dl.append(h("option", { value: p.name })); });
  }

  function addToLobby(id) {
    if (!inLobby(id)) lobby.push({ id: id, playing: playing().length < 10 });
    persist();
  }
  function addByName(name) {
    name = name.trim();
    if (!name) return false;
    var hit = findByName(name);
    if (hit) {
      if (inLobby(hit.id)) { addMsg = { text: hit.name + " is already in the lobby.", cls: "" }; return true; }
      addToLobby(hit.id);
      addMsg = { text: "Loaded " + hit.name + " from the database: " + rolesSummary(hit) + ".", cls: "" };
    } else {
      var p = clean({ name: name });
      players[p.id] = p;
      changes.upserts[p.id] = clean(p);
      addToLobby(p.id);
      addMsg = { text: name + " is new. Set their rank and roles, then save to GitHub so everyone has them.", cls: "new" };
    }
    return true;
  }

  function lobbySection() {
    var hasEx = lobby.some(function (e) { return examples[e.id]; });
    var nameIn = h("input", { type: "text", id: "add-name", placeholder: "Type a name, e.g. Nova#EUW", "aria-label": "Player name", maxlength: "40", list: "db-names", autocomplete: "off", spellcheck: "false" });
    function add() {
      if (!nameIn.value.trim()) { nameIn.focus(); return; }
      addByName(nameIn.value);
      renderAll();
      var n = document.getElementById("add-name"); if (n) n.focus();
    }
    nameIn.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); add(); } });

    return h("section", { class: "card", "aria-labelledby": "lobby-h" },
      h("div", { class: "sechead" }, h("h2", { id: "lobby-h", text: "Lobby" }), h("span", { class: "muted num", id: "lobbycount" })),
      h("div", { class: "addrow" }, nameIn, h("datalist", { id: "db-names" }), h("button", { onclick: add }, "Add player")),
      h("p", { class: "addmsg " + addMsg.cls, role: "status", text: addMsg.text }),
      hasEx ? h("div", { class: "banner" },
        h("p", { text: "The example players are only here to show how it works. They are never saved." }),
        h("button", { class: "ghost", onclick: function () {
          lobby = lobby.filter(function (e) { return !examples[e.id]; });
          examples = {}; current = null; persist(); renderAll();
        } }, "Clear examples")) : null,
      lobby.length
        ? h("div", { class: "plist" }, lobby.map(lobbyRow))
        : h("div", { class: "banner" },
            h("p", { text: "The lobby is empty. Add players by name above, or load ten example players to try it out." }),
            h("button", { class: "ghost", onclick: loadExamples }, "Load examples")),
      lobby.length ? h("div", { class: "addrow" },
        h("button", { class: "ghost small", onclick: function () { lobby = []; examples = {}; current = null; persist(); renderAll(); } }, "Clear lobby")) : null,
      dbPanel(),
      h("p", { class: "note", text: "Rating: each division is worth 100 (Iron IV = 0, Gold IV = 1,200, Diamond I = 2,700; Master 2,800, Grandmaster 3,200, Challenger 3,600). Second role costs 100, third role 175, fill 200, any other lane 250. A “won't play” lane is never assigned unless there is no other way to fill both teams. Players who rarely play ranked count " + RARE_BONUS + " higher, because their rank probably undersells them." })
    );
  }

  function makeExamples() {
    examples = {};
    EXAMPLES.forEach(function (x, i) {
      var p = clean({ id: "ex" + (i + 1), name: "Example: " + x[0], tier: x[1], div: x[2], primary: x[3], secondary: x[4], third: x[5], avoid: x[6], rare: x[7] === true });
      examples[p.id] = p;
    });
  }
  function loadExamples() {
    makeExamples();
    lobby = lobby.concat(Object.keys(examples).filter(function (id) { return !inLobby(id); }).map(function (id) { return { id: id, playing: true }; }));
    current = null;
    persist();
    renderAll();
  }

  // ===================== database panel =====================
  function dbPanel() {
    var d = h("details", { class: "dbpanel", id: "dbpanel" },
      h("summary", { id: "dbsummary" }),
      h("div", { class: "dbtools" },
        h("input", { type: "search", id: "db-filter", placeholder: "Search the database", "aria-label": "Search the database", value: dbFilter,
          oninput: function (e) { dbFilter = e.target.value; renderDbPanel(); } })),
      h("div", { class: "dblist", id: "dblist" }));
    d.open = dbOpen;
    d.addEventListener("toggle", function () { dbOpen = d.open; });
    return d;
  }
  function renderDbPanel() {
    var list = document.getElementById("dblist");
    var sum = document.getElementById("dbsummary");
    if (!list || !sum) return;
    var all = Object.keys(players).map(function (k) { return players[k]; })
      .sort(function (a, b) { return a.name.localeCompare(b.name, undefined, { sensitivity: "base" }); });
    sum.textContent = "Player database (" + all.length + ")";
    var q = dbFilter.trim().toLowerCase();
    var shown = q ? all.filter(function (p) { return p.name.toLowerCase().indexOf(q) >= 0; }) : all;
    list.innerHTML = "";
    if (!all.length) { list.append(h("p", { class: "note", text: "No saved players yet. Everyone you add to the lobby lands here once you save to GitHub." })); return; }
    if (!shown.length) { list.append(h("p", { class: "note", text: "No player matches “" + dbFilter + "”." })); return; }
    shown.forEach(function (p) {
      var del = h("button", { class: "ghost small danger", "aria-label": "Delete " + p.name + " from the database" }, "Delete");
      var armed = false;
      del.addEventListener("click", function () {
        if (!armed) { armed = true; del.textContent = "Confirm delete"; del.classList.add("armed"); setTimeout(function () { if (del.isConnected) { armed = false; del.textContent = "Delete"; del.classList.remove("armed"); } }, 4000); return; }
        delete changes.upserts[p.id];
        if (base[p.id] && changes.deletes.indexOf(p.id) < 0) changes.deletes.push(p.id);
        lobby = lobby.filter(function (e) { return e.id !== p.id; });
        persist(); rebuild(); renderAll();
      });
      list.append(h("div", { class: "dbrow" },
        h("div", { class: "who" }, h("strong", { text: p.name || "Unnamed" }), h("span", { text: rolesSummary(p) })),
        inLobby(p.id)
          ? h("span", { class: "chip", text: "in lobby" })
          : h("button", { class: "small", onclick: function () { addToLobby(p.id); addMsg = { text: "", cls: "" }; renderAll(); } }, "Add"),
        del));
    });
  }

  // ===================== teams =====================
  function teamSum(side, useRoles) {
    var sum = 0;
    side.forEach(function (s) { var p = get(s.id); sum += useRoles ? eff(p, s.role) : rating(p); });
    return sum;
  }

  function teamPanel(cls, title, side, useRoles) {
    var sorted = side.slice().sort(function (a, b) { return ROLES.indexOf(a.role) - ROLES.indexOf(b.role); });
    var sum = teamSum(side, useRoles);
    return h("div", { class: "team " + cls },
      h("div", { class: "thead" }, h("h2", { text: title }), h("span", { class: "muted", text: "avg " + rankLabel(sum / 5) })),
      sorted.map(function (s, i) {
        var p = get(s.id), f = fit(p, s.role);
        var chip = f === "secondary" ? h("span", { class: "chip sec", text: "2nd role" })
          : f === "third" ? h("span", { class: "chip sec", text: "3rd role" })
          : f === "fill" ? h("span", { class: "chip sec", text: "fill" })
          : f === "never" ? h("span", { class: "chip offr", text: "won't play" })
          : f === "off" ? h("span", { class: "chip offr", text: "off-role" }) : null;
        return h("div", { class: "slot", style: "--i:" + i },
          h("span", { class: "role", text: ABBR[s.role] }),
          h("div", { class: "who" }, h("strong", { text: p.name || "Unnamed" }), h("span", { text: playerRank(p) + (p.rare ? " · rarely ranked" : "") })),
          chip);
      }),
      h("div", { class: "tfoot" }, h("span", { text: useRoles ? "Strength after roles" : "Total rating" }), h("span", { class: "num", text: fmt(sum) }))
    );
  }

  function renderTeams() {
    var host = document.getElementById("teams");
    if (!host) return;
    host.innerHTML = "";
    var n = playing().length;

    var toggle = h("label", { class: "toggle", for: "use-roles" },
      h("input", { type: "checkbox", id: "use-roles", checked: !!settings.useRoles, onchange: function (e) {
        settings.useRoles = e.target.checked;
        if (n === 10) current = balance(false);
        persist(); renderTeams();
      } }), "Balance with roles");
    host.append(h("div", { class: "sechead" }, h("h2", { id: "teams-h", text: "Teams" })));
    host.append(h("div", { class: "controls" }, toggle,
      h("button", { class: "primary", id: "balance", disabled: n !== 10, onclick: function () { current = balance(false); copyText = null; persist(); renderTeams(); } }, "Balance"),
      h("button", { id: "reroll", disabled: n !== 10, onclick: function () { current = balance(true); copyText = null; persist(); renderTeams(); } }, "Reroll")
    ));
    if (n !== 10) {
      host.append(h("p", { class: "msg", text: n < 10
        ? "Tick exactly 10 players to balance. " + n + " ticked, " + (10 - n) + " to go."
        : "Tick exactly 10 players to balance. " + n + " are ticked, untick " + (n - 10) + "." }));
      host.append(h("p", { class: "muted", text: "Teams show up here once ten players are ticked." }));
      return;
    }
    if (!validSplit(current)) { current = balance(false); persist(); }
    var ur = current.useRoles !== false;
    var b = teamSum(current.blue, ur), r = teamSum(current.red, ur);
    var gap = Math.abs(b - r), per = gap / 5;
    var cls = per < 20 ? "good" : per < 60 ? "warn" : "bad";
    var word = per < 20 ? "Coin flip" : per < 60 ? "Pretty close" : "Lopsided";
    var lean = gap < 1 ? "Perfectly balanced" : (b > r ? "Blue" : "Red") + " heavier by " + fmt(gap);

    host.append(h("div", { class: "teams" },
      teamPanel("blue", "Blue side", current.blue, ur),
      teamPanel("red", "Red side", current.red, ur)));

    var copyBtn = h("button", { onclick: function () {
      var t = discordText(ur);
      function fallback() { copyText = t; renderTeams(); }
      try {
        navigator.clipboard.writeText(t).then(function () {
          copyBtn.textContent = "Copied";
          setTimeout(function () { copyBtn.textContent = "Copy for Discord"; }, 1600);
        }, fallback);
      } catch (e) { fallback(); }
    } }, "Copy for Discord");

    host.append(h("div", { class: "verdict" },
      h("div", { class: "meter" },
        scaleSvg(b, r, lean),
        h("div", { class: "words" },
          h("span", { class: "pill " + cls, text: word }),
          h("span", { class: "muted num", text: lean }))),
      copyBtn));
    if (copyText) {
      host.append(h("p", { class: "note", text: "Copying was blocked. Select the text below and copy it yourself." }),
        h("textarea", { class: "copy", id: "copy-text", readonly: true, "aria-label": "Teams as text" }, copyText));
    }
  }

  // A little balance scale: the beam tips toward the stronger team.
  function scaleSvg(blue, red, label) {
    var NS = "http://www.w3.org/2000/svg";
    function s(tag, attrs) {
      var e = document.createElementNS(NS, tag);
      Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
      for (var i = 2; i < arguments.length; i++) e.appendChild(arguments[i]);
      return e;
    }
    var cx = 66, cy = 20, arm = 46;
    var a = Math.max(-0.3, Math.min(0.3, (red - blue) / 400)); // >0: red side down
    var dx = arm * Math.cos(a), dy = arm * Math.sin(a);
    var L = { x: cx - dx, y: cy - dy }, R = { x: cx + dx, y: cy + dy };
    function pan(p, cls) {
      var y = p.y + 20;
      return s("g", {},
        s("path", { class: "string", d: "M" + p.x + " " + p.y + " L" + (p.x - 13) + " " + y + " M" + p.x + " " + p.y + " L" + (p.x + 13) + " " + y }),
        s("path", { class: cls, d: "M" + (p.x - 16) + " " + y + " Q" + p.x + " " + (y + 16) + " " + (p.x + 16) + " " + y + " Z" }));
    }
    var svg = s("svg", { class: "scale", viewBox: "0 0 132 72", role: "img", "aria-label": label },
      s("path", { class: "stand", d: "M66 20 L66 64 M50 66 L82 66" }),
      s("g", { class: "sway" },
        s("path", { class: "beam", d: "M" + L.x + " " + L.y + " L" + R.x + " " + R.y }),
        pan(L, "pan-blue"),
        pan(R, "pan-red")),
      s("circle", { class: "pivot", cx: cx, cy: cy, r: 5 }));
    return svg;
  }

  function discordText(ur) {
    function side(name, s) {
      var sorted = s.slice().sort(function (a, b) { return ROLES.indexOf(a.role) - ROLES.indexOf(b.role); });
      return "**" + name + "** (avg " + rankLabel(teamSum(s, ur) / 5) + ")\n" +
        sorted.map(function (x) { return ABBR[x.role] + "  " + get(x.id).name; }).join("\n");
    }
    return side("Blue side", current.blue) + "\n\n" + side("Red side", current.red);
  }

  // ===================== settings dialog =====================
  var dlg = document.getElementById("gh");
  function openSettings() {
    var fields = document.getElementById("repo-fields");
    var det = document.getElementById("repo-detected");
    var auto = REPO && REPO.source !== "saved";
    fields.hidden = !!auto;
    det.textContent = auto ? "Repo: " + REPO.owner + "/" + REPO.repo + " (branch " + BRANCH + ")" : "This page isn't on GitHub Pages, so enter the repo that holds players.json.";
    document.getElementById("gh-owner").value = REPO ? REPO.owner : "";
    document.getElementById("gh-repo").value = REPO ? REPO.repo : "";
    document.getElementById("gh-token").value = token;
    document.getElementById("gh-forget").hidden = !token;
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute("open", "");
  }
  function closeSettings() { if (dlg.close) dlg.close(); else dlg.removeAttribute("open"); }
  document.getElementById("gh-form").addEventListener("submit", function (e) {
    e.preventDefault();
    if (!REPO || REPO.source === "saved") {
      var o = document.getElementById("gh-owner").value.trim(), r = document.getElementById("gh-repo").value.trim();
      if (o && r) { REPO = { owner: o, repo: r, source: "saved" }; LS.set("cb.repo", { owner: o, repo: r }); }
    }
    token = document.getElementById("gh-token").value.trim();
    if (token) LS.set("cb.token", token); else LS.del("cb.token");
    closeSettings();
    load();
  });
  document.getElementById("gh-cancel").addEventListener("click", closeSettings);
  document.getElementById("gh-forget").addEventListener("click", function () {
    token = ""; LS.del("cb.token"); closeSettings(); renderDbBar();
  });

  // ===================== boot =====================
  function renderAll() {
    app.innerHTML = "";
    app.append(h("div", { class: "wrap" }, header(),
      h("div", { class: "grid" }, lobbySection(), h("section", { class: "card", id: "teams", "aria-labelledby": "teams-h" }))));
    renderDbBar(); renderLobbyCount(); renderNameList(); renderDbPanel(); renderTeams();
  }

  if (lobby.some(function (e) { return /^ex\d+$/.test(e.id); })) makeExamples();
  load();
})();
