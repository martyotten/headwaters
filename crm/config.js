// Connection details for the CRM's Supabase project.
//
// Both values are designed to be public: the page needs them to reach the
// database, and the database's row-level security rules (supabase/setup.sql)
// decide what anyone can see. Use the "Publishable" key (or the legacy "anon"
// key). NEVER put the "Secret" or "service_role" key here; the tests refuse it.
window.CRM_CONFIG = {
  supabaseUrl: "https://tergtnvvjzjvtpoiqpsk.supabase.co",
  supabaseKey: "sb_publishable_oeZVEN2c3EpJWy2kwnwjVw_WkOdhLYk"
};
