// Runs automatically after each verified (non-spam) Netlify form submission.
// For the website's "contact" form it saves the person to the private CRM:
//   - finds the contact by email, or creates one tagged "website lead"
//   - logs the message on the contact's actions log
//   - adds a follow-up due 7 days after the submission
//
// Netlify signs the events it sends to this function, so outside requests
// can't trigger it. It needs three environment variables, set in Netlify
// (never in this repo):
//   SUPABASE_URL          https://<project>.supabase.co
//   SUPABASE_SECRET_KEY   the project's Secret key (sb_secret_...)
//   CRM_OWNER_ID          the CRM owner's user id (Supabase > Authentication > Users)
"use strict";

const FORM_NAME = "contact";
const FOLLOW_UP_DAYS = 7;
const TIME_ZONE = "America/Chicago";

const clean = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "") || null;

// The calendar day (YYYY-MM-DD) in Minnesota time, `days` after `when`.
function dayAfter(when, days) {
  const d = new Date(when);
  const base = isNaN(d) ? new Date() : d;
  const local = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(base); // en-CA formats as YYYY-MM-DD
  const [y, m, dd] = local.split("-").map(Number);
  const out = new Date(Date.UTC(y, m - 1, dd + days));
  return out.toISOString().slice(0, 10);
}

function client(env, fetchImpl) {
  const base = env.SUPABASE_URL.replace(/\/+$/, "") + "/rest/v1/";
  const key = env.SUPABASE_SECRET_KEY;
  const headers = { apikey: key, "Content-Type": "application/json", Prefer: "return=representation" };
  if (key.startsWith("eyJ")) headers.Authorization = "Bearer " + key; // legacy service_role JWT
  return async (method, path, body) => {
    const res = await fetchImpl(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (!res.ok) throw new Error(`Supabase ${method} ${path.split("?")[0]} failed: ${res.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  };
}

async function saveToCrm(payload, env, fetchImpl) {
  const data = payload.data || {};
  const name = clean(data.name, 200);
  const email = (clean(data.email, 320) || "").toLowerCase() || null;
  const phone = clean(data.phone, 50);
  const company = clean(data.organization, 200);
  const message = clean(data.message, 5000);
  if (!name && !email) return { skipped: "no name or email" };

  const owner = env.CRM_OWNER_ID;
  const db = client(env, fetchImpl);
  const submitted = payload.created_at || new Date().toISOString();

  let contact = null;
  if (email) {
    const found = await db("GET",
      `contacts?select=id,phone,company,tags&owner_id=eq.${encodeURIComponent(owner)}&email=eq.${encodeURIComponent(email)}&limit=1`);
    contact = found && found[0];
  }

  if (contact) {
    // Fill in anything new without overwriting what's already there.
    const patch = {};
    if (phone && !contact.phone) patch.phone = phone;
    if (company && !contact.company) patch.company = company;
    if (!(contact.tags || []).includes("website lead")) patch.tags = (contact.tags || []).concat("website lead");
    if (Object.keys(patch).length) await db("PATCH", `contacts?id=eq.${contact.id}`, patch);
  } else {
    [contact] = await db("POST", "contacts", {
      owner_id: owner, name: name || email, email, phone, company,
      tags: ["website lead"],
    });
  }

  const today = dayAfter(submitted, 0);
  await db("POST", "actions", {
    owner_id: owner, contact_id: contact.id, kind: "email", happened_on: today,
    summary: "Website contact form" + (message ? ":\n" + message : ""),
  });
  const due = dayAfter(submitted, FOLLOW_UP_DAYS);
  await db("POST", "followups", {
    owner_id: owner, contact_id: contact.id, due_on: due,
    title: "Follow up on website inquiry",
  });
  return { contact_id: contact.id, due_on: due };
}

async function handler(event, _context, deps = {}) {
  const env = deps.env || process.env;
  const fetchImpl = deps.fetch || fetch;
  let payload;
  try {
    payload = JSON.parse(event.body || "{}").payload || {};
  } catch (e) {
    return { statusCode: 400, body: "bad payload" };
  }
  if (payload.form_name !== FORM_NAME) return { statusCode: 200, body: "ignored" };

  const missing = ["SUPABASE_URL", "SUPABASE_SECRET_KEY", "CRM_OWNER_ID"].filter((k) => !env[k]);
  if (missing.length) {
    console.error("CRM sync skipped; missing environment variables:", missing.join(", "));
    return { statusCode: 200, body: "crm not configured" };
  }
  try {
    const result = await saveToCrm(payload, env, fetchImpl);
    console.log("CRM sync ok", JSON.stringify(result));
    return { statusCode: 200, body: "ok" };
  } catch (err) {
    // The submission is still safe in Netlify Forms; log so it can be re-entered by hand.
    console.error("CRM sync failed:", err.message);
    return { statusCode: 500, body: "crm sync failed" };
  }
}

module.exports = { handler, dayAfter, saveToCrm };
