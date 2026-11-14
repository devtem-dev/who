/**
 * WHO platform: search, client UX, guided scenes and follow-ups.
 * Plain JS. Loads /api/people/index.json, falls back to cards in the DOM.
 */
(function () {
  "use strict";

  var INDEX_URL = "/api/people/index.json";
  var RECENT_KEY = "who-recent";
  var STOP = { of: 1, the: 1, a: 1, an: 1, and: 1, in: 1, at: 1, by: 1, for: 1, who: 1, is: 1, to: 1 };
  var REL_LABELS = {
    creator_of: "Creator of",
    works_for: "Works at",
    contributor_to: "Contributor to",
    founder_of: "Founder of",
    collaborates_with: "Works with"
  };
  var reduceMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  /* ---------- helpers ---------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function reEsc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  function norm(s) {
    return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9.+#\s-]/g, " ").replace(/\s+/g, " ").trim();
  }
  function words(s) {
    var out = [];
    norm(s).split(" ").forEach(function (w) {
      if (!w) return;
      out.push(w);
      if (/[.\-]/.test(w)) w.split(/[.\-]+/).forEach(function (p) { if (p) out.push(p); });
    });
    return out;
  }
  function queryTokens(q) {
    var all = words(q);
    var kept = all.filter(function (w) { return !STOP[w]; });
    return kept.length ? kept : all;
  }
  function lev(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    var prev = [], i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      var cur = [i];
      for (j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }
  function hl(text, toks) {
    if (!toks.length) return esc(text);
    var re = new RegExp("(" + toks.map(reEsc).join("|") + ")", "ig");
    return String(text).split(re).map(function (part, i) {
      return i % 2 ? "<mark>" + esc(part) + "</mark>" : esc(part);
    }).join("");
  }
  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments, ctx = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(ctx, args); }, ms);
    };
  }
  function go(url) {
    if (reduceMotion) { window.location.href = url; return; }
    document.body.classList.add("is-leaving");
    setTimeout(function () { window.location.href = url; }, 140);
  }

  /* ---------- recent searches ---------- */
  function getRecent() {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); } catch (e) { return []; }
  }
  function pushRecent(q) {
    q = (q || "").trim();
    if (!q) return;
    try {
      var list = getRecent().filter(function (x) { return x.toLowerCase() !== q.toLowerCase(); });
      list.unshift(q);
      localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 5)));
    } catch (e) { /* storage unavailable */ }
  }
  function clearRecent() {
    try { localStorage.removeItem(RECENT_KEY); } catch (e) { /* ignore */ }
  }

  /* ---------- data ---------- */
  function fromDOM() {
    var seen = {}, list = [];
    document.querySelectorAll(".person-card").forEach(function (a) {
      var url = a.getAttribute("href");
      if (!url || seen[url]) return;
      seen[url] = 1;
      var h3 = a.querySelector("h3");
      var name = h3 ? (h3.childNodes[0] ? h3.childNodes[0].textContent : h3.textContent).trim() : url;
      var img = a.querySelector("img");
      list.push({
        id: url.replace(/^.*\//, ""),
        name: name,
        aliases: [],
        role: ($(".person-role", a) || {}).textContent || "",
        summary: ($("p.text-sm", a) || {}).textContent || "",
        location: "",
        tags: Array.prototype.map.call(a.querySelectorAll(".tag"), function (t) { return t.textContent.trim(); }),
        url: url,
        avatar: img ? img.getAttribute("src") : "",
        status: a.querySelector(".badge-verified") ? "verified" : "source-backed",
        relations: []
      });
    });
    return list;
  }

  function loadPeople() {
    return fetch(INDEX_URL, { cache: "no-cache" })
      .then(function (r) { if (!r.ok) throw new Error("index"); return r.json(); })
      .then(function (d) { return d.people || []; })
      .catch(function () { return fromDOM(); });
  }

  /* ---------- engine ---------- */
  function buildEngine(people) {
    var byId = {};
    people.forEach(function (p) { byId[p.id] = p; });

    people.forEach(function (p) {
      (p.relations || []).forEach(function (r) {
        var t = r.person && byId[r.target] ? (byId[r.target].aliases[0] || byId[r.target].name) : r.target;
        r.name = t;
        r.label = (REL_LABELS[r.type] || "Related to") + " " + t;
      });
    });

    var vocab = {};
    var docs = people.map(function (p) {
      var defs = [
        { k: "name", w: 10, text: [p.name].concat(p.aliases || []).join(" ") },
        { k: "tag", w: 5, text: (p.tags || []).join(" ") },
        { k: "rel", w: 4, text: (p.relations || []).map(function (r) { return r.label; }).join(" ") },
        { k: "role", w: 3, text: p.role },
        { k: "loc", w: 2, text: p.location },
        { k: "sum", w: 1.5, text: p.summary }
      ];
      var fields = defs.map(function (f) {
        var ws = words(f.text);
        ws.forEach(function (w) { if (w.length >= 3 && !STOP[w]) vocab[w] = 1; });
        return { k: f.k, w: f.w, words: ws };
      });
      return { p: p, fields: fields, nameWords: fields[0].words };
    });
    var vocabList = Object.keys(vocab);

    function match(w, t, weight) {
      if (w === t) return weight;
      if (t.length >= 2 && w.indexOf(t) === 0) return weight * 0.7;
      if (t.length >= 4 && w.length >= 4 && lev(w, t, 1) <= 1) return weight * 0.4;
      return 0;
    }

    function scoreDoc(doc, toks) {
      var total = 0, matched = 0;
      toks.forEach(function (t) {
        var best = 0, extra = 0;
        doc.fields.forEach(function (f) {
          var s = 0;
          for (var i = 0; i < f.words.length; i++) {
            var v = match(f.words[i], t, f.w);
            if (v > s) s = v;
          }
          if (s > best) { extra += best * 0.2; best = s; } else { extra += s * 0.2; }
        });
        if (best > 0) { matched++; total += best + extra; }
      });
      return matched ? total * (matched / toks.length) : 0;
    }

    function reasonFor(doc, toks) {
      var nameHit = toks.some(function (t) {
        return doc.nameWords.some(function (w) { return match(w, t, 1) >= 0.7; });
      });
      if (nameHit) return "";
      var rels = doc.p.relations || [];
      for (var i = 0; i < rels.length; i++) {
        var rw = words(rels[i].name);
        if (toks.some(function (t) { return rw.some(function (w) { return match(w, t, 1) >= 0.7; }); })) return rels[i].label;
      }
      var tags = doc.p.tags || [];
      for (var j = 0; j < tags.length; j++) {
        var tw = words(tags[j]);
        if (toks.some(function (t) { return tw.some(function (w) { return match(w, t, 1) >= 0.7; }); })) return "Topic: " + tags[j];
      }
      return "";
    }

    function search(q) {
      var toks = queryTokens(q);
      if (!toks.length) return [];
      return docs.map(function (d) {
        return { p: d.p, score: scoreDoc(d, toks), reason: "" , doc: d };
      }).filter(function (r) { return r.score > 0; })
        .sort(function (a, b) { return b.score - a.score; })
        .map(function (r) { r.reason = reasonFor(r.doc, toks); return r; });
    }

    function didYouMean(q) {
      var toks = queryTokens(q), changed = false;
      var fixed = toks.map(function (t) {
        var known = vocabList.some(function (w) { return w.indexOf(t) === 0; });
        if (known || t.length < 4) return t;
        var best = null, bd = 3;
        vocabList.forEach(function (w) {
          var d = lev(t, w, 2);
          if (d < bd) { bd = d; best = w; }
        });
        if (best) { changed = true; return best; }
        return t;
      });
      return changed ? fixed.join(" ") : "";
    }

    function related(results, q) {
      var toks = queryTokens(q), counts = {}, order = [];
      function add(term) {
        var tw = words(term);
        if (toks.some(function (t) { return tw.indexOf(t) !== -1; })) return;
        if (!counts[term]) { counts[term] = 0; order.push(term); }
        counts[term]++;
      }
      results.slice(0, 3).forEach(function (r) {
        (r.p.tags || []).forEach(add);
        (r.p.relations || []).forEach(function (rel) { add(rel.name); });
      });
      return order.sort(function (a, b) { return counts[b] - counts[a]; }).slice(0, 6);
    }

    function topics() {
      var counts = {}, order = [];
      people.forEach(function (p) {
        (p.tags || []).forEach(function (t) {
          if (!counts[t]) { counts[t] = 0; order.push(t); }
          counts[t]++;
        });
      });
      return order.sort(function (a, b) { return counts[b] - counts[a]; });
    }

    return { people: people, search: search, didYouMean: didYouMean, related: related, topics: topics };
  }

  /* ---------- shared UX ---------- */
  function avatarHTML(p, size) {
    if (!p.avatar) return '<span class="sp-initial">' + esc((p.name || "?").charAt(0)) + "</span>";
    return '<img class="person-avatar" src="' + esc(p.avatar) + '" width="' + size + '" height="' + size + '" alt="" loading="lazy">';
  }

  function reveal(container) {
    if (reduceMotion || !("IntersectionObserver" in window)) return;
    var els = container.querySelectorAll(".card, .step");
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add("is-in"); io.unobserve(e.target); }
      });
    }, { threshold: 0.08 });
    Array.prototype.forEach.call(els, function (el, i) {
      el.classList.add("js-reveal");
      el.style.setProperty("--i", Math.min(i, 8));
      io.observe(el);
    });
  }

  function typewriter(input, prompts) {
    if (!input || reduceMotion || !prompts.length) return;
    var base = input.getAttribute("placeholder") || "";
    var pi = 0, ci = 0, dir = 1, timer = null, active = true;

    function stop() { active = false; clearTimeout(timer); input.setAttribute("placeholder", base); }
    function start() {
      if (input.value) return;
      active = true;
      clearTimeout(timer);
      tick();
    }
    function tick() {
      if (!active) return;
      var text = prompts[pi];
      ci += dir;
      input.setAttribute("placeholder", text.slice(0, ci) + (ci < text.length ? "|" : ""));
      var wait = dir === 1 ? 70 : 30;
      if (dir === 1 && ci >= text.length) { dir = -1; wait = 1600; }
      else if (dir === -1 && ci <= 0) { dir = 1; pi = (pi + 1) % prompts.length; wait = 350; }
      timer = setTimeout(tick, wait);
    }
    input.addEventListener("focus", stop);
    input.addEventListener("blur", function () { if (!input.value) start(); });
    setTimeout(start, 900);
  }

  function buildPrompts(engine) {
    var list = ["Search by name, project or topic"];
    engine.topics().slice(0, 4).forEach(function (t) { list.push("Try: " + t); });
    engine.people.slice(0, 3).forEach(function (p) { list.push("Try: " + (p.aliases[0] || p.name)); });
    return list;
  }

  function hotkey(input) {
    document.addEventListener("keydown", function (e) {
      var tag = (e.target.tagName || "").toLowerCase();
      if (e.key === "/" && tag !== "input" && tag !== "textarea" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        input.focus();
        input.select();
      }
    });
  }

  /* ---------- home: live suggestion panel ---------- */
  function mountHome(engine) {
    var form = $("#who-search");
    var input = form && $("input[name=q]", form);
    if (!form || !input) return;

    var panel = document.createElement("div");
    panel.className = "search-panel";
    panel.id = "search-panel";
    panel.setAttribute("role", "listbox");
    panel.hidden = true;
    form.appendChild(panel);

    input.setAttribute("role", "combobox");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-controls", "search-panel");
    input.setAttribute("aria-autocomplete", "list");

    var active = -1;

    function items() { return panel.querySelectorAll("[role=option]"); }
    function setActive(i) {
      var list = items();
      if (!list.length) { active = -1; return; }
      active = (i + list.length) % list.length;
      Array.prototype.forEach.call(list, function (el, n) {
        el.classList.toggle("is-active", n === active);
        el.setAttribute("aria-selected", n === active ? "true" : "false");
      });
      input.setAttribute("aria-activedescendant", list[active].id);
    }
    function close() {
      panel.hidden = true;
      active = -1;
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
    }
    function open() {
      panel.hidden = false;
      input.setAttribute("aria-expanded", "true");
    }

    function render() {
      var q = input.value.trim();
      var html = "";
      if (!q) {
        var recent = getRecent();
        if (!recent.length) { close(); return; }
        html += '<div class="sp-head"><span>Recent</span><button type="button" class="sp-clear" data-clear>Clear</button></div>';
        recent.forEach(function (r, i) {
          html += '<a class="sp-item" role="option" id="sp-' + i + '" href="/someone/?q=' + encodeURIComponent(r) + '" data-recent="' + esc(r) + '">' +
            '<span class="sp-initial">&#8635;</span><span class="sp-main"><span class="sp-name">' + esc(r) + "</span></span></a>";
        });
      } else {
        var results = engine.search(q).slice(0, 5);
        var toks = queryTokens(q);
        if (!results.length) {
          var fix = engine.didYouMean(q);
          html += '<div class="sp-empty">No profile matches &ldquo;' + esc(q) + "&rdquo;." +
            (fix ? ' Did you mean <a href="/someone/?q=' + encodeURIComponent(fix) + '">' + esc(fix) + "</a>?" : "") + "</div>";
        }
        results.forEach(function (r, i) {
          html += '<a class="sp-item" role="option" id="sp-' + i + '" href="' + esc(r.p.url) + '">' + avatarHTML(r.p, 36) +
            '<span class="sp-main"><span class="sp-name">' + hl(r.p.name, toks) + "</span>" +
            '<span class="sp-sub">' + esc(r.reason || r.p.role) + "</span></span></a>";
        });
        html += '<a class="sp-item sp-all" role="option" id="sp-all" href="/someone/?q=' + encodeURIComponent(q) + '">' +
          '<span class="sp-main"><span class="sp-name">See all results for &ldquo;' + esc(q) + "&rdquo;</span></span></a>";
      }
      panel.innerHTML = html;
      active = -1;
      open();
    }

    input.addEventListener("input", debounce(render, 80));
    input.addEventListener("focus", render);
    input.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); if (panel.hidden) render(); setActive(active + 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setActive(active - 1); }
      else if (e.key === "Escape") { close(); }
      else if (e.key === "Enter" && active > -1) {
        e.preventDefault();
        var el = items()[active];
        if (el) { pushRecent(input.value); go(el.getAttribute("href")); }
      }
    });
    panel.addEventListener("mousemove", function (e) {
      var el = e.target.closest("[role=option]");
      if (!el) return;
      setActive(Array.prototype.indexOf.call(items(), el));
    });
    panel.addEventListener("click", function (e) {
      if (e.target.closest("[data-clear]")) { clearRecent(); close(); return; }
      var a = e.target.closest("a.sp-item");
      if (a) {
        e.preventDefault();
        var rec = a.getAttribute("data-recent");
        if (!rec) pushRecent(input.value);
        go(a.getAttribute("href"));
      }
    });
    document.addEventListener("click", function (e) { if (!form.contains(e.target)) close(); });

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var q = input.value.trim();
      if (!q) return;
      pushRecent(q);
      var res = engine.search(q);
      if (res.length === 1 || (res.length > 1 && res[0].score >= res[1].score * 1.8)) go(res[0].p.url);
      else go("/someone/?q=" + encodeURIComponent(q));
    });

    typewriter(input, buildPrompts(engine));
    hotkey(input);
  }

  /* ---------- directory: filter, chips, follow-up ---------- */
  function mountDirectory(engine) {
    var grid = $("#people-grid");
    var form = $("#dir-search");
    var input = form && $("input[name=q]", form);
    if (!grid || !input) return;

    var chips = $("#tag-chips");
    var status = $("#result-status");
    var follow = $("#follow-up");
    var state = readURL();

    function readURL() {
      var p = new URLSearchParams(window.location.search);
      return { q: (p.get("q") || "").trim(), tag: (p.get("tag") || "").trim() };
    }
    function writeURL(push) {
      var p = new URLSearchParams();
      if (state.q) p.set("q", state.q);
      if (state.tag) p.set("tag", state.tag);
      var url = window.location.pathname + (p.toString() ? "?" + p.toString() : "");
      if (push) history.pushState(null, "", url); else history.replaceState(null, "", url);
    }

    function cardHTML(r, toks, i) {
      var p = r.p;
      var badge = p.status === "verified"
        ? '<span class="badge badge-verified badge-inline">Verified</span>'
        : '<span class="badge badge-inline">Source-backed</span>';
      return '<a href="' + esc(p.url) + '" class="card card-link person-card" style="--i:' + Math.min(i, 8) + '">' +
        '<div class="person-card-header">' + avatarHTML(p, 56) +
        "<div><h3>" + hl(p.name, toks) + " " + badge + "</h3>" +
        '<p class="person-role">' + hl(p.role, toks) + "</p></div></div>" +
        (r.reason ? '<p class="match-reason">' + esc(r.reason) + "</p>" : "") +
        '<p class="text-sm" style="margin:0;">' + hl(p.summary, toks) + "</p>" +
        '<div class="person-tags">' + (p.tags || []).map(function (t) { return '<span class="tag">' + esc(t) + "</span>"; }).join("") + "</div></a>";
    }

    function renderChips() {
      if (!chips) return;
      var html = '<button type="button" class="chip' + (state.tag ? "" : " is-on") + '" data-tag="">All</button>';
      engine.topics().forEach(function (t) {
        html += '<button type="button" class="chip' + (state.tag.toLowerCase() === t.toLowerCase() ? " is-on" : "") +
          '" data-tag="' + esc(t) + '">' + esc(t) + "</button>";
      });
      chips.innerHTML = html;
    }

    function run(opts) {
      opts = opts || {};
      var q = state.q, notice = "", results, effective = q;

      if (q) {
        results = engine.search(q);
        if (!results.length) {
          var fix = engine.didYouMean(q);
          var fixed = fix ? engine.search(fix) : [];
          if (fixed.length) {
            results = fixed;
            effective = fix;
            notice = 'Showing results for <strong>' + esc(fix) + '</strong>. <button type="button" class="link-btn" data-literal>Search instead for &ldquo;' + esc(q) + "&rdquo;</button>";
          }
        }
      } else {
        results = engine.people.map(function (p) { return { p: p, score: 0, reason: "" }; });
      }

      if (opts.literal) { results = engine.search(q); effective = q; notice = ""; }

      if (state.tag) {
        var tg = state.tag.toLowerCase();
        results = results.filter(function (r) {
          return (r.p.tags || []).some(function (t) { return t.toLowerCase() === tg; });
        });
      }

      var toks = effective ? queryTokens(effective) : [];
      grid.innerHTML = results.map(function (r, i) { return cardHTML(r, toks, i); }).join("");
      reveal(grid);
      renderChips();

      var n = results.length;
      status.innerHTML = (notice ? notice + " " : "") +
        '<span class="count">' + n + (n === 1 ? " profile" : " profiles") + "</span>" +
        (q ? " for &ldquo;" + esc(q) + "&rdquo;" : "") + (state.tag ? " in " + esc(state.tag) : "");

      renderFollowUp(results, effective, n);
    }

    function renderFollowUp(results, q, n) {
      if (!follow) return;
      var html = "";
      if (!n) {
        html += '<div class="follow-card"><h3>Nothing matched yet</h3>' +
          "<p>Try a shorter term, or start from a popular topic:</p>" +
          '<div class="chip-row">' + engine.topics().slice(0, 6).map(function (t) {
            return '<button type="button" class="chip" data-q="' + esc(t) + '">' + esc(t) + "</button>";
          }).join("") + "</div>" +
          '<p class="text-sm">Not listed? <a href="/submit?name=' + encodeURIComponent(state.q) + '">Request inclusion for &ldquo;' + esc(state.q || "this person") + '&rdquo;</a>.</p></div>';
      } else if (q) {
        var rel = engine.related(results, q);
        if (rel.length) {
          html += '<div class="follow-card"><h3>Related searches</h3><div class="chip-row">' +
            rel.map(function (t) { return '<button type="button" class="chip" data-q="' + esc(t) + '">' + esc(t) + "</button>"; }).join("") +
            "</div></div>";
        }
        html += '<p class="text-sm text-muted follow-note">Not the person you meant? <a href="/submit?name=' + encodeURIComponent(state.q) + '">Request inclusion</a> or <a href="/corrections">report a correction</a>.</p>';
      }
      follow.innerHTML = html;
    }

    function apply(push) {
      writeURL(push);
      run();
    }

    input.value = state.q;
    run();

    input.addEventListener("input", debounce(function () {
      state.q = input.value.trim();
      apply(false);
    }, 120));
    input.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && input.value) { input.value = ""; state.q = ""; apply(false); }
    });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      state.q = input.value.trim();
      pushRecent(state.q);
      apply(true);
    });

    document.addEventListener("click", function (e) {
      var chip = e.target.closest(".chip");
      if (chip) {
        if (chip.hasAttribute("data-q")) {
          state.q = chip.getAttribute("data-q");
          state.tag = "";
          input.value = state.q;
          pushRecent(state.q);
        } else {
          state.tag = chip.getAttribute("data-tag") || "";
        }
        apply(true);
        return;
      }
      if (e.target.closest("[data-literal]")) { run({ literal: true }); }
    });
    window.addEventListener("popstate", function () {
      state = readURL();
      input.value = state.q;
      run();
    });

    typewriter(input, buildPrompts(engine));
    hotkey(input);
  }

  /* ---------- submit page: carry the searched name over ---------- */
  function prefillSubmit() {
    var nameField = $("#name");
    if (!nameField || !/\/submit/.test(window.location.pathname)) return;
    var q = new URLSearchParams(window.location.search).get("name");
    if (q && !nameField.value) nameField.value = q;
  }

  /* ---------- boot ---------- */
  function boot() {
    prefillSubmit();
    var hasSearch = $("#who-search") || $("#people-grid");
    reveal(document);
    if (!hasSearch) return;
    loadPeople().then(function (people) {
      var engine = buildEngine(people);
      mountHome(engine);
      mountDirectory(engine);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
