(function (global) {
  const safeGlobal = typeof global !== "undefined" ? global : {};

  const fallbackEnv = {
    SUPABASE_URL: "https://ltxjjnzsphhprykuwwye.supabase.co",
    SUPABASE_ANON_KEY:
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0eGpqbnpzcGhocHJ5a3V3d3llIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ3ODgyMDYsImV4cCI6MjA4MDM2NDIwNn0.AR4MHCGyhBDpX3BTBIqQh0qap6tOLUHfuP8HMofF3Sk",
    ADMIN_USER: "zakamon",
    ADMIN_PASSWORD: "4GS49PFJ$64@Nr*eXEPa9z%4",
  };

  const supabaseUrl =
    safeGlobal.SUPABASE_URL ||
    (typeof SUPABASE_URL !== "undefined" ? SUPABASE_URL : undefined) ||
    fallbackEnv.SUPABASE_URL;
  const supabaseAnonKey =
    safeGlobal.SUPABASE_ANON_KEY ||
    (typeof SUPABASE_ANON_KEY !== "undefined"
      ? SUPABASE_ANON_KEY
      : undefined) ||
    fallbackEnv.SUPABASE_ANON_KEY;
  const adminUser =
    safeGlobal.ADMIN_USER ||
    (typeof ADMIN_USER !== "undefined" ? ADMIN_USER : undefined) ||
    fallbackEnv.ADMIN_USER;
  const adminPassword =
    safeGlobal.ADMIN_PASSWORD ||
    (typeof ADMIN_PASSWORD !== "undefined"
      ? ADMIN_PASSWORD
      : undefined) ||
    fallbackEnv.ADMIN_PASSWORD;

  if (!safeGlobal.supabase || typeof safeGlobal.supabase.createClient !== "function") {
    console.error("Supabase library failed to load.");
    return;
  }

  if (!supabaseUrl || !supabaseAnonKey) {
    console.error("Supabase environment variables are missing.");
    return;
  }

  const client = safeGlobal.supabase.createClient(supabaseUrl, supabaseAnonKey);
  safeGlobal.supabaseClient = client;
  safeGlobal.authConfig = {
    adminUser,
    adminPassword,
    dashboardPath: safeGlobal.DASHBOARD_PATH || "dashboard.html",
    loginPath: safeGlobal.LOGIN_PATH || "index.html",
  };
})(window);
