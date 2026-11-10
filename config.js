// إعدادات التطبيق — هذا الملف ينرفع مع التطبيق وأي أحد يقدر يشوفه، فلا تحط فيه كلمات مرور
window.APP_CONFIG = {
  companyName: "نظام المخزون",

  // ===== ربط Supabase =====
  // من Supabase: Project Settings > API (أو Data API)
  //   supabaseUrl  = Project URL
  //   supabaseKey  = anon / publishable key  (⚠️ مو service_role)
  // لو تركتها فاضية يشتغل التطبيق "محلي" على الجهاز للتجربة (دخول: admin / 1234)
  supabaseUrl: "https://hxamwcldtwsqupqsovma.supabase.co",
  supabaseKey: "sb_publishable_W0dpRPdfqrkNhNhGtyoaWQ__ZmloT74",

  // اسم الدخول يتحول داخلياً لإيميل: ahmed@<هذا>. ما يرسل أي إيميل.
  emailDomain: "inv.local",

  // أسماء الفروع كما تظهر في التطبيق
  // المفتاح = الاسم الموجود في ملف الإكسيل، القيمة = الاسم المعروض
  branchLabels: {
    "فرع الرياض": "فرع الرياض",
    "الفرع الثالث": "فرع تبوك",
    "مستودع فرع 3": "فرع المستودع",
  },

  // ترتيب ظهور الفروع
  branchOrder: ["فرع الرياض", "الفرع الثالث", "مستودع فرع 3"],
};
