/* ===================================================
   بضاعة تويوتا
   ١) جرد الكراتين: كل كرتون له باركود أصفر (مثل J18200859500004) — ممنوع يتكرر —
      والموظف يكتب QTY (عدد الحبات) و LINES (عدد الأصناف) من الملصق
   ٢) جرد الأصناف: يضرب باركود الكرتون يفتح، ويجرد اللي داخله (باركود أو يدوي)
      القفل: لو مطابق QTY و LINES ينقفل، لو فيه فرق ينبّه
   ٣) المدير: سحب Excel، أرشفة (تختفي من الموظفين)، وأرشيف للبحث
   كل فرع يشوف شحناته بس (حسب نطاق المستخدم)، والمدير يشوف الكل
   =================================================== */
window.TY = (() => {
  "use strict";
  const A = window.APP;
  const { state, store, esc, fmt, toast, CLOUD } = A;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const me = () => A.me();

  /* ---------- التخزين على الجهاز ---------- */
  const LS = CLOUD ? "inv_ty_cloud_v1" : "inv_ty_v1";
  const T = store.get(LS, { ships: {}, cartons: {}, lines: {} });
  const save = () => store.set(LS, T);
  const ui = { ship: null, carton: null, hist: [], last: null, branchF: "", qtyMode: store.get("inv_ty_qtymode", false), arch: null };

  const ms = (v) => (v == null || v === "" ? null : typeof v === "number" ? v : Date.parse(v) || null);
  const iso = (t) => (t ? new Date(t).toISOString() : null);
  const dt = (t) => (t ? new Date(t).toLocaleString("en-GB") : "");
  const dShort = (t) => (t ? new Date(t).toLocaleString("ar-SA-u-nu-latn", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "");
  const ST = { cartons: "جرد الكراتين", items: "جرد الأصناف", done: "مكتمل" };
  const C_ST = (c) => (c.status === "closed" ? (c.mismatch ? "مقفول بفرق" : "مطابق") : c.status === "open" ? "جاري" : "لم يبدأ");

  /* ---------- الفروع ---------- */
  // المدير = الكل. الموظف: فروع نطاقه (نطاق فاضي أو قاعدة بدون فرع = الكل)
  function myBranches() {
    const all = state.data?.branches || [];
    const u = me();
    if (!u || u.role === "admin" || !u.scope?.length || u.scope.some((r) => !r.b)) return all;
    const s = new Set(u.scope.map((r) => r.b));
    return all.filter((b) => s.has(b));
  }
  const canSee = (b) => A.isAdmin() || myBranches().includes(b);

  /* ---------- البيانات ---------- */
  const visibleShips = () => Object.values(T.ships).filter((s) => !s.deleted && !s.archived && canSee(s.branch));
  const cartonsOf = (sid) => Object.values(T.cartons).filter((c) => c.ship_id === sid && !c.deleted);
  const linesOf = (code) => Object.values(T.lines).filter((l) => l.carton === code && !l.deleted && l.qty > 0);
  const lineQty = (c, n) => { const l = T.lines[`${c.code}|${n}`]; return l && !l.deleted ? l.qty : 0; };
  function tally(c) { const ls = linesOf(c.code); return { qty: ls.reduce((s, l) => s + l.qty, 0), lines: ls.length, ls }; }
  function shipStats(s) {
    const cs = cartonsOf(s.id);
    let closed = 0, bad = 0, open = 0, qty = 0, lines = 0;
    for (const c of cs) { if (c.status === "closed") { closed++; if (c.mismatch) bad++; } else if (c.status === "open") open++; qty += c.qty; lines += c.lines; }
    return { n: cs.length, closed, bad, open, left: cs.length - closed, qty, lines };
  }

  /* ---------- الرفع للسيرفر ---------- */
  const queue = (op) => window.DB.queue(op);
  const pushShip = (s) => queue({ t: "tyship", row: {
    id: s.id, branch: s.branch, name: s.name || "", status: s.status, by_name: s.by_name || "", created_at: iso(s.created_at),
    cartons_at: iso(s.cartons_at), done_at: iso(s.done_at), deleted: !!s.deleted } });
  const pushCarton = (c, release) => queue({ t: "tycarton", row: { ...(release ? { release: true } : {}),
    code: c.code, ship_id: c.ship_id, branch: c.branch, qty: c.qty, lines: c.lines, by_name: c.by_name || "", at: iso(c.at),
    status: c.status, closed_by_name: c.closed_by || null, closed_at: iso(c.closed_at), mismatch: !!c.mismatch, deleted: !!c.deleted,
    owner: CLOUD ? c.owner || null : null, owner_name: c.owner_name || null, owner_at: iso(c.owner_at) } });

  /* ---------- مين يشتغل على إيش ----------
     - جرد الكراتين: واحد بس (اللي فتح الشحنة) + المدير
     - جرد الأصناف: للكل، بس الكرتون اللي أخذه موظف ينقفل على الباقين
       (كرتون أخذه وما جرد فيه شيء 15 دقيقة = يرجع حر) */
  const FREE_AFTER = 15 * 60000;
  const isShipOwner = (s) => A.isAdmin() || (s.u ? s.u === A.myId() : (s.by_name || "") === (me()?.name || ""));
  function takenBy(c) {          // يرجع اسم اللي ماخذ الكرتون (غيري) أو ""
    if (!c.owner || c.owner === A.myId() || c.status === "closed") return "";
    if (c.status === "new" && Date.now() - (c.owner_at || 0) > FREE_AFTER) return "";
    return c.owner_name || "موظف ثاني";
  }
  const pushLine = (l) => queue({ t: "tyline", row: {
    carton: l.carton, n: l.n, ship_id: l.ship_id, branch: l.branch, name: l.name || "", qty: Math.max(0, l.qty), by_name: l.by_name || "",
    at: iso(l.at), deleted: !!l.deleted || l.qty <= 0 } });
  const touch = (o) => { o.mt = Date.now(); return o; };

  // تغييرات من السيرفر (من الموظفين الثانيين / المدير)
  function apply(ty) {
    let changed = false;
    const recent = (o) => o?.mt && Date.now() - o.mt < 60000;      // غيّرته على هذا الجهاز قبل شوي (ممكن لسا ما انرفع)
    for (const s of ty.ships || []) {
      const loc = T.ships[s.id];
      if (recent(loc) && !s.archived && !s.deleted) continue;
      T.ships[s.id] = { id: s.id, branch: s.branch, name: s.name, status: s.status, by_name: s.by_name, u: s.user_id || loc?.u, created_at: ms(s.created_at),
        cartons_at: ms(s.cartons_at), done_at: ms(s.done_at), archived: !!s.archived, archived_at: ms(s.archived_at), archived_by: s.archived_by, deleted: !!s.deleted };
      if (CLOUD && (s.archived || s.deleted)) dropShip(s.id);
      changed = true;
    }
    for (const c of ty.cartons || []) {
      const loc = T.cartons[c.code];
      if (recent(loc) && loc.ship_id === c.ship_id) continue;
      if (T.ships[c.ship_id]?.archived && CLOUD) continue;
      T.cartons[c.code] = { code: c.code, ship_id: c.ship_id, branch: c.branch, qty: +c.qty || 0, lines: +c.lines || 0, by_name: c.by_name, at: ms(c.at),
        status: c.status, closed_by: c.closed_by_name, closed_at: ms(c.closed_at), mismatch: !!c.mismatch, deleted: !!c.deleted,
        owner: c.owner || null, owner_name: c.owner_name || "", owner_at: ms(c.owner_at) };
      changed = true;
    }
    for (const l of ty.lines || []) {
      const k = `${l.carton}|${l.n}`, loc = T.lines[k], at = ms(l.at);
      if (loc && loc.at > at) continue;                              // تعديلي أحدث
      if (T.ships[l.ship_id]?.archived && CLOUD) continue;
      T.lines[k] = { carton: l.carton, n: l.n, ship_id: l.ship_id, branch: l.branch, name: l.name || "", qty: +l.qty || 0, by_name: l.by_name, at, deleted: !!l.deleted };
      changed = true;
    }
    if (!changed) return;
    save();
    if ($$(".sheet-backdrop:not([hidden])").length) return;
    const scr = state.screen;
    if (scr === "home") { const n = openCount(); if (n != null) $("#hn-ty").textContent = fmt(n); }
    if (scr === "ty") renderList();
    else if (scr === "tys" || scr === "tyc") {
      const s = ui.ship && T.ships[ui.ship.id];
      if (!s || s.deleted || s.archived) { toast("الشحنة انأرشفت أو انحذفت من الإدارة", 3000); A.go("ty"); return; }
      ui.ship = s;
      if (scr === "tys") renderShip();
      else {
        const c = T.cartons[ui.carton?.code];
        if (!c || c.deleted || c.ship_id !== s.id) { A.go(shipUrl()); return; }
        if (takenBy(c) && !A.isAdmin()) { toast(`الكرتون ${c.code} صار عند ${takenBy(c)}`, 3500); A.go(shipUrl()); return; }
        ui.carton = c; renderCarton();
      }
    }
  }
  // شحنة انأرشفت: نشيل كراتينها وأصنافها من الجهاز (تبقى بالسيرفر للمدير)
  function dropShip(sid) {
    for (const [k, c] of Object.entries(T.cartons)) if (c.ship_id === sid) delete T.cartons[k];
    for (const [k, l] of Object.entries(T.lines)) if (l.ship_id === sid) delete T.lines[k];
  }

  /* ---------- الأصناف (من مخزون الفرع) ---------- */
  let idx = { data: null };
  function branchIdx(b) {
    const d = state.data;
    if (!d) return { byK: new Map(), byN: new Map(), list: [] };
    if (idx.data !== d || idx.b !== b || idx.len !== d.items.length) {
      const bi = d.branches.indexOf(b), byK = new Map(), byN = new Map(), list = [];
      for (const it of d.items) {
        if (it.b !== bi || it.x || it.gone) continue;
        const k = it.nk.toUpperCase();
        if (!byK.has(k)) byK.set(k, []);
        byK.get(k).push(it); byN.set(it.n, it); list.push(it);
      }
      idx = { data: d, b, len: d.items.length, byK, byN, list };
    }
    return idx;
  }
  // باركود الصنف → رقم الصنف (قاعدة تويوتا: أول 12 حرف بدون مسافات) + الربط اليدوي
  function resolveItem(raw, b) {
    const code = A.codeKey(raw), part = A.partFromBarcode(raw);
    const { byK, byN } = branchIdx(b);
    const linked = state.links?.[code];
    if (linked) return { code, n: linked, it: byN.get(linked) || null };
    for (const k of [part, part.slice(0, 10), code, code.slice(0, 10)]) {
      if (k.length < 4 || !byK.has(k)) continue;
      const l = byK.get(k);
      return l.length === 1 ? { code, n: l[0].n, it: l[0] } : { code, part, many: l };
    }
    return { code, n: part || code, it: null };
  }
  // الصنف مو بمخزون الفرع: ندوّر اسمه بالدليل
  async function fillName(l) {
    try {
      const r = await window.DB.searchCatalog(l.n, 3);
      const hit = r.find((x) => x.n === l.n);
      if (hit?.name && !l.name) { l.name = hit.name; save(); pushLine(l); if (state.screen === "tyc") renderCarton(); }
    } catch {}
  }

  /* ===================== قائمة الشحنات ===================== */
  function renderList() {
    const adm = A.isAdmin();
    $("#ty-arch-btn").hidden = !adm;
    $("#ty-admin-row").hidden = !adm;
    $("#ty-new").hidden = !myBranches().length;
    let list = visibleShips();
    if (adm) {
      const bs = [...new Set(list.map((s) => s.branch))];
      if (ui.branchF && !bs.includes(ui.branchF)) ui.branchF = "";
      $("#ty-filt").innerHTML = bs.length > 1 ? [["", "كل الفروع"], ...bs.map((b) => [b, A.branchLabel(b)])]
        .map(([v, t]) => `<button class="chip${ui.branchF === v ? " active" : ""}" data-b="${esc(v)}">${esc(t)}</button>`).join("") : "";
      if (ui.branchF) list = list.filter((s) => s.branch === ui.branchF);
    } else $("#ty-filt").innerHTML = "";
    // المفتوحة فوق (الأحدث أول) والمكتملة تحت
    list.sort((a, b) => (a.status === "done") - (b.status === "done") || (b.created_at || 0) - (a.created_at || 0));
    ui.listed = list;
    const today = new Date().toDateString();
    let doneHdr = false;
    $("#ty-list").innerHTML = list.length ? list.map((s) => {
      const t = shipStats(s), done = s.status === "done";
      const pct = done ? 100 : t.n ? Math.round((t.closed / t.n) * 100) : 0;
      const isToday = new Date(s.created_at || 0).toDateString() === today;
      const hdr = done && !doneHdr ? ((doneHdr = true), `<p class="ty-sec">✓ المكتملة${adm ? "" : " — للعرض عند المدير"}</p>`) : "";
      return `${hdr}<button class="ty-tile ${done ? "tt-a" : "tt-c"} ty-card${done && !adm ? " locked" : ""}" data-s="${esc(s.id)}">
        <span class="tt-bg">${done ? ICO.arch : ICO.box}</span>
        <span class="tt-ico">${done ? ICO.arch : ICO.box}</span>
        <span class="tt-txt"><strong>${esc(s.name || "شحنة")}</strong>
          <small>${esc(A.branchLabel(s.branch))} · ${esc(dShort(s.created_at))}${s.by_name ? " · " + esc(s.by_name) : ""}</small>
          <small>${fmt(t.n)} كرتون · انقفل ${fmt(t.closed)}${t.bad ? ` · <b class="ty-bad">فرق ${fmt(t.bad)}</b>` : ""}</small>
          ${isToday && !done ? `<em class="tt-tag">اليوم</em>` : done ? `<em class="tt-tag">✓ مكتملة</em>` : ""}</span>
        <span class="tt-num"><b>${pct}%</b><small>${done ? "مكتمل" : "منجز"}</small></span>
        <span class="tt-bar"><i style="width:${pct}%"></i></span>
        <svg class="tt-go" viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>
      </button>`;
    }).join("") : `<div class="empty"><p>ما فيه شحنات حالياً</p><p class="muted">اضغط "شحنة جديدة" وابدأ بجرد الكراتين</p></div>`;
  }
  $("#ty-list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-s]"); if (!b) return;
    const s = T.ships[b.dataset.s];
    if (s?.status === "done" && !A.isAdmin()) { toast("الشحنة مكتملة ✓ — ما تنفتح إلا للمدير"); return; }
    A.go("tys/" + b.dataset.s);
  });
  $("#ty-filt").addEventListener("click", (e) => { const b = e.target.closest("[data-b]"); if (!b) return; ui.branchF = b.dataset.b; renderList(); });
  $("#ty-arch-btn").addEventListener("click", () => A.go("tya"));

  // شحنة جديدة
  $("#ty-new").addEventListener("click", () => {
    const bs = myBranches();
    $("#tyn-branch").innerHTML = bs.map((b) => `<option value="${esc(b)}">${esc(A.branchLabel(b))}</option>`).join("");
    if (ui.branchF && bs.includes(ui.branchF)) $("#tyn-branch").value = ui.branchF;
    $("#tyn-branch-f").hidden = bs.length < 2;
    $("#tyn-name").value = todayName();
    A.openOverlay("tyn-backdrop");
  });
  const todayName = () => new Date().toLocaleDateString("en-GB");      // 11/11/2026
  $("#tyn-name").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("#tyn-save").click(); } });
  $("#tyn-save").addEventListener("click", () => {
    const branch = $("#tyn-branch").value;
    if (!branch) { toast("اختر الفرع"); return; }
    const now = Date.now();
    const s = touch({ id: window.DB.uuid(), branch, name: $("#tyn-name").value.trim() || todayName(), u: A.myId(),
      status: "cartons", by_name: me()?.name || "", created_at: now, archived: false, deleted: false });
    T.ships[s.id] = s; save(); pushShip(s);
    A.closeOverlay("tyn-backdrop");
    ui.view = "c";
    A.go(`tys/${s.id}/c`);
  });

  /* ===================== داخل الشحنة ===================== */
  /* داخل الشحنة: قائمة فيها ٣ أقسام (يشتغلون مع بعض، مو مراحل)
     ١) جرد الكراتين — للي فتح الشحنة + المدير، ويقدر يضيف كراتين بأي وقت (لو اكتشف كراتين نسيها)
     ٢) جرد الأصناف — للكل: الكراتين اللي ما انقفلت
     ٣) الأرشيف — الكراتين اللي انقفلت (للعرض، وإعادة الفتح لصاحبها أو المدير) */
  const VIEWS = { c: "جرد الكراتين", i: "جرد الأصناف", a: "أرشيف الكراتين" };
  const ICO = {
    box: `<svg viewBox="0 0 24 24"><path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8M7.5 5.5l9 5"/></svg>`,
    scan: `<svg viewBox="0 0 24 24"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 8v8M10 8v8M13 8v8M17 8v8"/></svg>`,
    arch: `<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/></svg>`,
  };
  function renderShip() {
    const s = ui.ship, t = shipStats(s), v = ui.view || "", done = s.status === "done";
    const cs = cartonsOf(s.id), owner = isShipOwner(s);
    const hub = !v;
    $("#tys-title").textContent = hub ? "الشحنة" : VIEWS[v];
    $("#tys-back-t").textContent = hub ? "الشحنات" : "الشحنة";
    $("#tys-more").hidden = !A.isAdmin() || !hub;
    $("#tys-hub").hidden = !hub;
    $("#tys-work").hidden = hub;
    const main = $("#tys-main");
    main.disabled = false; main.className = "btn primary bin-close";

    if (hub) {
      const myOpen = cs.filter((c) => c.status !== "closed" && c.owner === A.myId() && !takenBy(c)).length;
      const free = cs.filter((c) => c.status !== "closed" && !takenBy(c)).length;
      const pct = t.n ? Math.round((t.closed / t.n) * 100) : 0;
      const lock = !owner && !done;
      const tile = (v, ico, title, num, unit, lines, tag, bar) => `
        <button class="ty-tile tt-${v}" data-v="${v}">
          <span class="tt-bg">${ico}</span>
          <span class="tt-ico">${ico}</span>
          <span class="tt-txt"><strong>${title}</strong>${lines.map((x) => `<small>${x}</small>`).join("")}${tag ? `<em class="tt-tag">${tag}</em>` : ""}</span>
          <span class="tt-num"><b>${fmt(num)}</b><small>${unit}</small></span>
          ${bar != null ? `<span class="tt-bar"><i style="width:${bar}%"></i></span>` : ""}
          <svg class="tt-go" viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>
        </button>`;
      $("#tys-hub").innerHTML = `
        <div class="ty-hero${done ? " done" : ""}">
          <div class="th-top">
            <div class="th-id"><b>${esc(s.name || "شحنة")}</b>
              <small>${esc(A.branchLabel(s.branch))} · ${esc(dShort(s.created_at))}${s.by_name ? " · " + esc(s.by_name) : ""}</small></div>
            <span class="th-st">${done ? "✓ مكتملة" : "مفتوحة"}</span>
          </div>
          <div class="th-nums">
            <div><b>${fmt(t.n)}</b><small>كرتون</small></div>
            <div><b>${fmt(t.qty)}</b><small>حبة QTY</small></div>
            <div><b>${fmt(t.closed - t.bad)}</b><small>مطابق</small></div>
            <div class="${t.bad ? "bad" : ""}"><b>${fmt(t.bad)}</b><small>فرق</small></div>
          </div>
          <div class="th-bar"><i style="width:${pct}%"></i></div>
          <small class="th-pct">${t.n ? `انقفل ${fmt(t.closed)} من ${fmt(t.n)} كرتون · ${pct}%` : "لسا ما انضاف كراتين"}</small>
        </div>
        ${tile("c", ICO.box, "جرد الكراتين", t.n, "كرتون",
          [`QTY ${fmt(t.qty)} · LINES ${fmt(t.lines)}`],
          lock ? `🔒 عند ${esc(s.by_name || "موظف ثاني")} — للعرض` : done ? "للعرض" : "تقدر تضيف كراتين بأي وقت")}
        ${tile("i", ICO.scan, "جرد الأصناف", t.left, "باقي",
          [t.left ? `${fmt(free)} حر تقدر تاخذه${t.open ? ` · جاري ${fmt(t.open)}` : ""}` : t.n ? "كل الكراتين انقفلت ✓" : "لسا ما انضاف كراتين"],
          myOpen ? `معك ${fmt(myOpen)} — كمّل` : "", pct)}
        ${tile("a", ICO.arch, "الأرشيف", t.closed, "مقفول",
          [`مطابق ${fmt(t.closed - t.bad)}${t.bad ? ` · <b class="ty-bad">فرق ${fmt(t.bad)}</b>` : ""}`],
          "الكراتين المقفولة — للعرض")}`;
      main.hidden = false;
      if (done) { main.hidden = !A.isAdmin(); main.textContent = "⬇ سحب Excel"; }
      else if (!owner) { main.hidden = true; }
      else if (!t.n) { main.hidden = true; }
      else if (t.left) { main.textContent = `باقي ${fmt(t.left)} كرتون ما انقفل`; main.disabled = true; }
      else main.textContent = "✓ إنهاء الشحنة";
      return;
    }

    // ---- الأقسام ----
    const canAdd = v === "c" && owner && !done;
    $(".ty-scan").hidden = done || (v === "c" && !owner);
    $("#tys-input").placeholder = v === "c" ? "اضرب أو اكتب رقم الكرتون" : "اضرب باركود الكرتون أو دوّره";
    $("#tys-go").textContent = v === "c" ? "إضافة" : "فتح";
    $("#tys-help").innerHTML = v === "c"
      ? (canAdd ? `اضرب باركود كل كرتون (الملصق الأصفر) واكتب <b>QTY</b> و <b>LINES</b>. نسيت كراتين؟ ضيفها بأي وقت — تطلع على طول بجرد الأصناف.`
        : `🔒 جرد الكراتين عند <b>${esc(s.by_name || "موظف ثاني")}</b> — هنا للعرض بس.`)
      : v === "i" ? `اختر كرتون أو اضرب باركوده. الكرتون اللي تاخذه ينقفل على الباقين لين تخلصه، ولما ينقفل يروح للأرشيف.`
      : `الكراتين اللي انقفلت — اضغط على كرتون تشوف أصنافه${owner ? " أو تعيد فتحه" : ""}.`;
    $("#tys-sum").innerHTML = v === "c"
      ? `<div><b>${fmt(t.n)}</b><small>كرتون</small></div><div><b>${fmt(t.qty)}</b><small>QTY حبة</small></div><div><b>${fmt(t.lines)}</b><small>LINES</small></div>`
      : v === "i"
      ? `<div><b>${fmt(t.left)}</b><small>باقي</small></div><div><b>${fmt(t.open)}</b><small>جاري</small></div><div><b>${fmt(t.left - t.open)}</b><small>لم يبدأ</small></div>`
      : `<div><b>${fmt(t.closed)}</b><small>انقفل</small></div><div class="okc"><b>${fmt(t.closed - t.bad)}</b><small>مطابق</small></div><div class="${t.bad ? "w" : ""}"><b>${fmt(t.bad)}</b><small>فرق</small></div>`;
    const q = A.codeKey($("#tys-input").value);
    let list = v === "i" ? cs.filter((c) => c.status !== "closed") : v === "a" ? cs.filter((c) => c.status === "closed") : cs;
    if (v !== "c" && q) list = list.filter((c) => c.code.includes(q));
    const mine = (c) => c.owner && c.owner === A.myId() && c.status !== "closed";
    // معي أول، بعدها الحر، بعدها اللي عند غيري
    const rank = (c) => (mine(c) ? 0 : takenBy(c) ? 2 : 1);
    list.sort(v === "c" ? (a, b) => (b.at || 0) - (a.at || 0)
      : v === "a" ? (a, b) => (b.mismatch - a.mismatch) || (b.closed_at || 0) - (a.closed_at || 0)
      : (a, b) => rank(a) - rank(b) || a.code.localeCompare(b.code));
    $("#tys-list").innerHTML = list.length ? list.map((c) => {
      const tl = v === "c" && c.status === "new" ? null : tally(c);
      const tb = takenBy(c);
      const cls = c.status === "closed" ? (c.mismatch ? "bad" : "closed") : tb ? "busy" : mine(c) ? "draft" : "left";
      const lab = c.status === "closed" ? (c.mismatch ? "⚠ فرق" : "✓ مطابق") + (c.closed_by ? ` · ${esc(c.closed_by)}` : "")
        : tb ? `🔒 عند ${esc(tb)}` : mine(c) ? "معك — كمّل" : v === "c" ? esc(c.by_name || "") : "حر";
      return `<button class="bin-row ty-crow st-${cls}" data-c="${esc(c.code)}">
        <span class="tc-main"><b dir="ltr">${esc(c.code)}</b>
        <small>QTY <b>${fmt(c.qty)}</b> · LINES <b>${fmt(c.lines)}</b>${tl && (tl.qty || c.status !== "new") ? ` — مجرود ${fmt(tl.qty)} حبة · ${fmt(tl.lines)} صنف` : ""}</small></span>
        <i>${lab}</i></button>`;
    }).join("") : `<p class="muted pad">${q && v !== "c" ? "ما فيه كرتون بهالرقم"
      : v === "c" ? "ما انمسح ولا كرتون — اضرب أول باركود" : v === "i" ? (t.n ? "كل الكراتين انقفلت ✓ — تلقاها بالأرشيف" : "لسا ما انضاف كراتين") : "ما انقفل ولا كرتون للحين"}</p>`;
    main.hidden = true;
  }

  $("#tys-input").addEventListener("input", () => { if (ui.view && ui.view !== "c") renderShip(); });
  $("#tys-hub").addEventListener("click", (e) => {
    if (e.target.closest(".th-id b")) { $("#tys-title").click(); return; }          // اسم الشحنة = تعديل الاسم
    const b = e.target.closest("[data-v]"); if (b) A.go(`tys/${ui.ship.id}/${b.dataset.v}`);
  });
  $("#tys-back").addEventListener("click", back);
  $("#tys-input").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("#tys-go").click(); } });
  $("#tys-go").addEventListener("click", () => {
    const v = $("#tys-input").value;
    if (!A.codeKey(v)) { $("#tys-input").focus(); return; }
    $("#tys-input").value = "";
    shipScan(v, true);
  });
  $("#tys-cam").addEventListener("click", A.openCamera);
  $("#tys-list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-c]"); if (!b) return;
    const c = T.cartons[b.dataset.c]; if (!c) return;
    if (ui.view === "c") {
      if (isShipOwner(ui.ship) && ui.ship.status !== "done") openCartonForm(c.code, c);
      else toast(ui.ship.status === "done" ? "الشحنة مكتملة — للعرض بس" : `🔒 جرد الكراتين عند ${ui.ship.by_name || "موظف ثاني"}`);
    } else takeCarton(c);
  });
  // اسم الشحنة: يعدّله اللي فتحها أو المدير (بالضغط على العنوان بالقائمة)
  $("#tys-title").addEventListener("click", () => {
    const s = ui.ship; if (!s || ui.view || !isShipOwner(s)) return;
    const v = prompt("اسم الشحنة", s.name || ""); if (v == null || !v.trim()) return;
    s.name = v.trim(); touch(s); save(); pushShip(s); renderShip();
  });

  // أخذ كرتون لجرد أصنافه — ينقفل على الباقين
  async function takeCarton(c) {
    if (c.status === "closed") { openCarton(c); return; }        // المقفول يتشاف بس
    const mine = A.myId();
    let tb = takenBy(c);
    if (tb && !A.isAdmin()) { A.beep("err"); toast(`🔒 الكرتون ${c.code} مأخوذ — عند ${tb}`, 3500); return; }
    if (tb && !confirm(`الكرتون ${c.code} عند ${tb}.\nتاخذه منه؟`)) return;
    if (c.owner !== mine || Date.now() - (c.owner_at || 0) > 60000) {
      if (CLOUD && navigator.onLine && window.DB.tyClaim) {
        try {
          const r = await window.DB.tyClaim(c.code, me()?.name || "", !!tb);
          if (r && r.ok === false && r.exists) {
            c.owner = r.owner; c.owner_name = r.owner_name || ""; c.owner_at = ms(r.owner_at); save();
            A.beep("err"); toast(`🔒 الكرتون ${c.code} مأخوذ — عند ${c.owner_name || "موظف ثاني"}`, 3500);
            if (state.screen === "tys") renderShip();
            return;
          }
        } catch (e) { window.DB.note?.("حجز الكرتون ما زبط: " + e.message); }
      }
      c.owner = mine; c.owner_name = me()?.name || ""; c.owner_at = Date.now();
      touch(c); save(); pushCarton(c);
    }
    openCarton(c);
  }

  // ضربة باركود بشاشة الشحنة
  async function shipScan(raw, typed) {
    const s = ui.ship;
    const code = A.codeKey(raw);
    if (code.length < 5) { A.beep("err"); toast("رقم الكرتون قصير — تأكد منه"); return; }
    if (ui.view === "c") {
      if (s.status === "done") { A.beep("err"); toast("الشحنة مكتملة — للعرض بس"); return; }
      if (!isShipOwner(s)) { A.beep("err"); toast(`🔒 جرد الكراتين عند ${s.by_name || "موظف ثاني"}`); return; }
      return addCarton(code);
    }
    let c = T.cartons[code];
    if (!(c && !c.deleted && c.ship_id === s.id) && typed) {
      const part = cartonsOf(s.id).filter((x) => x.code.includes(code));
      if (part.length === 1) c = part[0];
    }
    if (c && !c.deleted && c.ship_id === s.id) { if (!takenBy(c) || A.isAdmin()) A.beep("ok"); takeCarton(c); return; }
    A.beep("err");
    if (c && !c.deleted) { const o = T.ships[c.ship_id]; toast(`الكرتون ${code} موجود بشحنة ثانية: ${o?.name || ""} (${A.branchLabel(c.branch)})`, 4000); return; }
    toast(`الكرتون ${code} مو موجود بهالشحنة — ما انمسح بجرد الكراتين${isShipOwner(s) && s.status !== "done" ? " (ضيفه من «جرد الكراتين»)" : ""}`, 4000);
  }

  // ---- إضافة كرتون (ممنوع التكرار) ----
  async function addCarton(code) {
    const ex = T.cartons[code];
    if (ex && !ex.deleted) { A.beep("err"); dupMsg(code, ex.ship_id === ui.ship.id ? "بهالشحنة" : `بشحنة «${T.ships[ex.ship_id]?.name || ""}»`, ex.by_name, ex.at); flashRow(code); return; }
    if (CLOUD && navigator.onLine) {
      try {
        const info = await window.DB.tyCartonInfo(code);
        if (info && info.ship_id !== ui.ship.id) { A.beep("err"); dupMsg(code, `${info.archived ? "بالأرشيف — " : ""}بشحنة «${info.ship || ""}» ${A.branchLabel(info.branch)}`, info.by_name, ms(info.at)); return; }
      } catch (e) { window.DB.note?.("فحص تكرار الكرتون ما زبط: " + e.message); }
    }
    A.beep("ok");
    openCartonForm(code, null);
  }
  function dupMsg(code, where, by, at) {
    toast(`⛔ مكرر! الكرتون ${code} انمسح قبل ${where}${by ? " — " + by : ""}${at ? " · " + dShort(at) : ""}`, 5000);
  }
  function flashRow(code) {
    const r = $(`#tys-list [data-c="${CSS.escape(code)}"]`);
    if (!r) return;
    r.scrollIntoView({ block: "center", behavior: "smooth" });
    r.classList.remove("flash"); void r.offsetWidth; r.classList.add("flash");
  }

  // ---- نافذة QTY و LINES ----
  let cform = null;
  function openCartonForm(code, c) {
    cform = { code, c };
    $("#tyq-code").textContent = code;
    $("#tyq-title").textContent = c ? "تعديل الكرتون" : "كرتون جديد";
    $("#tyq-qty").value = c ? c.qty : "";
    $("#tyq-lines").value = c ? c.lines : "";
    $("#tyq-err").hidden = true;
    $("#tyq-del").hidden = !c || (c.status === "closed" && !A.isAdmin());
    A.openOverlay("tyq-backdrop");
    setTimeout(() => $("#tyq-qty").focus(), 200);
  }
  $("#tyq-qty").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("#tyq-lines").focus(); } });
  $("#tyq-lines").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("#tyq-save").click(); } });
  $("#tyq-save").addEventListener("click", () => {
    if (!cform) return;
    const qty = +A.toEnDigits($("#tyq-qty").value), lines = +A.toEnDigits($("#tyq-lines").value);
    const err = (m, el) => { $("#tyq-err").textContent = m; $("#tyq-err").hidden = false; A.beep("err"); $(el).focus(); };
    if (!Number.isInteger(qty) || qty < 1) return err("اكتب QTY (عدد الحبات) — إجباري", "#tyq-qty");
    if (!Number.isInteger(lines) || lines < 1) return err("اكتب LINES (عدد الأصناف) — إجباري", "#tyq-lines");
    if (lines > qty) return err("LINES ما يصير أكثر من QTY — تأكد من الملصق", "#tyq-lines");
    const { code, c } = cform; cform = null;
    if (c) {
      c.qty = qty; c.lines = lines;
      if (c.status === "closed") { const t = tally(c); c.mismatch = t.qty !== qty || t.lines !== lines; }
      touch(c); save(); pushCarton(c);
      toast("✓ انحفظ");
    } else {
      const s = ui.ship;
      const nc = touch({ code, ship_id: s.id, branch: s.branch, qty, lines, by_name: me()?.name || "", at: Date.now(), status: "new", mismatch: false, deleted: false });
      T.cartons[code] = nc; save(); pushCarton(nc);
      toast(`✓ انضاف ${code} — اضرب الكرتون اللي بعده`);
    }
    A.closeOverlay("tyq-backdrop");
    if (state.screen === "tyc") renderCarton(); else renderShip();
  });
  $("#tyq-del").addEventListener("click", () => {
    const c = cform?.c; if (!c) return;
    const t = tally(c);
    if (!confirm(`حذف الكرتون ${c.code}؟${t.lines ? `\nفيه ${t.lines} صنف مجرود بينحذف معه` : ""}`)) return;
    cform = null;
    c.deleted = true; touch(c); pushCarton(c);
    for (const l of t.ls) { l.deleted = true; l.qty = 0; l.at = Date.now(); pushLine(l); }
    save();
    A.closeOverlay("tyq-backdrop");
    if (state.screen === "tyc") A.go(`tys/${ui.ship.id}/i`); else renderShip();
  });

  // ---- الزر الرئيسي بالشحنة ----
  $("#tys-main").addEventListener("click", () => {
    const s = ui.ship, t = shipStats(s);
    if (s.status !== "done") {
      if (!isShipOwner(s) || !t.n || t.left) return;
      if (!confirm(`إنهاء الشحنة؟\n${t.n} كرتون${t.bad ? ` (منها ${t.bad} بفرق)` : " — كلها مطابقة ✓"}`)) return;
      s.status = "done"; s.done_at = Date.now();
    } else { if (A.isAdmin()) exportShips([s]); return; }
    touch(s); save(); pushShip(s);
    A.beep("ok");
    renderShip();
  });

  // ---- خيارات المدير ----
  $("#tys-more").addEventListener("click", () => {
    const s = ui.ship;
    $("#tyo-title").textContent = s.name || "خيارات الشحنة";
    $("#tyo-back").hidden = s.status !== "done";
    A.openOverlay("tyo-backdrop");
  });
  $("#tyo-export").addEventListener("click", () => { A.closeOverlay("tyo-backdrop"); exportShips([ui.ship]); });
  $("#tyo-rename").addEventListener("click", () => {
    const s = ui.ship; const v = prompt("اسم الشحنة", s.name || ""); if (v == null || !v.trim()) return;
    s.name = v.trim(); touch(s); save(); pushShip(s); A.closeOverlay("tyo-backdrop"); renderShip();
  });
  $("#tyo-back").addEventListener("click", () => {
    const s = ui.ship;
    if (!confirm("إعادة فتح الشحنة؟ ترجع مفتوحة للموظفين (كل الجرد اللي صار يبقى محفوظ)")) return;
    s.status = "items"; s.done_at = null; touch(s); save(); pushShip(s);
    A.closeOverlay("tyo-backdrop"); renderShip();
  });
  $("#tyo-arch").addEventListener("click", () => {
    const s = ui.ship, t = shipStats(s);
    if (!confirm(`أرشفة «${s.name}»؟${s.status !== "done" ? "\n⚠ الشحنة لسا ما اكتملت" : ""}\nتختفي من الموظفين وتلقاها بالأرشيف (بحث وسحب Excel)`)) return;
    archive([s]);
    A.closeOverlay("tyo-backdrop");
    toast(`✓ انأرشفت (${t.n} كرتون)`);
    A.go("ty");
  });
  $("#tyo-del").addEventListener("click", () => {
    const s = ui.ship;
    if (!confirm(`حذف الشحنة «${s.name}» بكل كراتينها؟`)) return;
    if (prompt("للتأكيد اكتب: حذف") !== "حذف") return;
    s.deleted = true; touch(s); save(); pushShip(s);
    if (CLOUD) { dropShip(s.id); save(); }
    A.closeOverlay("tyo-backdrop");
    A.go("ty");
  });
  function archive(ships) {
    const now = Date.now(), by = me()?.name || "";
    for (const s of ships) {
      s.archived = true; s.archived_at = now; s.archived_by = by; touch(s);
      queue({ t: "tyarch", row: { id: s.id, at: iso(now), by } });
      if (CLOUD) dropShip(s.id);
    }
    save();
  }
  $("#ty-export-all").addEventListener("click", () => {
    const list = ui.listed || [];
    if (!list.length) { toast("ما فيه شحنات"); return; }
    exportShips(list);
  });
  $("#ty-arch-done").addEventListener("click", () => {
    const done = (ui.listed || []).filter((s) => s.status === "done");
    if (!done.length) { toast("ما فيه شحنات مكتملة"); return; }
    if (!confirm(`أرشفة ${done.length} شحنة مكتملة؟\nتختفي من الموظفين وتبقى بالأرشيف`)) return;
    archive(done); renderList(); toast(`✓ انأرشفت ${done.length} شحنة`);
  });

  /* ===================== داخل الكرتون ===================== */
  function openCarton(c) {
    A.closeOverlay("scan-ov");
    if (state.screen === "tyc" && ui.carton && ui.carton.code !== c.code) leaveCarton();
    A.go(`tyc/${c.ship_id}/${encodeURIComponent(c.code)}`);
  }
  function renderCarton() {
    const c = ui.carton, t = tally(c), closed = c.status === "closed";
    $("#screen-tyc").classList.toggle("closed", closed);
    $("#tyc-title").textContent = c.code;
    $("#tyc-sub").textContent = closed ? (c.mismatch ? "⚠ انقفل بفرق" : "✓ مقفول") : A.branchLabel(c.branch);
    const box = (el, got, want) => {
      el.querySelector("b").textContent = `${fmt(got)} / ${fmt(want)}`;
      el.className = got === want ? "ok" : got > want ? "over" : "";
    };
    box($("#tyc-tq"), t.qty, c.qty);
    box($("#tyc-tl"), t.lines, c.lines);
    $("#tyc-qtymode").classList.toggle("active", ui.qtyMode);
    $("#tyc-total").textContent = `${fmt(t.lines)} صنف · ${fmt(t.qty)} حبة`;
    $("#tyc-empty-t").textContent = closed ? "الكرتون مقفول — للتعديل اضغط «إعادة فتح»" : ui.qtyMode ? "اضرب باركود الصنف — يسألك كم حبة" : "اضرب باركود الصنف — كل ضربة = حبة";
    const { byN } = branchIdx(c.branch);
    const last = ui.last && T.lines[`${c.code}|${ui.last}`];
    const showLast = last && !last.deleted && last.qty > 0 && !closed;
    $("#tyc-empty").hidden = !!showLast; $("#tyc-card").hidden = !showLast;
    if (showLast) {
      $("#tyc-num").textContent = last.n; $("#tyc-name").textContent = last.name || "";
      $("#tyc-big").textContent = fmt(last.qty);
      $("#tyc-tag").textContent = byN.has(last.n) ? "" : "مو موجود بمخزون الفرع";
      $("#tyc-tag").className = "bl-tag" + (byN.has(last.n) ? "" : " w");
    }
    const ls = t.ls.slice().sort((a, b) => (b.at || 0) - (a.at || 0));
    $("#tyc-list").innerHTML = ls.length ? ls.map((l) => `<div class="bin-item on${l.n === ui.last ? " last" : ""}" data-n="${esc(l.n)}">
        <span class="bi-t"><b dir="ltr">${esc(l.n)}</b>${byN.has(l.n) ? "" : '<i class="xb">مو بالمخزون</i>'}<small>${esc(l.name || "—")}</small></span>
        <span class="bi-sys">${esc(l.by_name || "")}</span>
        <span class="bi-q">${fmt(l.qty)}</span></div>`).join("")
      : `<p class="muted pad">ما انجرد شيء بهالكرتون للحين</p>`;
    $("#tyc-close").textContent = closed ? "↺ إعادة فتح الكرتون" : "✓ قفل الكرتون";
    $("#tyc-close").classList.toggle("ghost", closed);
    $("#tyc-close").classList.toggle("primary", !closed);
  }

  // إضافة/تعديل صنف بالكرتون
  function setLine(c, n, qty, name) {
    if (c.status === "closed") { toast("الكرتون مقفول — اضغط «إعادة فتح» أول"); return; }
    const k = `${c.code}|${n}`, old = T.lines[k];
    const prev = old && !old.deleted ? old.qty : 0;
    qty = Math.max(0, qty);
    ui.hist.push({ n, prev });
    if (ui.hist.length > 200) ui.hist.shift();
    const l = T.lines[k] = { carton: c.code, n, ship_id: c.ship_id, branch: c.branch, name: name || old?.name || "",
      qty, by_name: me()?.name || "", at: Date.now(), deleted: qty <= 0 };
    ui.last = qty > 0 ? n : ui.last === n ? null : ui.last;
    if (c.status === "new" && qty > 0) { c.status = "open"; touch(c); pushCarton(c); }
    save(); pushLine(l);
    renderCarton();
    if (!l.name && qty > 0) fillName(l);
  }
  const addLine = (c, n, add, name) => setLine(c, n, lineQty(c, n) + add, name);

  // ضربة باركود داخل الكرتون — يرجع نص للكاميرا
  function cartonScan(raw) {
    const c = ui.carton;
    const code = A.codeKey(raw);
    if (!code) return "";
    const other = T.cartons[code];
    if (other && !other.deleted && other.ship_id === c.ship_id) {
      if (other.code === c.code) { A.beep("warn"); toast("هذا باركود الكرتون نفسه — اضرب باركود الأصناف"); return "باركود الكرتون نفسه"; }
      A.closeOverlay("scan-ov");
      if (takenBy(other) && !A.isAdmin()) { A.beep("err"); toast(`🔒 الكرتون ${other.code} مأخوذ — عند ${takenBy(other)}`, 3500); return ""; }
      A.beep("ok"); toast(`فتحنا الكرتون ${other.code}`); takeCarton(other); return "";
    }
    if (c.status === "closed") { A.beep("err"); toast("الكرتون مقفول — اضغط «إعادة فتح» أول"); return "الكرتون مقفول"; }
    const r = resolveItem(raw, c.branch);
    window.DB.note?.(`تويوتا ${c.code}: باركود ${code} → ${r.many ? r.many.map((i) => i.n).join("، ") : r.n}`);
    if (r.many) { A.beep("err"); A.closeOverlay("scan-ov"); openManual("pick", { candidates: r.many, query: r.part, code }); return ""; }
    A.beep(r.it ? "ok" : "warn");
    if (ui.qtyMode) { A.closeOverlay("scan-ov"); openManual("add", { n: r.n, name: r.it?.name }); return ""; }
    addLine(c, r.n, 1, r.it?.name);
    return `✓ ${r.n} — ${fmt(lineQty(c, r.n))} حبة`;
  }

  // ---- نافذة الكمية / الإدخال اليدوي ----
  // pick = يختار الصنف ويكتب الكمية · add = كم حبة يضيف · set = تعديل كمية صنف موجود
  let mf = null;
  function openManual(mode, o = {}) {
    const c = ui.carton;
    if (c.status === "closed") { toast("الكرتون مقفول — اضغط «إعادة فتح» أول"); return; }
    mf = { mode, n: o.n || null, name: o.name || "", code: o.code || null, candidates: o.candidates || null };
    $("#tym-pick").hidden = mode !== "pick";
    $("#tym-title").textContent = mode === "pick" ? (o.code ? "أكثر من صنف لهذا الباركود" : "إدخال يدوي") : o.name || "—";
    $("#tym-num").textContent = mode === "pick" ? (o.code || "") : o.n;
    $("#tym-label").textContent = mode === "set" ? "الكمية بالكرتون" : mode === "add" ? "كم حبة تضيف؟" : "الكمية";
    $("#tym-qty").value = mode === "set" ? lineQty(c, o.n) : mode === "pick" ? 1 : "";
    $("#tym-quick").innerHTML = [1, 2, 5, 10, 12, 20, 24, 50].map((v) => `<button type="button" data-v="${v}">${v}</button>`).join("");
    $("#tym-remove").hidden = mode !== "set";
    if (mode === "pick") { $("#tym-search").value = o.candidates ? "" : o.query || ""; renderManualList(); }
    A.openOverlay("tym-backdrop");
    setTimeout(() => (mode === "pick" && !o.candidates ? $("#tym-search") : $("#tym-qty")).focus(), 200);
  }
  function renderManualList() {
    const c = ui.carton, { list } = branchIdx(c.branch);
    const q = A.numKey($("#tym-search").value).toUpperCase();
    let res = mf.candidates && !q ? mf.candidates : q.length >= 2 ? list.filter((it) => it.nk.toUpperCase().startsWith(q)).slice(0, 40) : [];
    const typed = $("#tym-search").value.trim().toUpperCase().replace(/\s+/g, "");
    const exact = res.some((it) => it.n.toUpperCase() === typed);
    $("#tym-list").innerHTML = res.map((it) => `<button type="button" class="pk-row${mf.n === it.n ? " sel" : ""}" data-n="${esc(it.n)}"><b dir="ltr">${esc(it.n)}</b><span>${esc(it.name)}</span><small>نظام ${fmt(it.q)}</small></button>`).join("")
      + (typed.length >= 4 && !exact ? `<button type="button" class="pk-row${mf.n === typed ? " sel" : ""}" data-n="${esc(typed)}" data-raw="1"><b dir="ltr">${esc(typed)}</b><span>استخدم الرقم مثل ما كتبته</span><small>مو بالمخزون</small></button>` : "")
      || `<p class="muted pad">${q ? "ما فيه نتائج" : "اكتب رقم الصنف"}</p>`;
  }
  let tymT;
  $("#tym-search").addEventListener("input", () => { clearTimeout(tymT); mf && (mf.n = null); tymT = setTimeout(renderManualList, 120); });
  $("#tym-search").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("#tym-qty").focus(); } });
  $("#tym-list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-n]"); if (!b || !mf) return;
    mf.n = b.dataset.n;
    mf.name = b.dataset.raw ? "" : branchIdx(ui.carton.branch).byN.get(mf.n)?.name || "";
    renderManualList();
    $("#tym-qty").focus(); $("#tym-qty").select?.();
  });
  $("#tym-quick").addEventListener("click", (e) => { const b = e.target.closest("[data-v]"); if (!b) return; $("#tym-qty").value = b.dataset.v; $("#tym-qty").focus(); });
  $("#tym-qty").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("#tym-save").click(); } });
  $("#tym-save").addEventListener("click", () => {
    if (!mf) return;
    const c = ui.carton;
    const v = +A.toEnDigits($("#tym-qty").value);
    if (!Number.isInteger(v) || v < 0) { toast("كمية غير صحيحة"); return; }
    if (mf.mode === "pick") {
      if (!mf.n) {
        // ما اختار من القائمة: لو الرقم المكتوب يطابق صنف واحد ناخذه، وإلا الرقم مثل ما هو
        const typed = $("#tym-search").value.trim().toUpperCase().replace(/\s+/g, "");
        if (typed.length < 4) { toast("اختر الصنف أو اكتب رقمه"); $("#tym-search").focus(); return; }
        const hit = branchIdx(c.branch).byK.get(A.numKey(typed).toUpperCase());
        mf.n = hit?.length === 1 ? hit[0].n : typed; mf.name = hit?.length === 1 ? hit[0].name : "";
      }
      if (mf.code) { A.saveLink(mf.code, mf.n); toast("✓ انربط الباركود بالصنف"); }
      const { n, name } = mf; mf = null;
      A.closeOverlay("tym-backdrop");
      if (v) addLine(c, n, v, name);
      return;
    }
    const { n, name, mode } = mf; mf = null;
    A.closeOverlay("tym-backdrop");
    if (mode === "add") { if (v) addLine(c, n, v, name); } else setLine(c, n, v, name);
  });
  $("#tym-remove").addEventListener("click", () => { if (!mf) return; const { n } = mf; mf = null; A.closeOverlay("tym-backdrop"); setLine(ui.carton, n, 0); });

  $("#tyc-manual").addEventListener("click", () => openManual("pick"));
  $("#tyc-list").addEventListener("click", (e) => {
    const r = e.target.closest("[data-n]"); if (!r) return;
    if (ui.carton.status === "closed") { toast("الكرتون مقفول — اضغط «إعادة فتح» أول"); return; }
    const l = T.lines[`${ui.carton.code}|${r.dataset.n}`];
    openManual("set", { n: r.dataset.n, name: l?.name });
  });
  $("#tyc-big").addEventListener("click", () => { if (ui.last) openManual("set", { n: ui.last, name: T.lines[`${ui.carton.code}|${ui.last}`]?.name }); });
  $("#tyc-plus").addEventListener("click", () => { if (ui.last) addLine(ui.carton, ui.last, 1); });
  $("#tyc-minus").addEventListener("click", () => { if (ui.last) addLine(ui.carton, ui.last, -1); });
  $("#tyc-undo").addEventListener("click", () => {
    const c = ui.carton;
    if (c.status === "closed") return;
    const h = ui.hist.pop(); if (!h) { toast("ما فيه شيء نتراجع عنه"); return; }
    setLine(c, h.n, h.prev); ui.hist.pop();      // setLine يسجل خطوة — نشيلها
    if (h.prev <= 0) ui.last = ui.hist.at(-1)?.n || null;
    renderCarton(); toast("↶ تراجع");
  });
  $("#tyc-qtymode").addEventListener("click", () => {
    ui.qtyMode = !ui.qtyMode; store.set("inv_ty_qtymode", ui.qtyMode); renderCarton();
    toast(ui.qtyMode ? "🔢 وضع الكمية: كل ضربة تسألك كم حبة" : "كل ضربة = حبة وحدة");
  });
  $("#tyc-cam").addEventListener("click", () => {
    if (ui.carton.status === "closed") { toast("الكرتون مقفول — اضغط «إعادة فتح» أول"); return; }
    A.openCamera();
  });
  $("#tyc-target").addEventListener("click", () => {
    const c = ui.carton;
    if (c.status === "closed" && !A.isAdmin()) { toast("الكرتون مقفول"); return; }
    openCartonForm(c.code, c);
  });
  // طلع من الكرتون بدون ما يجرد شيء = يرجع حر للباقين
  function leaveCarton() {
    const c = ui.carton;
    if (c && c.status !== "closed" && c.owner === A.myId() && !tally(c).lines) {
      c.owner = null; c.owner_name = ""; c.owner_at = null; c.status = "new";
      touch(c); save(); pushCarton(c, true);
    }
  }
  $("#tyc-back").addEventListener("click", () => { leaveCarton(); A.go(shipUrl()); });

  // ---- قفل الكرتون: مطابق = ينقفل، فرق = تنبيه ----
  $("#tyc-close").addEventListener("click", () => {
    const c = ui.carton;
    if (c.status === "closed") {
      if (!A.isAdmin() && c.owner && c.owner !== A.myId()) { toast(`الكرتون جرده ${c.owner_name || c.closed_by || "موظف ثاني"} — إعادة الفتح له أو للمدير`); return; }
      if (!confirm(`إعادة فتح الكرتون ${c.code} للتعديل؟`)) return;
      c.status = "open"; c.mismatch = false; c.closed_by = null; c.closed_at = null;
      c.owner = A.myId(); c.owner_name = me()?.name || ""; c.owner_at = Date.now();
      if (ui.view === "a") ui.view = "i";             // رجع مفتوح = مكانه بجرد الأصناف
      touch(c); save(); pushCarton(c); renderCarton();
      return;
    }
    const t = tally(c);
    if (t.qty === c.qty && t.lines === c.lines) { closeCarton(false); return; }
    const row = (lab, want, got) => {
      const d = got - want;
      return `<div class="tyx-row${d ? " bad" : ""}"><b>${lab}</b><span>الملصق <b>${fmt(want)}</b></span><span>المجرود <b>${fmt(got)}</b></span>
        <i>${d === 0 ? "✓ مطابق" : d > 0 ? `زيادة ${fmt(d)}` : `نقص ${fmt(-d)}`}</i></div>`;
    };
    $("#tyx-body").innerHTML = `<p class="hint">الكرتون <b dir="ltr">${esc(c.code)}</b> — المجرود مو مطابق للملصق الأصفر:</p>
      ${row("QTY", c.qty, t.qty)}${row("LINES", c.lines, t.lines)}
      <p class="hint">تأكد من الأصناف. لو الفرق صحيح فعلاً اقفله مع الفرق ويطلع للمدير.</p>`;
    A.beep("warn");
    A.openOverlay("tyx-backdrop");
  });
  $("#tyx-force").addEventListener("click", () => { A.closeOverlay("tyx-backdrop"); closeCarton(true); });
  function closeCarton(mismatch) {
    const c = ui.carton, s = ui.ship;
    c.status = "closed"; c.mismatch = mismatch; c.closed_by = me()?.name || ""; c.closed_at = Date.now();
    touch(c); save(); pushCarton(c);
    A.beep(mismatch ? "warn" : "ok");
    navigator.vibrate?.(30);
    const left = shipStats(s).left;
    toast(`${mismatch ? "⚠ انقفل الكرتون مع الفرق" : "✓ مطابق — انقفل الكرتون"}${left ? ` · باقي ${left} كرتون` : " · كل الكراتين انقفلت ✓"}`, 3000);
    A.go(shipUrl());
  }

  /* ===================== Excel ===================== */
  // صف موحّد (من الجهاز أو من بحث الأرشيف بالسيرفر)
  function localRows(f = {}) {
    const out = [];
    const txt = (f.text || "").trim().toUpperCase();
    for (const c of Object.values(T.cartons)) {
      if (c.deleted) continue;
      const s = T.ships[c.ship_id];
      if (!s || s.deleted) continue;
      if (f.ship && s.id !== f.ship) continue;
      if (f.branch && s.branch !== f.branch) continue;
      if (f.archived != null && !!s.archived !== f.archived) continue;
      if (f.from && c.at < f.from) continue;
      if (f.to && c.at >= f.to) continue;
      const base = { ship_id: s.id, ship: s.name, branch: s.branch, ship_status: s.status, archived: !!s.archived, archived_at: s.archived_at, ship_at: s.created_at,
        code: c.code, c_qty: c.qty, c_lines: c.lines, c_status: c.status, mismatch: !!c.mismatch, c_by: c.by_name, c_at: c.at, c_closed_by: c.closed_by, c_closed_at: c.closed_at };
      const ls = linesOf(c.code);
      const okC = !txt || c.code.includes(txt) || (s.name || "").toUpperCase().includes(txt);
      if (!ls.length) { if (okC) out.push(base); continue; }
      for (const l of ls) if (okC || l.n.toUpperCase().startsWith(txt)) out.push({ ...base, n: l.n, name: l.name, qty: l.qty, l_by: l.by_name, l_at: l.at });
    }
    return out.sort((a, b) => (b.ship_at || 0) - (a.ship_at || 0) || a.code.localeCompare(b.code) || String(a.n || "").localeCompare(String(b.n || "")));
  }
  const normRow = (r) => ({ ...r, archived_at: ms(r.archived_at), ship_at: ms(r.ship_at), c_at: ms(r.c_at), c_closed_at: ms(r.c_closed_at), l_at: ms(r.l_at) });
  const rowStatus = (r) => C_ST({ status: r.c_status, mismatch: r.mismatch });

  async function exportRows(rows, name) {
    if (!rows.length) { toast("ما فيه بيانات"); return; }
    let X;
    try { X = await A.loadXLSX(); } catch { toast("تعذّر تحميل Excel"); return; }
    const wb = X.utils.book_new(); wb.Workbook = { Views: [{ RTL: true }] };
    const its = rows.filter((r) => r.n);
    const sh1 = X.utils.aoa_to_sheet([["رقم الصنف", "اسم الصنف", "الكمية", "رقم الكرتون", "QTY الكرتون", "LINES الكرتون", "حالة الكرتون", "تاريخ الكرتون", "تاريخ جرد الصنف", "جرده", "الفرع", "الشحنة"],
      ...its.map((r) => [r.n, r.name || "", r.qty, r.code, r.c_qty, r.c_lines, rowStatus(r), dt(r.c_at), dt(r.l_at), r.l_by || "", A.branchLabel(r.branch), r.ship || ""])]);
    sh1["!cols"] = [18, 30, 8, 20, 10, 10, 12, 18, 18, 14, 12, 18].map((w) => ({ wch: w }));
    X.utils.book_append_sheet(wb, sh1, "الأصناف");
    // الكراتين
    const cm = new Map();
    for (const r of rows) {
      let c = cm.get(r.code);
      if (!c) cm.set(r.code, c = { r, qty: 0, lines: 0 });
      if (r.n) { c.qty += +r.qty || 0; c.lines++; }
    }
    const sh2 = X.utils.aoa_to_sheet([["رقم الكرتون", "الفرع", "الشحنة", "QTY الملصق", "LINES الملصق", "QTY المجرود", "LINES المجرود", "فرق QTY", "فرق LINES", "الحالة", "مسحه", "تاريخ المسح", "قفله", "وقت القفل"],
      ...[...cm.values()].map(({ r, qty, lines }) => [r.code, A.branchLabel(r.branch), r.ship || "", r.c_qty, r.c_lines, qty, lines, qty - r.c_qty, lines - r.c_lines,
        rowStatus(r), r.c_by || "", dt(r.c_at), r.c_closed_by || "", dt(r.c_closed_at)])]);
    sh2["!cols"] = [20, 12, 18, 10, 10, 10, 10, 9, 9, 12, 14, 18, 14, 18].map((w) => ({ wch: w }));
    X.utils.book_append_sheet(wb, sh2, "الكراتين");
    // مجموع كل صنف
    const nm = new Map();
    for (const r of its) {
      const k = `${r.branch}|${r.n}`;
      let x = nm.get(k);
      if (!x) nm.set(k, x = { r, qty: 0, cs: [] });
      x.qty += +r.qty || 0; x.cs.push(r.code);
    }
    const sh3 = X.utils.aoa_to_sheet([["رقم الصنف", "اسم الصنف", "الفرع", "المجموع", "عدد الكراتين", "الكراتين"],
      ...[...nm.values()].sort((a, b) => a.r.n.localeCompare(b.r.n)).map(({ r, qty, cs }) => [r.n, r.name || "", A.branchLabel(r.branch), qty, cs.length, cs.join(" ، ")])]);
    sh3["!cols"] = [18, 30, 12, 9, 10, 40].map((w) => ({ wch: w }));
    X.utils.book_append_sheet(wb, sh3, "مجموع الأصناف");
    X.writeFile(wb, name.replace(/[\\/:*?"<>|]/g, "-"));
    toast(`✓ ${fmt(cm.size)} كرتون · ${fmt(its.length)} سطر صنف`, 3000);
  }
  async function exportShips(ships) {
    if (CLOUD) { toast("جاري سحب آخر جرد…", 8000); await window.DB.sync(A.applyChanges); }
    const ids = new Set(ships.map((s) => s.id));
    const rows = localRows().filter((r) => ids.has(r.ship_id));
    const name = ships.length === 1 ? `تويوتا-${ships[0].name}-${A.today()}.xlsx` : `تويوتا-${ships.length}-شحنة-${A.today()}.xlsx`;
    await exportRows(rows, name);
  }

  /* ===================== الأرشيف (المدير) ===================== */
  async function renderArchive() {
    const bs = state.data?.branches || [];
    const sel = $("#tya-branch"), cur = sel.value;
    sel.innerHTML = `<option value="">كل الفروع</option>` + bs.map((b) => `<option value="${esc(b)}">${esc(A.branchLabel(b))}</option>`).join("");
    sel.value = bs.includes(cur) ? cur : "";
    if (ui.arch) { drawResults(); return; }
    $("#tya-export").disabled = true;
    $("#tya-sum").textContent = "الشحنات المؤرشفة:";
    $("#tya-list").innerHTML = `<p class="muted pad">جاري التحميل…</p>`;
    let ships;
    try {
      ships = CLOUD ? (await window.DB.tyArchivedShips()).map((s) => ({ ...s, created_at: ms(s.created_at), archived_at: ms(s.archived_at) }))
        : Object.values(T.ships).filter((s) => s.archived && !s.deleted).sort((a, b) => (b.archived_at || 0) - (a.archived_at || 0));
    } catch (e) { $("#tya-list").innerHTML = `<p class="muted pad">تعذّر التحميل: ${esc(e.message)}${CLOUD ? " — تأكد إنك شغّلت تحديث 7 بالسيرفر" : ""}</p>`; return; }
    if (state.screen !== "tya" || ui.arch) return;
    $("#tya-list").innerHTML = ships.length ? ships.map((s) => `<div class="bin-row ty-arow">
        <span class="tc-main"><b>${esc(s.name || "شحنة")}</b><small>${esc(A.branchLabel(s.branch))} · ${esc(dShort(s.created_at))} · انأرشفت ${esc(dShort(s.archived_at))}${s.archived_by ? " · " + esc(s.archived_by) : ""}</small></span>
        <span class="ty-aacts"><button class="btn ghost" data-ex="${esc(s.id)}" data-nm="${esc(s.name || "")}">⬇ Excel</button><button class="btn ghost" data-un="${esc(s.id)}">↺ استرجاع</button></span>
      </div>`).join("") : `<p class="muted pad">ما فيه شحنات مؤرشفة</p>`;
  }
  async function archSearch(p) {
    if (!CLOUD) return localRows(p);
    const rows = await window.DB.tySearch({ p_ship: p.ship || null, p_text: p.text || null, p_from: iso(p.from), p_to: iso(p.to), p_branch: p.branch || null,
      p_archived: p.archived ?? null });
    return (rows || []).map(normRow);
  }
  $("#tya-search").addEventListener("click", async () => {
    const from = $("#tya-from").value, to = $("#tya-to").value;
    const p = {
      text: $("#tya-q").value.trim(), branch: $("#tya-branch").value || null,
      from: from ? new Date(from + "T00:00").getTime() : null,
      to: to ? new Date(to + "T00:00").getTime() + 86400000 : null,
      archived: $("#tya-all").checked ? null : true,
    };
    if (!p.text && !p.from && !p.to && !p.branch && p.archived) { ui.arch = null; renderArchive(); return; }
    $("#tya-list").innerHTML = `<p class="muted pad">جاري البحث…</p>`;
    try { ui.arch = await archSearch(p); }
    catch (e) { $("#tya-list").innerHTML = `<p class="muted pad">تعذّر البحث: ${esc(e.message)}</p>`; return; }
    drawResults();
  });
  $("#tya-q").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("#tya-search").click(); } });
  function drawResults() {
    const rows = ui.arch || [];
    const cs = new Set(rows.map((r) => r.code)), ss = new Set(rows.map((r) => r.ship_id));
    $("#tya-export").disabled = !rows.length;
    $("#tya-sum").innerHTML = `${fmt(rows.length)} سطر · ${fmt(cs.size)} كرتون · ${fmt(ss.size)} شحنة <button class="chip" id="tya-reset">✕ مسح البحث</button>`;
    const show = rows.slice(0, 300);
    $("#tya-list").innerHTML = show.length ? `<div class="tya-table">${show.map((r) => `<div class="tya-r${r.mismatch ? " bad" : ""}">
        <b dir="ltr">${esc(r.n || "—")}</b><span>${esc(r.name || "")}</span><i>${r.n ? fmt(r.qty) : ""}</i>
        <small dir="ltr">${esc(r.code)}</small><small>${esc(r.ship || "")} · ${esc(A.branchLabel(r.branch))} · ${esc(dShort(r.c_at))}${r.archived ? "" : " · حالية"}</small>
      </div>`).join("")}</div>${rows.length > 300 ? `<p class="muted pad">يعرض أول 300 — الكل بملف Excel</p>` : ""}`
      : `<p class="muted pad">ما فيه نتائج</p>`;
  }
  $("#tya-sum").addEventListener("click", (e) => { if (e.target.id === "tya-reset") { ui.arch = null; $("#tya-q").value = ""; renderArchive(); } });
  $("#tya-export").addEventListener("click", () => exportRows(ui.arch || [], `أرشيف-تويوتا-${A.today()}.xlsx`));
  $("#tya-list").addEventListener("click", async (e) => {
    const ex = e.target.closest("[data-ex]"), un = e.target.closest("[data-un]");
    if (ex) {
      toast("جاري التحميل…", 8000);
      try { await exportRows(await archSearch({ ship: ex.dataset.ex }), `تويوتا-${ex.dataset.nm}-${A.today()}.xlsx`); }
      catch (er) { toast("تعذّر: " + er.message, 3000); }
    }
    if (un) {
      if (!confirm("استرجاع الشحنة من الأرشيف؟ ترجع تطلع للموظفين")) return;
      try {
        if (CLOUD) { await window.DB.flush(); await window.DB.tyUnarchive(un.dataset.un); }
        const s = T.ships[un.dataset.un];
        if (s) { s.archived = false; s.archived_at = null; touch(s); save(); }
        toast("✓ رجعت الشحنة");
        A.runSync();
        ui.arch = null; renderArchive();
      } catch (er) { toast("تعذّر: " + er.message, 3000); }
    }
  });

  /* ===================== التنقل ===================== */
  const shipUrl = (s = ui.ship) => "tys/" + s.id + (ui.view ? "/" + ui.view : "");
  function shipOk(id) {
    const s = T.ships[id];
    return s && !s.deleted && !s.archived && canSee(s.branch) && (s.status !== "done" || A.isAdmin()) ? s : null;
  }
  function route(h) {
    let m;
    if (h === "ty") { renderList(); A.show("ty"); A.runSync(); return; }
    if (h === "tya") { if (!A.isAdmin()) return A.go("ty"); A.show("tya"); renderArchive(); return; }
    if ((m = h.match(/^tys\/([\w-]+)(?:\/([cia]))?$/))) {
      const s = shipOk(m[1]); if (!s) return A.go("ty");
      if (ui.ship?.id !== s.id || ui.view !== (m[2] || "")) $("#tys-input").value = "";
      ui.ship = s; ui.view = m[2] || ""; renderShip(); A.show("tys"); return;
    }
    if ((m = h.match(/^tyc\/([\w-]+)\/(.+)$/))) {
      const s = shipOk(m[1]), c = s && T.cartons[decodeURIComponent(m[2])];
      if (!c || c.deleted || c.ship_id !== s.id) return A.go(s ? shipUrl(s) : "ty");
      if (takenBy(c) && !A.isAdmin()) { toast(`🔒 الكرتون ${c.code} عند ${takenBy(c)}`); return A.go(shipUrl(s)); }
      if (ui.carton?.code !== c.code) { ui.hist = []; ui.last = null; }
      ui.ship = s; ui.carton = c; renderCarton(); A.show("tyc"); return;
    }
    A.go("ty");
  }
  function back() {
    if (state.screen === "tyc") leaveCarton();
    const up = { ty: "home", tya: "ty", tys: ui.view && ui.ship ? "tys/" + ui.ship.id : "ty", tyc: ui.ship ? shipUrl() : "ty" }[state.screen];
    if (up) A.go(up);
  }
  function scan(raw) {
    if (state.screen === "tys" && ui.ship) { shipScan(raw); return ""; }
    if (state.screen === "tyc" && ui.carton) return cartonScan(raw);
    return "";
  }
  const continuous = () => state.screen === "tyc" && !!ui.carton && !ui.qtyMode && ui.carton.status !== "closed";

  const openCount = () => (!state.data && !A.isAdmin() ? null : visibleShips().filter((s) => s.status !== "done").length);
  return { route, back, scan, apply, continuous, openCount, _T: T, _localRows: localRows };
})();
