/* قراءة ملف Excel أو نص ملصوق من Excel — يشتغل بالخلفية عشان الصفحة ما تعلق */
/* eslint-disable no-restricted-globals */
let XLSX_LOADED = false;

// أسماء الأعمدة المقبولة (يتعرف عليها بالاسم وبأي ترتيب)
const ALIASES = {
  n: ["رقم الصنف", "رقم القطعه", "رقم القطعة", "الرقم", "رقم", "item no", "item", "part no", "part number"],
  name: ["اسم الصنف", "اسم القطعه", "اسم القطعة", "الوصف", "الاسم", "description", "name"],
  b: ["اسم الفرع", "الفرع", "المستودع", "branch", "warehouse"],
  q: ["الكمية المتوفرة", "الكميه المتوفره", "المتوفر", "الكمية", "الكميه", "الرصيد", "qty", "quantity", "on hand"],
  r: ["الكمية المحجوزة", "الكميه المحجوزه", "المحجوز", "reserved"],
  loc: ["موقع الصنف", "الموقع", "location", "bin"],
  c: ["سعر معدل التكلفة", "سعر معدل التكلفه", "التكلفة", "التكلفه", "cost"],
};
const normH = (s) => String(s ?? "").replace(/[ً-ْـ]/g, "").replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي")
  .replace(/\s+/g, " ").trim().toLowerCase();
const ALIAS_N = Object.fromEntries(Object.entries(ALIASES).map(([k, a]) => [k, a.map(normH)]));

function mapHeader(row) {
  const h = row.map(normH);
  const idx = {};
  // تطابق كامل أولاً ثم "يحتوي"
  for (const pass of [0, 1]) {
    for (const [k, al] of Object.entries(ALIAS_N)) {
      if (idx[k] != null) continue;
      const i = h.findIndex((x, j) => x && !Object.values(idx).includes(j) &&
        al.some((a) => (pass === 0 ? x === a : x.includes(a))));
      if (i >= 0) idx[k] = i;
    }
  }
  return idx;
}
const clean = (v) => {
  if (v == null) return "";
  if (typeof v === "number" && Number.isInteger(v)) return String(v);
  return String(v).replace(/ /g, " ").trim();
};
const num = (v) => {
  if (typeof v === "number") return Math.round(v * 100) / 100;
  const s = String(v ?? "").replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d)).replace(/[,\s]/g, "");
  const f = parseFloat(s);
  return Number.isFinite(f) ? Math.round(f * 100) / 100 : 0;
};

function extract(rows) {
  // نبحث عن صف العناوين في أول 20 صف
  let hi = -1, idx = null;
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const m = mapHeader(rows[i] || []);
    if (m.n != null) { hi = i; idx = m; break; }
  }
  if (hi < 0) return { error: "noheader" };
  const out = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i]; if (!r) continue;
    const n = clean(r[idx.n]).toUpperCase().replace(/\s+/g, " ");   // بعض الأرقام فيها مسافة (MZ-TK48-33-04 -J)
    if (!n) continue;
    out.push([
      n,
      idx.name != null ? clean(r[idx.name]).replace(/\s+/g, " ") : "",
      idx.b != null ? clean(r[idx.b]) : "",
      idx.q != null ? num(r[idx.q]) : 0,
      idx.r != null ? num(r[idx.r]) : 0,
      idx.loc != null ? clean(r[idx.loc]).toUpperCase() : "",
      idx.c != null ? num(r[idx.c]) : 0,
    ]);
  }
  return { cols: Object.keys(idx), rows: out };
}

self.onmessage = (e) => {
  const { kind, buf, text } = e.data;
  try {
    let rows;
    if (kind === "xlsx") {
      if (!XLSX_LOADED) { importScripts("vendor/xlsx.full.min.js"); XLSX_LOADED = true; }
      self.postMessage({ progress: "قراءة الملف…" });
      const wb = XLSX.read(buf, { type: "array", dense: true, cellDates: false, cellHTML: false, cellStyles: false });
      const ws = wb.Sheets[wb.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" });
    } else {
      rows = String(text).replace(/\r/g, "").split("\n").map((l) => l.split("\t"));
    }
    self.postMessage({ progress: "ترتيب البيانات…" });
    self.postMessage({ result: extract(rows) });
  } catch (err) {
    self.postMessage({ result: { error: String(err && err.message || err) } });
  }
};
