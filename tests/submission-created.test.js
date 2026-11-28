// Tests for the form-to-CRM function. Run: node --test tests/
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { handler, dayAfter } = require("../netlify/functions/submission-created.js");

const ENV = {
  SUPABASE_URL: "https://abc.supabase.co/",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  CRM_OWNER_ID: "11111111-1111-1111-1111-111111111111",
};

// A fake Supabase REST API that records calls.
function fakeSupabase(existing) {
  const calls = [];
  const fetch = async (url, opts) => {
    const u = new URL(url);
    const table = u.pathname.replace("/rest/v1/", "");
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ method: opts.method, table, query: u.search, body, headers: opts.headers });
    let out = [];
    if (opts.method === "GET") out = existing ? [existing] : [];
    if (opts.method === "POST") out = [Object.assign({ id: table + "-new" }, body)];
    return { ok: true, status: 200, text: async () => JSON.stringify(out) };
  };
  return { calls, fetch };
}

const event = (data, extra = {}) => ({
  body: JSON.stringify({ payload: Object.assign({ form_name: "contact", created_at: "2026-11-28T03:30:00.000Z", data }, extra) }),
});

test("new lead creates a contact, logs the message and adds a 7-day follow-up", async () => {
  const sb = fakeSupabase(null);
  const res = await handler(event({ name: " Dana Lee ", email: "Dana@Example.com", phone: "612-555-0100", organization: "Acme", message: "Need help with AI" }), {}, { env: ENV, fetch: sb.fetch });
  assert.strictEqual(res.statusCode, 200);
  const [lookup, contact, action, followup] = sb.calls;
  assert.match(lookup.query, /email=eq\.dana%40example\.com/);
  assert.match(lookup.query, /owner_id=eq\.11111111/);
  assert.deepStrictEqual(
    { method: contact.method, table: contact.table, name: contact.body.name, email: contact.body.email, phone: contact.body.phone, company: contact.body.company, tags: contact.body.tags, owner: contact.body.owner_id },
    { method: "POST", table: "contacts", name: "Dana Lee", email: "dana@example.com", phone: "612-555-0100", company: "Acme", tags: ["website lead"], owner: ENV.CRM_OWNER_ID });
  assert.strictEqual(action.table, "actions");
  assert.strictEqual(action.body.contact_id, "contacts-new");
  assert.match(action.body.summary, /Need help with AI/);
  // 03:30 UTC on Nov 28 is still Nov 27 in Minnesota, so the follow-up is due Dec 4.
  assert.strictEqual(action.body.happened_on, "2026-11-27");
  assert.deepStrictEqual([followup.table, followup.body.due_on, followup.body.contact_id], ["followups", "2026-12-04", "contacts-new"]);
  assert.strictEqual(sb.calls.length, 4);
  assert.strictEqual(contact.headers.apikey, "sb_secret_test");
  assert.strictEqual(contact.headers.Authorization, undefined);
});

test("returning contact is reused and only empty fields are filled", async () => {
  const sb = fakeSupabase({ id: "c1", phone: null, company: "Old Co", tags: ["client"] });
  await handler(event({ name: "Dana", email: "dana@example.com", phone: "612", organization: "New Co", message: "hi" }), {}, { env: ENV, fetch: sb.fetch });
  const patch = sb.calls.find((c) => c.method === "PATCH");
  assert.strictEqual(patch.query, "?id=eq.c1");
  assert.deepStrictEqual(patch.body, { phone: "612", tags: ["client", "website lead"] });
  assert.ok(!sb.calls.some((c) => c.method === "POST" && c.table === "contacts"));
  assert.strictEqual(sb.calls.filter((c) => c.table === "followups").length, 1);
});

test("other forms are ignored", async () => {
  const sb = fakeSupabase(null);
  const res = await handler({ body: JSON.stringify({ payload: { form_name: "newsletter", data: { email: "a@b.c" } } }) }, {}, { env: ENV, fetch: sb.fetch });
  assert.strictEqual(res.body, "ignored");
  assert.strictEqual(sb.calls.length, 0);
});

test("missing configuration does nothing and doesn't fail the submission", async () => {
  const sb = fakeSupabase(null);
  const res = await handler(event({ name: "A", email: "a@b.c" }), {}, { env: {}, fetch: sb.fetch });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(sb.calls.length, 0);
});

test("a Supabase error is reported, not thrown", async () => {
  const fetch = async () => ({ ok: false, status: 401, text: async () => '{"message":"Invalid API key"}' });
  const res = await handler(event({ name: "A", email: "a@b.c" }), {}, { env: ENV, fetch });
  assert.strictEqual(res.statusCode, 500);
});

test("dates roll over months and years in Minnesota time", () => {
  assert.strictEqual(dayAfter("2026-12-28T18:00:00Z", 7), "2027-01-04");
  assert.strictEqual(dayAfter("2026-03-01T05:59:00Z", 0), "2026-02-28");
});
