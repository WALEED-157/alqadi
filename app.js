/* ===================================================
   نظام المخزون — منطق التطبيق
   =================================================== */
(() => {
  "use strict";

  const CFG = window.APP_CONFIG;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const LS_USER = "inv_user";
  const LS_USERS = "inv_users_v1";
  const CLOUD = window.DB.on;          // مربوط بـ Supabase؟
  // نسخة السحابة لها مفاتيح منفصلة عشان ما يختلط فيها جرد التجربة المحلي
  const LS_COUNTS = CLOUD ? "inv_counts_cloud_v1" : "inv_counts_v1";
  const LS_EXTRAS = CLOUD ? "inv_extras_cloud_v1" : "inv_extras_v1";   // أصناف زائدة لقيناها بالجرد وما هي بالنظام
  const PAGE = 80;

  /* ---------- التخزين ---------- */
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { toast("تعذّر الحفظ على الجهاز"); } },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  /* ---------- الجرد: كل صنف له قائمة إدخالات تُجمع ---------- */
  // counts[key] = { qty(المجموع), loc, note, by, at, entries:[{qty, by, u, at}] }
  function normCount(c) {
    if (!c) return c;
    if (!Array.isArray(c.entries)) c.entries = [{ qty: +c.qty || 0, by: c.by, u: "", at: c.at || Date.now() }];
    c.entries.forEach((e) => { if (!e.id) e.id = window.DB.uuid(); });
    c.qty = c.entries.reduce((s, e) => s + (+e.qty || 0), 0);
    const last = c.entries[c.entries.length - 1];
    c.by = last?.by; c.at = last?.at;
    return c;
  }
  const loadedCounts = store.get(LS_COUNTS, {});
  Object.values(loadedCounts).forEach(normCount);

  const state = {
    user: store.get(LS_USER, null),
    data: null,          // { branches, items[] }
    counts: loadedCounts,
    branch: null,        // index
    branchItems: [],
    filtered: [],
    rendered: 0,
    status: "todo",      // الافتراضي: يعرض اللي ما انجرد بس (البحث يعرض الكل)
    pins: [],           // أجزاء البحث المثبتة: {type:"loc",from,to} | {type:"text",raw}
    editing: null,
    screen: "login",
    profiles: null,      // قائمة المستخدمين من السيرفر (للمدير)
  };
  const saveCounts = () => store.set(LS_COUNTS, state.counts);

  /* ---------- أدوات النص ---------- */
  const AR_DIAC = /[ً-ْـٰ]/g;
  function norm(s) {
    return String(s ?? "")
      .toLowerCase()
      .replace(AR_DIAC, "")
      .replace(/[أإآٱ]/g, "ا")
      .replace(/ة/g, "ه")
      .replace(/ى/g, "ي")
      .replace(/ؤ/g, "و")
      .replace(/ئ/g, "ي")
      .replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d))
      .replace(/\s+/g, " ");
  }
  const numKey = (s) => norm(s).replace(/[\s\-_/.]/g, "");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n) => (Number.isFinite(+n) ? (+n).toLocaleString("en-US") : n);
  const fmtTime = (t) => new Date(t).toLocaleString("ar-SA-u-nu-latn", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const toEnDigits = (s) => String(s ?? "").replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d));

  // تحليل الموقع: B057+060 → {p:"B", n:57}
  function parseLoc(s) {
    const m = toEnDigits(s).toUpperCase().match(/^\s*([A-Z]+)\s*-?\s*(\d+)/);
    return m ? { p: m[1], n: parseInt(m[2], 10) } : null;
  }
  const cmpLoc = (a, b) => (a.p === b.p ? a.n - b.n : a.p < b.p ? -1 : 1);

  /* ---------- البيانات ---------- */
  // الصفوف: [رقم, اسم, اسم الفرع, متوفر, محجوز, موقع, تكلفة]
  async function loadData(force) {
    if (state.data && !force) return state.data;
    const raw = await window.DB.loadItems(force);
    const extras = Object.values(store.get(LS_EXTRAS, {}));
    const names = new Set(raw.items.map((r) => r[2]));
    extras.forEach((x) => names.add(x.b));
    const branches = CFG.branchOrder.filter((b) => names.has(b)).concat([...names].filter((b) => !CFG.branchOrder.includes(b)).sort());
    const bIdx = new Map(branches.map((b, i) => [b, i]));
    const items = raw.items.map((r, i) => ({
      i, n: r[0], name: r[1], b: bIdx.get(r[2]), q: +r[3] || 0, r: +r[4] || 0, loc: r[5] || "", c: r[6],
      nn: norm(r[0]), nk: numKey(r[0]), nm: norm(r[1]),
    }));
    state.data = { branches, items, version: raw.version };
    extras.forEach(addExtraItem);
    return state.data;
  }
  // المخزون تغيّر على السيرفر (المدير رفع تحديث) — نعيد التحميل بدون ما نخرب الشاشة
  async function reloadItems() {
    const bname = state.branch != null ? state.data?.branches[state.branch] : null;
    await loadData(true);
    state.branch = null;
    if (state.screen === "inventory" && bname != null) {
      const bi = state.data.branches.indexOf(bname);
      if (bi >= 0) { state.branch = bi; state.branchItems = scopedItems(bi); applyFilter(); }
    } else if (state.screen === "branches") renderBranches();
    else if (state.screen === "admin") renderAdmin();
  }

  /* ---------- الأصناف الزائدة (موجودة فعلياً وغير موجودة بالنظام) ---------- */
  // extras["فرع|رقم"] = { b: اسم الفرع, n, name, loc, by, u, at }
  function addExtraItem(x) {
    const { branches, items } = state.data;
    const bi = branches.indexOf(x.b);
    if (bi < 0 || !x.n) return null;
    const ex = items.find((it) => it.b === bi && it.n === x.n);
    if (ex) return ex;
    const it = {
      i: items.length, n: x.n, name: x.name || "", b: bi, q: 0, r: 0, loc: x.loc || "", c: "", x: true,
      nn: norm(x.n), nk: numKey(x.n), nm: norm(x.name || ""),
    };
    items.push(it);
    return it;
  }
  function removeExtraIfEmpty(it) {
    if (!it?.x || countOf(it)) return;
    const ex = store.get(LS_EXTRAS, {});
    const rec = ex[keyOf(it)];
    delete ex[keyOf(it)];
    store.set(LS_EXTRAS, ex);
    if (rec?.synced) pushExtra(it, rec, true);
    it.gone = true;
    state.branchItems = state.branchItems.filter((x) => x !== it);
  }

  /* ---------- الرفع للسيرفر (يتجمع بالطابور لو ما فيه نت) ---------- */
  const bOf = (it) => state.data.branches[it.b];
  const iso = (t) => new Date(t || Date.now()).toISOString();
  function pushEntry(it, e) {
    window.DB.queue({ t: "entry", row: { id: e.id, branch: bOf(it), n: it.n, qty: e.qty, user_id: e.u, by_name: e.by || "", at: iso(e.at) } });
  }
  const pushDel = (id) => window.DB.queue({ t: "del", id });
  const pushMeta = (it, c) => window.DB.queue({ t: "meta", row: { branch: bOf(it), n: it.n, loc: c?.loc ?? null, note: c?.note || null } });
  function pushExtra(it, rec, deleted = false) {
    window.DB.queue({ t: "extra", row: { branch: bOf(it), n: it.n, name: it.name || "", loc: it.loc || "", by_name: rec?.by || "", at: iso(rec?.at), deleted } });
  }
  // أول جرد لصنف زائد = نرفعه للسيرفر عشان يطلع للكل
  function commitExtra(it) {
    if (!it.x) return;
    const ex = store.get(LS_EXTRAS, {});
    const rec = ex[keyOf(it)];
    if (!rec || rec.synced) return;
    rec.synced = true;
    store.set(LS_EXTRAS, ex);
    pushExtra(it, rec);
  }
  const keyOf = (it) => `${state.data.branches[it.b]}|${it.n}`;
  const countOf = (it) => state.counts[keyOf(it)];
  const effLoc = (it) => countOf(it)?.loc ?? it.loc;
  // المحجوز = الزبون أخذه وما صدرت فاتورته — داخل في المتوفر لكنه مو بالرف
  // الجرد النهائي = اللي بالرف + المحجوز، والفرق = النهائي − المتوفر
  const resv = (it) => +it.r || 0;
  const finalOf = (it, c = countOf(it)) => (c ? c.qty + resv(it) : null);
  const diffOf = (it, c = countOf(it)) => (c ? c.qty + resv(it) - it.q : 0);
  const branchLabel = (name) => CFG.branchLabels?.[name] || name;

  /* ---------- المستخدمون والصلاحيات ---------- */
  // المستخدمون في config.js ثابتون (لا يمكن حذفهم)، والباقي يضيفهم المدير من لوحة التحكم
  // الوضع المحلي (بدون Supabase): مدير افتراضي للتجربة فقط
  const LOCAL_ADMIN = { username: "admin", password: "1234", name: "المدير", role: "admin" };
  function allUsers() {
    if (CLOUD) return state.profiles || [];
    const map = new Map();
    for (const u of CFG.users || [LOCAL_ADMIN]) map.set(u.username.toLowerCase(), { role: "admin", active: true, ...u, builtin: true });
    for (const u of store.get(LS_USERS, [])) {
      const k = u.username.toLowerCase();
      if (!map.get(k)?.builtin) map.set(k, u);
    }
    return [...map.values()];
  }
  const findUser = (username) => allUsers().find((u) => u.username.toLowerCase() === String(username).toLowerCase());
  const me = () => (CLOUD ? window.DB.profile : state.user ? findUser(state.user.username) : null);
  const myId = () => (CLOUD ? me()?.id : me()?.username);
  const isAdmin = () => me()?.role === "admin";
  const isBlind = () => !isAdmin() && !!me()?.blind;

  // نطاق المستخدم: scope = [{b: اسم الفرع أو "" للكل, from, to}] — فاضي = كل شيء
  function scopeFor(bname) {
    const u = me();
    if (!u || u.role === "admin" || !u.scope?.length) return { ok: true, test: null };
    const rules = u.scope.filter((r) => !r.b || r.b === bname);
    if (!rules.length) return { ok: false, test: null };
    const tests = rules.map((r) => makeLocTest({ from: r.from || "", to: r.to || "" }));
    if (tests.some((t) => !t)) return { ok: true, test: null };   // قاعدة بدون موقع = الفرع كامل
    return { ok: true, test: (L) => tests.some((t) => t(L)) };
  }
  function scopedItems(bi) {
    const sc = scopeFor(state.data.branches[bi]);
    if (!sc.ok) return [];
    const its = state.data.items.filter((x) => x.b === bi && !x.gone);
    return sc.test ? its.filter((it) => it.x || sc.test(it.loc || "") || sc.test(effLoc(it) || "")) : its;
  }

  /* ---------- التنقل (بدون سجل متصفح — زر الرجوع لا يخرج من التطبيق) ---------- */
  function show(id) {
    state.screen = id;
    $$(".screen").forEach((s) => s.classList.toggle("active", s.id === "screen-" + id));
    window.scrollTo(0, 0);
  }
  let cur = location.hash.slice(1) || "home";
  function go(h) {
    cur = h;
    try { history.replaceState(history.state, "", "#" + h); } catch {}
    route();
  }
  async function route() {
    const h = cur;
    const u = me();
    if (!u || u.active === false) {
      if (state.user) { state.user = null; store.del(LS_USER); }
      return show("login");
    }
    document.body.classList.toggle("blind", isBlind());
    if (h === "home") {
      $("#user-name").textContent = u.name;
      $("#admin-card").hidden = u.role !== "admin";
      return show("home");
    }
    if (!state.data) {
      toast("جاري تحميل الأصناف…", 60000);
      try { await loadData(); } catch (err) {
        console.warn(err);
        toast(navigator.onLine ? "تعذّر تحميل المخزون: " + (err.message || "") : "ما فيه إنترنت — افتح التطبيق مرة وأنت متصل عشان ينحفظ المخزون", 4000);
        if (h !== "admin") return;
        state.data = { branches: [], items: [] };      // المدير يقدر يدخل يرفع المخزون حتى لو فاضي
      }
      if (state.data) $("#toast").hidden = true;
    }
    if (h === "branches") { renderBranches(); return show("branches"); }
    if (h === "admin" && u.role === "admin") { renderAdmin(); return show("admin"); }
    const m = h.match(/^inv\/(\d+)$/);
    if (m && scopeFor(state.data.branches[+m[1]] ?? "").ok && state.data.branches[+m[1]] != null) {
      openBranch(+m[1]); return show("inventory");
    }
    go("home");
  }

  // حارس زر الرجوع: نضيف خطوة وهمية في السجل، وأي ضغطة رجوع ترجعنا داخل التطبيق
  let needArm = true;
  function arm() {
    if (!needArm) return;
    needArm = false;
    try { history.pushState({ guard: 1 }, "", "#" + cur); } catch {}
  }
  document.addEventListener("pointerdown", arm, true);
  window.addEventListener("popstate", () => {
    try { history.pushState({ guard: 1 }, "", "#" + cur); } catch {}
    needArm = true;          // بعض المتصفحات تتجاهل الخطوة بدون لمسة — نعيدها عند اللمسة التالية
    onBack();
  });
  function onBack() {
    if (rec) { rec.stop(); return; }
    const open = $$(".sheet-backdrop:not([hidden])");
    if (open.length) { closeOverlay(open[open.length - 1].id); return; }
    const up = { inventory: "branches", branches: "home", admin: "home" }[state.screen];
    if (up) go(up);
  }

  /* ---------- الكيبورد: نخلي الصفحة بطول المساحة الظاهرة عشان النتائج ما تختفي فوق ---------- */
  const vv = window.visualViewport;
  let fullH = 0;
  function fitViewport() {
    if (!vv) return;
    const h = Math.round(vv.height);
    fullH = Math.max(fullH, h);
    document.documentElement.style.setProperty("--app-h", h + "px");
    const kb = h < fullH * 0.78;           // الكيبورد مفتوح
    document.body.classList.toggle("kb", kb);
    if (kb && state.screen === "inventory") { window.scrollTo(0, 0); $("#table-wrap").scrollTop = 0; }
  }
  if (vv) {
    vv.addEventListener("resize", fitViewport);
    addEventListener("orientationchange", () => { fullH = 0; setTimeout(fitViewport, 300); });
    fitViewport();
  }

  /* ---------- إبقاء الشاشة شغالة ---------- */
  let wakeLock = null;
  async function keepAwake() {
    if (!("wakeLock" in navigator) || wakeLock || document.visibilityState !== "visible") return;
    try {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } catch {}
  }
  document.addEventListener("visibilitychange", keepAwake);
  document.addEventListener("pointerdown", keepAwake, true);

  /* ---------- تسجيل الدخول ---------- */
  $("#company-name").textContent = CFG.companyName;
  document.title = CFG.companyName;
  const loginErr = (m) => { $("#login-error").textContent = m; $("#login-error").hidden = false; };
  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const u = $("#login-user").value.trim().toLowerCase();
    const p = $("#login-pass").value;
    $("#login-error").hidden = true;
    if (CLOUD) {
      const btn = $("#login-form [type=submit]");
      btn.disabled = true;
      try { await window.DB.signIn(u, p); }
      catch (err) {
        loginErr(err.message === "bad" ? "اسم المستخدم أو كلمة المرور غير صحيحة"
          : err.message === "inactive" ? "الحساب موقوف — راجع المدير"
          : err.message === "net" ? "ما فيه اتصال بالإنترنت" : "تعذّر الدخول: " + err.message);
        return;
      } finally { btn.disabled = false; }
      startSync();
    } else {
      const found = allUsers().find((x) => x.username.toLowerCase() === u && x.password === p && x.active !== false);
      if (!found) { loginErr("اسم المستخدم أو كلمة المرور غير صحيحة"); return; }
      state.user = { username: found.username, name: found.name };
      store.set(LS_USER, state.user);   // يبقى مسجّل دخول دائماً حتى يضغط خروج
    }
    $("#login-pass").value = "";
    state.branch = null;
    go("home");
  });
  $("#pw-toggle").addEventListener("click", () => {
    const i = $("#login-pass");
    i.type = i.type === "password" ? "text" : "password";
  });
  $("#logout-btn").addEventListener("click", async () => {
    const pend = window.DB.getStatus().pending;
    if (pend && !confirm(`فيه ${pend} جرد ما انرفع لأن ما فيه إنترنت.\nبيبقى محفوظ على هذا الجوال، وينرفع لما ترجع تدخل بنفس حسابك وفيه نت.\nتطلع؟`)) return;
    if (!pend && !confirm("تسجيل الخروج من هذا الجهاز؟")) return;
    if (CLOUD) await window.DB.signOut();
    state.user = null; store.del(LS_USER); state.branch = null; go("home");
  });

  /* ---------- الرئيسية ---------- */
  $$("[data-go]").forEach((b) => b.addEventListener("click", () => go(b.dataset.go)));
  $$("[data-soon]").forEach((b) => b.addEventListener("click", () => toast("هذا القسم قيد التطوير")));
  $$("[data-back]").forEach((b) => b.addEventListener("click", () => go(b.dataset.back)));

  /* ---------- الفروع ---------- */
  function renderBranches() {
    const { branches } = state.data;
    const order = [...branches.keys()]
      .filter((bi) => scopeFor(branches[bi]).ok)
      .sort((a, b) => {
        const ia = CFG.branchOrder.indexOf(branches[a]), ib = CFG.branchOrder.indexOf(branches[b]);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });
    $("#branch-list").innerHTML = order.length ? order.map((bi) => {
      const its = scopedItems(bi);
      const done = its.filter((x) => countOf(x)).length;
      const pct = its.length ? Math.round((done / its.length) * 100) : 0;
      return `<button class="branch-card" data-b="${bi}">
        <span class="bc-icon"><svg viewBox="0 0 24 24"><path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6"/></svg></span>
        <span><strong>${esc(branchLabel(branches[bi]))}</strong><small>${fmt(its.length)} صنف · تم جرد ${fmt(done)}</small></span>
        <span class="bc-pct">${pct}%</span>
        <span class="bc-bar"><span style="width:${pct}%"></span></span>
      </button>`;
    }).join("") : `<div class="empty"><p>ما عندك فروع مخصصة — راجع المدير</p></div>`;
    $$("#branch-list .branch-card").forEach((c) => c.addEventListener("click", () => go("inv/" + c.dataset.b)));
  }

  /* ---------- شاشة الجرد ---------- */
  function openBranch(bi) {
    if (state.branch !== bi) {
      state.branch = bi;
      state.status = "todo";
      state.pins = [];
      $("#search").value = "";
      $$("#status-chips .chip").forEach((c) => c.classList.toggle("active", c.dataset.f === "todo"));
    }
    state.branchItems = scopedItems(bi);
    $("#inv-branch").textContent = branchLabel(state.data.branches[bi]);
    renderPins();
    applyFilter();
  }

  /* ===== محرك البحث =====
     - كتابة مباشرة       → "يحتوي على" (رقم الصنف أو اسمه)
     - نقطة قبل الكلمة    → "يبدأ بـ"   مثال: ".بواجي"
     - أكثر من كلمة       → كل كلمة شرط لازم يتحقق
     - "بواجي:"           → تثبيت "بواجي" كجزء منفصل، وتكمل البحث داخله
     - ":B001:B100:"      → تثبيت نطاق مواقع (أو زر الموقع 📍)
     - الجزء المثبت لا يُلغى إلا بزر ✕ الخاص به
  */
  function parseText(text) {
    if (!text || !text.trim()) return null;
    const toks = (text.match(/\.?[^\s.]+/g) || []).map((w) => ({
      w: w.replace(/^\./, ""),
      has: !w.startsWith("."),
    }));
    return toks.length ? toks : null;
  }

  const test = (hay, needle, has) => (has ? hay.includes(needle) : hay.startsWith(needle));
  function tokOk(it, tk) {
    const q = norm(tk.w);
    const numOk = () => { const qk = numKey(tk.w); return test(it.nn, q, tk.has) || (!!qk && test(it.nk, qk, tk.has)); };
    return numOk() || test(it.nm, q, tk.has);
  }
  const matchText = (it, toks) => !toks || toks.every((tk) => tokOk(it, tk));

  const cleanLoc = (s) => toEnDigits(s).toUpperCase().replace(/\s+/g, "");
  function makeLocTest(loc) {
    if (!loc || (!loc.from && !loc.to)) return null;
    const from = cleanLoc(loc.from), to = cleanLoc(loc.to);
    const pf = parseLoc(from), pt = parseLoc(to);
    if (!to) return (L) => cleanLoc(L).startsWith(from);
    if (!from) return (L) => cleanLoc(L).startsWith(to);
    if (pf && pt) {
      return (L) => { const pl = parseLoc(L); return !!pl && cmpLoc(pl, pf) >= 0 && cmpLoc(pl, pt) <= 0; };
    }
    return (L) => { const u = cleanLoc(L); return u >= from && (u <= to || u.startsWith(to)); };
  }

  function buildFilters() {
    const raw = $("#search").value;
    const locTests = [], textTests = [];
    let preview = false;
    for (const p of state.pins) {
      if (p.type === "loc") { const f = makeLocTest(p); if (f) locTests.push(f); }
      else textTests.push(parseText(p.raw));
    }
    const m = raw.match(/^:([^:]*)(?::([^:]*))?$/);
    if (m) {
      preview = true;
      const f = makeLocTest({ from: m[1].trim(), to: (m[2] ?? "").trim() });
      if (f) locTests.push(f);
    } else textTests.push(parseText(raw));
    return { locTests, textTests, preview };
  }

  function statusOk(it, searching) {
    const c = countOf(it);
    switch (state.status) {
      case "todo": return searching || !c;   // البحث يطلع المجرود كمان (بالأخضر)
      case "extra": return !!it.x;
      case "done": return !!c;
      case "diff": return !!c && diffOf(it, c) !== 0;
      default: return true;
    }
  }

  function applyFilter() {
    const { locTests, textTests, preview } = buildFilters();
    const searching = textTests.some(Boolean);
    let list = state.branchItems.filter((it) => {
      if (!statusOk(it, searching)) return false;
      if (locTests.length) { const L = effLoc(it) || ""; if (!locTests.every((f) => f(L))) return false; }
      return textTests.every((t) => matchText(it, t));
    });
    if (locTests.length) {
      list = list.slice().sort((a, b) => {
        const la = parseLoc(effLoc(a)), lb = parseLoc(effLoc(b));
        if (la && lb) return cmpLoc(la, lb) || a.n.localeCompare(b.n);
        return String(effLoc(a)).localeCompare(String(effLoc(b)));
      });
    }
    state.filtered = list;
    state.rendered = 0;
    $("#tbody").innerHTML = "";
    $("#table-wrap").scrollTop = 0;
    renderMore();
    $("#empty").hidden = list.length > 0;
    const q = $("#search").value.trim();
    $("#empty-add").hidden = !searching;
    $("#empty-msg").textContent = searching ? "الصنف غير موجود في مخزون الفرع" : state.status === "todo" ? "تم جرد كل الأصناف هنا ✓" : "لا توجد نتائج";
    $("#empty-add").dataset.q = /^[\s.]*$/.test(q) ? "" : q.replace(/^\./, "");
    const total = state.branchItems.length;
    $("#result-count").textContent =
      list.length === total ? `${fmt(total)} صنف` : `${fmt(list.length)} نتيجة من ${fmt(total)}`;
    updateProgress();
    updateSearchUI(preview);
  }

  function rowHTML(it) {
    const c = countOf(it);
    const L = effLoc(it);
    const diff = c && diffOf(it, c) !== 0;
    const multi = c && c.entries.length > 1;
    return `<div class="trow${c ? " done" : ""}" data-i="${it.i}">
      <span class="t-item"><span class="t-num">${esc(it.n)}${it.x ? '<i class="xb">زائد</i>' : ""}</span><span class="t-name">${esc(it.name)}</span></span>
      <span class="t-loc${c && (L || "") !== (it.loc || "") ? " changed" : ""}">${esc(L || "—")}</span>
      <span class="t-q"><span class="sys">${fmt(it.q)}</span>${resv(it) ? `<span class="rsv">محجوز ${fmt(resv(it))}</span>` : ""}${c ?`<span class="cnt${diff ? " d" : ""}">${multi ? "Σ " : "جرد "}${fmt(c.qty)}</span>` : ""}</span>
      <button class="edit-btn" aria-label="تعديل">${c
        ? '<svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>'
        : '<svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>'}</button>
    </div>`;
  }

  function renderMore() {
    const next = state.filtered.slice(state.rendered, state.rendered + PAGE);
    if (!next.length) return;
    $("#tbody").insertAdjacentHTML("beforeend", next.map(rowHTML).join(""));
    state.rendered += next.length;
  }
  new IntersectionObserver((es) => { if (es[0].isIntersecting) renderMore(); }, { root: $("#table-wrap"), rootMargin: "400px" })
    .observe($("#sentinel"));

  function updateProgress() {
    const total = state.branchItems.length;
    const done = state.branchItems.filter((x) => countOf(x)).length;
    $("#inv-progress-bar").style.width = total ? (done / total) * 100 + "%" : "0";
    $("#inv-progress-text").textContent = `${fmt(done)}/${fmt(total)}`;
  }

  /* ---------- واجهة شريط البحث ---------- */
  const searchEl = $("#search");
  let tmr;

  function extractPins() {
    let v = searchEl.value, changed = false;
    for (;;) {
      let m = v.match(/^:([^:]*):([^:]*):([\s\S]*)$/);
      if (m && (m[1].trim() || m[2].trim())) {
        state.pins.push({ type: "loc", from: cleanLoc(m[1]), to: cleanLoc(m[2]) });
        v = m[3]; changed = true; continue;
      }
      m = v.match(/^([^:]*\S[^:]*):([\s\S]*)$/);
      if (m) {
        state.pins.push({ type: "text", raw: m[1] });
        v = m[2]; changed = true; continue;
      }
      break;
    }
    if (changed) { searchEl.value = v; renderPins(); }
  }

  function onSearchChange() {
    extractPins();
    clearTimeout(tmr);
    tmr = setTimeout(applyFilter, 120);
    $("#search-clear").hidden = !searchEl.value;
  }
  searchEl.addEventListener("input", onSearchChange);
  searchEl.addEventListener("keydown", (e) => { if (e.key === "Enter") searchEl.blur(); });

  $("#search-clear").addEventListener("click", () => {
    searchEl.value = ""; $("#search-clear").hidden = true; applyFilter();
  });

  const PIN_ICONS = {
    loc: '<svg viewBox="0 0 24 24"><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
    text: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
  };
  const X_ICON = '<svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>';
  function renderPins() {
    // الكلمات المثبتة تبقى في البار السفلي
    $("#pins").innerHTML = state.pins.map((p, i) => p.type !== "text" ? "" :
      `<div class="pin text">${PIN_ICONS.text}<span class="pt"><i>${esc(p.raw.trim())}</i></span>
        <button data-pin="${i}" aria-label="إلغاء">${X_ICON}</button></div>`).join("");
    const pinsEl = $("#pins");
    pinsEl.scrollLeft = -pinsEl.scrollWidth;
    // نطاق المواقع يطلع فوق بجنب اسم الفرع عشان ما يضيّق البحث
    const li = state.pins.findIndex((p) => p.type === "loc");
    const lp = $("#loc-pin");
    lp.hidden = li < 0;
    $("#inv-tb-label").hidden = li >= 0;
    $("#loc-btn").classList.toggle("on", li >= 0);
    if (li >= 0) {
      const p = state.pins[li];
      lp.innerHTML = `<span class="lp-t" dir="ltr">${esc(p.from || "…")}${p.to ? ` → ${esc(p.to)}` : "…"}</span>
        <button data-pin="${li}" aria-label="إلغاء النطاق">${X_ICON}</button>`;
    }
  }
  function onPinClick(e) {
    const b = e.target.closest("[data-pin]");
    if (!b) return;
    state.pins.splice(+b.dataset.pin, 1);
    renderPins();
    applyFilter();
  }
  $("#pins").addEventListener("click", onPinClick);
  $("#loc-pin").addEventListener("click", (e) => {
    if (e.target.closest("[data-pin]")) return onPinClick(e);
    $("#loc-btn").click();       // الضغط على النطاق يفتحه للتعديل
  });

  function updateSearchUI(preview) {
    searchEl.placeholder = state.pins.length ? "ابحث داخل النتائج…"
      : preview ? "اكتب :من:إلى: ثم ابحث" : "ابحث برقم أو اسم الصنف…";
    $("#search-clear").hidden = !searchEl.value;
  }

  $$("#status-chips .chip").forEach((c) => c.addEventListener("click", () => {
    state.status = c.dataset.f;
    $$("#status-chips .chip").forEach((x) => x.classList.toggle("active", x === c));
    applyFilter();
  }));

  $("#cam-btn").addEventListener("click", () => toast("مسح الباركود: بانتظار قاعدة الباركود"));

  /* ---------- النوافذ المنبثقة ---------- */
  function openOverlay(id) { $("#" + id).hidden = false; }
  function closeOverlay(id) {
    if (id === "imp-backdrop" && impBusy) return;     // ما نقفل النافذة وقت الرفع
    $("#" + id).hidden = true;
    if (id === "sheet-backdrop") {
      const it = state.editing;
      state.editing = null;
      if (it?.x && !countOf(it)) { removeExtraIfEmpty(it); applyFilter(); }   // صنف زائد انضاف بدون جرد
      if (state.needReload) setTimeout(runSync, 300);
    }
  }
  $$(".sheet-backdrop").forEach((bd) => bd.addEventListener("click", (e) => {
    if (e.target === bd) closeOverlay(bd.id);
  }));
  $$("[data-close]").forEach((b) => b.addEventListener("click", () => closeOverlay(b.dataset.close)));

  /* ---------- نطاق المواقع (من / إلى) ---------- */
  const locFrom = $("#loc-from"), locTo = $("#loc-to");
  function locPrefixes() {
    const g = new Map();
    for (const it of state.branchItems) {
      const raw = cleanLoc(effLoc(it)).match(/^[A-Z]+-?\d+/)?.[0];
      const p = parseLoc(raw);
      if (!p) continue;
      const cur = g.get(p.p);
      if (!cur) g.set(p.p, { p: p.p, min: p.n, minS: raw, max: p.n, maxS: raw, cnt: 1 });
      else {
        cur.cnt++;
        if (p.n < cur.min) { cur.min = p.n; cur.minS = raw; }
        if (p.n > cur.max) { cur.max = p.n; cur.maxS = raw; }
      }
    }
    return [...g.values()].sort((a, b) => (a.p < b.p ? -1 : 1));
  }
  $("#loc-btn").addEventListener("click", () => {
    searchEl.blur();
    const curLoc = state.pins.find((p) => p.type === "loc");
    locFrom.value = curLoc?.from || ""; locTo.value = curLoc?.to || "";
    $("#loc-prefixes").innerHTML = locPrefixes().map((g) =>
      `<button type="button" class="lp" data-from="${esc(g.minS)}" data-to="${esc(g.maxS)}">
        <b>${esc(g.p)}</b><small dir="ltr">${esc(g.minS)} → ${esc(g.maxS)}</small><small>${fmt(g.cnt)} صنف</small></button>`).join("")
      || `<p class="muted">لا توجد مواقع</p>`;
    updateLocPreview();
    openOverlay("loc-backdrop");
    setTimeout(() => locFrom.focus(), 250);
  });
  $("#loc-prefixes").addEventListener("click", (e) => {
    const b = e.target.closest(".lp"); if (!b) return;
    locFrom.value = b.dataset.from; locTo.value = b.dataset.to;
    updateLocPreview();
    locFrom.focus(); locFrom.select();
  });
  function updateLocPreview() {
    const f = makeLocTest({ from: locFrom.value, to: locTo.value });
    const n = f ? state.branchItems.filter((it) => f(effLoc(it) || "")).length : 0;
    $("#loc-preview").textContent = f ? `${fmt(n)} صنف في هذا النطاق` : "اكتب الموقع";
    $("#loc-apply").disabled = !f;
  }
  [locFrom, locTo].forEach((i) => {
    i.addEventListener("input", updateLocPreview);
    i.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (i === locFrom) locTo.focus(); else $("#loc-apply").click();
    });
  });
  $("#loc-apply").addEventListener("click", () => {
    const from = cleanLoc(locFrom.value), to = cleanLoc(locTo.value);
    if (!from && !to) return;
    state.pins = state.pins.filter((p) => p.type !== "loc");   // نطاق واحد في المرة
    state.pins.unshift({ type: "loc", from: from || to, to: from ? to : "" });
    closeOverlay("loc-backdrop");
    renderPins();
    applyFilter();
  });

  /* ---------- البحث بالصوت (بدون كيبورد) ---------- */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  const micBtn = $("#mic-btn");
  function cleanSpeech(s) {
    return s
      .replace(/نقطتين|نقطتان/g, ":")
      .replace(/\s*(نقطه|نقطة)\s*/g, " .")
      .replace(/[؟?!،,]+/g, "")
      .replace(/\.\s*$/, "")
      .trim();
  }
  micBtn.addEventListener("click", () => {
    if (rec) { rec.stop(); return; }
    if (!SR) { toast("المتصفح لا يدعم الكتابة بالصوت — استخدم Chrome"); return; }
    if (!window.isSecureContext) { toast("الصوت يحتاج رابط https — يشتغل بعد الرفع على GitHub"); return; }
    searchEl.blur();
    const base = searchEl.value;
    const sep = base && !/\s$/.test(base) ? " " : "";
    rec = new SR();
    rec.lang = "ar-SA";
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (e) => {
      let txt = "";
      for (const r of e.results) txt += r[0].transcript;
      searchEl.value = base + sep + cleanSpeech(txt);
      onSearchChange();
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed") toast("اسمح للمتصفح باستخدام المايكروفون");
      else if (e.error !== "no-speech" && e.error !== "aborted") toast("تعذّر التعرف على الصوت");
    };
    rec.onend = () => { rec = null; micBtn.classList.remove("on"); };
    micBtn.classList.add("on");
    try { rec.start(); } catch { rec = null; micBtn.classList.remove("on"); }
  });

  /* ---------- نافذة الجرد ---------- */
  $("#tbody").addEventListener("click", (e) => {
    const row = e.target.closest(".trow");
    if (!row) return;
    openSheet(state.data.items[+row.dataset.i]);
  });

  const cnt = $("#sh-count");
  function openSheet(it) {
    state.editing = it;
    const c = countOf(it);
    $("#sh-num").textContent = it.n;
    $("#sh-name").textContent = it.name;
    $("#sh-q").textContent = fmt(it.q);
    $("#sh-r").textContent = fmt(it.r);
    const rn = $("#sh-rnote");
    rn.hidden = !resv(it) || isBlind();
    rn.textContent = `المحجوز عند الزبون (مو بالرف) — المفروض بالرف: ${fmt(it.q - resv(it))}، ونضيف المحجوز على جردك`;
    $("#sh-loc0").textContent = it.loc || "—";
    cnt.value = "";
    cnt.placeholder = "0";
    $("#sh-loc").value = effLoc(it) || "";
    $("#sh-note").value = c?.note || "";
    $("#sh-reset").hidden = !(c && isAdmin());
    renderEntries();
    updateDiff();
    openOverlay("sheet-backdrop");
    setTimeout(() => cnt.focus(), 250);
  }
  const closeSheet = () => closeOverlay("sheet-backdrop");

  function renderEntries() {
    const it = state.editing; const c = countOf(it);
    const box = $("#sh-entries");
    $("#sh-count-label").textContent = c ? "إضافة كمية (تُجمع مع الجرد السابق)" : "كمية الجرد";
    if (!c) { box.hidden = true; return; }
    const u = me();
    box.hidden = false;
    box.innerHTML = `<div class="ent-head"><span>الجرد السابق</span><b>المجموع ${fmt(c.qty)}</b></div>` +
      c.entries.map((e, i) => {
        const canDel = isAdmin() || (e.u && e.u === myId());
        return `<div class="ent"><b>${fmt(e.qty)}</b><span>${esc(e.by || "—")} · ${fmtTime(e.at)}</span>${
          canDel ? `<button type="button" data-ent="${i}" aria-label="حذف هذا الإدخال"><svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg></button>` : ""}</div>`;
      }).join("");
  }
  $("#sh-entries").addEventListener("click", (e) => {
    const b = e.target.closest("[data-ent]"); if (!b) return;
    const it = state.editing; const key = keyOf(it); const c = state.counts[key];
    const en = c.entries[+b.dataset.ent];
    if (!confirm(`حذف إدخال الكمية ${en.qty} (${en.by || ""})؟`)) return;
    c.entries.splice(+b.dataset.ent, 1);
    pushDel(en.id);
    if (!c.entries.length) delete state.counts[key]; else normCount(c);
    saveCounts();
    if (!state.counts[key] && it.x) { removeExtraIfEmpty(it); closeSheet(); applyFilter(); return; }
    refreshRow(it);
    renderEntries(); updateDiff();
    $("#sh-reset").hidden = !(state.counts[key] && isAdmin());
  });

  function updateDiff() {
    const it = state.editing; if (!it) return;
    const el = $("#sh-diff");
    const prev = countOf(it)?.qty || 0;
    const hasPrev = !!countOf(it);
    const r = resv(it);
    const withR = (shelf) => (r ? `بالرف ${fmt(shelf)} + محجوز ${fmt(r)} = ${fmt(shelf + r)} · ` : "");
    if (cnt.value === "") {
      const d0 = prev + r - it.q;
      el.textContent = hasPrev && !isBlind() ? withR(prev) + diffText(d0) : "";
      el.className = "diff " + (hasPrev && !isBlind() ? (d0 === 0 ? "ok" : "bad") : "");
      return;
    }
    const total = prev + +cnt.value;
    const sum = hasPrev ? `المجموع ${fmt(prev)} + ${fmt(+cnt.value)} = ${fmt(total)}` : "";
    if (isBlind()) { el.textContent = sum; el.className = "diff"; return; }
    const d = total + r - it.q;
    el.textContent = (sum ? sum + " · " : "") + withR(total) + diffText(d);
    el.className = "diff " + (d === 0 ? "ok" : "bad");
  }
  const diffText = (d) => (d === 0 ? "✓ مطابق للنظام" : d > 0 ? `زيادة ${fmt(d)} عن النظام` : `نقص ${fmt(-d)} عن النظام`);

  cnt.addEventListener("input", updateDiff);
  $("#qty-plus").addEventListener("click", () => { cnt.value = Math.max(0, (+cnt.value || 0) + 1); updateDiff(); });
  $("#qty-minus").addEventListener("click", () => { cnt.value = Math.max(0, (+cnt.value || 0) - 1); updateDiff(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { const open = $$(".sheet-backdrop:not([hidden])"); if (open.length) closeOverlay(open.at(-1).id); }
    if (e.key === "Enter" && state.editing && e.target === cnt) { e.preventDefault(); save(); }
  });

  function save() {
    const it = state.editing; if (!it) return;
    const key = keyOf(it);
    const c = state.counts[key];
    const v = toEnDigits(cnt.value).trim();
    const loc = cleanLoc($("#sh-loc").value) || $("#sh-loc").value.trim();
    const note = $("#sh-note").value.trim();
    if (v === "") {
      if (!c) { cnt.focus(); toast("اكتب كمية الجرد"); return; }
      c.loc = loc; c.note = note;            // تعديل الموقع/الملاحظة فقط
    } else {
      if (!Number.isFinite(+v) || +v < 0) { cnt.focus(); toast("كمية غير صحيحة"); return; }
      const u = me();
      const entry = { id: window.DB.uuid(), qty: +v, by: u?.name, u: myId(), at: Date.now() };
      commitExtra(it);
      if (c) { c.entries.push(entry); c.loc = loc; c.note = note; normCount(c); }
      else state.counts[key] = normCount({ entries: [entry], loc, note });
      pushEntry(it, entry);
    }
    const cc = state.counts[key];
    if (!c || c.loc !== it.loc || note || v === "") pushMeta(it, cc);
    saveCounts();
    refreshRow(it);
    closeSheet();
    navigator.vibrate?.(30);
    toast(c && v !== "" ? `✓ أُضيفت — المجموع ${fmt(state.counts[key].qty)}` : "✓ تم حفظ الجرد");
  }
  $("#sh-save").addEventListener("click", save);
  $("#sh-reset").addEventListener("click", () => {
    const it = state.editing; if (!it) return;
    if (!confirm("حذف كل الجرد لهذا الصنف؟")) return;
    (countOf(it)?.entries || []).forEach((e) => pushDel(e.id));
    delete state.counts[keyOf(it)];
    saveCounts();
    if (it.x) { removeExtraIfEmpty(it); closeSheet(); applyFilter(); return; }
    refreshRow(it);
    closeSheet();
  });

  /* ---------- إضافة صنف زائد ---------- */
  const xNum = $("#x-num");
  function openExtra(q = "") {
    searchEl.blur();
    const isNum = /\d/.test(q) && !/[ء-ي]/.test(q);
    xNum.value = isNum ? q.toUpperCase() : "";
    $("#x-name").value = isNum ? "" : q;
    $("#x-loc").value = state.pins.find((p) => p.type === "loc")?.from || "";
    $("#x-hint").textContent = "";
    $("#x-sugg").innerHTML = "";
    if (isNum) xLookup();
    openOverlay("extra-backdrop");
    setTimeout(() => (isNum ? $("#x-name") : xNum).focus(), 250);
  }
  $("#empty-add").addEventListener("click", (e) => openExtra(e.currentTarget.dataset.q || ""));
  $("#extra-btn").addEventListener("click", () => openExtra(""));
  let suggT, suggSeq = 0;
  function xLookup() {
    const n = toEnDigits(xNum.value).trim().toUpperCase().replace(/\s+/g, "");
    const hit = n && state.data.items.find((it) => it.b === state.branch && !it.gone && it.n.toUpperCase() === n);
    $("#x-hint").textContent = hit ? `موجود بالفرع: ${hit.name || ""} — المتابعة تفتحه للجرد` : "";
    // البحث في الدليل الكامل (يحتاج إنترنت)
    clearTimeout(suggT);
    const seq = ++suggSeq;
    if (hit || n.length < 3) { $("#x-sugg").innerHTML = ""; return; }
    suggT = setTimeout(async () => {
      let list = [];
      try { list = await window.DB.searchCatalog(n, 6); } catch {}
      if (seq !== suggSeq) return;
      const exact = list.find((r) => r.n === n);
      if (exact && !$("#x-name").value.trim()) $("#x-name").value = exact.name;
      $("#x-sugg").innerHTML = list.filter((r) => r !== exact).map((r) =>
        `<button type="button" data-n="${esc(r.n)}" data-name="${esc(r.name)}"><b>${esc(r.n)}</b><span>${esc(r.name)}</span></button>`).join("");
    }, 250);
  }
  xNum.addEventListener("input", xLookup);
  $("#x-sugg").addEventListener("click", (e) => {
    const b = e.target.closest("[data-n]"); if (!b) return;
    xNum.value = b.dataset.n; $("#x-name").value = b.dataset.name;
    $("#x-sugg").innerHTML = "";
    xLookup();
  });
  $("#x-go").addEventListener("click", () => {
    const n = toEnDigits(xNum.value).trim().toUpperCase().replace(/\s+/g, "");
    if (!n) { xNum.focus(); toast("اكتب رقم الصنف"); return; }
    const bname = state.data.branches[state.branch];
    let it = state.data.items.find((x) => x.b === state.branch && !x.gone && x.n.toUpperCase() === n);
    if (!it) {
      const u = me();
      const rec = { b: bname, n, name: $("#x-name").value.trim(), loc: cleanLoc($("#x-loc").value), by: u?.name, u: myId(), at: Date.now() };
      const ex = store.get(LS_EXTRAS, {});
      ex[`${bname}|${n}`] = rec;
      store.set(LS_EXTRAS, ex);
      it = addExtraItem(rec);
      it.gone = false;
      if (!state.branchItems.includes(it)) state.branchItems.push(it);
    }
    closeOverlay("extra-backdrop");
    openSheet(it);
  });
  $("#x-name").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#x-go").click(); });

  function refreshRow(it) {
    const row = $(`#tbody .trow[data-i="${it.i}"]`);
    if (row) {
      row.outerHTML = rowHTML(it);
      $(`#tbody .trow[data-i="${it.i}"]`)?.classList.add("flash");
    } else if (it.x) applyFilter();
    updateProgress();
  }

  /* ---------- المزامنة: نطبّق جرد الموظفين الثانيين ---------- */
  function applyChanges(ch) {
    const touched = new Set();
    let extrasChanged = false;
    for (const [id, branch, n, qty, uid, by, at, deleted] of ch.entries) {
      const key = `${branch}|${n}`;
      let c = state.counts[key];
      if (deleted) {
        const i = c ? c.entries.findIndex((e) => e.id === id) : -1;
        if (i >= 0) {
          c.entries.splice(i, 1); touched.add(key);
          if (!c.entries.length) delete state.counts[key]; else normCount(c);
        }
        continue;
      }
      if (!c) c = state.counts[key] = { entries: [], note: "" };
      const ex = c.entries.find((e) => e.id === id);
      if (ex) { if (ex.qty !== +qty) { ex.qty = +qty; normCount(c); touched.add(key); } continue; }
      c.entries.push({ id, qty: +qty, by, u: uid, at: +at });
      c.entries.sort((a, b) => a.at - b.at);
      normCount(c); touched.add(key);
    }
    for (const [branch, n, loc, note, at] of ch.meta) {
      const key = `${branch}|${n}`;
      const c = state.counts[key];
      if (!c || (c.metaAt && c.metaAt > at)) continue;
      if (c.loc !== (loc ?? undefined) || (c.note || "") !== (note || "")) touched.add(key);
      c.loc = loc ?? undefined; c.note = note || ""; c.metaAt = at;
    }
    if (ch.extras.length) {
      const exs = store.get(LS_EXTRAS, {});
      for (const [branch, n, name, loc, by, uid, at, deleted] of ch.extras) {
        const key = `${branch}|${n}`;
        if (deleted) {
          if (!exs[key]) continue;
          delete exs[key]; extrasChanged = true;
          const bi = state.data?.branches.indexOf(branch);
          const it = bi >= 0 ? state.data.items.find((x) => x.x && x.b === bi && x.n === n) : null;
          if (it && !state.counts[key]) it.gone = true;
        } else {
          if (exs[key]?.synced && exs[key].name === name && exs[key].loc === loc) continue;
          const rec = { b: branch, n, name, loc, by, u: uid, at: +at, synced: true };
          exs[key] = rec; extrasChanged = true;
          if (state.data) {
            if (!state.data.branches.includes(branch)) { state.needReload = true; continue; }
            const it = addExtraItem(rec);
            if (it) { it.gone = false; if (it.x) { it.name = name; it.nm = norm(name); } }
          }
        }
      }
      store.set(LS_EXTRAS, exs);
    }
    if (touched.size || extrasChanged) saveCounts();
    if (ch.itemsChanged || state.needReload) {
      if (state.editing) state.needReload = true;
      else { state.needReload = false; reloadItems().then(() => toast("✓ تم تحديث المخزون من الإدارة")).catch(() => {}); return; }
    }
    if (!state.data || (!touched.size && !extrasChanged)) return;
    // تحديث الشاشة الحالية بدون ما نرجّع المستخدم لفوق
    if (state.screen === "inventory") {
      if (extrasChanged && !state.editing) {
        state.branchItems = scopedItems(state.branch);
        const top = $("#table-wrap").scrollTop;
        applyFilter();
        $("#table-wrap").scrollTop = top;
      } else {
        for (const it of state.branchItems) if (touched.has(keyOf(it))) refreshRow(it);
        updateProgress();
      }
      if (state.editing && touched.has(keyOf(state.editing))) { renderEntries(); updateDiff(); }
    } else if (state.screen === "branches") renderBranches();
    else if (state.screen === "admin" && adminTab === "stats") renderStats();
  }

  let syncT, syncTick = 0;
  function runSync() {
    if (!CLOUD || !window.DB.profile || document.visibilityState !== "visible") return;
    window.DB.sync(applyChanges);
    // كل كم دقيقة نتأكد إن الحساب ما انوقف أو تغيّرت صلاحياته
    if (++syncTick % 6 === 0) window.DB.refreshProfile().then((p) => {
      if (p && !p.active) { window.DB.signOut(); go("home"); return; }
      document.body.classList.toggle("blind", isBlind());
    }).catch(() => {});
  }
  function startSync() {
    if (!CLOUD) return;
    clearInterval(syncT);
    runSync();
    syncT = setInterval(runSync, 30000);
  }
  document.addEventListener("visibilitychange", runSync);

  // مؤشر الاتصال
  let syncTxt = "";
  function renderSync(s) {
    if (!s.cloud) return;
    if (s.needLogin && me()) {
      // الجلسة انتهت: نطلب دخول من جديد — الجرد اللي ما انرفع محفوظ وينرفع بعد الدخول
      window.DB.expire();
      $("#login-error").textContent = `انتهت جلسة الدخول — سجّل دخول مرة ثانية${s.pending ? ` (عندك ${s.pending} جرد محفوظ بينرفع بعد الدخول)` : ""}`;
      $("#login-error").hidden = false;
      go("home");
    }
    const st = s.error && s.pending ? "err" : s.pending ? "pend" : !s.online ? "off" : "ok";
    syncTxt = s.pending ? `${s.pending} بانتظار الرفع${s.online ? "…" : " (بدون إنترنت)"}${s.error ? " — " + s.error : ""}`
      : !s.online ? "غير متصل — الجرد ينحفظ على الجهاز" : "متصل ✓ كل الجرد مرفوع";
    $$(".sync-ind").forEach((el) => { el.hidden = false; el.dataset.st = st; el.title = syncTxt; const t = el.querySelector(".st"); if (t) t.textContent = syncTxt; });
  }
  // الضغط على النقطة: يعرض الحالة بالتفصيل ويعيد المحاولة
  $$(".sync-ind").forEach((el) => el.addEventListener("click", () => { toast(syncTxt, 4000); runSync(); }));
  window.DB.onStatus(renderSync);
  renderSync(window.DB.getStatus());

  /* ---------- تصدير ---------- */
  function download(name, content, type) {
    const blob = new Blob([content], { type });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }
  const today = () => new Date().toISOString().slice(0, 10);
  function countRows(items, blind) {
    const head = ["الفرع", "رقم الصنف", "اسم الصنف", "النوع", "الموقع بالنظام", "الموقع بعد الجرد",
      ...(blind ? [] : ["المتوفر", "المحجوز"]), "الجرد (بالرف)", ...(blind ? [] : ["الجرد النهائي (+المحجوز)", "الفرق"]),
      "تفصيل الإدخالات", "ملاحظات", "آخر جرد بواسطة", "التاريخ"];
    const rows = items.filter((it) => !it.gone).map((it) => {
      const c = countOf(it);
      return [branchLabel(state.data.branches[it.b]), it.n, it.name, it.x ? "زائد (غير موجود بالنظام)" : "", it.loc, c?.loc ?? "",
        ...(blind ? [] : [it.q, it.r]), c?.qty ?? "", ...(blind ? [] : [c ? finalOf(it, c) : "", c ? diffOf(it, c) : ""]),
        c ? c.entries.map((e) => `${e.qty} (${e.by || ""})`).join(" + ") : "",
        c?.note ?? "", c?.by ?? "", c ? new Date(c.at).toLocaleString("en-GB") : ""];
    });
    return [head, ...rows];
  }
  function exportCSV(items, name, blind) {
    const csv = countRows(items, blind).map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
    download(name, "﻿" + csv, "text/csv;charset=utf-8");
  }
  $("#export-btn").addEventListener("click", () => {
    exportCSV(state.branchItems, `جرد-${branchLabel(state.data.branches[state.branch])}-${today()}.csv`, isBlind());
  });

  // ملف جرد (JSON) يرسله الموظف للمدير ليدمجه في جهازه
  function exportBackup(withUsers) {
    const u = me();
    const data = { type: "inv-backup", v: 3, at: Date.now(), by: u?.name, counts: state.counts, extras: store.get(LS_EXTRAS, {}) };
    if (withUsers) data.users = store.get(LS_USERS, []);
    download(`جرد-${u?.username || "user"}-${today()}.json`, JSON.stringify(data), "application/json");
  }
  $("#backup-card").addEventListener("click", () => exportBackup(false));

  /* ---------- لوحة التحكم (للمدير) ---------- */
  let adminTab = "stats";
  $$("#admin-tabs button").forEach((b) => b.addEventListener("click", () => { adminTab = b.dataset.tab; renderAdmin(); }));

  function renderAdmin() {
    $$("#admin-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === adminTab));
    ["stats", "users", "data"].forEach((t) => ($("#tab-" + t).hidden = t !== adminTab));
    if (adminTab === "stats") renderStats();
    if (adminTab === "users") { renderUsers(); if (CLOUD) loadProfiles(); }
    if (adminTab === "data") renderDataTab();
  }
  async function loadProfiles() {
    try { state.profiles = await window.DB.listProfiles(); }
    catch (e) { toast("تعذّر تحميل المستخدمين: " + e.message, 3000); return; }
    if (adminTab === "users") renderUsers();
  }

  function renderStats() {
    const { branches, items } = state.data;
    const per = branches.map(() => ({ total: 0, done: 0, diff: 0, plus: 0, minus: 0, extra: 0 }));
    for (const it of items) {
      if (it.gone) continue;
      const s = per[it.b]; s.total++;
      if (it.x) s.extra++;
      const c = countOf(it);
      if (c) {
        s.done++;
        const d = diffOf(it, c);
        if (d !== 0) { s.diff++; if (d > 0) s.plus++; else s.minus++; }
      }
    }
    const users = new Map();
    for (const c of Object.values(state.counts)) {
      for (const e of c.entries) {
        const k = e.u || e.by || "—";
        const x = users.get(k) || { name: e.by || k, entries: 0, qty: 0, last: 0, today: 0 };
        x.entries++; x.qty += +e.qty || 0; x.last = Math.max(x.last, e.at || 0);
        if (new Date(e.at).toDateString() === new Date().toDateString()) x.today++;
        users.set(k, x);
      }
    }
    const order = [...branches.keys()].sort((a, b) => CFG.branchOrder.indexOf(branches[a]) - CFG.branchOrder.indexOf(branches[b]));
    $("#tab-stats").innerHTML =
      `<h4 class="sec">الفروع</h4>` +
      order.map((bi) => {
        const s = per[bi]; const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
        return `<div class="stat-card">
          <div class="sc-top"><strong>${esc(branchLabel(branches[bi]))}</strong><span class="bc-pct">${pct}%</span></div>
          <span class="bc-bar"><span style="width:${pct}%"></span></span>
          <div class="sc-nums">
            <div><b>${fmt(s.done)}</b><small>تم جرده</small></div>
            <div><b>${fmt(s.total - s.done)}</b><small>متبقي</small></div>
            <div class="w"><b>${fmt(s.diff)}</b><small>فيه فرق</small></div>
            <div><b class="ok">+${fmt(s.plus)}</b><small>زيادة</small></div>
            <div><b class="bad">−${fmt(s.minus)}</b><small>نقص</small></div>
            <div><b>${fmt(s.extra)}</b><small>صنف زائد</small></div>
          </div>
        </div>`;
      }).join("") +
      `<h4 class="sec">نشاط الموظفين <small class="muted">(على هذا الجهاز)</small></h4>` +
      ([...users.values()].sort((a, b) => b.last - a.last).map((x) => `<div class="urow">
          <span class="avatar">${esc((x.name || "?").trim()[0] || "?")}</span>
          <span class="u-main"><strong>${esc(x.name)}</strong><small>آخر جرد ${x.last ? fmtTime(x.last) : "—"}</small></span>
          <span class="u-num"><b>${fmt(x.entries)}</b><small>إدخال · اليوم ${fmt(x.today)}</small></span>
        </div>`).join("") || `<p class="muted pad">لا يوجد جرد بعد</p>`);
  }

  function scopeSummary(u) {
    if (u.role === "admin") return "مدير — كل الصلاحيات";
    if (!u.scope?.length) return "كل الفروع · كل المواقع";
    return u.scope.map((r) => {
      const b = r.b ? branchLabel(r.b) : "كل الفروع";
      const l = r.from || r.to ? ` ${r.from || ""}${r.to ? " → " + r.to : "…"}` : "";
      return b + l;
    }).join(" ، ");
  }
  function renderUsers() {
    const list = allUsers();
    $("#user-list").innerHTML = list.map((u) => `<button class="urow ucard${u.active === false ? " off" : ""}" data-u="${esc(u.username)}">
        <span class="avatar${u.role === "admin" ? " adm" : ""}">${esc((u.name || "?").trim()[0] || "?")}</span>
        <span class="u-main"><strong>${esc(u.name)} ${u.role === "admin" ? '<i class="badge">مدير</i>' : ""}${u.blind ? '<i class="badge b2">جرد أعمى</i>' : ""}${u.active === false ? '<i class="badge b3">موقوف</i>' : ""}</strong>
          <small dir="ltr" class="uname">@${esc(u.username)}</small>
          <small>${esc(scopeSummary(u))}</small></span>
        <svg class="chev" viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>
      </button>`).join("");
  }
  $("#user-list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-u]"); if (!b) return;
    openUserSheet(findUser(b.dataset.u));
  });
  $("#add-user").addEventListener("click", () => openUserSheet(null));

  // محرر المستخدم
  let editingUser = null;
  function branchOptions(sel) {
    const { branches } = state.data;
    return `<option value="">كل الفروع</option>` + CFG.branchOrder.concat(branches.filter((b) => !CFG.branchOrder.includes(b)))
      .filter((b) => branches.includes(b))
      .map((b) => `<option value="${esc(b)}"${b === sel ? " selected" : ""}>${esc(branchLabel(b))}</option>`).join("");
  }
  function scopeRowHTML(r = {}) {
    return `<div class="scope-row">
      <select class="sr-b">${branchOptions(r.b || "")}</select>
      <input class="sr-from" dir="ltr" placeholder="من A001" value="${esc(r.from || "")}" autocapitalize="characters" autocomplete="off">
      <input class="sr-to" dir="ltr" placeholder="إلى A105" value="${esc(r.to || "")}" autocapitalize="characters" autocomplete="off">
      <button type="button" class="sr-del" aria-label="حذف"><svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
    </div>`;
  }
  function openUserSheet(u) {
    editingUser = u;
    $("#us-title").textContent = u ? "تعديل مستخدم" : "مستخدم جديد";
    $("#us-name").value = u?.name || "";
    $("#us-username").value = u?.username || "";
    $("#us-username").disabled = !!u;
    $("#us-pass").value = u?.password || "";
    $("#us-role").value = u?.role || "user";
    $("#us-blind").checked = !!u?.blind;
    $("#us-active").checked = u ? u.active !== false : true;
    $("#us-scope").innerHTML = (u?.scope || []).map(scopeRowHTML).join("");
    const self = CLOUD && u && u.id === me()?.id;     // المدير ما يقدر يوقف أو يحذف نفسه
    $("#us-delete").hidden = !u || !!u.builtin || self;
    $("#us-builtin").hidden = !u?.builtin;
    ["#us-name", "#us-pass", "#us-role", "#us-active"].forEach((s) => ($(s).disabled = !!u?.builtin));
    if (self) { $("#us-role").disabled = true; $("#us-active").disabled = true; }
    $("#us-pass").placeholder = CLOUD && u ? "اتركها فاضية = بدون تغيير" : CLOUD ? "6 أحرف على الأقل" : "";
    $("#us-error").hidden = true;
    updateRoleUI();
    openOverlay("user-backdrop");
  }
  function updateRoleUI() { $("#us-scope-box").hidden = $("#us-role").value === "admin"; }
  $("#us-role").addEventListener("change", updateRoleUI);
  $("#us-add-scope").addEventListener("click", () => {
    $("#us-scope").insertAdjacentHTML("beforeend", scopeRowHTML());
    $("#us-scope .scope-row:last-child .sr-from").focus();
  });
  $("#us-scope").addEventListener("click", (e) => {
    const d = e.target.closest(".sr-del"); if (d) d.closest(".scope-row").remove();
  });
  $("#us-save").addEventListener("click", async () => {
    const err = (m) => { $("#us-error").textContent = m; $("#us-error").hidden = false; };
    if (editingUser?.builtin) { closeOverlay("user-backdrop"); return; }
    const name = $("#us-name").value.trim();
    const username = $("#us-username").value.trim();
    const password = $("#us-pass").value;
    if (!name) return err("اكتب الاسم");
    if (!/^[A-Za-z0-9_.\-]{2,}$/.test(username)) return err("اسم المستخدم: حروف إنجليزية أو أرقام (حرفين على الأقل)");
    const minPw = CLOUD ? 6 : 3;
    if ((!CLOUD || !editingUser || password) && password.length < minPw) return err(`كلمة المرور قصيرة (${minPw} أحرف على الأقل)`);
    if (!editingUser && findUser(username)) return err("اسم المستخدم موجود مسبقاً");
    const role = $("#us-role").value;
    const scope = role === "admin" ? [] : $$("#us-scope .scope-row").map((r) => ({
      b: r.querySelector(".sr-b").value,
      from: cleanLoc(r.querySelector(".sr-from").value),
      to: cleanLoc(r.querySelector(".sr-to").value),
    })).filter((r) => r.b || r.from || r.to);
    const user = { username, name, password, role, blind: role !== "admin" && $("#us-blind").checked, active: $("#us-active").checked, scope };
    if (CLOUD) {
      const btn = $("#us-save"); btn.disabled = true;
      try {
        const fields = { name, role, blind: user.blind, active: user.active, scope };
        if (editingUser) {
          await window.DB.updateProfile(editingUser.id, fields);
          if (password) await window.DB.setPassword(editingUser.id, password);
        } else await window.DB.createUser({ username, password, ...fields });
      } catch (e) {
        return err(e.message === "exists" ? "اسم المستخدم موجود مسبقاً"
          : /too short/i.test(e.message) ? "كلمة المرور قصيرة (6 أحرف على الأقل)"
          : "تعذّر الحفظ: " + e.message);
      } finally { btn.disabled = false; }
      closeOverlay("user-backdrop");
      toast(editingUser ? "✓ تم تحديث المستخدم" : "✓ تمت إضافة المستخدم");
      loadProfiles();
      return;
    }
    const list = store.get(LS_USERS, []).filter((x) => x.username.toLowerCase() !== username.toLowerCase());
    list.push(user);
    store.set(LS_USERS, list);
    closeOverlay("user-backdrop");
    toast(editingUser ? "✓ تم تحديث المستخدم" : "✓ تمت إضافة المستخدم");
    renderUsers();
  });
  $("#us-delete").addEventListener("click", async () => {
    const u = editingUser; if (!u || u.builtin) return;
    if (!confirm(`حذف المستخدم ${u.name}؟ (الجرد اللي سواه يبقى)`)) return;
    if (CLOUD) {
      try { await window.DB.deleteUser(u.id); } catch (e) { toast("تعذّر الحذف: " + e.message, 3500); return; }
      closeOverlay("user-backdrop");
      loadProfiles();
      return;
    }
    store.set(LS_USERS, store.get(LS_USERS, []).filter((x) => x.username.toLowerCase() !== u.username.toLowerCase()));
    closeOverlay("user-backdrop");
    renderUsers();
  });

  /* ---------- البيانات: رفع وتحديث المخزون وسحب الجرد ---------- */
  function renderDataTab() {
    const { branches, items } = state.data;
    const per = branches.map(() => ({ n: 0, done: 0 }));
    for (const it of items) if (!it.gone && !it.x) { per[it.b].n++; if (countOf(it)) per[it.b].done++; }
    const ver = state.data.version;
    const verTxt = ver && /^\d{14}/.test(ver) ? `${ver.slice(0, 4)}-${ver.slice(4, 6)}-${ver.slice(6, 8)} ${ver.slice(8, 10)}:${ver.slice(10, 12)}` : "";
    $("#ad-info").innerHTML = branches.map((b, i) => `<div><b>${fmt(per[i].n)}</b><small>${esc(branchLabel(b))}</small></div>`).join("") +
      `<div><b id="ad-cat">…</b><small>الدليل الكامل</small></div>` +
      `<div class="full">${CLOUD ? "مربوط بالسيرفر ✓" : "وضع محلي (بدون سيرفر) — التغييرات على هذا الجهاز فقط"}${verTxt ? ` · آخر تحديث للمخزون ${verTxt}` : ""}</div>`;
    window.DB.catalogSize().then((n) => { const el = $("#ad-cat"); if (el) el.textContent = fmt(n); }).catch(() => {});
    $("#ad-import").hidden = CLOUD; $("#ad-backup").hidden = CLOUD;
    $("#ad-clear-t").textContent = CLOUD ? "بدء جرد جديد (حذف كل الجرد)" : "حذف كل الجرد من هذا الجهاز";
  }

  function parseInWorker(msg, onProg) {
    return new Promise((res, rej) => {
      const w = new Worker("xlsx-worker.js?v=6");
      w.onmessage = (e) => {
        if (e.data.progress) onProg?.(e.data.progress);
        if (e.data.result) { w.terminate(); res(e.data.result); }
      };
      w.onerror = (e) => { w.terminate(); rej(new Error(e.message || "worker")); };
      w.postMessage(msg, msg.buf ? [msg.buf] : []);
    });
  }
  const impErr = (m) => { $("#imp-error").textContent = m; $("#imp-error").hidden = !m; };
  function impProgress(txt, frac) {
    $("#imp-progress").hidden = txt == null;
    $("#imp-ptext").textContent = txt || "";
    $("#imp-bar").style.width = Math.round((frac || 0) * 100) + "%";
  }
  let imp = null;     // العملية الجاهزة للتأكيد
  let impBusy = false;
  function openImport(mode) {
    imp = null;
    $("#imp-title").textContent = mode === "paste" ? "تحديث الكميات (لصق)" : "رفع المخزون الكامل";
    $("#imp-paste-box").hidden = mode !== "paste";
    $("#imp-file-box").hidden = mode === "paste";
    $("#imp-result").hidden = true; $("#imp-apply").hidden = true;
    impErr(""); impProgress(null);
    if (mode === "paste") {
      const bs = state.data.branches;
      $("#imp-branch").innerHTML = `<option value="">حسب عمود الفرع</option>` +
        bs.map((b) => `<option value="${esc(b)}">${esc(branchLabel(b))}</option>`).join("");
    }
    openOverlay("imp-backdrop");
  }

  // ---- رفع الملف الكامل ----
  $("#ad-full").addEventListener("click", () => $("#ad-xlsx").click());
  $("#ad-xlsx").addEventListener("change", async (e) => {
    const f = e.target.files[0]; e.target.value = "";
    if (!f) return;
    openImport("file");
    impProgress("تحميل الملف…", 0.05);
    let res;
    try { res = await parseInWorker({ kind: "xlsx", buf: await f.arrayBuffer() }, (p) => impProgress(p, 0.3)); }
    catch (err) { impProgress(null); impErr("تعذّر قراءة الملف: " + err.message); return; }
    impProgress(null);
    if (res.error) return impErr(res.error === "noheader" ? "ما لقيت عمود \"رقم الصنف\" في أول 20 صف" : "خطأ: " + res.error);
    const hasB = res.cols.includes("b");
    const cat = new Map();
    const items = new Map();
    for (const r of res.rows) {
      if (!cat.has(r[0]) || (!cat.get(r[0]) && r[1])) cat.set(r[0], r[1]);
      if (!hasB || !r[2] || (!r[3] && !r[4])) continue;
      const k = r[2] + "|" + r[0];
      const ex = items.get(k);
      if (!ex) items.set(k, r.slice());
      else { ex[3] += r[3]; ex[4] += r[4]; if (!ex[5]) ex[5] = r[5]; if (!ex[1]) ex[1] = r[1]; }
    }
    const perB = new Map();
    for (const r of items.values()) perB.set(r[2], (perB.get(r[2]) || 0) + 1);
    imp = { kind: "full", catalog: [...cat.entries()], items: [...items.values()] };
    $("#imp-items").checked = items.size > 0;
    $("#imp-items").disabled = !items.size;
    $("#imp-result").hidden = false;
    $("#imp-result").innerHTML =
      `صفوف الملف: <b>${fmt(res.rows.length)}</b><br>` +
      `الدليل الكامل: <b>${fmt(cat.size)}</b> رقم صنف<br>` +
      (hasB ? `مخزون الفروع (اللي له كمية): <b>${fmt(items.size)}</b> صنف` +
        `<table>${[...perB].map(([b, n]) => `<tr><td>${esc(branchLabel(b))}</td><td><b>${fmt(n)}</b></td></tr>`).join("")}</table>`
        : `<span class="w">الملف ما فيه عمود "اسم الفرع" — بيترفع كدليل فقط</span>`) +
      `<br><small class="muted">الأعمدة المعروفة: ${res.cols.map((c) => COL_AR[c]).join("، ")}</small>`;
    $("#imp-apply").hidden = false;
    $("#imp-apply").textContent = "تأكيد ورفع";
  });
  const COL_AR = { n: "رقم الصنف", name: "اسم الصنف", b: "الفرع", q: "المتوفر", r: "المحجوز", loc: "الموقع", c: "التكلفة" };

  // ---- تحديث بالصق ----
  $("#ad-paste").addEventListener("click", () => {
    openImport("paste");
    setTimeout(() => $("#imp-text").focus(), 250);
  });
  $("#imp-text").addEventListener("input", () => { $("#imp-result").hidden = true; $("#imp-apply").hidden = true; imp = null; });
  $("#imp-preview").addEventListener("click", async () => {
    impErr("");
    const text = $("#imp-text").value;
    if (!text.trim()) return impErr("الصق البيانات أول");
    const res = await parseInWorker({ kind: "tsv", text });
    if (res.error) return impErr(res.error === "noheader" ? "ما لقيت صف العناوين — انسخ مع صف العناوين (رقم الصنف، الكمية المتوفرة…)" : "خطأ: " + res.error);
    if (!res.cols.includes("q")) return impErr("لازم يكون فيه عمود الكمية المتوفرة");
    const selB = $("#imp-branch").value;
    if (!res.cols.includes("b") && !selB) return impErr("اللصق ما فيه عمود الفرع — اختر الفرع من القائمة");
    const has = (k) => res.cols.includes(k);
    const { branches, items } = state.data;
    const existing = new Map();
    for (const it of items) if (!it.x && !it.gone) existing.set(branches[it.b] + "|" + it.n, it);
    const pasted = new Map();
    const unknownB = new Set();
    for (const r of res.rows) {
      const b = (has("b") && r[2]) || selB;
      if (!b) continue;
      if (!branches.includes(b) && !CFG.branchOrder.includes(b)) unknownB.add(b);
      const k = b + "|" + r[0];
      const p = pasted.get(k);
      if (p) { p[3] += r[3]; p[4] += r[4]; } else pasted.set(k, [r[0], r[1], b, r[3], r[4], r[5], r[6]]);
    }
    const changed = [], added = [], zeroed = [];
    let same = 0;
    for (const [k, p] of pasted) {
      const ex = existing.get(k);
      const row = [p[0], (has("name") && p[1]) || ex?.name || "", p[2], p[3], has("r") ? p[4] : ex?.r || 0,
        (has("loc") && p[5]) || ex?.loc || "", has("c") ? p[6] : ex?.c || 0];
      if (!ex) added.push(row);
      else if (ex.q !== row[3] || ex.r !== row[4] || (ex.loc || "") !== row[5] || (has("name") && p[1] && ex.name !== row[1])) changed.push({ row, old: ex });
      else same++;
    }
    const affected = new Set([...pasted.values()].map((p) => p[2]));
    if ($("#imp-zero").checked) {
      for (const [k, ex] of existing) {
        const b = branches[ex.b];
        if (affected.has(b) && !pasted.has(k) && (ex.q || ex.r)) zeroed.push([ex.n, ex.name, b, 0, 0, ex.loc || "", ex.c || 0]);
      }
    }
    const rows = [...added, ...changed.map((c) => c.row), ...zeroed];
    // القائمة الكاملة بعد التحديث (للوضع المحلي)
    const all = new Map();
    for (const [k, ex] of existing) all.set(k, [ex.n, ex.name, branches[ex.b], ex.q, ex.r, ex.loc || "", ex.c || 0]);
    for (const r of rows) all.set(r[2] + "|" + r[0], r);
    imp = { kind: "paste", rows, all: [...all.values()] };
    const sample = changed.slice(0, 6).map(({ row, old }) =>
      `<tr><td dir="ltr">${esc(row[0])}</td><td>${esc(branchLabel(row[2]))}</td><td>${fmt(old.q)} ← <b>${fmt(row[3])}</b></td></tr>`).join("");
    $("#imp-result").hidden = false;
    $("#imp-result").innerHTML =
      `الأسطر: <b>${fmt(pasted.size)}</b> · الفروع: ${[...affected].map((b) => esc(branchLabel(b))).join("، ")}<br>` +
      `<span class="ok">تغيّرت كميته: <b>${fmt(changed.length)}</b></span> · جديد: <b>${fmt(added.length)}</b> · بدون تغيير: <b>${fmt(same)}</b><br>` +
      ($("#imp-zero").checked ? `<span class="w">مو موجود باللصق ← كميته تصير 0: <b>${fmt(zeroed.length)}</b></span><br>` : "") +
      (unknownB.size ? `<span class="w">فروع جديدة: ${[...unknownB].map(esc).join("، ")}</span><br>` : "") +
      (sample ? `<table>${sample}</table>` : "") +
      `<small class="muted">الجرد ما يتأثر بالتحديث</small>`;
    $("#imp-apply").hidden = !rows.length;
    $("#imp-apply").textContent = `تأكيد تحديث ${fmt(rows.length)} صنف`;
    if (!rows.length) impErr("ما فيه تغييرات");
  });
  $("#imp-zero").addEventListener("change", () => { if (!$("#imp-result").hidden) $("#imp-preview").click(); });
  $("#imp-branch").addEventListener("change", () => { if (!$("#imp-result").hidden) $("#imp-preview").click(); });

  $("#imp-apply").addEventListener("click", async () => {
    if (!imp || impBusy) return;
    if (imp.kind === "full" && !$("#imp-cat").checked && !$("#imp-items").checked) return impErr("اختر شيء للرفع");
    if (imp.kind === "full" && $("#imp-items").checked && !confirm("استبدال مخزون الفروع بالكامل بالملف الجديد؟")) return;
    impBusy = true; impErr("");
    $("#imp-apply").disabled = true; $("#imp-x").disabled = true;
    const label = { catalog: "رفع الدليل", items: "رفع مخزون الفروع" };
    try {
      if (imp.kind === "full") {
        await window.DB.replaceAll({
          catalog: $("#imp-cat").checked ? imp.catalog : null,
          items: $("#imp-items").checked ? imp.items : null,
        }, (what, d, t) => impProgress(`${label[what]}… ${fmt(d)} / ${fmt(t)}`, t ? d / t : 0));
      } else {
        await window.DB.upsertItems(imp.rows, imp.all, (d, t) => impProgress(`تحديث… ${fmt(d)} / ${fmt(t)}`, d / t));
      }
      impProgress("تحميل المخزون الجديد…", 1);
      await reloadItems();
      impBusy = false;
      closeOverlay("imp-backdrop");
      toast("✓ تم تحديث المخزون", 3000);
      renderAdmin();
    } catch (err) {
      impErr("توقف الرفع: " + err.message + " — تقدر تعيد المحاولة");
    } finally {
      impBusy = false; impProgress(null);
      $("#imp-apply").disabled = false; $("#imp-x").disabled = false;
    }
  });

  // ---- سحب الجرد (Excel) ----
  function loadXLSX() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    return new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "vendor/xlsx.full.min.js";
      s.onload = () => res(window.XLSX); s.onerror = () => rej(new Error("xlsx"));
      document.head.appendChild(s);
    });
  }
  $("#ad-export-all").addEventListener("click", async () => {
    if (CLOUD) { toast("جاري سحب آخر جرد…", 10000); await window.DB.sync(applyChanges); }
    const live = state.data.items.filter((it) => !it.gone);
    const done = live.filter((it) => countOf(it));
    const todo = live.filter((it) => !countOf(it) && !it.x);
    try {
      const X = await loadXLSX();
      const wb = X.utils.book_new();
      wb.Workbook = { Views: [{ RTL: true }] };
      const sh1 = X.utils.aoa_to_sheet(countRows(done, false));
      sh1["!cols"] = [14, 18, 34, 12, 12, 12, 9, 9, 10, 12, 9, 28, 20, 14, 18].map((w) => ({ wch: w }));
      X.utils.book_append_sheet(wb, sh1, "الجرد");
      const sh2 = X.utils.aoa_to_sheet([["الفرع", "رقم الصنف", "اسم الصنف", "الموقع", "المتوفر", "المحجوز"],
        ...todo.map((it) => [branchLabel(state.data.branches[it.b]), it.n, it.name, it.loc, it.q, it.r])]);
      sh2["!cols"] = [14, 18, 34, 12, 9, 9].map((w) => ({ wch: w }));
      X.utils.book_append_sheet(wb, sh2, "لم يُجرد");
      X.writeFile(wb, `جرد-كل-الفروع-${today()}.xlsx`);
      toast(`✓ ${fmt(done.length)} صنف مجرود · ${fmt(todo.length)} ما انجرد`, 3000);
    } catch {
      exportCSV(done, `جرد-كل-الفروع-${today()}.csv`, false);
    }
  });
  $("#ad-backup").addEventListener("click", () => exportBackup(true));
  $("#ad-import").addEventListener("click", () => $("#ad-file").click());
  $("#ad-file").addEventListener("change", async (e) => {
    const f = e.target.files[0]; e.target.value = "";
    if (!f) return;
    let data;
    try { data = JSON.parse(await f.text()); } catch { toast("الملف غير صالح"); return; }
    if (data?.type !== "inv-backup" || typeof data.counts !== "object") { toast("هذا ليس ملف جرد"); return; }
    let added = 0, items = 0;
    if (data.extras && typeof data.extras === "object") {
      const ex = store.get(LS_EXTRAS, {});
      for (const [k, x] of Object.entries(data.extras)) {
        if (!ex[k]) ex[k] = x;
        const it = addExtraItem(x);
        if (it) it.gone = false;
      }
      store.set(LS_EXTRAS, ex);
    }
    for (const [key, inc] of Object.entries(data.counts)) {
      normCount(inc);
      const c = state.counts[key];
      if (!c) { state.counts[key] = inc; added += inc.entries.length; items++; continue; }
      const seen = new Set(c.entries.map((e) => `${e.u}|${e.at}|${e.qty}`));
      let any = false;
      for (const e of inc.entries) {
        if (seen.has(`${e.u}|${e.at}|${e.qty}`)) continue;
        c.entries.push(e); added++; any = true;
      }
      if (any) { c.entries.sort((a, b) => a.at - b.at); if (inc.at >= c.at) { c.loc = inc.loc; c.note = inc.note || c.note; } normCount(c); items++; }
    }
    saveCounts();
    let msg = `✓ تم دمج ${fmt(added)} إدخال في ${fmt(items)} صنف`;
    if (Array.isArray(data.users) && data.users.length && confirm(`الملف فيه ${data.users.length} مستخدم — استيرادهم لهذا الجهاز؟`)) {
      const map = new Map(store.get(LS_USERS, []).map((u) => [u.username.toLowerCase(), u]));
      data.users.forEach((u) => u?.username && map.set(u.username.toLowerCase(), u));
      store.set(LS_USERS, [...map.values()]);
      msg += " + المستخدمين";
    }
    toast(msg, 3500);
    renderAdmin();
  });
  $("#ad-clear").addEventListener("click", async () => {
    if (!confirm(CLOUD ? "حذف كل الجرد من كل الأجهزة والبدء من جديد؟ اسحب نسخة Excel قبلها. لا يمكن التراجع."
      : "حذف كل الجرد من هذا الجهاز؟ لا يمكن التراجع.")) return;
    if (prompt('للتأكيد اكتب: حذف') !== "حذف") return;
    if (CLOUD) {
      try { await window.DB.flush(); await window.DB.resetCounts(); }
      catch (e) { toast("تعذّر الحذف: " + e.message, 3500); return; }
    }
    state.counts = {}; saveCounts();
    store.del(LS_EXTRAS);
    state.data.items.forEach((it) => { if (it.x) it.gone = true; });
    toast("تم حذف الجرد"); renderAdmin();
  });

  /* ---------- تنبيه ---------- */
  let toastT;
  function toast(msg, ms = 2000) {
    const t = $("#toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms);
  }

  /* ---------- PWA ---------- */
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  /* ---------- الوضع النهاري / الليلي ---------- */
  function setTheme(t) {
    document.documentElement.dataset.theme = t;
    document.querySelector('meta[name="theme-color"]').content = t === "dark" ? "#102236" : "#0f2a44";
    try { localStorage.setItem("inv_theme", t); } catch {}
  }
  $$(".theme-btn").forEach((b) => b.addEventListener("click", () =>
    setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark")));

  // للاختبار من وحدة التحكم
  window.__inv = { state, parseText, matchText, makeLocTest, applyFilter, allUsers, onBack, applyChanges };

  try { history.replaceState(null, "", "#" + cur); } catch {}
  if (CLOUD) {
    $("#backup-card").hidden = true;          // مع السيرفر ما يحتاج ترسل ملفات
    window.DB.restore().then((p) => { route(); if (p) startSync(); }).catch(() => route());
  } else route();
})();
