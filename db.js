/* ===================================================
   طبقة البيانات: Supabase (سحابي) أو محلي على الجهاز
   - الجرد يُحفظ على الجهاز أولاً ثم يُرفع (يشتغل بدون إنترنت)
   - مخزون الفروع محفوظ في IndexedDB ويتحدث لما يتغير رقم النسخة
   =================================================== */
window.DB = (() => {
  "use strict";
  const CFG = window.APP_CONFIG || {};
  const on = !!(CFG.supabaseUrl && CFG.supabaseKey && window.supabase);
  const AUTH_KEY = "inv-auth";
  const sb = on ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
    // lock بسيط: قفل المتصفح الافتراضي أحياناً يعلّق الطلبات للأبد على الجوال
    auth: { persistSession: true, autoRefreshToken: true, storageKey: AUTH_KEY, lock: async (_n, _t, fn) => fn() },
  }) : null;
  // الجلسة موجودة على الجهاز؟ (لو انمسحت = لازم دخول من جديد، حتى لو الملف الشخصي محفوظ)
  const hasSession = () => { try { return !!localStorage.getItem(AUTH_KEY); } catch { return true; } };
  const emailOf = (u) => `${String(u).trim().toLowerCase()}@${CFG.emailDomain || "inv.local"}`;

  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };
  const K = {
    profile: "inv_profile_v1",
    outbox: "inv_outbox_v1",
    cursor: "inv_sync_at_v1",
  };

  /* ---------- IndexedDB صغير (مفتاح/قيمة) ---------- */
  const idb = (() => {
    let p;
    const open = () => (p ||= new Promise((res, rej) => {
      const r = indexedDB.open("inv", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("kv");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
    const tx = async (mode, fn) => {
      const db = await open();
      return new Promise((res, rej) => {
        const t = db.transaction("kv", mode);
        const req = fn(t.objectStore("kv"));
        t.oncomplete = () => res(req?.result);
        t.onerror = () => rej(t.error);
      });
    };
    return {
      get: (k) => tx("readonly", (s) => s.get(k)).catch(() => undefined),
      set: (k, v) => tx("readwrite", (s) => s.put(v, k)),
      del: (k) => tx("readwrite", (s) => s.delete(k)),
    };
  })();

  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
      (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));

  // خطأ شبكة/جلسة = نعيد المحاولة لاحقاً. غيره = خطأ دائم
  const retryable = (status) => !status || status === 401 || status === 408 || status === 429 || status >= 500;
  // كل طلب له حد أقصى عشان ما يعلّق المزامنة
  async function q(promise, ms = 25000) {
    let t;
    const timeout = new Promise((_, rej) => { t = setTimeout(() => { const e = new Error("timeout"); e.status = 0; rej(e); }, ms); });
    try {
      const { data, error, status } = await Promise.race([promise, timeout]);
      if (error) { const e = new Error(error.message || "error"); e.status = status; e.code = error.code; throw e; }
      return data;
    } finally { clearTimeout(t); }
  }

  /* ---------- الدخول ---------- */
  let profile = ls.get(K.profile, null);
  async function fetchProfile(uid) {
    const p = await q(sb.from("profiles").select("*").eq("id", uid).maybeSingle());
    if (p) { profile = p; ls.set(K.profile, p); }
    return p;
  }
  async function restore() {
    if (!on) return null;
    let session = null;
    try { session = (await sb.auth.getSession()).data.session; } catch {}
    if (!session) { profile = null; ls.del(K.profile); return null; }
    if (profile?.id !== session.user.id) profile = null;
    // نحدّث الملف الشخصي بالخلفية (لو الجهاز بدون نت نكمل بالمحفوظ)
    const fresh = fetchProfile(session.user.id).catch(() => profile);
    return profile || (await fresh);
  }
  async function signIn(username, password) {
    const { data, error } = await sb.auth.signInWithPassword({ email: emailOf(username), password });
    if (error) {
      const e = new Error(/invalid/i.test(error.message) ? "bad" : /fetch|network/i.test(error.message) ? "net" : error.message);
      throw e;
    }
    const p = await fetchProfile(data.user.id);
    if (!p || !p.active) { await sb.auth.signOut().catch(() => {}); throw new Error("inactive"); }
    status.needLogin = false; status.error = "";
    emit(); scheduleFlush();
    return p;
  }
  async function signOut() {
    profile = null; ls.del(K.profile);
    status.needLogin = false; status.error = "";
    if (on) await sb.auth.signOut({ scope: "local" }).catch(() => {});
  }
  const refreshProfile = () => (on && profile ? fetchProfile(profile.id) : Promise.resolve(profile));

  /* ---------- مخزون الفروع ---------- */
  // الصيغة: { version, items: [[n, name, branch, q, r, loc, c], ...] }
  const ITEMS_KEY = on ? "items_cloud" : "items_local";
  let itemsVersion = null;
  async function loadItems(force) {
    const cached = await idb.get(ITEMS_KEY);
    if (!on) {
      if (cached) { itemsVersion = cached.version; return cached; }    // محلي: آخر شيء رفعه المدير على هذا الجهاز
      const raw = await (await fetch("data/items.json", { cache: "no-cache" })).json();
      const data = { version: "file", items: raw.items.map((r) => [r[0], r[1], raw.branches[r[2]], r[3], r[4], r[5], r[6]]) };
      itemsVersion = data.version;
      return data;
    }
    if (cached && !force) {
      try {
        const m = await q(sb.from("app_meta").select("value").eq("key", "items_version").maybeSingle());
        if ((m?.value ?? null) === cached.version) { itemsVersion = cached.version; return cached; }
      } catch (e) {
        if (retryable(e.status)) { itemsVersion = cached.version; return cached; }   // بدون نت: النسخة المحفوظة
        throw e;
      }
    }
    let data;
    try { data = await q(sb.rpc("get_items")); }
    catch (e) { if (cached) { itemsVersion = cached.version; return cached; } throw e; }
    data = { version: data.version ?? null, items: data.items || [] };
    await idb.set(ITEMS_KEY, data).catch(() => {});
    itemsVersion = data.version;
    return data;
  }

  /* ---------- رفع الجرد (طابور يشتغل بدون نت) ---------- */
  let outbox = ls.get(K.outbox, []);
  const listeners = new Set();
  const status = { online: navigator.onLine, syncing: false, lastSync: ls.get(K.cursor, null)?.local || 0, error: "", needLogin: false };
  // الجلسة راحت: نوقف ونطلب دخول (الجرد اللي ما انرفع يبقى محفوظ باسم صاحبه)
  function checkSession() {
    if (hasSession()) return true;
    status.needLogin = true; status.error = "انتهت جلسة الدخول — سجّل دخول من جديد";
    emit();
    return false;
  }
  const emit = () => listeners.forEach((f) => { try { f(getStatus()); } catch {} });
  // كل عملية مربوطة بصاحبها: لو طلع من حسابه تبقى محفوظة وتترفع لما يرجع يدخل
  const mine = (o) => !o.uid || o.uid === profile?.id;
  const getStatus = () => ({ ...status, pending: outbox.filter(mine).length, others: outbox.filter((o) => !mine(o)).length, cloud: on });

  function queue(op) {
    if (!on) return;
    op.uid = profile?.id;
    outbox.push(op);
    ls.set(K.outbox, outbox);
    emit();
    scheduleFlush();
  }
  let flushT;
  const scheduleFlush = () => { clearTimeout(flushT); flushT = setTimeout(() => flush().catch(() => {}), 400); };

  const TABLE = { entry: "count_entries", meta: "count_meta", extra: "extras" };
  async function runOps(type, ops) {
    if (type === "entry") {
      await q(sb.from("count_entries").upsert(ops.map((o) => o.row), { onConflict: "id", ignoreDuplicates: true }));
    } else if (type === "del") {
      await q(sb.from("count_entries").update({ deleted: true, deleted_by: profile?.id }).in("id", ops.map((o) => o.id)));
    } else if (type === "meta" || type === "extra") {
      // نفس الصنف مرتين بنفس الدفعة = نرسل الأخير بس
      const m = new Map(ops.map((o) => [`${o.row.round_id}|${o.row.n}`, o.row]));
      await q(sb.from(TABLE[type]).upsert([...m.values()], { onConflict: "round_id,n" }));
    } else if (type === "round") {
      const m = new Map(ops.map((o) => [o.row.id, o.row]));
      await q(sb.from("rounds").upsert([...m.values()], { onConflict: "id" }));
    }
  }
  let flushing = null;
  function flush() {
    if (!on || !profile) return Promise.resolve();
    return (flushing ||= (async () => {
      try {
        for (;;) {
          if (!checkSession()) { const e = new Error("needLogin"); e.status = 401; throw e; }
          const list = outbox.filter(mine);
          if (!list.length) break;
          const type = list[0].t;
          let k = 0;
          while (k < list.length && list[k].t === type && k < 500) k++;
          const batch = list.slice(0, k);
          try {
            await runOps(type, batch);
            status.online = true; status.error = "";
          } catch (e0) {
            let e = e0;
            console.warn("sync", type, e.status, e.message);
            if (e.status === 401 || e.status === 403) {
              // غالباً الجلسة انتهت: نجدّدها ونعيد مرة. لو ما تجددت = دخول من جديد
              const { error } = await sb.auth.refreshSession().catch((er) => ({ error: er }));
              if (error && !hasSession()) { checkSession(); throw e; }
              try { await runOps(type, batch); e = null; } catch (e2) { e = e2; }
              if (e && e.status === 401) { status.error = `رفض السيرفر (401): ${e.message}`; throw e; }
              // 403 بعد تجديد الجلسة = ما عنده صلاحية لهالعملية: نتجاوزها عشان ما توقف الباقي
              if (e) status.error = `عملية مرفوضة وتم تجاوزها (${e.status}): ${e.message}`;
            } else if (retryable(e.status)) { status.online = false; status.error = e.message === "timeout" ? "الاتصال بطيء — بنعيد المحاولة" : ""; throw e; }
            else status.error = `عملية مرفوضة وتم تجاوزها (${e.status}): ${e.message}`;   // مرفوض نهائياً
          }
          const done = new Set(batch);
          outbox = outbox.filter((o) => !done.has(o));
          ls.set(K.outbox, outbox);
          emit();
        }
      } finally { flushing = null; emit(); }
    })());
  }

  // سحب التغييرات من السيرفر (مع تداخل دقيقتين عشان ما يفوتنا شيء)
  async function pull() {
    if (!on || !profile) return null;
    if (!checkSession()) return null;      // بدون جلسة السيرفر يرجع فاضي — ما نحرّك المؤشر
    const cur = ls.get(K.cursor, null);
    const since = cur?.server ? new Date(Date.parse(cur.server) - 120000).toISOString() : "1970-01-01T00:00:00Z";
    const ch = await q(sb.rpc("get_changes", { since }));
    ls.set(K.cursor, { server: ch.now, local: Date.now() });
    status.lastSync = Date.now(); status.online = true;
    ch.itemsChanged = ch.items_version != null && itemsVersion != null && ch.items_version !== itemsVersion;
    return ch;
  }

  async function sync(apply) {
    if (!on || !profile || status.syncing) return;
    status.syncing = true; emit();
    try {
      // الرفع لو تعطّل ما يوقف السحب — الموظف لازم يستلم الجرد الجديد حتى لو عنده شيء معلّق
      try { await flush(); } catch (e) { if (!hasSession()) throw e; }
      const ch = await pull();
      if (ch) apply(ch);
    } catch (e) {
      if (e.status === 401 || e.status === 403) { /* الرسالة انكتبت في flush */ }
      else if (retryable(e.status)) status.online = false;
      else status.error = e.message;
    } finally { status.syncing = false; emit(); }
  }
  addEventListener("online", () => { status.online = true; emit(); scheduleFlush(); });
  addEventListener("offline", () => { status.online = false; emit(); });

  function resetLocalSync() { ls.del(K.cursor); }
  // أرقام الجولات اللي لسا ما انرفعت (عشان المدير يعرف)
  const pendingRounds = () => new Set(outbox.filter((o) => o.t === "round").map((o) => o.row.id));

  /* ---------- المدير ---------- */
  async function listProfiles() {
    return q(sb.from("profiles").select("*").order("created_at"));
  }
  async function createUser({ username, name, password, role, blind, active, scope }) {
    try {
      return await q(sb.rpc("admin_create_user", {
        p_username: username.toLowerCase(), p_password: password, p_name: name, p_role: role,
        p_blind: !!blind, p_active: active !== false, p_scope: scope || [], p_domain: CFG.emailDomain || "inv.local",
      }));
    } catch (e) { throw new Error(/exists/.test(e.message) ? "exists" : e.message); }
  }
  const updateProfile = (id, fields) => q(sb.from("profiles").update(fields).eq("id", id));
  const setPassword = (uid, pw) => q(sb.rpc("admin_set_password", { uid, pw }));
  const deleteUser = (uid) => q(sb.rpc("admin_delete_user", { uid }));

  // رفع على دفعات بالتوازي
  async function inBatches(rows, size, par, fn, onProgress) {
    let done = 0, i = 0;
    const worker = async () => {
      while (i < rows.length) {
        const part = rows.slice(i, i + size); i += size;
        for (let tries = 0; ; tries++) {
          try { await fn(part); break; }
          catch (e) { if (tries >= 3 || !retryable(e.status)) throw e; await new Promise((r) => setTimeout(r, 1500 * (tries + 1))); }
        }
        done += part.length;
        onProgress?.(done, rows.length);
      }
    };
    await Promise.all(Array.from({ length: par }, worker));
  }
  const toItemRow = (r) => ({ n: r[0], name: r[1] || "", branch: r[2], q: +r[3] || 0, r: +r[4] || 0, loc: r[5] || "", c: +r[6] || 0 });

  // استبدال كامل: الدليل و/أو مخزون الفروع
  async function replaceAll({ items, catalog }, onProgress) {
    if (!on) {
      if (items) await idb.set("items_local", { version: "local-" + Date.now(), items });
      if (catalog) await idb.set("catalog_local", catalog);
      return;
    }
    if (catalog) {
      onProgress?.("catalog", 0, catalog.length);
      await q(sb.rpc("admin_clear", { what: "catalog" }));
      await inBatches(catalog, 5000, 4, (part) => q(sb.from("catalog").insert(part.map(([n, name]) => ({ n, name: name || "" })))),
        (d, t) => onProgress?.("catalog", d, t));
    }
    if (items) {
      onProgress?.("items", 0, items.length);
      await q(sb.rpc("admin_clear", { what: "items" }));
      await inBatches(items, 2000, 4, (part) => q(sb.from("items").insert(part.map(toItemRow))), (d, t) => onProgress?.("items", d, t));
    }
    await q(sb.rpc("bump_items_version"));
  }
  // تحديث (لصق): نرسل الأصناف اللي تغيّرت بس
  async function upsertItems(rows, allItems, onProgress) {
    if (!on) { await idb.set("items_local", { version: "local-" + Date.now(), items: allItems }); return; }
    await inBatches(rows, 2000, 4, (part) => q(sb.from("items").upsert(part.map(toItemRow), { onConflict: "branch,n" })), onProgress);
    await q(sb.rpc("bump_items_version"));
  }
  async function searchCatalog(text, limit = 8) {
    const s = String(text || "").trim().toUpperCase();
    if (s.length < 2) return [];
    if (!on) {
      const cat = (await idb.get("catalog_local")) || [];
      const out = [];
      for (const r of cat) { if (r[0].startsWith(s)) { out.push({ n: r[0], name: r[1] }); if (out.length >= limit) break; } }
      return out;
    }
    const esc = s.replace(/[%_\\]/g, (c) => "\\" + c);
    return q(sb.from("catalog").select("n,name").like("n", esc + "%").order("n").limit(limit));
  }
  async function catalogSize() {
    if (!on) return ((await idb.get("catalog_local")) || []).length;
    const { count } = await sb.from("catalog").select("n", { count: "estimated", head: true });
    return count || 0;
  }
  const resetCounts = () => (on ? q(sb.rpc("admin_clear", { what: "counts" })) : Promise.resolve());
  // كل إدخالات الجولة حتى المحذوفة (للتقرير): [id, n, qty, user_id, by_name, at, deleted, deleted_by, kind, updated_at]
  const roundEntries = (rid) => (on ? q(sb.rpc("get_round_entries", { rid }), 40000) : Promise.resolve(null));

  return {
    on, uuid, idb,
    get profile() { return profile; },
    expire() { profile = null; ls.del(K.profile); },   // الجلسة راحت: نرجع لشاشة الدخول ونخلي الطابور
    restore, signIn, signOut, refreshProfile,
    loadItems, get itemsVersion() { return itemsVersion; },
    queue, flush, pull, sync, getStatus, onStatus: (f) => listeners.add(f), resetLocalSync, pendingRounds,
    listProfiles, createUser, updateProfile, setPassword, deleteUser,
    replaceAll, upsertItems, searchCatalog, catalogSize, resetCounts, roundEntries,
  };
})();
