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
  // v2: الجرد صار مربوط بجولة (موقع/نطاق مواقع) — المفتاح: "رقم الجولة|رقم الصنف"
  const LS_COUNTS = CLOUD ? "inv_counts_cloud_v2" : "inv_counts_v2";
  const LS_EXTRAS = CLOUD ? "inv_extras_cloud_v2" : "inv_extras_v2";   // أصناف زائدة لقيناها بالجرد وما هي بالنظام
  const LS_ROUNDS = CLOUD ? "inv_rounds_cloud_v1" : "inv_rounds_v1";
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
    rounds: store.get(LS_ROUNDS, {}),   // جولات الجرد: id → {id, branch, loc_from, loc_to, name, users, status, ...}
    round: null,         // الجولة المفتوحة في شاشة الجرد
    branchAll: [],       // كل أصناف الفرع (للبحث عن صنف بموقع ثاني)
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
  const saveRounds = () => store.set(LS_ROUNDS, state.rounds);

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
    const m = toEnDigits(s).toUpperCase().match(/^\s*([A-Z]+)\s*[-+]?\s*(\d+)/);   // B057 / FR-03 / FR+11
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
    await loadData(true);
    if (state.screen === "inventory" && state.round) {
      const bi = state.data.branches.indexOf(state.round.branch);
      if (bi >= 0) { state.branch = bi; setRoundItems(); applyFilter(); }
    } else if (state.screen === "branches") renderRounds();
    else if (state.screen === "admin") renderAdmin();
  }

  /* ---------- الأصناف الزائدة (موجودة فعلياً وغير موجودة بالنظام) ---------- */
  // extras["جولة|رقم"] = { r: رقم الجولة, b: اسم الفرع, n, name, loc, by, u, at }
  function addExtraItem(x) {
    const { branches, items } = state.data;
    const bi = branches.indexOf(x.b);
    if (bi < 0 || !x.n) return null;
    const ex = items.find((it) => it.b === bi && it.n === x.n && (!it.x || it.xr === x.r));
    if (ex) return ex;
    const it = {
      i: items.length, n: x.n, name: x.name || "", b: bi, q: 0, r: 0, loc: x.loc || "", c: "", x: true, xr: x.r,
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
    state.branchAll = state.branchAll.filter((x) => x !== it);
  }

  /* ---------- الرفع للسيرفر (يتجمع بالطابور لو ما فيه نت) ---------- */
  const bOf = (it) => state.data.branches[it.b];
  const iso = (t) => new Date(t || Date.now()).toISOString();
  const rid = () => state.round?.id;
  function pushEntry(it, e) {
    window.DB.queue({ t: "entry", row: { id: e.id, round_id: rid(), branch: bOf(it), n: it.n, qty: e.qty, user_id: e.u, by_name: e.by || "", at: iso(e.at), kind: e.kind || "count", bin: e.bin || null } });
  }
  const pushDel = (id) => window.DB.queue({ t: "del", id });
  const pushMeta = (it, c) => window.DB.queue({ t: "meta", row: {
    round_id: rid(), branch: bOf(it), n: it.n, loc: c?.loc ?? null, note: c?.note || null,
    verified_by: c?.ver?.u ?? null, verified_name: c?.ver?.by ?? null, verified_at: c?.ver ? iso(c.ver.at) : null } });
  function pushExtra(it, rec, deleted = false) {
    window.DB.queue({ t: "extra", row: { round_id: rid(), branch: bOf(it), n: it.n, name: it.name || "", loc: it.loc || "", by_name: rec?.by || "", at: iso(rec?.at), deleted } });
  }
  const pushRound = (r) => window.DB.queue({ t: "round", row: {
    id: r.id, branch: r.branch, loc_from: r.loc_from || "", loc_to: r.loc_to || "", name: r.name || "", users: r.users || [],
    status: r.status, created_at: r.created_at, review_at: r.review_at || null, closed_at: r.closed_at || null,
    summary: r.summary || null, deleted: !!r.deleted, kind: r.kind || "range", items: r.items || [] } });
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
  const keyOf = (it) => `${rid()}|${it.n}`;
  const countOf = (it) => state.counts[keyOf(it)];
  const countIn = (r, it) => state.counts[`${r.id}|${it.n}`];
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
  const findUser = (username) => allUsers().find((u) => window.DB.normUser(u.username) === window.DB.normUser(username));
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
  /* ---------- جولات الجرد ---------- */
  // جولة = فرع + نطاق مواقع. الموظف يشوف أصناف النطاق بس، والبحث يشمل الفرع كامل
  // الجرد السريع (kind = quick): أصناف يختارها المدير بالاسم/الرقم — ما له نطاق مواقع
  const isQuick = (r) => r?.kind === "quick";
  const quickSets = new WeakMap();
  const quickSet = (r) => { let s = quickSets.get(r); if (!s) { s = new Set(r.items || []); quickSets.set(r, s); } return s; };
  const roundTest = (r) => (isQuick(r) ? null : makeLocTest({ from: r.loc_from || "", to: r.loc_to || "" }));
  const isShelf = (f, t) => /^[A-Z]+$/.test(f || "") && (!t || t === f);   // رف كامل بالحرف
  const rangeText = (r) => (isQuick(r) ? `جرد سريع · ${fmt((r.items || []).length)} صنف`
    : isShelf(r.loc_from, r.loc_to) ? `رف ${r.loc_from} كامل`
    : r.loc_from || r.loc_to ? `${r.loc_from || "…"}${r.loc_to ? " → " + r.loc_to : "…"}` : "الفرع كامل");
  const roundTitle = (r) => r.name || `${branchLabel(r.branch)} · ${rangeText(r)}`;
  const STATUS_AR = { open: "جاري الجرد", review: "مراجعة الفروقات", closed: "مغلق" };
  function inRange(r, it, t = roundTest(r)) { return isQuick(r) ? quickSet(r).has(it.n) : !t || t(it.loc || ""); }
  // أصناف الجولة: اللي موقعها بالنظام داخل النطاق + اللي انجردت فيها (من موقع ثاني) + الزائدة
  function roundItemsOf(r) {
    if (!state.data) return [];
    const bi = state.data.branches.indexOf(r.branch);
    if (bi < 0) return [];
    const t = roundTest(r);
    return state.data.items.filter((it) => it.b === bi && !it.gone &&
      (it.x ? it.xr === r.id : (inRange(r, it, t) || !!countIn(r, it))));
  }
  function setRoundItems() {
    const r = state.round, bi = state.branch;
    state.branchItems = roundItemsOf(r);
    state.inRound = new Set(state.branchItems);
    state.branchAll = state.data.items.filter((it) => it.b === bi && !it.gone && (!it.x || it.xr === r.id));
  }
  // الجولات اللي يشوفها المستخدم
  function myRounds() {
    const u = me();
    return Object.values(state.rounds).filter((r) => !r.deleted && r.status !== "closed" &&
      (isAdmin() || (scopeFor(r.branch).ok && (!r.users?.length || r.users.includes(myId())))))
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }

  /* ---------- التنقل (بدون سجل متصفح — زر الرجوع لا يخرج من التطبيق) ---------- */
  function show(id) {
    if (id === "login" && state.screen !== "login") renderLastUser();
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
    if (h === "branches") { renderRounds(); runSync(); return show("branches"); }   // نسحب آخر جرد فتحه المدير
    if (h === "admin" && u.role === "admin") { renderAdmin(); return show("admin"); }
    // جرد الباركود: قائمة المواقع / داخل موقع
    const mb = h.match(/^bins\/([\w-]+)$/) || h.match(/^bin\/([\w-]+)\/(.+)$/);
    if (mb) {
      const rb = state.rounds[mb[1]];
      if (!rb || !myRounds().includes(rb) || !state.data.branches.includes(rb.branch)) return go("branches");
      if (rb.status !== "open") return go("inv/" + rb.id);           // المراجعة بالشاشة العادية
      enterRound(rb);
      if (mb[2]) { state.binCur = decodeURIComponent(mb[2]); renderBin(); return show("bin"); }
      renderBins(); return show("bins");
    }
    const m = h.match(/^inv\/([\w-]+)$/);
    const r = m && state.rounds[m[1]];
    if (r && myRounds().includes(r) && state.data.branches.includes(r.branch)) {
      if (r.status === "open" && modes[r.id] === "scan") return go("bins/" + r.id);
      openRound(r); show("inventory");
      if (r.status === "open" && !modes[r.id]) openOverlay("mode-backdrop");   // أول مرة: عادي ولا باركود؟
      return;
    }
    go(m ? "branches" : "home");
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
    const up = { inventory: "branches", branches: "home", admin: "home", bins: "branches", bin: state.round ? "bins/" + state.round.id : "branches" }[state.screen];
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
  const loginErr = (m) => {
    $("#login-error").textContent = m; $("#login-error").hidden = false;
    const c = $("#login-form"); c.classList.remove("shake"); void c.offsetWidth; c.classList.add("shake");
    navigator.vibrate?.([40, 40, 40]);
  };
  // آخر واحد دخل من هالجهاز: زر "متابعة" بدل ما يكتب اسمه كل مرة
  const LS_LAST = "inv_last_user";
  function renderLastUser() {
    const last = store.get(LS_LAST, null);
    $("#last-user").hidden = !last?.u;
    if (!last?.u) return;
    $("#lu-name").textContent = last.name || last.u;
    $("#lu-av").textContent = (last.name || last.u).trim()[0] || "؟";
  }
  renderLastUser();
  $("#last-user").addEventListener("click", () => {
    const last = store.get(LS_LAST, null); if (!last) return;
    $("#login-user").value = last.u;
    $("#last-user").hidden = true;
    $("#login-pass").focus();
  });
  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const u = $("#login-user").value.trim();
    const p = toEnDigits($("#login-pass").value);
    if (!u) { $("#login-user").focus(); return; }
    if (!p) { $("#login-pass").focus(); return; }
    $("#login-error").hidden = true;
    if (CLOUD) {
      const btn = $("#login-form [type=submit]");
      btn.disabled = true;
      try { await window.DB.signIn(u, p); }
      catch (err) {
        btn.disabled = false;
        loginErr(err.message === "bad" ? "اسم الدخول أو الرقم السري غير صحيح"
          : err.message === "inactive" ? "الحساب موقوف — راجع المدير"
          : err.message === "net" ? "ما فيه اتصال بالإنترنت" : "تعذّر الدخول: " + err.message);
        return;
      }
      store.set(LS_LAST, { u, name: window.DB.profile?.name || u });
      // إعادة تحميل مرة وحدة بعد الدخول: بعض الطلبات ما تاخذ الجلسة الجديدة إلا بعد التحديث
      location.replace(location.pathname + "#home");
      location.reload();
      return;
    } else {
      const found = allUsers().find((x) => window.DB.normUser(x.username) === window.DB.normUser(u) && x.password === p && x.active !== false);
      if (!found) { loginErr("اسم الدخول أو الرقم السري غير صحيح"); return; }
      state.user = { username: found.username, name: found.name };
      store.set(LS_USER, state.user);   // يبقى مسجّل دخول دائماً حتى يضغط خروج
      store.set(LS_LAST, { u, name: found.name });
    }
    $("#login-pass").value = "";
    state.branch = null;
    go("home");
  });
  $("#pw-toggle").addEventListener("click", () => {
    const i = $("#login-pass");
    i.type = i.type === "password" ? "text" : "password";
    i.focus();
  });
  // الرقم السري: كيبورد أرقام افتراضياً، وزر للتبديل للحروف
  $("#kb-toggle").addEventListener("click", () => {
    const i = $("#login-pass");
    const num = i.inputMode === "numeric";
    i.inputMode = num ? "text" : "numeric";
    $("#kb-toggle").textContent = num ? "123" : "أبج";
    i.blur(); setTimeout(() => i.focus(), 50);
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
  // تقدّم الجولة: كم صنف بالنطاق انجرد، والفروقات
  function roundProgress(r) {
    const its = roundItemsOf(r);
    let done = 0, diff = 0, review = 0, verified = 0, extra = 0;
    for (const it of its) {
      const c = countIn(r, it);
      if (it.x) extra++;
      if (c) { done++; if (diffOf(it, c)) diff++; }
      if (needsReview(it, c)) review++;
      if (c?.ver) verified++;
    }
    return { total: its.length, done, diff, review, verified, extra, pct: its.length ? Math.round((done / its.length) * 100) : 0 };
  }
  function renderRounds() {
    const list = myRounds();
    $("#branch-list").innerHTML = list.length ? list.map((r) => {
      const p = roundProgress(r);
      const rv = r.status === "review";
      return `<button class="branch-card round-card${rv ? " rv" : ""}" data-r="${esc(r.id)}">
        <span class="bc-icon"><svg viewBox="0 0 24 24"><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg></span>
        <span><strong>${esc(r.name || branchLabel(r.branch))}</strong>
          <small>${esc(branchLabel(r.branch))} · <b dir="ltr">${esc(rangeText(r))}</b></small>
          <small>${rv ? `<i class="badge b2">مراجعة الفروقات</i> باقي ${fmt(p.review)}` : `${fmt(p.total)} صنف · تم ${fmt(p.done)}`}</small></span>
        <span class="bc-pct">${rv ? fmt(p.review) : p.pct + "%"}</span>
        <span class="bc-bar"><span style="width:${rv ? Math.round(((p.total - p.review) / Math.max(1, p.total)) * 100) : p.pct}%"></span></span>
      </button>`;
    }).join("") : `<div class="empty"><svg viewBox="0 0 24 24"><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
        <p>ما فيه جرد مفتوح لك حالياً</p><p class="muted">المدير يفتح الجرد من لوحة التحكم ← الجرد</p></div>`;
    $$("#branch-list .round-card").forEach((c) => c.addEventListener("click", () => go("inv/" + c.dataset.r)));
  }

  /* ---------- شاشة الجرد ---------- */
  function openRound(r) {
    const review = r.status === "review";
    const mode = review ? "review" : "open";
    if (state.round?.id !== r.id || state.mode !== mode) {
      state.status = review ? "review" : "todo";
      state.pins = [];
      $("#search").value = "";
    }
    state.round = r;
    state.mode = mode;
    state.branch = state.data.branches.indexOf(r.branch);
    setRoundItems();
    renderChips();
    $("#inv-branch").textContent = r.name || branchLabel(r.branch);
    $("#inv-tb-label").textContent = review ? "مراجعة الفروقات" : rangeText(r);
    document.body.classList.toggle("review", review);
    $("#to-scan").hidden = review;
    renderPins();
    applyFilter();
  }
  // الفلاتر تتغير حسب المرحلة
  const CHIPS = {
    open: [["todo", "لم يُجرد"], ["done", "تم"], ["diff", "فيه فرق"], ["extra", "زائد"], ["all", "الكل"]],
    review: [["review", "للمراجعة"], ["verified", "تم التأكيد"], ["all", "الكل"]],
  };
  function renderChips() {
    $("#status-chips").innerHTML = CHIPS[state.mode].map(([f, t]) =>
      `<button class="chip${state.status === f ? " active" : ""}" data-f="${f}">${t}</button>`).join("");
  }
  // يحتاج مراجعة: فيه فرق (أو ما انجرد والمفروض موجود) وما أحد أكده
  function needsReview(it, c) {
    if (c?.ver) return false;
    return (c ? c.qty : 0) + resv(it) - it.q !== 0;
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
    // رف كامل بالحرف (A أو A → A): كل مواقع الرف، حتى اللي مكتوب فيها "A" بس بدون رقم
    // (ومو "AB" — الحرف لازم يطابق بالضبط، عشان F ما تجيب FR)
    if (/^[A-Z]+$/.test(from) && (!to || to === from)) return (L) => (cleanLoc(L).match(/^[A-Z]+/)?.[0] || "") === from;
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
      case "review": return searching || needsReview(it, c);
      case "verified": return !!c?.ver;
      default: return true;
    }
  }

  /* ---------- ترتيب القائمة ---------- */
  // مفتاح الموقع للترتيب: الحرف، ثم "بدون رقم" قبل الأرقام، ثم الرقم. اللي بدون موقع آخر شيء
  function locKey(it) {
    const L = cleanLoc(effLoc(it));
    const letter = L.match(/^[A-Z]+/)?.[0];
    if (!letter) return ["~", -1, L];
    const p = parseLoc(L);
    return [letter, p ? p.n : -1, L];
  }
  const byNum = (a, b) => a.n.localeCompare(b.n, "en", { numeric: true });
  const byLoc = (a, b) => {
    const x = locKey(a), y = locKey(b);
    return (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0) || x[1] - y[1] || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0) || byNum(a, b);
  };
  // الفرق الأكبر أول (زيادة أو نقص) — اللي ما انجرد يُحسب بالرف = 0
  const absDiff = (it) => Math.abs((countOf(it)?.qty || 0) + resv(it) - it.q);
  const SORTERS = { loc: byLoc, num: byNum, diff: (a, b) => absDiff(b) - absDiff(a) || byLoc(a, b) };
  const SORT_AR = { "": "حسب النظام", loc: "الموقع", num: "رقم الصنف", diff: "كمية الفرق (الأكبر أول)" };
  const sortPref = store.get("inv_sort", { open: "", review: "diff" });
  const currentSort = () => sortPref[state.mode === "review" ? "review" : "open"] || "";
  $("#sort-btn").addEventListener("click", () => {
    const opts = state.mode === "review" ? ["diff", "loc", "num"] : ["", "loc", "num", "diff"];
    $("#sort-opts").innerHTML = opts.map((k) =>
      `<button type="button" class="sort-opt${currentSort() === k ? " on" : ""}" data-k="${k}"><span>${SORT_AR[k]}</span><i></i></button>`).join("");
    openOverlay("sort-backdrop");
  });
  $("#sort-opts").addEventListener("click", (e) => {
    const b = e.target.closest("[data-k]"); if (!b) return;
    sortPref[state.mode === "review" ? "review" : "open"] = b.dataset.k;
    store.set("inv_sort", sortPref);
    closeOverlay("sort-backdrop");
    applyFilter();
    toast("الترتيب: " + SORT_AR[b.dataset.k]);
  });

  function applyFilter() {
    if (!state.round) return;
    const { locTests, textTests, preview } = buildFilters();
    const searching = textTests.some(Boolean);
    // البحث يشمل الفرع كامل: صنف موقعه بالنظام غلط أو بدون موقع يقدر يلقاه ويجرده
    const base = searching ? state.branchAll : state.branchItems;
    let list = base.filter((it) => {
      if (!statusOk(it, searching)) return false;
      if (locTests.length) { const L = effLoc(it) || ""; if (!locTests.every((f) => f(L))) return false; }
      return textTests.every((t) => matchText(it, t));
    });
    // الترتيب: اللي اختاره الموظف، وإلا المراجعة = الفرق الأكبر، ونطاق المواقع = بالموقع
    const sort = currentSort() || (locTests.length ? "loc" : "");
    const cmp = SORTERS[sort];
    if (cmp) list = list.slice().sort(cmp);
    $("#sort-btn").classList.toggle("on", !!currentSort() && !(state.mode === "review" && currentSort() === "diff"));
    state.filtered = list;
    state.rendered = 0;
    $("#tbody").innerHTML = "";
    $("#table-wrap").scrollTop = 0;
    renderMore();
    $("#empty").hidden = list.length > 0;
    const q = $("#search").value.trim();
    $("#empty-add").hidden = !searching;
    $("#empty-msg").textContent = searching ? "الصنف غير موجود في مخزون الفرع"
      : state.status === "todo" ? "تم جرد كل أصناف هذا النطاق ✓"
      : state.status === "review" ? "ما فيه فروقات للمراجعة ✓" : "لا توجد نتائج";
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
    const out = !it.x && !inRange(state.round, it);          // موقعه بالنظام خارج نطاق الجولة
    const rv = state.mode === "review";
    const cls = c?.ver ? " done ver" : rv && needsReview(it, c) ? " rv" : c ? " done" : "";
    return `<div class="trow${cls}" data-i="${it.i}">
      <span class="t-item"><span class="t-num">${esc(it.n)}${it.x ? '<i class="xb">زائد</i>' : ""}${out ? '<i class="xb ob">خارج النطاق</i>' : ""}${c?.ver ? '<i class="xb vb">✓ مؤكد</i>' : ""}</span><span class="t-name">${esc(it.name)}</span></span>
      <span class="t-loc${c && (L || "") !== (it.loc || "") ? " changed" : ""}">${esc(L || "—")}</span>
      <span class="t-q"><span class="sys">${fmt(it.q)}</span>${resv(it) ? `<span class="rsv">محجوز ${fmt(resv(it))}</span>` : ""}${c ?`<span class="cnt${diff ? " d" : ""}">${multi ? "Σ " : "جرد "}${fmt(c.qty)}</span>` : ""}${(() => {
        // المراجعة: كمية الفرق على السطر (+ زيادة / − نقص)
        if (!rv || isBlind() || c?.ver) return "";
        const d = (c?.qty || 0) + resv(it) - it.q;
        return d ? `<span class="dq ${d > 0 ? "p" : "m"}" dir="ltr">${d > 0 ? "+" : "−"}${fmt(Math.abs(d))}</span>` : "";
      })()}</span>
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
    if (state.mode === "review") {
      const left = state.branchItems.filter((x) => needsReview(x, countOf(x))).length;
      $("#inv-progress-bar").style.width = total ? ((total - left) / total) * 100 + "%" : "0";
      $("#inv-progress-text").textContent = `باقي ${fmt(left)}`;
      return;
    }
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
      lp.innerHTML = `<span class="lp-t"${isShelf(p.from, p.to) ? "" : ' dir="ltr"'}>${isShelf(p.from, p.to) ? `رف ${esc(p.from)}` : `${esc(p.from || "…")}${p.to ? ` → ${esc(p.to)}` : "…"}`}</span>
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

  $("#status-chips").addEventListener("click", (e) => {
    const c = e.target.closest(".chip"); if (!c) return;
    state.status = c.dataset.f;
    $$("#status-chips .chip").forEach((x) => x.classList.toggle("active", x === c));
    applyFilter();
  });

  /* ===== الباركود =====
     ملصق تويوتا: 13 خانة = 12 خانة رقم القطعة (لو الرقم 10 تنحشى بمسافتين) + خانة تحقق بالآخر
       "4243160311  F" → 42431-60311     "110715002101J" → 11071-50021-01
     الترتيب: 1) ربط تعلّمناه من تصحيح موظف  2) أول 12 خانة  3) أول 10  4) أطول رقم صنف يطابق بداية الباركود
     لو ما طلع صح والموظف اختار الصنف يدوي → ينربط الباركود فيه للكل، والمرة الجاية يفتح على طول */
  const LS_LINKS = CLOUD ? "inv_barcodes_cloud_v1" : "inv_barcodes_v1";
  state.links = store.get(LS_LINKS, {});
  const codeKey = (raw) => toEnDigits(String(raw ?? "")).toUpperCase().replace(/[^A-Z0-9]/g, "");
  function partFromBarcode(raw) {
    const s = toEnDigits(String(raw ?? "")).toUpperCase().replace(/[\r\n\t]/g, "").replace(/^[^A-Z0-9]+/, "");
    return s.slice(0, 12).replace(/[^A-Z0-9]/g, "");
  }
  let nkIndex = { src: null, map: null };
  function itemsByKey() {
    if (nkIndex.src !== state.branchAll) {
      const m = new Map();
      for (const it of state.branchAll) { const k = it.nk.toUpperCase(); if (!m.has(k)) m.set(k, []); m.get(k).push(it); }
      nkIndex = { src: state.branchAll, map: m };
    }
    return nkIndex.map;
  }
  function resolveBarcode(raw) {
    const code = codeKey(raw), part = partFromBarcode(raw);
    const m = itemsByKey();
    const linked = state.links[code];
    if (linked) { const hit = state.branchAll.filter((it) => it.n === linked); if (hit.length) return { code, part, items: hit, how: "link" }; }
    for (const k of [part, part.slice(0, 10), code, code.slice(0, 10)]) if (k.length >= 4 && m.has(k)) return { code, part, items: m.get(k), how: "rule" };
    for (let L = Math.min(code.length, 14); L >= 5; L--) { const k = code.slice(0, L); if (m.has(k)) return { code, part, items: m.get(k), how: "prefix" }; }
    return { code, part, items: [], how: "none" };
  }
  // صوت: ok = صنف هذا الموقع، warn = صنف من موقع ثاني، err = باركود غير معروف
  function beep(kind = "ok") {
    try {
      const A = window.AudioContext || window.webkitAudioContext; if (!A) return;
      const ac = beep.ac ||= new A();
      const tones = { ok: [[1500, 0, .09]], warn: [[900, 0, .08], [900, .13, .08]], err: [[320, 0, .35]] }[kind];
      for (const [f, at, len] of tones) {
        const o = ac.createOscillator(), g = ac.createGain();
        o.frequency.value = f; g.gain.value = .14; o.connect(g); g.connect(ac.destination);
        o.start(ac.currentTime + at); o.stop(ac.currentTime + at + len);
      }
    } catch {}
    if (kind !== "ok") navigator.vibrate?.(kind === "err" ? [80, 60, 80] : 60);
    navigator.vibrate?.(40);
  }
  function handleScan(raw) {
    if (state.screen === "bin") return binScan(raw);
    if (state.screen !== "inventory" || !state.round) return;
    const res = resolveBarcode(raw);
    if (!res.code) return;
    beep();
    state.scan = { code: res.code, autoN: res.items.length === 1 ? res.items[0].n : null, at: Date.now() };
    window.DB.note?.(`باركود ${res.code} → ${res.items.length ? res.items.map((i) => i.n).join("، ") : "ما لقيته"} (${res.how})`);
    if (res.items.length === 1) { searchEl.value = ""; $("#search-clear").hidden = true; applyFilter(); openSheet(res.items[0]); return; }
    // أكثر من صنف (مثلاً -01 و -02) أو ما لقيناه: نعرض البحث والموظف يختار — واختياره يعلّم التطبيق
    searchEl.value = res.items.length ? res.items[0].nk.slice(0, 10) : res.part || res.code;
    onSearchChange();
    toast(res.items.length ? `فيه ${res.items.length} أصناف لهذا الباركود — اختر الصحيح وبيرتبط` : "ما لقيت الباركود — ابحث واختر الصنف الصحيح، وبيرتبط تلقائياً", 4000);
  }
  // ربط الباركود بالصنف (للكل)
  function saveLink(code, n) {
    state.links[code] = n;
    store.set(LS_LINKS, state.links);
    window.DB.queue({ t: "barcode", row: { code, n, by_name: me()?.name || "", deleted: false } });
  }
  // نافذة الجرد بعد مسح: لو الصنف غير اللي طلع تلقائياً → نعرض "ربط الباركود"
  function scanLinkFor(it) {
    const s = state.scan;
    if (!s || Date.now() - s.at > 5 * 60000 || s.autoN === it.n || state.links[s.code] === it.n) return null;
    return s.code;
  }

  // ---- الكاميرا ----
  const SCAN_FORMATS = ["code_39", "code_128", "code_93", "codabar", "ean_13", "ean_8", "upc_a", "upc_e", "itf", "qr_code", "data_matrix", "pdf417"];
  let cam = null;
  function loadZXing() {
    if (window.ZXing) return Promise.resolve();
    return new Promise((res, rej) => { const s = document.createElement("script"); s.src = "vendor/zxing.min.js"; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  }
  async function openCamera() {
    if (!navigator.mediaDevices?.getUserMedia) { toast(window.isSecureContext ? "الجهاز ما يدعم الكاميرا" : "الكاميرا تحتاج رابط https"); return; }
    searchEl.blur();
    $("#scan-hint").textContent = "وجّه الكاميرا على باركود الكرتون";
    openOverlay("scan-ov");
    const video = $("#scan-video");
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } } });
    } catch (e) {
      closeOverlay("scan-ov");
      toast(e?.name === "NotAllowedError" ? "اسمح للتطبيق باستخدام الكاميرا من إعدادات المتصفح" : "تعذّر فتح الكاميرا", 3500);
      return;
    }
    if ($("#scan-ov").hidden) { stream.getTracks().forEach((t) => t.stop()); return; }   // انقفلت قبل ما تفتح
    cam = { stream, stop: false, last: "", lastAt: 0 };
    video.srcObject = stream;
    await video.play().catch(() => {});
    const track = stream.getVideoTracks()[0];
    const caps = track.getCapabilities?.() || {};
    $("#scan-torch").hidden = !caps.torch;
    // نقبل القراءة لما تطلع نفس النتيجة مرتين ورا بعض (يقلل القراءات الغلط)
    const got = (text) => {
      if (!cam || cam.stop || !text) return;
      const now = Date.now();
      if (text !== cam.last || now - cam.lastAt > 1500) { cam.last = text; cam.lastAt = now; return; }
      if (state.screen === "bin" && !binQtyMode) {
        if (now < (cam.pause || 0)) return;
        cam.pause = now + 1300; cam.last = "";          // نفس الكرتون قدام الكاميرا ما ينحسب مرتين بسرعة
        const it = binScan(text);
        $("#scan-hint").textContent = it ? `✓ ${it.n} — ${binDraft().q[it.n] || 0} حبة` : "باركود غير معروف";
        return;
      }
      closeOverlay("scan-ov");
      handleScan(text);
    };
    if ("BarcodeDetector" in window) {
      let det;
      try {
        const sup = await window.BarcodeDetector.getSupportedFormats();
        det = new window.BarcodeDetector({ formats: SCAN_FORMATS.filter((f) => sup.includes(f)) });
      } catch { det = null; }
      if (det) {
        const loop = async () => {
          if (!cam || cam.stop) return;
          try { const r = await det.detect(video); if (r.length) got(r[0].rawValue); } catch {}
          setTimeout(loop, 90);
        };
        loop();
        return;
      }
    }
    // آيفون وغيره: مكتبة ZXing على صور من الفيديو (منطقة الوسط بس عشان السرعة)
    try { await loadZXing(); } catch { closeOverlay("scan-ov"); toast("تعذّر تحميل قارئ الباركود"); return; }
    const Z = window.ZXing;
    const hints = new Map();
    hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.CODE_39, Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.CODE_93, Z.BarcodeFormat.CODABAR,
      Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.ITF, Z.BarcodeFormat.QR_CODE, Z.BarcodeFormat.DATA_MATRIX]);
    hints.set(Z.DecodeHintType.TRY_HARDER, true);
    const reader = new Z.MultiFormatReader(); reader.setHints(hints);
    const cv = document.createElement("canvas"); const ctx = cv.getContext("2d", { willReadFrequently: true });
    const loop = () => {
      if (!cam || cam.stop) return;
      const w = video.videoWidth, h = video.videoHeight;
      if (w && h) {
        const cw = Math.round(w * 0.9), ch = Math.round(h * 0.45);
        cv.width = cw; cv.height = ch;
        ctx.drawImage(video, (w - cw) / 2, (h - ch) / 2, cw, ch, 0, 0, cw, ch);
        try { got(reader.decodeWithState(new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(cv)))).getText()); } catch {}
      }
      setTimeout(loop, 120);
    };
    loop();
  }
  function stopCamera() {
    if (!cam) return;
    cam.stop = true;
    cam.stream.getTracks().forEach((t) => t.stop());
    $("#scan-video").srcObject = null;
    cam = null;
  }
  $("#cam-btn").addEventListener("click", openCamera);
  $("#scan-close").addEventListener("click", () => closeOverlay("scan-ov"));
  $("#scan-torch").addEventListener("click", async () => {
    const t = cam?.stream.getVideoTracks()[0]; if (!t) return;
    cam.torch = !cam.torch;
    try { await t.applyConstraints({ advanced: [{ torch: cam.torch }] }); $("#scan-torch").classList.toggle("on", cam.torch); } catch {}
  });

  // ---- سكانر خارجي (يكتب مثل الكيبورد بسرعة ويضغط Enter) ----
  const kbScan = { buf: "", t0: 0, last: 0 };
  document.addEventListener("keydown", (e) => {
    if ((state.screen !== "inventory" && state.screen !== "bin") || $$(".sheet-backdrop:not([hidden])").length) return;
    const now = performance.now();
    if (e.key === "Enter") {
      const n = kbScan.buf.length;
      const fast = n >= 6 && (kbScan.last - kbScan.t0) / Math.max(1, n - 1) < 45;   // أسرع من أي إنسان
      const code = kbScan.buf; kbScan.buf = "";
      if (!fast) return;
      e.preventDefault(); e.stopPropagation();
      if (document.activeElement === searchEl) { searchEl.value = ""; searchEl.blur(); }
      handleScan(code);
      return;
    }
    if (e.key.length !== 1) return;
    if (now - kbScan.last > 100) { kbScan.buf = ""; kbScan.t0 = now; }
    kbScan.buf += e.key; kbScan.last = now;
  }, true);

  /* ===== جرد الباركود: موقع موقع =====
     - الموظف يفتح الرف (A001)، كل ضربة = حبة، وزر الكمية للكراتين
     - كل شي "مسودة" لين يقفل الرف (يعدّل بحرية، ومحفوظة لو انقفل التطبيق)
     - القفل = إدخال واحد لكل صنف مربوط بالرف، وينتقل للرف اللي بعده
     - الصنف يقدر يكون بأكثر من رف: المجموع للصنف، والموقع يبقى الأصلي، والرفوف الثانية بالملاحظات
     - يمشي مع الجرد العادي بنفس الجولة بدون تعارض */
  const LS_MODES = "inv_modes_v1";
  const modes = store.get(LS_MODES, {});
  const LS_BINST = CLOUD ? "inv_binst_cloud_v1" : "inv_binst_v1";
  state.binSt = store.get(LS_BINST, {});                 // "جولة|رف" → {status, u, by, at}
  const LS_DRAFTS = "inv_bin_drafts_v1";
  const drafts = store.get(LS_DRAFTS, {});              // "جولة|رف" → {q:{رقم: كمية}, order:[], hist:[], last}
  const saveDrafts = () => store.set(LS_DRAFTS, drafts);
  let binQtyMode = store.get("inv_qtymode", false);
  const binOf = (loc) => { const L = cleanLoc(loc); return L.match(/^[A-Z]+[-+]?\d+/)?.[0] || L.match(/^[A-Z]+$/)?.[0] || ""; };
  const binCmp = (a, b) => {
    const pa = parseLoc(a) || { p: a, n: -1 }, pb = parseLoc(b) || { p: b, n: -1 };
    return (pa.p < pb.p ? -1 : pa.p > pb.p ? 1 : 0) || pa.n - pb.n || (a < b ? -1 : a > b ? 1 : 0);
  };
  const binKey = (bin) => `${state.round.id}|${bin}`;
  const binDraft = () => (drafts[binKey(state.binCur)] ||= { q: {}, order: [], hist: [], last: null });
  // نفس إعداد الجولة بدون شاشة القائمة
  function enterRound(r) {
    if (state.round?.id !== r.id) { state.status = "todo"; state.pins = []; }
    state.round = r; state.mode = "open";
    state.branch = state.data.branches.indexOf(r.branch);
    setRoundItems();
  }
  // رفوف الجولة: من مواقع أصنافها بالنظام + أي رف انجرد فيه
  function roundBins(r) {
    const m = new Map();
    for (const it of roundItemsOf(r)) {
      if (it.x || !inRange(r, it)) continue;
      const b = binOf(it.loc); if (!b) continue;
      m.set(b, (m.get(b) || 0) + 1);
    }
    for (const [k, c] of Object.entries(state.counts)) if (k.startsWith(r.id + "|")) for (const e of c.entries) if (e.bin && !m.has(e.bin)) m.set(e.bin, 0);
    for (const k of Object.keys(drafts)) if (k.startsWith(r.id + "|")) { const b = k.slice(r.id.length + 1); if (!m.has(b)) m.set(b, 0); }
    return [...m.entries()].map(([bin, n]) => ({ bin, n })).sort((a, b) => binCmp(a.bin, b.bin));
  }
  // الكمية المعتمدة لكل صنف في رف (من الإدخالات)
  function binCommitted(r, bin) {
    const m = new Map(), pre = r.id + "|";
    for (const [k, c] of Object.entries(state.counts)) {
      if (!k.startsWith(pre)) continue;
      for (const e of c.entries) if (e.bin === bin) m.set(k.slice(pre.length), (m.get(k.slice(pre.length)) || 0) + (+e.qty || 0));
    }
    return m;
  }
  // الرفوف الثانية للصنف (للملاحظات بالتصدير)
  function extraBinsNote(it, c) {
    if (!c) return "";
    const m = new Map();
    for (const e of c.entries) if (e.bin) m.set(e.bin, (m.get(e.bin) || 0) + (+e.qty || 0));
    const orig = binOf(it.loc);
    const others = [...m.entries()].filter(([b, q]) => q && b !== orig && b !== c.loc);
    return others.length ? `مواقع إضافية: ${others.map(([b, q]) => `${b} (${q})`).join("، ")}` : "";
  }
  const binStatus = (bin) => {
    const s = state.binSt[binKey(bin)];
    const fresh = s && Date.now() - (s.at || 0) < 3 * 3600000;      // الفتح يعتبر منتهي بعد 3 ساعات (جوال طفى مثلاً)
    if (s?.status === "closed") return { st: "closed", by: s.by, at: s.at };
    if (drafts[binKey(bin)] && Object.keys(drafts[binKey(bin)].q).length) return { st: "draft" };
    if (s?.status === "open" && fresh && s.u !== myId()) return { st: "busy", by: s.by };
    return { st: "" };
  };
  function pushBin(bin, status) {
    const row = { round_id: state.round.id, bin, status, by_name: me()?.name || "" };
    state.binSt[binKey(bin)] = { status, u: myId(), by: row.by_name, at: Date.now() };
    store.set(LS_BINST, state.binSt);
    window.DB.queue({ t: "bin", row });
  }

  // ---- قائمة المواقع ----
  function renderBins() {
    const r = state.round;
    const bins = roundBins(r);
    let closed = 0;
    $("#bins-title").textContent = r.name || branchLabel(r.branch);
    $("#bins-list").innerHTML = bins.length ? bins.map(({ bin, n }) => {
      const s = binStatus(bin);
      if (s.st === "closed") closed++;
      const lab = { closed: `✓ انقفل${s.by ? " · " + esc(s.by) : ""}`, draft: "✎ مسودة — ما انقفل", busy: `مفتوح عند ${esc(s.by || "موظف")}`, "": "" }[s.st];
      return `<button class="bin-row st-${s.st || "left"}" data-bin="${esc(bin)}"><b dir="ltr">${esc(bin)}</b><span>${n ? fmt(n) + " صنف بالنظام" : "بدون أصناف بالنظام"}</span><i>${lab}</i></button>`;
    }).join("") : `<p class="muted pad">ما فيه مواقع بنطاق هذا الجرد — استخدم "اكتب موقع"</p>`;
    $("#bins-count").textContent = `${fmt(closed)}/${fmt(bins.length)}`;
    $("#bins-bar").style.width = bins.length ? (closed / bins.length) * 100 + "%" : "0";
    const nxt = bins.find((b) => binStatus(b.bin).st !== "closed" && binStatus(b.bin).st !== "busy");
    $("#bins-next").textContent = nxt ? `ابدأ من ${nxt.bin} ←` : "كل المواقع انقفلت ✓";
    $("#bins-next").disabled = !nxt;
  }
  function openBin(bin) {
    bin = cleanLoc(bin);
    if (!bin) return;
    const s = binStatus(bin);
    if (s.st === "busy" && !confirm(`الموقع ${bin} مفتوح عند ${s.by || "موظف ثاني"}.\nتفتحه أنت بعد؟ (ممكن ينجرد مرتين)`)) return;
    const key = binKey(bin);
    // رف مقفول قبل: نفتحه للتعديل من الكميات المعتمدة
    if (!drafts[key]) {
      const had = binCommitted(state.round, bin);
      drafts[key] = { q: Object.fromEntries(had), order: [...had.keys()], hist: [], last: null };
      saveDrafts();
    }
    if (state.binSt[key]?.status !== "open" || state.binSt[key]?.u !== myId()) pushBin(bin, "open");
    go(`bin/${state.round.id}/${encodeURIComponent(bin)}`);
  }
  $("#bins-list").addEventListener("click", (e) => { const b = e.target.closest("[data-bin]"); if (b) openBin(b.dataset.bin); });
  $("#bins-next").addEventListener("click", () => {
    const nxt = roundBins(state.round).find((b) => !["closed", "busy"].includes(binStatus(b.bin).st));
    if (nxt) openBin(nxt.bin);
  });
  $("#bins-goto-btn").addEventListener("click", () => { openBin($("#bins-goto").value); $("#bins-goto").value = ""; });
  $("#bins-goto").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#bins-goto-btn").click(); });
  $("#to-scan").addEventListener("click", () => { modes[state.round.id] = "scan"; store.set(LS_MODES, modes); go("bins/" + state.round.id); });
  $("#to-normal").addEventListener("click", () => { modes[state.round.id] = "normal"; store.set(LS_MODES, modes); go("inv/" + state.round.id); });
  $("#mode-backdrop").addEventListener("click", (e) => {
    const b = e.target.closest("[data-mode]"); if (!b) return;
    modes[state.round.id] = b.dataset.mode; store.set(LS_MODES, modes);
    closeOverlay("mode-backdrop");
    if (b.dataset.mode === "scan") go("bins/" + state.round.id);
  });

  // ---- داخل الموقع ----
  const itemByN = (n) => state.branchAll.find((x) => x.n === n);
  function renderBin() {
    const r = state.round, bin = state.binCur, d = binDraft();
    const expected = roundItemsOf(r).filter((it) => !it.x && binOf(it.loc) === bin);
    $("#bin-title").textContent = bin;
    $("#bin-sub").textContent = `${fmt(expected.length)} صنف بالنظام`;
    $("#bin-qtymode").classList.toggle("active", binQtyMode);
    const scanned = d.order.filter((n) => d.q[n] > 0).reverse();
    const scannedSet = new Set(scanned);
    const pieces = scanned.reduce((s, n) => s + d.q[n], 0);
    $("#bin-total").textContent = `${fmt(scanned.length)} صنف · ${fmt(pieces)} حبة`;
    const row = (it, q) => {
      const other = binOf(it.loc) !== bin;
      return `<div class="bin-item${q ? " on" : ""}${it.n === d.last ? " last" : ""}" data-n="${esc(it.n)}">
        <span class="bi-t"><b dir="ltr">${esc(it.n)}</b>${it.x ? '<i class="xb">زائد</i>' : other ? `<i class="xb ob">موقعه ${esc(binOf(it.loc) || "بدون")}</i>` : ""}<small>${esc(it.name)}</small></span>
        <span class="bi-sys">نظام <b>${fmt(it.q)}</b>${resv(it) ? `<i>محجوز ${fmt(resv(it))}</i>` : ""}</span>
        <span class="bi-q">${q ? fmt(q) : "—"}</span></div>`;
    };
    $("#bin-list").innerHTML =
      scanned.map((n) => { const it = itemByN(n); return it ? row(it, d.q[n]) : ""; }).join("") +
      (expected.some((it) => !scannedSet.has(it.n)) ? `<div class="bin-sep">بالنظام في ${esc(bin)} — ما انمسحت بعد</div>` : "") +
      expected.filter((it) => !scannedSet.has(it.n)).map((it) => row(it, 0)).join("");
    // بطاقة آخر صنف
    const last = d.last && itemByN(d.last);
    $("#bl-empty").hidden = !!last; $("#bl-card").hidden = !last;
    if (last) {
      $("#bl-num").textContent = last.n; $("#bl-name").textContent = last.name;
      $("#bl-big").textContent = fmt(d.q[last.n] || 0);
      const other = !last.x && binOf(last.loc) !== bin;
      $("#bl-tag").textContent = last.x ? "صنف زائد" : other ? `موقعه بالنظام ${binOf(last.loc) || "— بدون موقع"} · انضاف على مجموعه` : "";
      $("#bl-tag").className = "bl-tag" + (last.x || other ? " w" : "");
      const tot = countOf(last)?.qty || 0;
      $("#bl-sys").textContent = `النظام ${fmt(last.q)}${resv(last) ? ` · محجوز ${fmt(resv(last))}` : ""}${tot ? ` · معتمد بكل المواقع ${fmt(tot)}` : ""}`;
    }
  }
  // إضافة/تعديل كمية صنف في الرف (مسودة)
  function binSet(it, qty) {
    const d = binDraft();
    d.hist.push({ n: it.n, prev: d.q[it.n] || 0 });
    if (d.hist.length > 200) d.hist.shift();
    if (qty > 0) { d.q[it.n] = qty; if (!d.order.includes(it.n)) d.order.push(it.n); else { d.order = d.order.filter((x) => x !== it.n); d.order.push(it.n); } }
    else delete d.q[it.n];
    d.last = qty > 0 ? it.n : d.last === it.n ? null : d.last;
    saveDrafts();
    renderBin();
  }
  const binAdd = (it, n = 1) => binSet(it, (binDraft().q[it.n] || 0) + n);
  // ضربة باركود داخل الرف
  function binScan(raw) {
    const res = resolveBarcode(raw);
    if (!res.code) return null;
    window.DB.note?.(`رف ${state.binCur}: باركود ${res.code} → ${res.items.map((i) => i.n).join("، ") || "—"}`);
    if (res.items.length === 1) {
      const it = res.items[0];
      beep(it.x || binOf(it.loc) === state.binCur ? "ok" : "warn");
      if (binQtyMode) { openBinQty(it, "add"); return it; }
      binAdd(it, 1);
      return it;
    }
    beep("err");
    openPick(res.code, res.items, res.part);
    return null;
  }
  // اختيار صنف (باركود فيه أكثر من صنف / غير معروف / بحث يدوي)
  let pick = null;
  function openPick(code, candidates, query) {
    pick = { code };
    $("#pk-title").textContent = code ? (candidates.length ? "أكثر من صنف لهذا الباركود" : "باركود غير معروف") : "بحث يدوي";
    $("#pk-sub").textContent = code ? `${code} — اختيارك يربطه بالصنف للمرات الجاية` : `يضاف للموقع ${state.binCur}`;
    $("#pk-search").value = candidates.length ? "" : query || "";
    renderPick(candidates);
    openOverlay("pick-backdrop");
    if (!candidates.length) setTimeout(() => $("#pk-search").focus(), 250);
  }
  function renderPick(candidates) {
    const toks = parseText($("#pk-search").value);
    const list = candidates?.length && !toks ? candidates : toks ? state.branchAll.filter((it) => matchText(it, toks)).slice(0, 60) : [];
    $("#pk-list").innerHTML = list.map((it) => `<button class="pk-row" data-n="${esc(it.n)}"><b dir="ltr">${esc(it.n)}</b><span>${esc(it.name)}</span><small dir="ltr">${esc(it.loc || "—")} · ${fmt(it.q)}</small></button>`).join("")
      || `<p class="muted pad">${toks ? "ما فيه نتائج" : "اكتب رقم أو اسم الصنف"}</p>`;
  }
  let pkT;
  $("#pk-search").addEventListener("input", () => { clearTimeout(pkT); pkT = setTimeout(() => renderPick(null), 150); });
  $("#pk-list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-n]"); if (!b) return;
    const it = itemByN(b.dataset.n); if (it) binPicked(it);
  });
  $("#pk-extra").addEventListener("click", () => { const q = $("#pk-search").value.trim(); closeOverlay("pick-backdrop"); openExtra(q || pick?.code || ""); });
  function binPicked(it) {
    closeOverlay("pick-backdrop");
    if (pick?.code) { saveLink(pick.code, it.n); toast("✓ انربط الباركود بالصنف", 2000); }
    pick = null;
    if (binQtyMode) openBinQty(it, "add"); else binAdd(it, 1);
  }
  $("#bin-search").addEventListener("click", () => openPick(null, [], ""));

  // ---- الكمية (للكراتين والتعديل) ----
  let bq = null;
  function openBinQty(it, mode) {
    bq = { it, mode };
    const cur = binDraft().q[it.n] || 0;
    $("#bq-num").textContent = it.n; $("#bq-title").textContent = it.name;
    $("#bq-sys").textContent = `النظام ${fmt(it.q)}${resv(it) ? ` · محجوز ${fmt(resv(it))}` : ""} · في ${state.binCur} الحين: ${fmt(cur)}`;
    $("#bq-label").textContent = mode === "add" ? "كم حبة تضيف؟" : `الكمية في ${state.binCur}`;
    $("#bq-input").value = mode === "add" ? "" : cur || "";
    $("#bq-quick").innerHTML = [1, 5, 10, 12, 20, 24, 50, 100].map((v) => `<button type="button" data-v="${v}">${mode === "add" ? "" : "+"}${v}</button>`).join("");
    $("#bq-remove").hidden = mode === "add" || !cur;
    openOverlay("bq-backdrop");
    setTimeout(() => $("#bq-input").focus(), 200);
  }
  $("#bq-quick").addEventListener("click", (e) => {
    const b = e.target.closest("[data-v]"); if (!b) return;
    const v = +b.dataset.v, i = $("#bq-input");
    i.value = bq?.mode === "add" ? v : (+i.value || 0) + v;
    i.focus();
  });
  function saveBinQty() {
    if (!bq) return;
    const v = +toEnDigits($("#bq-input").value);
    if (!Number.isFinite(v) || v < 0) { toast("كمية غير صحيحة"); return; }
    const { it, mode } = bq; bq = null;
    closeOverlay("bq-backdrop");
    if (mode === "add") { if (v) binAdd(it, v); } else binSet(it, v);
  }
  $("#bq-save").addEventListener("click", saveBinQty);
  $("#bq-input").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveBinQty(); } });
  $("#bq-remove").addEventListener("click", () => { if (!bq) return; const it = bq.it; bq = null; closeOverlay("bq-backdrop"); binSet(it, 0); });
  $("#bl-big").addEventListener("click", () => { const it = itemByN(binDraft().last); if (it) openBinQty(it, "set"); });
  $("#bl-plus").addEventListener("click", () => { const it = itemByN(binDraft().last); if (it) binAdd(it, 1); });
  $("#bl-minus").addEventListener("click", () => { const it = itemByN(binDraft().last); if (it) binAdd(it, -1); });
  $("#bin-list").addEventListener("click", (e) => { const r = e.target.closest("[data-n]"); const it = r && itemByN(r.dataset.n); if (it) openBinQty(it, "set"); });
  $("#bin-undo").addEventListener("click", () => {
    const d = binDraft(); const h = d.hist.pop(); if (!h) { toast("ما فيه شيء نتراجع عنه"); return; }
    if (h.prev > 0) d.q[h.n] = h.prev; else delete d.q[h.n];
    d.last = h.prev > 0 ? h.n : d.order.filter((n) => d.q[n] > 0).at(-1) || null;
    saveDrafts(); renderBin(); toast("↶ تراجع");
  });
  $("#bin-qtymode").addEventListener("click", () => {
    binQtyMode = !binQtyMode; store.set("inv_qtymode", binQtyMode); renderBin();
    toast(binQtyMode ? "🔢 وضع الكمية: كل ضربة تسألك كم حبة" : "كل ضربة = حبة وحدة");
  });
  $("#bin-cam").addEventListener("click", openCamera);
  $("#bin-back").addEventListener("click", () => {
    const d = binDraft();
    if (Object.keys(d.q).length) toast("المسودة محفوظة — ترجع تكمل هذا الموقع بأي وقت", 2500);
    go("bins/" + state.round.id);
  });

  // ---- قفل الموقع ----
  $("#bin-close").addEventListener("click", () => {
    const r = state.round, bin = state.binCur, d = binDraft();
    const scanned = Object.keys(d.q).filter((n) => d.q[n] > 0);
    const pieces = scanned.reduce((s, n) => s + d.q[n], 0);
    const expected = roundItemsOf(r).filter((it) => !it.x && binOf(it.loc) === bin);
    const missing = expected.filter((it) => !d.q[it.n]);
    const fromOther = scanned.map(itemByN).filter((it) => it && !it.x && binOf(it.loc) !== bin);
    $("#bc-title").textContent = `قفل الموقع ${bin}`;
    $("#bc-body").innerHTML = `<div class="sc-nums rp-nums"><div><b>${fmt(scanned.length)}</b><small>صنف انمسح</small></div><div><b>${fmt(pieces)}</b><small>حبة</small></div>
        <div class="${missing.length ? "w" : "okc"}"><b>${fmt(missing.length)}</b><small>ما انمسح</small></div><div><b>${fmt(fromOther.length)}</b><small>من موقع ثاني</small></div></div>` +
      (missing.length ? `<p class="hint">هذي بالنظام في ${esc(bin)} وما انمسحت — <b>ما تتصفّر</b>، لو لقيتوها برف ثاني تنحسب، واللي يبقى يطلع بمراجعة الفروقات:</p>
        <div class="bc-miss">${missing.slice(0, 30).map((it) => `<div><b dir="ltr">${esc(it.n)}</b><span>${esc(it.name)}</span><small>نظام ${fmt(it.q)}</small></div>`).join("")}${missing.length > 30 ? `<p class="muted">+ ${missing.length - 30} صنف</p>` : ""}</div>` : `<p class="okc">✓ كل أصناف الموقع انمسحت</p>`);
    const next = roundBins(r).find((b) => b.bin !== bin && !["closed", "busy"].includes(binStatus(b.bin).st) && binCmp(b.bin, bin) > 0)
      || roundBins(r).find((b) => b.bin !== bin && !["closed", "busy"].includes(binStatus(b.bin).st));
    $("#bc-next").textContent = next ? `قفل وافتح ${next.bin} ←` : "قفل — هذا آخر موقع";
    $("#bc-next").dataset.next = next?.bin || "";
    openOverlay("bc-backdrop");
  });
  // الاعتماد: إدخال لكل صنف بفرق المسودة عن المعتمد (أول مرة "جرد"، بعدها "تصحيح")
  function commitBin() {
    const r = state.round, bin = state.binCur, key = binKey(bin), d = drafts[key] || { q: {} };
    const had = binCommitted(r, bin);
    const u = me(), now = Date.now();
    let n = 0;
    for (const num of new Set([...Object.keys(d.q), ...had.keys()])) {
      const want = d.q[num] || 0, prev = had.get(num) || 0;
      if (want === prev) continue;
      const it = itemByN(num); if (!it) continue;
      const entry = { id: window.DB.uuid(), qty: want - prev, by: u?.name, u: myId(), at: now, kind: prev ? "fix" : "count", bin };
      commitExtra(it);
      const k = keyOf(it);
      const c = state.counts[k] ||= { entries: [], note: "" };
      c.entries.push(entry); normCount(c);
      pushEntry(it, entry);
      // الموقع يبقى الأصلي. الصنف اللي ما له موقع بالنظام ياخذ الرف اللي انوجد فيه
      if (!hasRealLoc(it.loc) && !c.loc) { c.loc = bin; pushMeta(it, c); }
      if (!state.branchItems.includes(it)) state.branchItems.push(it);
      n++;
    }
    saveCounts();
    delete drafts[key]; saveDrafts();
    pushBin(bin, "closed");
    return n;
  }
  $("#bc-next").addEventListener("click", () => {
    const next = $("#bc-next").dataset.next;
    commitBin(); closeOverlay("bc-backdrop");
    navigator.vibrate?.(30);
    if (next) { toast(`✓ انقفل ${state.binCur} — فتحنا ${next}`); openBin(next); }
    else { toast(`✓ انقفل ${state.binCur}`); go("bins/" + state.round.id); }
  });
  $("#bc-list").addEventListener("click", () => {
    commitBin(); closeOverlay("bc-backdrop");
    toast(`✓ انقفل ${state.binCur}`);
    go("bins/" + state.round.id);
  });

  /* ---------- النوافذ المنبثقة ---------- */
  function openOverlay(id) { $("#" + id).hidden = false; }
  function closeOverlay(id) {
    if (id === "imp-backdrop" && impBusy) return;     // ما نقفل النافذة وقت الرفع
    $("#" + id).hidden = true;
    if (id === "scan-ov") stopCamera();
    if (id === "sheet-backdrop") {
      const it = state.editing;
      state.editing = null;
      if (it?.x && !countOf(it)) { removeExtraIfEmpty(it); applyFilter(); }   // صنف زائد انضاف بدون جرد
      if (state.needReload) setTimeout(runSync, 300);
    }
    if (state.reloadOnClose && !$$(".sheet-backdrop:not([hidden])").length) {
      const f = state.reloadOnClose; state.reloadOnClose = null; setTimeout(f, 200);
    }
  }
  $$(".sheet-backdrop").forEach((bd) => bd.addEventListener("click", (e) => {
    if (e.target === bd) closeOverlay(bd.id);
  }));
  $$("[data-close]").forEach((b) => b.addEventListener("click", () => closeOverlay(b.dataset.close)));

  /* ---------- نطاق المواقع (من / إلى) ---------- */
  const locFrom = $("#loc-from"), locTo = $("#loc-to");
  $("#loc-btn").addEventListener("click", () => {
    searchEl.blur();
    const curLoc = state.pins.find((p) => p.type === "loc");
    locFrom.value = curLoc?.from || ""; locTo.value = curLoc?.to || "";
    $("#loc-prefixes").innerHTML = shelfChips(locGroups(state.branchItems, effLoc)) || `<p class="muted">لا توجد مواقع</p>`;
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
    return toEnDigits(s)
      .replace(/نقطتين|نقطتان/g, ":")
      .replace(/\s*(نقطه|نقطة)\s*/g, " .")
      .replace(/\s*(شرطه|شرطة|داش)\s*/g, "-")
      .replace(/[؟?!،,]+/g, "")
      // الجوال يقطّع الأرقام بمسافات ("90 919" / "9 0 9 1 9") — نرجّعها رقم واحد عشان البحث يلقاه
      .replace(/(\d)\s+(?=\d)/g, "$1")
      .replace(/(\d)\s*-\s*(?=\d)/g, "$1-")
      .replace(/(^|\s)([A-Za-z])\s+(?=\d)/g, "$1$2")
      .replace(/\.\s*$/, "")
      .replace(/\s+/g, " ")
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
    // صنف موقعه بالنظام خارج نطاق الجولة (أو بدون موقع): ينجرد هنا ونعدّل موقعه
    const out = !it.x && !inRange(state.round, it);
    const on = $("#sh-onote");
    const realLoc = hasRealLoc(it.loc);
    on.hidden = !out && realLoc;
    on.textContent = !realLoc ? "هذا الصنف بدون موقع بالنظام — اكتب الموقع اللي لقيته فيه"
      : `موقعه بالنظام ${it.loc} (خارج نطاق هذا الجرد) — اكتب الموقع اللي لقيته فيه`;
    cnt.value = "";
    const rv = state.mode === "review";
    cnt.placeholder = rv ? "كم بالرف؟" : "0";
    $("#sh-loc").value = out && !c ? "" : effLoc(it) || "";
    $("#sh-note").value = c?.note || "";
    $("#sh-reset").hidden = !(c && isAdmin());
    $("#sh-verify").hidden = !rv || !c || !!c.ver;
    const lk = scanLinkFor(it);
    $("#sh-link").hidden = !lk;
    if (lk) { $("#sh-link-cb").checked = true; $("#sh-link-code").textContent = `الباركود ${lk} — المرة الجاية يفتح هذا الصنف على طول`; }
    renderEntries();
    updateDiff();
    openOverlay("sheet-backdrop");
    setTimeout(() => ((out || !realLoc) && !c && !rv ? $("#sh-loc") : cnt).focus(), 250);
  }
  const closeSheet = () => closeOverlay("sheet-backdrop");

  function renderEntries() {
    const it = state.editing; const c = countOf(it);
    const box = $("#sh-entries");
    const rv = state.mode === "review";
    $("#sh-count-label").textContent = rv ? "العد الثاني: كم لقيت بالرف؟ (المجموع الكامل)"
      : c ? "إضافة كمية (تُجمع مع الجرد السابق)" : "كمية الجرد";
    if (!c) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = `<div class="ent-head"><span>الجرد السابق</span><b>المجموع ${fmt(c.qty)}</b></div>` +
      c.entries.map((e, i) => {
        const canDel = !rv && (isAdmin() || (e.u && e.u === myId()));
        const fix = e.kind === "fix";
        return `<div class="ent${fix ? " fix" : ""}"><b>${fix && e.qty > 0 ? "+" : ""}${fmt(e.qty)}</b><span>${e.bin ? `<i class="ent-bin" dir="ltr">${esc(e.bin)}</i>` : ""}${fix ? "تصحيح · " : ""}${esc(e.by || "—")} · ${fmtTime(e.at)}</span>${
          canDel ? `<button type="button" data-ent="${i}" aria-label="حذف هذا الإدخال"><svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg></button>` : ""}</div>`;
      }).join("") +
      (c.ver ? `<div class="ent ver"><b>✓</b><span>أكّده ${esc(c.ver.by || "")} · ${fmtTime(c.ver.at)}</span></div>` : "");
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
    if (state.mode === "review") {
      // المراجعة: الرقم المكتوب = المجموع الصحيح بالرف (مو إضافة)
      const shelf = cnt.value === "" ? prev : +cnt.value;
      const d = shelf + r - it.q;
      const chg = cnt.value !== "" && shelf !== prev ? `تعديل ${fmt(prev)} ← ${fmt(shelf)} · ` : "";
      if (isBlind()) { el.textContent = chg || (d ? "فيه فرق — أعد العد بدقة" : ""); el.className = "diff" + (d ? " bad" : ""); return; }
      el.textContent = chg + withR(shelf) + diffText(d);
      el.className = "diff " + (d === 0 ? "ok" : "bad");
      return;
    }
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

  // بعد حفظ جرد صنف جا من مسح باركود: نربط الباركود فيه لو الموظف اختاره يدوي
  function applyScanLink(it) {
    const s = state.scan;
    state.scan = null;
    if (!s || $("#sh-link").hidden || !$("#sh-link-cb").checked) return false;
    saveLink(s.code, it.n);
    return true;
  }
  function save() {
    const it = state.editing; if (!it) return;
    const key = keyOf(it);
    const c = state.counts[key];
    const v = toEnDigits(cnt.value).trim();
    const loc = cleanLoc($("#sh-loc").value) || $("#sh-loc").value.trim();
    const note = $("#sh-note").value.trim();
    if (state.mode === "review") return saveReview(it, key, c, v, loc, note);
    const out = !it.x && !inRange(state.round, it);
    if (out && !c && v !== "" && !loc) { $("#sh-loc").focus(); toast("اكتب الموقع اللي لقيت فيه الصنف"); return; }
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
    // صنف من موقع ثاني انجرد هنا = صار من أصناف هذا الجرد
    if (!state.branchItems.includes(it)) state.branchItems.push(it);
    saveCounts();
    const linked = applyScanLink(it);
    refreshRow(it);
    closeSheet();
    navigator.vibrate?.(30);
    toast((c && v !== "" ? `✓ أُضيفت — المجموع ${fmt(state.counts[key].qty)}` : "✓ تم حفظ الجرد") + (linked ? " · وانربط الباركود" : ""));
  }
  // المراجعة: العد الثاني يصحّح المجموع (إدخال "تصحيح" بالفرق) ويأكّد الصنف
  function saveReview(it, key, c, v, loc, note) {
    const prev = c?.qty || 0;
    if (v === "" && !c) { cnt.focus(); toast("اكتب كم لقيت بالرف (ولو صفر)"); return; }
    if (v !== "" && (!Number.isFinite(+v) || +v < 0)) { cnt.focus(); toast("كمية غير صحيحة"); return; }
    const total = v === "" ? prev : +v;
    const u = me();
    const now = Date.now();
    let cc = c;
    if (!c || total !== prev) {
      const entry = { id: window.DB.uuid(), qty: total - prev, by: u?.name, u: myId(), at: now, kind: "fix" };
      commitExtra(it);
      if (c) c.entries.push(entry);
      else cc = state.counts[key] = { entries: [entry], loc, note };
      normCount(cc);
      pushEntry(it, entry);
    }
    cc.loc = loc; cc.note = note;
    cc.ver = { by: u?.name, u: myId(), at: now };
    pushMeta(it, cc);
    if (!state.branchItems.includes(it)) state.branchItems.push(it);
    applyScanLink(it);
    saveCounts();
    refreshRow(it);
    closeSheet();
    navigator.vibrate?.(30);
    toast(total !== prev ? `✓ تم التصحيح ${fmt(prev)} ← ${fmt(total)} والتأكيد` : "✓ تم التأكيد");
  }
  $("#sh-verify").addEventListener("click", () => { cnt.value = ""; save(); });
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
    const n = toEnDigits(xNum.value).trim().toUpperCase().replace(/\s+/g, " ");
    const hit = n && state.branchAll.find((it) => it.n.toUpperCase() === n);
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
    const n = toEnDigits(xNum.value).trim().toUpperCase().replace(/\s+/g, " ");
    if (!n) { xNum.focus(); toast("اكتب رقم الصنف"); return; }
    const bname = state.data.branches[state.branch];
    let it = state.branchAll.find((x) => x.n.toUpperCase() === n);
    if (!it) {
      const u = me();
      const rec = { r: rid(), b: bname, n, name: $("#x-name").value.trim(), loc: cleanLoc($("#x-loc").value), by: u?.name, u: myId(), at: Date.now() };
      const ex = store.get(LS_EXTRAS, {});
      ex[`${rid()}|${n}`] = rec;
      store.set(LS_EXTRAS, ex);
      it = addExtraItem(rec);
      it.gone = false;
      if (!state.branchItems.includes(it)) { state.branchItems.push(it); state.inRound.add(it); }
      if (!state.branchAll.includes(it)) state.branchAll.push(it);
    }
    closeOverlay("extra-backdrop");
    if (state.screen === "bin") { binPicked(it); return; }
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
    let extrasChanged = false, roundsChanged = false;
    // الجولات (يفتحها ويغيّر مرحلتها المدير)
    for (const r of ch.rounds || []) {
      const old = state.rounds[r.id];
      state.rounds[r.id] = { ...old, ...r };
      if (!old || old.status !== r.status || old.deleted !== r.deleted || old.loc_from !== r.loc_from || old.loc_to !== r.loc_to
        || JSON.stringify(old.users) !== JSON.stringify(r.users)) roundsChanged = true;
    }
    if ((ch.rounds || []).length) saveRounds();
    if ((ch.barcodes || []).length) {
      for (const [code, n, , deleted] of ch.barcodes) { if (deleted) delete state.links[code]; else state.links[code] = n; }
      store.set(LS_LINKS, state.links);
    }
    let binsChanged = false;
    for (const [round, bin, status, uid, by, at] of ch.bins || []) {
      const k = `${round}|${bin}`, cur = state.binSt[k];
      if (cur && cur.at > at && cur.u === myId()) continue;          // تغييري المحلي أحدث
      state.binSt[k] = { status, u: uid, by, at: +at }; binsChanged = true;
    }
    if (binsChanged) store.set(LS_BINST, state.binSt);
    for (const [id, branch, n, qty, uid, by, at, deleted, round, kind, bin] of ch.entries) {
      if (!round) continue;
      const key = `${round}|${n}`;
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
      c.entries.push({ id, qty: +qty, by, u: uid, at: +at, kind: kind || "count", bin: bin || undefined });
      c.entries.sort((a, b) => a.at - b.at);
      normCount(c); touched.add(key);
    }
    for (const [branch, n, loc, note, at, round, vname, vat, vby] of ch.meta) {
      if (!round) continue;
      const key = `${round}|${n}`;
      const c = state.counts[key];
      if (!c || (c.metaAt && c.metaAt > at)) continue;
      const ver = vat ? { by: vname, u: vby, at: +vat } : undefined;
      if (c.loc !== (loc ?? undefined) || (c.note || "") !== (note || "") || !!c.ver !== !!ver) touched.add(key);
      c.loc = loc ?? undefined; c.note = note || ""; c.metaAt = at; c.ver = ver;
    }
    if (ch.extras.length) {
      const exs = store.get(LS_EXTRAS, {});
      for (const [branch, n, name, loc, by, uid, at, deleted, round] of ch.extras) {
        if (!round) continue;
        const key = `${round}|${n}`;
        if (deleted) {
          if (!exs[key]) continue;
          delete exs[key]; extrasChanged = true;
          const bi = state.data?.branches.indexOf(branch);
          const it = bi >= 0 ? state.data.items.find((x) => x.x && x.xr === round && x.b === bi && x.n === n) : null;
          if (it && !state.counts[key]) it.gone = true;
        } else {
          if (exs[key]?.synced && exs[key].name === name && exs[key].loc === loc) continue;
          const rec = { r: round, b: branch, n, name, loc, by, u: uid, at: +at, synced: true };
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
    if ((state.screen === "bins" || state.screen === "bin") && state.round) {
      const r = state.rounds[state.round.id];
      if (roundsChanged && (!r || r.status !== "open" || !myRounds().includes(r))) { if (!$$(".sheet-backdrop:not([hidden])").length) go("branches"); return; }
      if (r) state.round = r;
      if (state.screen === "bins" && (binsChanged || touched.size || roundsChanged)) renderBins();
      return;
    }
    if (!state.data || (!touched.size && !extrasChanged && !roundsChanged)) return;
    // تحديث الشاشة الحالية بدون ما نرجّع المستخدم لفوق
    if (state.screen === "inventory" && state.round) {
      const r = state.rounds[state.round.id];
      if (roundsChanged && (!r || !myRounds().includes(r))) {
        // الجولة انقفلت أو انحذفت أو ما عادت له
        if (!state.editing) { toast(r?.status === "closed" ? "تم إغلاق هذا الجرد من الإدارة" : "هذا الجرد ما عاد متاح لك", 3500); go("branches"); }
        return;
      }
      if (roundsChanged && r.status !== state.round.status && !state.editing) {
        toast(r.status === "review" ? "بدأت مراجعة الفروقات — أعد عد الأصناف اللي فيها فرق" : "رجع الجرد مفتوح", 3500);
        openRound(r); return;
      }
      state.round = r;
      if ((extrasChanged || roundsChanged) && !state.editing) {
        setRoundItems();
        const top = $("#table-wrap").scrollTop;
        applyFilter();
        $("#table-wrap").scrollTop = top;
      } else {
        for (const it of state.branchItems) if (touched.has(keyOf(it))) refreshRow(it);
        updateProgress();
      }
      if (state.editing && touched.has(keyOf(state.editing))) { renderEntries(); updateDiff(); }
    } else if (state.screen === "branches") renderRounds();
    else if (state.screen === "admin" && !state.adminBusy) renderAdmin(true);
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
  // الضغط على النقطة: الحالة + سجل التشخيص (صوّره لو فيه مشكلة)
  $$(".sync-ind").forEach((el) => el.addEventListener("click", () => {
    const s = window.DB.getStatus();
    $("#diag-body").textContent = [
      syncTxt,
      `الإصدار ${APP_VER} · ${navigator.onLine ? "فيه نت" : "بدون نت"} · بانتظار الرفع: ${s.pending}${s.others ? ` · لحساب ثاني: ${s.others}` : ""}`,
      `آخر نجاح: ${s.okAt ? new Date(s.okAt).toLocaleTimeString("en-GB") : "—"} · الجلسة: ${localStorage.getItem("inv-auth") ? "موجودة" : "مفقودة"}`,
      "", ...window.DB.log.slice().reverse(),
    ].join("\n");
    openOverlay("diag-backdrop");
    runSync();
  }));

  // المراقب: لو فيه جرد معلّق أكثر من دقيقتين وفيه نت — نصلّحه تلقائياً بإعادة تحميل الصفحة (نفس اللي كان يحل المشكلة يدوياً)
  setInterval(() => {
    if (!CLOUD || !me() || document.visibilityState !== "visible" || !navigator.onLine) return;
    const s = window.DB.getStatus();
    if (!s.pending) return;
    const stuck = Date.now() - Math.max(s.oldestPending, s.okAt || 0);
    if (stuck > 45000) runSync();
    if (stuck < 120000 || $$(".sheet-backdrop:not([hidden])").length) return;
    let last = 0; try { last = +sessionStorage.getItem("inv_autoreload") || 0; } catch {}
    if (Date.now() - last < 5 * 60000) return;             // مرة كل 5 دقايق بالكثير
    try { sessionStorage.setItem("inv_autoreload", Date.now()); } catch {}
    window.DB.note("المراقب: الرفع معلّق — إعادة تحميل تلقائي");
    try { localStorage.setItem("inv_diag_log", JSON.stringify(window.DB.log)); } catch {}
    location.reload();
  }, 15000);
  window.DB.onStatus(renderSync);
  // المدير: لما تنرفع جولة نشيل علامة "لسا ما انرفع"
  let lastPendRounds = 0;
  window.DB.onStatus(() => {
    const n = window.DB.pendingRounds().size;
    if (n !== lastPendRounds) { lastPendRounds = n; if (state.screen === "admin" && adminTab === "rounds") renderAdmin(true); }
  });
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
  // صفوف جولة: [{r, it, c}] — withTodo = حتى اللي ما انجرد
  const roundRows = (r, withTodo = true) => roundItemsOf(r).map((it) => ({ r, it, c: countIn(r, it) })).filter((x) => withTodo || x.c);
  const dt = (t) => (t ? new Date(t).toLocaleString("en-GB") : "");
  function countRows(rows, blind) {
    const head = ["الجرد", "الفرع", "رقم الصنف", "اسم الصنف", "النوع", "الموقع بالنظام", "الموقع بعد الجرد",
      ...(blind ? [] : ["المتوفر", "المحجوز"]), "الجرد (بالرف)", ...(blind ? [] : ["الجرد النهائي (+المحجوز)", "الفرق"]),
      "تفصيل الإدخالات", "التأكيد", "ملاحظات", "آخر جرد بواسطة", "التاريخ"];
    const out = rows.filter(({ it }) => !it.gone).map(({ r, it, c }) => {
      const type = it.x ? "زائد (غير موجود بالنظام)" : !inRange(r, it) ? "من موقع ثاني" : !c ? "ما انجرد" : "";
      return [roundTitle(r), branchLabel(state.data.branches[it.b]), it.n, it.name, type, it.loc, c?.loc ?? "",
        ...(blind ? [] : [it.q, it.r]), c?.qty ?? "", ...(blind ? [] : [c ? finalOf(it, c) : "", c ? diffOf(it, c) : ""]),
        c ? c.entries.map((e) => `${e.kind === "fix" && e.qty > 0 ? "+" : ""}${e.qty} (${e.kind === "fix" ? "تصحيح " : ""}${e.by || ""})`).join(" ، ") : "",
        c?.ver ? `${c.ver.by || ""} ${dt(c.ver.at)}` : "", [c?.note, extraBinsNote(it, c)].filter(Boolean).join(" · "), c?.by ?? "", c ? dt(c.at) : ""];
    });
    return [head, ...out];
  }
  function exportCSV(rows, name, blind) {
    const csv = countRows(rows, blind).map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
    download(name, "﻿" + csv, "text/csv;charset=utf-8");
  }
  // تصدير الجرد من شاشة الموظف انشال — المدير يسحبه من لوحة التحكم

  // ملف جرد (JSON) يرسله الموظف للمدير ليدمجه في جهازه
  function exportBackup(withUsers) {
    const u = me();
    const data = { type: "inv-backup", v: 3, at: Date.now(), by: u?.name, counts: state.counts, extras: store.get(LS_EXTRAS, {}) };
    if (withUsers) data.users = store.get(LS_USERS, []);
    download(`جرد-${u?.username || "user"}-${today()}.json`, JSON.stringify(data), "application/json");
  }
  $("#backup-card").addEventListener("click", () => exportBackup(false));

  /* ---------- لوحة التحكم (للمدير) ---------- */
  let adminTab = "rounds";
  $$("#admin-tabs button").forEach((b) => b.addEventListener("click", () => { adminTab = b.dataset.tab; renderAdmin(); }));

  // soft = تحديث من المزامنة: ما نرسم وفيه نافذة مفتوحة أو المستخدم يتعامل مع الصفحة
  // آخر مرة المدير لمس أو كتب في لوحة التحكم
  let adminTouchAt = 0;
  ["pointerdown", "keydown", "input", "wheel", "scroll"].forEach((ev) =>
    $("#screen-admin").addEventListener(ev, () => { adminTouchAt = Date.now(); }, { capture: true, passive: true }));
  function renderAdmin(soft) {
    if (soft) {
      // تحديث تلقائي من المزامنة: ما نعيد الرسم والمدير شغّال (يكتب، فاتح نافذة، أو لمس الصفحة قبل شوي)
      if ($$(".sheet-backdrop:not([hidden])").length) return;
      if (adminTab !== "rounds" && adminTab !== "locs") return;
      if (Date.now() - adminTouchAt < 20000) { clearTimeout(renderAdmin.t); renderAdmin.t = setTimeout(() => renderAdmin(true), 20000); return; }
      const a = document.activeElement;
      if (a && $("#screen-admin").contains(a) && /INPUT|SELECT|TEXTAREA/.test(a.tagName)) return;
      const y = window.scrollY;
      renderAdmin(false);
      window.scrollTo(0, y);
      return;
    }
    $$("#admin-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === adminTab));
    ["rounds", "locs", "users", "data"].forEach((t) => ($("#tab-" + t).hidden = t !== adminTab));
    if (adminTab === "rounds") renderRoundsAdmin();
    if (adminTab === "locs") renderLocs();
    if (adminTab === "users") { renderUsers(); if (CLOUD && !soft) loadProfiles(); }
    if (adminTab === "data") renderDataTab();
  }
  async function loadProfiles() {
    try { state.profiles = await window.DB.listProfiles(); }
    catch (e) { toast("تعذّر تحميل المستخدمين: " + e.message, 3000); return; }
    if (adminTab === "users") renderUsers();
  }

  /* ===== لوحة التحكم ← الجرد (الجولات) ===== */
  // أسماء اللي جردوا في الجولة: name → عدد الإدخالات
  function roundCounters(r) {
    const m = new Map();
    const pre = r.id + "|";
    for (const [k, c] of Object.entries(state.counts)) {
      if (!k.startsWith(pre)) continue;
      for (const e of c.entries) m.set(e.by || "—", (m.get(e.by || "—") || 0) + 1);
    }
    return m;
  }
  const fmtDate = (t) => (t ? new Date(t).toLocaleDateString("ar-SA-u-nu-latn", { day: "numeric", month: "short" }) : "");
  function renderRoundsAdmin() {
    const all = Object.values(state.rounds).filter((r) => !r.deleted);
    const active = all.filter((r) => r.status !== "closed").sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    const closed = all.filter((r) => r.status === "closed").sort((a, b) => (a.closed_at < b.closed_at ? 1 : -1)).slice(0, 30);
    const pend = window.DB.pendingRounds?.() || new Set();
    const card = (r) => {
      const p = roundProgress(r);
      const who = [...roundCounters(r).keys()];
      const st = r.status;
      const acts = st === "open"
        ? `<button data-act="review" class="btn primary sm-btn">إنهاء الجرد ← مراجعة الفروقات</button><button data-act="report" class="btn ghost sm-btn">التقرير</button><button data-act="edit" class="btn ghost sm-btn">تعديل</button><button data-act="del" class="btn ghost danger sm-btn">حذف</button>`
        : st === "review"
        ? `<button data-act="close" class="btn primary sm-btn">إغلاق واعتماد</button><button data-act="reopen" class="btn ghost sm-btn">رجوع للجرد</button><button data-act="report" class="btn ghost sm-btn">التقرير</button>`
        : `<button data-act="erp" class="btn primary sm-btn">ملف النظام (Excel)</button><button data-act="excel" class="btn ghost sm-btn">التفاصيل</button><button data-act="report" class="btn ghost sm-btn">التقرير</button>`;
      return `<div class="stat-card round-admin st-${st}" data-id="${esc(r.id)}">
        <div class="sc-top"><strong>${isQuick(r) ? "⚡ " : ""}${esc(r.name || branchLabel(r.branch))}</strong><i class="badge ${st === "review" ? "b2" : st === "closed" ? "b3" : ""}">${STATUS_AR[st]}</i></div>
        ${pend.has(r.id) ? `<small class="w">⏳ لسا ما انرفع للسيرفر — الموظفين ما يشوفونه. اضغط النقطة فوق للتفاصيل</small>` : ""}
        <small class="muted">${esc(branchLabel(r.branch))} · <b dir="ltr">${esc(rangeText(r))}</b> · فُتح ${fmtDate(r.created_at)}${r.closed_at ? " · أُغلق " + fmtDate(r.closed_at) : ""}</small>
        <span class="bc-bar"><span style="width:${p.pct}%"></span></span>
        <div class="sc-nums">
          <div><b>${fmt(p.done)}/${fmt(p.total)}</b><small>تم جرده</small></div>
          <div class="w"><b>${fmt(p.diff)}</b><small>فيه فرق</small></div>
          ${st === "open" ? `<div><b>${fmt(p.total - p.done)}</b><small>باقي</small></div><div><b>${fmt(p.extra)}</b><small>زائد</small></div>`
            : st === "review" ? `<div><b>${fmt(p.review)}</b><small>للمراجعة</small></div><div><b>${fmt(p.verified)}</b><small>مؤكد</small></div>`
            : `<div><b>${fmt(p.total - p.done)}</b><small>ما انجرد</small></div><div><b>${fmt(p.verified)}</b><small>مؤكد</small></div>`}
        </div>
        <small class="muted">${who.length ? "جرد: " + who.map(esc).join("، ") : "ما أحد بدأ"}${r.users?.length ? ` · مخصص لـ ${r.users.length} موظف` : ""}</small>
        <div class="ra-acts">${acts}</div>
      </div>`;
    };
    $("#tab-rounds").innerHTML =
      `<div class="ra-new"><button class="btn primary" id="new-round"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg> جرد مواقع (نطاق)</button>` +
      `<button class="btn ghost" id="new-quick"><svg viewBox="0 0 24 24"><path d="M13 2L3 14h9l-1 8 10-12h-9z"/></svg> جرد سريع (اختيار أصناف)</button></div>` +
      `<h4 class="sec">الجاري</h4>` + (active.map(card).join("") || `<p class="muted pad">ما فيه جرد مفتوح</p>`) +
      (closed.length ? `<h4 class="sec">المغلق</h4>` + closed.map(card).join("") : "");
  }
  $("#tab-rounds").addEventListener("click", (e) => {
    if (e.target.closest("#new-round")) return openRoundForm(null);
    if (e.target.closest("#new-quick")) return openQuick(null);
    const b = e.target.closest("[data-act]"); if (!b) return;
    const r = state.rounds[b.closest("[data-id]").dataset.id]; if (!r) return;
    roundAction(r, b.dataset.act);
  });
  function updateRound(r, fields) {
    Object.assign(r, fields);
    quickSets.delete(r);
    saveRounds();
    pushRound(r);
    renderAdmin();
  }
  async function roundAction(r, act) {
    if (act === "report") return openReport(r);
    if (act === "edit") return isQuick(r) ? openQuick(r) : openRoundForm(r);
    if (act === "erp") return exportERP(r);
    if (act === "excel") return exportRoundsExcel([r], `جرد-${roundTitle(r)}-${today()}.xlsx`);
    if (act === "del") {
      if (!confirm(`حذف الجرد "${roundTitle(r)}"؟ ${roundProgress(r).done ? "فيه أصناف مجرودة — بتختفي من التطبيق." : ""}`)) return;
      return updateRound(r, { deleted: true });
    }
    if (act === "review") {
      const p = roundProgress(r);
      if (!confirm(`إنهاء الجرد والبدء بمراجعة الفروقات؟\n\nتم جرد ${p.done} من ${p.total}\nللمراجعة: ${p.review} صنف (فيه فرق أو ما انجرد)\n\nالموظفين يشوفون بس الأصناف اللي تحتاج إعادة عد.`)) return;
      return updateRound(r, { status: "review", review_at: new Date().toISOString() });
    }
    if (act === "reopen") return updateRound(r, { status: "open" });
    if (act === "close") {
      const p = roundProgress(r);
      if (!confirm(`إغلاق واعتماد الجرد؟\n${p.review ? `⚠️ باقي ${p.review} صنف ما تأكد — بيتسجل بآخر عد (اللي ما انجرد = 0 بالرف).\n` : ""}\nبعد الإغلاق ينزل لك ملف النظام (رقم الصنف + الكمية + الموقع).`)) return;
      const who = Object.fromEntries(roundCounters(r));
      updateRound(r, { status: "closed", closed_at: new Date().toISOString(),
        summary: { total: p.total, done: p.done, diff: p.diff, verified: p.verified, counters: Object.keys(who) } });
      exportERP(r);
    }
  }

  // ---- فتح / تعديل جرد ----
  let editingRound = null;
  // الرفوف: لكل حرف أول وآخر موقع، وكم صنف موقعه الحرف بس (مثلاً "A" بدون رقم)
  function locGroups(items, getLoc = (it) => it.loc) {
    const g = new Map();
    for (const it of items) {
      const L = cleanLoc(getLoc(it));
      const letter = L.match(/^[A-Z]+/)?.[0];
      if (!letter) continue;
      if (!g.has(letter)) g.set(letter, { p: letter, min: Infinity, minS: "", max: -Infinity, maxS: "", cnt: 0, plain: 0 });
      const cur = g.get(letter);
      cur.cnt++;
      const raw = L.match(/^[A-Z]+[-+]?\d+/)?.[0];
      const p = parseLoc(raw);
      if (!p) { cur.plain++; continue; }
      if (p.n < cur.min) { cur.min = p.n; cur.minS = raw; }
      if (p.n > cur.max) { cur.max = p.n; cur.maxS = raw; }
    }
    return [...g.values()].sort((a, b) => (a.p < b.p ? -1 : 1));
  }
  // أزرار الرفوف: الضغط = الرف كامل (حتى المواقع اللي بدون رقم)
  const shelfChips = (groups) => groups.map((g) =>
    `<button type="button" class="lp" data-from="${esc(g.p)}" data-to="${esc(g.p)}"><b>${esc(g.p)}</b>` +
    `<small dir="ltr">${g.minS ? `${esc(g.minS)} → ${esc(g.maxS)}` : "بدون أرقام"}</small>` +
    `<small>${fmt(g.cnt)} صنف${g.plain ? ` · <i class="lp-plain">${fmt(g.plain)} بدون رقم</i>` : ""}</small></button>`).join("");
  const branchItemsOf = (bname) => { const bi = state.data.branches.indexOf(bname); return state.data.items.filter((it) => it.b === bi && !it.x && !it.gone); };
  function openRoundForm(r) {
    editingRound = r;
    const bs = state.data.branches;
    if (!bs.length) { toast("ارفع المخزون أول من تبويب البيانات"); return; }
    $("#rd-title").textContent = r ? "تعديل الجرد" : "فتح جرد جديد";
    $("#rd-branch").innerHTML = bs.map((b) => `<option value="${esc(b)}"${(r ? r.branch : state.lastRoundBranch || bs[0]) === b ? " selected" : ""}>${esc(branchLabel(b))}</option>`).join("");
    $("#rd-branch").disabled = !!r;
    $("#rd-from").value = r?.loc_from || ""; $("#rd-to").value = r?.loc_to || "";
    $("#rd-name").value = r?.name || "";
    const users = allUsers().filter((u) => u.role !== "admin" && u.active !== false);
    const sel = new Set(r?.users || []);
    $("#rd-users").innerHTML = users.length ? users.map((u) => {
      const id = CLOUD ? u.id : u.username;
      return `<label class="uchk"><input type="checkbox" value="${esc(id)}"${sel.has(id) ? " checked" : ""}><span>${esc(u.name)}</span></label>`;
    }).join("") : `<p class="muted">ما فيه موظفين — أضفهم من تبويب المستخدمون</p>`;
    $("#rd-error").hidden = true;
    renderRoundPrefixes();
    openOverlay("round-backdrop");
    if (CLOUD && !state.profiles) loadProfiles().then(() => { if (!$("#round-backdrop").hidden && editingRound === r) openRoundForm(r); });
  }
  function renderRoundPrefixes() {
    $("#rd-prefixes").innerHTML = shelfChips(locGroups(branchItemsOf($("#rd-branch").value))) || `<p class="muted">لا توجد مواقع</p>`;
    updateRoundPreview();
  }
  function updateRoundPreview() {
    const bname = $("#rd-branch").value;
    const r = { id: editingRound?.id || "_", branch: bname, loc_from: cleanLoc($("#rd-from").value), loc_to: cleanLoc($("#rd-to").value) };
    const t = roundTest(r);
    const its = branchItemsOf(bname).filter((it) => !t || t(it.loc || ""));
    const overlap = Object.values(state.rounds).filter((o) => !o.deleted && !isQuick(o) && o.status !== "closed" && o.branch === bname && o.id !== r.id)
      .filter((o) => its.some((it) => inRange(o, it))).map(roundTitle);
    $("#rd-preview").innerHTML = `<b>${fmt(its.length)}</b> صنف ${t ? `في النطاق <b dir="ltr">${esc(rangeText(r))}</b>` : "(الفرع كامل)"}` +
      (overlap.length ? `<br><span class="w">⚠️ يتداخل مع جرد مفتوح: ${overlap.map(esc).join("، ")}</span>` : "");
  }
  $("#rd-branch").addEventListener("change", () => { state.lastRoundBranch = $("#rd-branch").value; renderRoundPrefixes(); });
  ["#rd-from", "#rd-to"].forEach((s) => $(s).addEventListener("input", updateRoundPreview));
  $("#rd-prefixes").addEventListener("click", (e) => {
    const b = e.target.closest(".lp"); if (!b) return;
    $("#rd-from").value = b.dataset.from; $("#rd-to").value = b.dataset.to;
    updateRoundPreview();
  });
  $("#rd-save").addEventListener("click", () => {
    const from = cleanLoc($("#rd-from").value), to = cleanLoc($("#rd-to").value);
    if (!editingRound && !$("#rd-branch").value) { toast("اختر الفرع"); return; }
    const users = $$("#rd-users input:checked").map((i) => i.value);
    const fields = { loc_from: from, loc_to: to, name: $("#rd-name").value.trim(), users };
    if (!from && !to && !confirm("ما حددت مواقع — يعني جرد الفرع كامل. متأكد؟")) return;
    closeOverlay("round-backdrop");
    if (editingRound) { updateRound(editingRound, fields); toast("✓ تم تعديل الجرد"); return; }
    const r = { id: window.DB.uuid(), branch: $("#rd-branch").value, status: "open", created_at: new Date().toISOString(), deleted: false, ...fields };
    state.rounds[r.id] = r;
    updateRound(r, {});
    toast("✓ تم فتح الجرد — يطلع للموظفين الحين", 3000);
  });

  // ---- جرد سريع: شاشة اختيار الأصناف بفلاتر مثل Excel ----
  const QK_FIELDS = { n: "رقم الصنف", name: "اسم الصنف", loc: "الموقع", q: "المتوفر" };
  const QK_OPS_TXT = { starts: "يبدأ بـ", contains: "يحتوي", eq: "يساوي", notcontains: "لا يحتوي", notstarts: "لا يبدأ بـ" };
  const QK_OPS_NUM = { gt: "أكبر من", lt: "أقل من", eq: "يساوي" };
  const qk = { branch: null, sel: new Set(), filters: [], round: null, list: [] };
  function openQuick(r) {
    const bs = state.data.branches;
    if (!bs.length) { toast("ارفع المخزون أول من تبويب البيانات"); return; }
    qk.round = r;
    qk.branch = r ? r.branch : state.lastRoundBranch || bs[0];
    qk.sel = new Set(r?.items || []);
    qk.filters = [{ f: "name", op: "contains", v: "" }];
    $("#qk-title").textContent = r ? "تعديل الجرد السريع" : "جرد سريع — اختيار الأصناف";
    $("#qk-branch").innerHTML = bs.map((b) => `<option value="${esc(b)}"${b === qk.branch ? " selected" : ""}>${esc(branchLabel(b))}</option>`).join("");
    $("#qk-branch").disabled = !!r;
    $("#qk-name").value = r?.name || "";
    $("#qk-only").checked = !!r;
    $("#qk-paste").value = "";
    const users = allUsers().filter((u) => u.role !== "admin" && u.active !== false);
    const usel = new Set(r?.users || []);
    $("#qk-users").innerHTML = users.length ? users.map((u) => {
      const id = CLOUD ? u.id : u.username;
      return `<label class="uchk"><input type="checkbox" value="${esc(id)}"${usel.has(id) ? " checked" : ""}><span>${esc(u.name)}</span></label>`;
    }).join("") : `<p class="muted">ما فيه موظفين — أضفهم من تبويب المستخدمون</p>`;
    renderQkFilters();
    applyQk();
    openOverlay("quick-backdrop");
    if (CLOUD && !state.profiles) loadProfiles().then(() => { if (!$("#quick-backdrop").hidden && qk.round === r) { const keep = new Set(qk.sel); openQuick(r); qk.sel = keep; applyQk(); } });
    setTimeout(() => $("#qk-filters .qf-v")?.focus(), 250);
  }
  function renderQkFilters() {
    $("#qk-filters").innerHTML = qk.filters.map((f, i) => {
      const ops = f.f === "q" ? QK_OPS_NUM : QK_OPS_TXT;
      return `<div class="qf-row" data-i="${i}">
        <select class="qf-f">${Object.entries(QK_FIELDS).map(([k, t]) => `<option value="${k}"${k === f.f ? " selected" : ""}>${t}</option>`).join("")}</select>
        <select class="qf-op">${Object.entries(ops).map(([k, t]) => `<option value="${k}"${k === f.op ? " selected" : ""}>${t}</option>`).join("")}</select>
        <input class="qf-v" value="${esc(f.v)}" placeholder="${f.f === "q" ? "0" : "مثال: بواجي ، فلتر"}" autocomplete="off"${f.f === "n" || f.f === "loc" || f.f === "q" ? ' dir="ltr"' : ""}>
        <button type="button" class="sr-del" aria-label="حذف"><svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
      </div>`;
    }).join("");
  }
  // قيم الشرط: "بواجي ، فلتر" أو "بواجي أو فلتر" = أي وحدة منها
  const qkValues = (v) => String(v || "").split(/\s*(?:[,،|]|\sأو\s)\s*/).map((s) => s.trim()).filter(Boolean);
  function qkTest(f) {
    const vals = qkValues(f.v);
    if (!vals.length) return null;
    if (f.f === "q") {
      const x = +toEnDigits(vals[0]);
      if (!Number.isFinite(x)) return null;
      return (it) => (f.op === "gt" ? it.q > x : f.op === "lt" ? it.q < x : it.q === x);
    }
    const neg = f.op === "notcontains" || f.op === "notstarts";
    const mode = f.op === "starts" || f.op === "notstarts" ? "starts" : f.op === "eq" ? "eq" : "contains";
    const prep = vals.map((v) => ({ t: norm(v), k: numKey(v) }));
    const hay = (it) => (f.f === "n" ? [it.nn, it.nk] : f.f === "name" ? [it.nm] : [norm(it.loc || "")]);
    const hit = (h, p) => (mode === "starts" ? h.startsWith(p) : mode === "eq" ? h === p : h.includes(p));
    const one = (it) => { const hs = hay(it); return prep.some((p) => hs.some((h, j) => hit(h, j === 1 ? p.k : p.t) && (j === 0 || p.k))); };
    return neg ? (it) => !one(it) : one;
  }
  function applyQk() {
    const tests = qk.filters.map(qkTest).filter(Boolean);
    const all = branchItemsOf(qk.branch);
    const only = $("#qk-only").checked;
    qk.list = all.filter((it) => (only ? qk.sel.has(it.n) : true) && tests.every((t) => t(it)));
    const shown = qk.list.slice(0, 300);
    const selIn = qk.list.filter((it) => qk.sel.has(it.n)).length;
    $("#qk-count").innerHTML = `النتائج <b>${fmt(qk.list.length)}</b>${!tests.length && !only ? " (كل الفرع)" : ""} · المحدد منها <b>${fmt(selIn)}</b> · <span class="okc">إجمالي المحدد <b>${fmt(qk.sel.size)}</b></span>`;
    $("#qk-list").innerHTML = shown.length ? `<table class="rp-table qk-table"><thead><tr><th></th><th>رقم الصنف</th><th>اسم الصنف</th><th>الموقع</th><th>المتوفر</th></tr></thead><tbody>` +
      shown.map((it) => `<tr data-n="${esc(it.n)}" class="${qk.sel.has(it.n) ? "on" : ""}"><td><input type="checkbox"${qk.sel.has(it.n) ? " checked" : ""}></td>
        <td dir="ltr">${esc(it.n)}</td><td>${esc(it.name)}</td><td dir="ltr">${esc(it.loc || "—")}</td><td>${fmt(it.q)}</td></tr>`).join("") +
      `</tbody></table>${qk.list.length > shown.length ? `<p class="hint pad">يعرض أول 300 — "تحديد كل النتائج" يحدد الـ ${fmt(qk.list.length)} كلها</p>` : ""}`
      : `<p class="muted pad">ما فيه نتائج</p>`;
    $("#qk-save").textContent = qk.round ? `حفظ التعديل (${fmt(qk.sel.size)} صنف)` : `إنشاء الجرد السريع (${fmt(qk.sel.size)} صنف)`;
  }
  let qkT;
  $("#qk-filters").addEventListener("input", (e) => {
    const row = e.target.closest(".qf-row"); if (!row) return;
    const f = qk.filters[+row.dataset.i];
    if (e.target.classList.contains("qf-v")) { f.v = e.target.value; clearTimeout(qkT); qkT = setTimeout(applyQk, 200); }
  });
  $("#qk-filters").addEventListener("change", (e) => {
    const row = e.target.closest(".qf-row"); if (!row) return;
    const f = qk.filters[+row.dataset.i];
    if (e.target.classList.contains("qf-f")) { f.f = e.target.value; f.op = f.f === "q" ? "gt" : "contains"; renderQkFilters(); }
    if (e.target.classList.contains("qf-op")) f.op = e.target.value;
    applyQk();
  });
  $("#qk-filters").addEventListener("click", (e) => {
    const d = e.target.closest(".sr-del"); if (!d) return;
    qk.filters.splice(+d.closest(".qf-row").dataset.i, 1);
    if (!qk.filters.length) qk.filters.push({ f: "name", op: "contains", v: "" });
    renderQkFilters(); applyQk();
  });
  $("#qk-add-filter").addEventListener("click", () => {
    qk.filters.push({ f: "n", op: "starts", v: "" });
    renderQkFilters();
    $$("#qk-filters .qf-v").at(-1)?.focus();
  });
  $("#qk-branch").addEventListener("change", () => { qk.branch = $("#qk-branch").value; state.lastRoundBranch = qk.branch; qk.sel.clear(); applyQk(); });
  $("#qk-only").addEventListener("change", applyQk);
  $("#qk-all").addEventListener("click", () => {
    if (qk.list.length > 3000 && !confirm(`تحديد ${fmt(qk.list.length)} صنف؟`)) return;
    qk.list.forEach((it) => qk.sel.add(it.n)); applyQk();
  });
  $("#qk-none").addEventListener("click", () => { qk.list.forEach((it) => qk.sel.delete(it.n)); applyQk(); });
  $("#qk-list").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-n]"); if (!tr) return;
    const n = tr.dataset.n;
    if (qk.sel.has(n)) qk.sel.delete(n); else qk.sel.add(n);
    const on = qk.sel.has(n);
    tr.classList.toggle("on", on); tr.querySelector("input").checked = on;
    const selIn = qk.list.filter((it) => qk.sel.has(it.n)).length;
    $("#qk-count").innerHTML = $("#qk-count").innerHTML.replace(/المحدد منها <b>[^<]*<\/b>/, `المحدد منها <b>${fmt(selIn)}</b>`).replace(/إجمالي المحدد <b>[^<]*<\/b>/, `إجمالي المحدد <b>${fmt(qk.sel.size)}</b>`);
    $("#qk-save").textContent = qk.round ? `حفظ التعديل (${fmt(qk.sel.size)} صنف)` : `إنشاء الجرد السريع (${fmt(qk.sel.size)} صنف)`;
  });
  $("#qk-paste-add").addEventListener("click", () => {
    const have = new Map(branchItemsOf(qk.branch).map((it) => [it.n.toUpperCase(), it.n]));
    let add = 0, miss = [];
    for (const line of $("#qk-paste").value.split(/\r?\n/)) {
      const v = toEnDigits(line.split("\t")[0]).trim().toUpperCase().replace(/\s+/g, " ");
      if (!v || /رقم/.test(v)) continue;
      const n = have.get(v);
      if (n) { if (!qk.sel.has(n)) add++; qk.sel.add(n); } else miss.push(v);
    }
    $("#qk-paste").value = miss.join("\n");
    toast(`✓ أُضيف ${fmt(add)} صنف${miss.length ? ` · ${fmt(miss.length)} مو موجود بمخزون الفرع (باقي في المربع)` : ""}`, 3500);
    $("#qk-only").checked = true; applyQk();
  });
  $("#qk-save").addEventListener("click", () => {
    if (!qk.sel.size) { toast("حدد أصناف أول"); return; }
    const users = $$("#qk-users input:checked").map((i) => i.value);
    const fields = { name: $("#qk-name").value.trim(), users, items: [...qk.sel], kind: "quick", loc_from: "", loc_to: "" };
    closeOverlay("quick-backdrop");
    if (qk.round) { updateRound(qk.round, fields); toast("✓ تم تعديل الجرد السريع"); return; }
    const r = { id: window.DB.uuid(), branch: qk.branch, status: "open", created_at: new Date().toISOString(), deleted: false, ...fields };
    state.rounds[r.id] = r;
    updateRound(r, {});
    toast(`✓ جرد سريع (${fmt(fields.items.length)} صنف) — يطلع للموظفين الحين`, 3000);
  });

  // ---- تقرير نهاية الجرد ----
  async function openReport(r) {
    $("#rp-title").textContent = "تقرير: " + roundTitle(r);
    $("#rp-body").innerHTML = `<p class="muted pad">جاري تجهيز التقرير…</p>`;
    openOverlay("report-backdrop");
    let entries = null;
    if (CLOUD) {
      await window.DB.flush().catch(() => {});
      try {
        entries = (await window.DB.roundEntries(r.id)).map(([id, n, qty, u, by, at, deleted, delBy, kind]) =>
          ({ id, n, qty: +qty, u, by, at: +at, deleted, delBy, kind: kind || "count" }));
      } catch (e) { toast("تعذّر جلب كل الإدخالات — التقرير من البيانات المحفوظة", 3000); }
    }
    if (!entries) {
      entries = [];
      const pre = r.id + "|";
      for (const [k, c] of Object.entries(state.counts)) if (k.startsWith(pre)) for (const e of c.entries) entries.push({ ...e, n: k.slice(pre.length), deleted: false, kind: e.kind || "count" });
    }
    state.report = buildReport(r, entries);
    $("#rp-body").innerHTML = reportHTML(state.report);
  }
  function buildReport(r, entries) {
    const rows = roundRows(r, true);
    const s = { total: 0, done: 0, todo: 0, plus: 0, minus: 0, plusQ: 0, minusQ: 0, extra: 0, moved: 0, verified: 0, fixes: 0 };
    const byItem = new Map(rows.map((x) => [x.it.n, x]));
    for (const { it, c } of rows) {
      if (it.x) s.extra++;
      else if (inRange(r, it)) s.total++;
      if (c) {
        s.done++;
        const d = diffOf(it, c);
        if (d > 0) { s.plus++; s.plusQ += d; } else if (d < 0) { s.minus++; s.minusQ -= d; }
        if (!it.x && c.loc != null && c.loc !== (it.loc || "")) s.moved++;
        if (c.ver) s.verified++;
      } else if (!it.x && inRange(r, it)) s.todo++;
    }
    // الموظفين
    const U = new Map();
    const get = (u, by) => {
      const k = u || by || "—";
      if (!U.has(k)) U.set(k, { name: by || k, items: new Set(), entries: 0, fixes: 0, dels: 0, times: [], verified: 0 });
      const x = U.get(k); if (by) x.name = by; return x;
    };
    for (const e of entries) {
      const x = get(e.u, e.by);
      if (e.deleted) {
        // الحذف يُحسب على اللي حذف (أو صاحب الإدخال لو ما ندري)
        const d = e.delBy ? get(e.delBy, U.get(e.delBy)?.name) : x;
        d.dels++;
      }
      if (e.deleted) continue;
      x.entries++; x.times.push(e.at);
      if (e.kind === "fix") { x.fixes++; s.fixes++; } else x.items.add(e.n);
    }
    for (const { c } of rows) if (c?.ver) { const x = get(c.ver.u, c.ver.by); x.verified++; }
    const opened = Date.parse(r.created_at) || 0;
    const people = [...U.values()].filter((x) => x.entries || x.dels || x.verified).map((x) => {
      const t = x.times.sort((a, b) => a - b);
      let active = 0;
      for (let i = 1; i < t.length; i++) active += Math.min(t[i] - t[i - 1], 10 * 60000);   // فترات التوقف فوق 10 دقايق ما تنحسب
      active += t.length ? 60000 : 0;
      const rate = active ? x.items.size / (active / 3600000) : 0;
      return { ...x, items: x.items.size, first: t[0], last: t.at(-1), active, rate, late: t[0] && opened ? t[0] - opened : 0 };
    }).sort((a, b) => b.items - a.items);
    const ranked = people.filter((p) => p.items >= 5).sort((a, b) => b.rate - a.rate);
    const end = Date.parse(r.closed_at || "") || Date.now();
    return { r, s, people, fastest: ranked[0], slowest: ranked.length > 1 ? ranked.at(-1) : null, duration: end - opened, byItem };
  }
  const dur = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? `${m} د` : `${Math.floor(m / 60)} س ${m % 60} د`; };
  const hm = (t) => (t ? new Date(t).toLocaleString("ar-SA-u-nu-latn", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "—");
  function reportHTML(R) {
    const { r, s, people } = R;
    const box = (v, t, cls = "") => `<div class="${cls}"><b>${v}</b><small>${t}</small></div>`;
    return `<div class="rp-meta">${esc(branchLabel(r.branch))} · <b dir="ltr">${esc(rangeText(r))}</b> · ${STATUS_AR[r.status]}<br>
        فُتح ${hm(Date.parse(r.created_at))}${r.review_at ? ` · المراجعة ${hm(Date.parse(r.review_at))}` : ""}${r.closed_at ? ` · أُغلق ${hm(Date.parse(r.closed_at))}` : ""} · المدة ${dur(R.duration)}</div>
      <div class="sc-nums rp-nums">
        ${box(`${fmt(s.done)}/${fmt(s.total)}`, "تم جرده")}${box(fmt(s.todo), "ما انجرد", s.todo ? "w" : "")}
        ${box(`+${fmt(s.plus)}`, `زيادة (${fmt(s.plusQ)} حبة)`, "okc")}${box(`−${fmt(s.minus)}`, `نقص (${fmt(s.minusQ)} حبة)`, "badc")}
        ${box(fmt(s.extra), "صنف زائد")}${box(fmt(s.moved), "تغيّر موقعه")}${box(fmt(s.verified), "مؤكد بالمراجعة")}${box(fmt(s.fixes), "تصحيح بالمراجعة")}
      </div>
      ${R.fastest ? `<p class="rp-badges">⚡ الأسرع: <b>${esc(R.fastest.name)}</b> (${Math.round(R.fastest.rate)} صنف/ساعة)${R.slowest && R.slowest !== R.fastest ? ` · 🐢 الأبطأ: <b>${esc(R.slowest.name)}</b> (${Math.round(R.slowest.rate)} صنف/ساعة)` : ""}</p>` : ""}
      <div class="rp-table-wrap"><table class="rp-table">
        <thead><tr><th>الموظف</th><th>أصناف</th><th>إدخالات</th><th>صنف/ساعة</th><th>بدأ</th><th>آخر عد</th><th>وقت العمل</th><th>تأخر عن الفتح</th><th>تصحيح</th><th>حذف</th><th>تأكيد</th></tr></thead>
        <tbody>${people.map((p) => `<tr><td><b>${esc(p.name)}</b></td><td>${fmt(p.items)}</td><td>${fmt(p.entries)}</td><td>${p.items ? Math.round(p.rate) : "—"}</td>
          <td>${hm(p.first)}</td><td>${hm(p.last)}</td><td>${p.active ? dur(p.active) : "—"}</td><td>${p.first ? dur(p.late) : "—"}</td>
          <td class="${p.fixes ? "w" : ""}">${fmt(p.fixes)}</td><td class="${p.dels ? "w" : ""}">${fmt(p.dels)}</td><td>${fmt(p.verified)}</td></tr>`).join("")
          || `<tr><td colspan="11" class="muted">ما فيه جرد بعد</td></tr>`}</tbody>
      </table></div>
      <p class="hint">صنف/ساعة = عدد الأصناف ÷ وقت العمل الفعلي (التوقف أكثر من 10 دقايق ما ينحسب). التصحيح = تعديل بالمراجعة، والحذف = إدخالات انحذفت.</p>`;
  }
  $("#rp-export").addEventListener("click", async () => {
    const R = state.report; if (!R) return;
    const X = await loadXLSX();
    const wb = X.utils.book_new(); wb.Workbook = { Views: [{ RTL: true }] };
    const s = R.s;
    const sum = X.utils.aoa_to_sheet([
      ["الجرد", roundTitle(R.r)], ["الفرع", branchLabel(R.r.branch)], ["النطاق", rangeText(R.r)], ["الحالة", STATUS_AR[R.r.status]],
      ["فُتح", dt(R.r.created_at)], ["المراجعة", dt(R.r.review_at)], ["أُغلق", dt(R.r.closed_at)], ["المدة", dur(R.duration)], [],
      ["أصناف النطاق", s.total], ["تم جرده", s.done], ["ما انجرد", s.todo], ["زيادة (أصناف)", s.plus], ["زيادة (حبات)", s.plusQ],
      ["نقص (أصناف)", s.minus], ["نقص (حبات)", s.minusQ], ["أصناف زائدة", s.extra], ["تغيّر موقعه", s.moved], ["مؤكد بالمراجعة", s.verified], ["تصحيحات", s.fixes],
    ]);
    sum["!cols"] = [{ wch: 18 }, { wch: 30 }];
    X.utils.book_append_sheet(wb, sum, "الملخص");
    const ppl = X.utils.aoa_to_sheet([["الموظف", "أصناف", "إدخالات", "صنف/ساعة", "بدأ", "آخر عد", "وقت العمل (دقيقة)", "تأخر عن الفتح (دقيقة)", "تصحيح", "حذف", "تأكيد"],
      ...R.people.map((p) => [p.name, p.items, p.entries, Math.round(p.rate), dt(p.first), dt(p.last), Math.round(p.active / 60000), Math.round(p.late / 60000), p.fixes, p.dels, p.verified])]);
    ppl["!cols"] = [18, 8, 8, 10, 18, 18, 12, 14, 8, 8, 8].map((w) => ({ wch: w }));
    X.utils.book_append_sheet(wb, ppl, "الموظفين");
    const det = X.utils.aoa_to_sheet(countRows(roundRows(R.r, true), false));
    X.utils.book_append_sheet(wb, det, "الأصناف");
    X.writeFile(wb, `تقرير-${roundTitle(R.r)}-${today()}.xlsx`.replace(/[\\/:*?"<>|]/g, "-"));
  });

  // ---- ملف النظام: رقم الصنف + الكمية (جرد + محجوز) + الموقع المحدث ----
  async function exportERP(r) {
    if (CLOUD) await window.DB.sync(applyChanges);
    const rows = roundRows(r, true).filter(({ it }) => !it.gone);
    const erp = rows.map(({ it, c }) => [it.n, (c?.qty || 0) + resv(it), (c?.loc ?? it.loc) || ""]);
    try {
      const X = await loadXLSX();
      const wb = X.utils.book_new();
      const sh = X.utils.aoa_to_sheet([["رقم الصنف", "الكمية", "الموقع"], ...erp]);
      sh["!cols"] = [{ wch: 22 }, { wch: 10 }, { wch: 14 }];
      X.utils.book_append_sheet(wb, sh, "للنظام");
      const det = X.utils.aoa_to_sheet(countRows(rows, false));
      X.utils.book_append_sheet(wb, det, "التفاصيل");
      X.writeFile(wb, `للنظام-${roundTitle(r)}-${today()}.xlsx`.replace(/[\\/:*?"<>|]/g, "-"));
      toast(`✓ ملف النظام: ${fmt(erp.length)} صنف`, 3000);
    } catch { toast("تعذّر إنشاء ملف Excel"); }
  }
  async function exportRoundsExcel(rounds, name) {
    const done = [], todo = [];
    for (const r of rounds) for (const x of roundRows(r, true)) (x.c ? done : todo).push(x);
    const X = await loadXLSX();
    const wb = X.utils.book_new(); wb.Workbook = { Views: [{ RTL: true }] };
    const sh1 = X.utils.aoa_to_sheet(countRows(done, false));
    sh1["!cols"] = [20, 14, 18, 34, 14, 12, 12, 9, 9, 10, 12, 9, 30, 20, 20, 14, 18].map((w) => ({ wch: w }));
    X.utils.book_append_sheet(wb, sh1, "الجرد");
    const sh2 = X.utils.aoa_to_sheet([["الجرد", "الفرع", "رقم الصنف", "اسم الصنف", "الموقع", "المتوفر", "المحجوز"],
      ...todo.filter(({ it }) => !it.x).map(({ r, it }) => [roundTitle(r), branchLabel(r.branch), it.n, it.name, it.loc, it.q, it.r])]);
    sh2["!cols"] = [20, 14, 18, 34, 12, 9, 9].map((w) => ({ wch: w }));
    X.utils.book_append_sheet(wb, sh2, "لم يُجرد");
    X.writeFile(wb, name.replace(/[\\/:*?"<>|]/g, "-"));
    toast(`✓ ${fmt(done.length)} صنف مجرود · ${fmt(todo.length)} ما انجرد`, 3000);
  }

  // ---- خريطة المواقع: وش انجرد ومتى ومين، ووش باقي ----
  let locsBranch = null, locsSel = null;
  function renderLocs() {
    const bs = state.data.branches;
    if (!bs.length) { $("#tab-locs").innerHTML = `<p class="muted pad">ارفع المخزون أول</p>`; return; }
    if (!bs.includes(locsBranch)) {
      // نبدأ بفرع آخر جرد
      const last = Object.values(state.rounds).filter((r) => !r.deleted).sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
      locsBranch = last && bs.includes(last.branch) ? last.branch : bs[0];
    }
    const rounds = Object.values(state.rounds).filter((r) => !r.deleted && !isQuick(r) && r.branch === locsBranch);   // الجرد السريع ما يدخل بالخريطة
    const tests = rounds.map((r) => ({ r, t: roundTest(r) }));
    const bins = new Map();
    let noLoc = 0;
    for (const it of branchItemsOf(locsBranch)) {
      // الموقع: B057 أو الحرف بس (A) لو مكتوب بدون رقم
      const L = cleanLoc(it.loc);
      const bin = L.match(/^[A-Z]+[-+]?\d+/)?.[0] || L.match(/^[A-Z]+$/)?.[0];
      if (!bin) { noLoc++; continue; }
      bins.set(bin, (bins.get(bin) || 0) + 1);
    }
    const info = (bin) => {
      const cov = tests.filter(({ t }) => !t || t(bin)).map(({ r }) => r);
      const open = cov.find((r) => r.status !== "closed");
      const closed = cov.filter((r) => r.status === "closed").sort((a, b) => (a.closed_at < b.closed_at ? 1 : -1))[0];
      return { open, closed, st: open ? "prog" : closed ? "done" : "left" };
    };
    const groups = new Map();
    for (const [bin, n] of bins) {
      const p = parseLoc(bin) || { p: bin, n: -1 };          // -1 = الرف بدون رقم
      if (!groups.has(p.p)) groups.set(p.p, []);
      groups.get(p.p).push({ bin, n, num: p.n, ...info(bin) });
    }
    let tot = { done: 0, prog: 0, left: 0 };
    const html = [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([p, list]) => {
      list.sort((a, b) => a.num - b.num);
      const c = { done: 0, prog: 0, left: 0 };
      list.forEach((x) => { c[x.st]++; tot[x.st]++; });
      return `<div class="loc-group"><div class="lg-head"><b>${esc(p)}</b><small>${fmt(list.length)} موقع · <span class="okc">تم ${fmt(c.done)}</span> · <span class="w">جاري ${fmt(c.prog)}</span> · باقي ${fmt(c.left)}</small></div>
        <div class="lg-bins">${list.map((x) => `<button class="bin ${x.st}${locsSel === x.bin ? " sel" : ""}" data-bin="${esc(x.bin)}" title="${esc(x.bin)} · ${x.n} صنف">${x.num < 0 ? "بدون رقم" : esc(x.bin.replace(/^[A-Z]+[-+]?/, ""))}</button>`).join("")}</div>
        ${list.some((x) => x.bin === locsSel) ? binDetail(list.find((x) => x.bin === locsSel)) : ""}</div>`;
    }).join("");
    const all = tot.done + tot.prog + tot.left;
    $("#tab-locs").innerHTML =
      `<div class="locs-top"><select id="locs-branch">${bs.map((b) => `<option value="${esc(b)}"${b === locsBranch ? " selected" : ""}>${esc(branchLabel(b))}</option>`).join("")}</select>
        <div class="legend"><span class="bin done"></span>تم <span class="bin prog"></span>جاري <span class="bin left"></span>باقي</div></div>
      <div class="sc-nums rp-nums">
        <div><b>${all ? Math.round((tot.done / all) * 100) : 0}%</b><small>من مواقع الفرع</small></div>
        <div class="okc"><b>${fmt(tot.done)}</b><small>موقع انجرد</small></div><div class="w"><b>${fmt(tot.prog)}</b><small>جاري</small></div>
        <div><b>${fmt(tot.left)}</b><small>باقي</small></div></div>` +
      `<button class="nl-card" id="nl-open"${noLoc ? "" : " disabled"}>
        <span class="nl-ic"><svg viewBox="0 0 24 24"><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><path d="M9 7l6 6M15 7l-6 6"/></svg></span>
        <span class="nl-t"><b>${fmt(noLoc)}</b> صنف بدون موقع أو موقعه (-)<small>${noLoc ? "اضغط للقائمة — تقدر تصدّرها أو تسوي لها جرد سريع" : "كل الأصناف لها موقع ✓"}</small></span>
        <svg class="chev" viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>
      </button>` +
      (html || `<p class="muted pad">ما فيه مواقع بهذا الفرع</p>`);
  }

  // ---- أصناف بدون موقع (فاضي، "-"، أو أي شيء ما يبدأ بحرف رف) ----
  const hasRealLoc = (loc) => { const L = cleanLoc(loc); return /^[A-Z]+[-+]?\d+/.test(L) || /^[A-Z]+$/.test(L); };
  const noLocItems = (bname) => branchItemsOf(bname).filter((it) => !hasRealLoc(it.loc)).sort(byNum);
  let nlList = [];
  function renderNoLoc() {
    const q = $("#nl-search").value.trim();
    const toks = parseText(q);
    const list = toks ? nlList.filter((it) => matchText(it, toks)) : nlList;
    const shown = list.slice(0, 400);
    $("#nl-list").innerHTML = shown.length ? `<table class="rp-table qk-table nl-table"><thead><tr><th>رقم الصنف</th><th>اسم الصنف</th><th>الموقع</th><th>المتوفر</th><th>المحجوز</th></tr></thead><tbody>` +
      shown.map((it) => `<tr><td dir="ltr">${esc(it.n)}</td><td>${esc(it.name)}</td><td dir="ltr" class="muted">${esc(it.loc || "فاضي")}</td><td>${fmt(it.q)}</td><td>${it.r ? fmt(it.r) : ""}</td></tr>`).join("") +
      `</tbody></table>${list.length > shown.length ? `<p class="hint pad">يعرض أول 400 من ${fmt(list.length)} — التصدير فيه الكل</p>` : ""}`
      : `<p class="muted pad">ما فيه نتائج</p>`;
  }
  $("#tab-locs").addEventListener("click", (e) => {
    if (!e.target.closest("#nl-open")) return;
    nlList = noLocItems(locsBranch);
    $("#nl-title").textContent = `أصناف بدون موقع — ${branchLabel(locsBranch)}`;
    const qty = nlList.reduce((s, it) => s + it.q, 0);
    $("#nl-sub").textContent = `${fmt(nlList.length)} صنف · مجموع المتوفر ${fmt(qty)} حبة`;
    $("#nl-search").value = "";
    renderNoLoc();
    openOverlay("noloc-backdrop");
  });
  let nlT;
  $("#nl-search").addEventListener("input", () => { clearTimeout(nlT); nlT = setTimeout(renderNoLoc, 150); });
  $("#nl-export").addEventListener("click", async () => {
    try {
      const X = await loadXLSX();
      const wb = X.utils.book_new(); wb.Workbook = { Views: [{ RTL: true }] };
      const sh = X.utils.aoa_to_sheet([["الفرع", "رقم الصنف", "اسم الصنف", "الموقع بالنظام", "المتوفر", "المحجوز"],
        ...nlList.map((it) => [branchLabel(locsBranch), it.n, it.name, it.loc || "", it.q, it.r])]);
      sh["!cols"] = [14, 20, 40, 14, 10, 10].map((w) => ({ wch: w }));
      X.utils.book_append_sheet(wb, sh, "بدون موقع");
      X.writeFile(wb, `بدون-موقع-${branchLabel(locsBranch)}-${today()}.xlsx`.replace(/[\\/:*?"<>|]/g, "-"));
    } catch { toast("تعذّر إنشاء ملف Excel"); }
  });
  // جرد سريع لكل الأصناف اللي بدون موقع (الموظف يجردها ويكتب موقعها الصحيح)
  $("#nl-quick").addEventListener("click", () => {
    const items = nlList.map((it) => it.n);
    if (!items.length) return;
    closeOverlay("noloc-backdrop");
    state.lastRoundBranch = locsBranch;
    openQuick(null);
    qk.sel = new Set(items);
    $("#qk-only").checked = true;
    $("#qk-name").value = `بدون موقع — ${branchLabel(locsBranch)}`;
    applyQk();
  });
  function binDetail(x) {
    const r = x.open || x.closed;
    const names = r ? (r.status === "closed" && r.summary?.counters ? r.summary.counters : [...roundCounters(r).keys()]) : [];
    return `<div class="bin-detail"><b dir="ltr">${esc(x.bin)}</b> · ${fmt(x.n)} صنف<br>${
      x.open ? `<span class="w">جاري: ${esc(roundTitle(x.open))} (${STATUS_AR[x.open.status]}) · فُتح ${hm(Date.parse(x.open.created_at))}</span>`
      : x.closed ? `<span class="okc">انجرد: ${esc(roundTitle(x.closed))} · أُغلق ${hm(Date.parse(x.closed.closed_at))}</span>` : "ما انجرد بعد"}${
      names.length ? `<br>جرده: ${names.map(esc).join("، ")}` : ""}${
      x.open && x.closed ? `<br><small class="muted">آخر جرد مغلق: ${hm(Date.parse(x.closed.closed_at))}</small>` : ""}</div>`;
  }
  $("#tab-locs").addEventListener("change", (e) => { if (e.target.id === "locs-branch") { locsBranch = e.target.value; locsSel = null; renderLocs(); } });
  $("#tab-locs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-bin]"); if (!b) return;
    locsSel = locsSel === b.dataset.bin ? null : b.dataset.bin;
    renderLocs();
  });

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
    $("#us-pass").placeholder = CLOUD && u ? "اتركها فاضية = بدون تغيير" : CLOUD ? "4 أرقام أو أكثر — مثال: 1234" : "";
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
    if (!/^[\u0600-\u06FFA-Za-z0-9 _.\-]{2,15}$/.test(username.trim())) return err("اسم الدخول: عربي أو إنجليزي، من 2 إلى 15 حرف (مثال: أحمد)");
    const minPw = CLOUD ? 4 : 3;
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
          : /too short/i.test(e.message) ? "كلمة المرور قصيرة (4 أرقام على الأقل)"
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
    for (const it of items) if (!it.gone && !it.x) per[it.b].n++;
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
    // كل الجرد المفتوح (جاري + مراجعة). المغلق يطلع من بطاقته في تبويب الجرد
    const rounds = Object.values(state.rounds).filter((r) => !r.deleted && r.status !== "closed");
    if (!rounds.length) { toast("ما فيه جرد مفتوح — ملفات الجرد المغلق من تبويب الجرد", 3500); return; }
    try { await exportRoundsExcel(rounds, `جرد-مفتوح-${today()}.xlsx`); }
    catch { exportCSV(rounds.flatMap((r) => roundRows(r, false)), `جرد-${today()}.csv`, false); }
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
    Object.values(state.rounds).forEach((r) => { r.deleted = true; }); saveRounds();
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
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).catch(() => {});
    // نسخة جديدة نزلت: نعيد تحميل الصفحة مرة وحدة (ولو فيه نافذة جرد مفتوحة ننتظر لين تنقفل)
    let hadCtrl = !!navigator.serviceWorker.controller, reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadCtrl) { hadCtrl = true; return; }        // أول تثبيت — ما يحتاج
      if (reloading) return;
      const go2 = () => { if (reloading) return; reloading = true; location.reload(); };
      if ($$(".sheet-backdrop:not([hidden])").length) state.reloadOnClose = go2; else go2();
    });
  }
  const APP_VER = "21";
  $("#app-ver").textContent = "الإصدار " + APP_VER;
  $("#login-ver").textContent = `${CFG.companyName} · الإصدار ${APP_VER}`;

  /* ---------- الوضع النهاري / الليلي ---------- */
  function setTheme(t) {
    document.documentElement.dataset.theme = t;
    document.querySelector('meta[name="theme-color"]').content = t === "dark" ? "#102236" : "#0f2a44";
    try { localStorage.setItem("inv_theme", t); } catch {}
  }
  $$(".theme-btn").forEach((b) => b.addEventListener("click", () =>
    setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark")));

  // للاختبار من وحدة التحكم
  window.__inv = { state, parseText, matchText, makeLocTest, applyFilter, allUsers, onBack, applyChanges, resolveBarcode, handleScan };

  try { history.replaceState(null, "", "#" + cur); } catch {}
  if (CLOUD) {
    $("#backup-card").hidden = true;          // مع السيرفر ما يحتاج ترسل ملفات
    window.DB.restore().then((p) => { route(); if (p) startSync(); }).catch(() => route());
  } else route();
})();
