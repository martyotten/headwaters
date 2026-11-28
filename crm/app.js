// Headwaters CRM: contacts, follow-ups and an actions log, for one owner.
//
// All data lives in Supabase. Row-level security (supabase/setup.sql) makes
// the database return only the signed-in owner's rows. Everything shown on
// the page is inserted as text (never as HTML), so stored notes can't run
// code in the page.
(function () {
  "use strict";

  const cfg = window.CRM_CONFIG || {};
  const app = document.getElementById("app");
  const nav = document.getElementById("nav");
  let db = null;
  let session = null;
  let flash = null; // {text, err} shown once on the next render

  // ---- small helpers ------------------------------------------------------

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, "");
      else el.setAttribute(k, String(v));
    }
    append(el, kids);
    return el;
  }

  function append(el, kids) {
    for (const kid of kids) {
      if (kid === null || kid === undefined || kid === false) continue;
      if (Array.isArray(kid)) append(el, kid);
      else el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
  }

  function show(...kids) {
    app.replaceChildren();
    if (flash) {
      app.append(h("p", { class: flash.err ? "msg err" : "msg", role: "status" }, flash.text));
      flash = null;
    }
    append(app, kids);
  }

  function go(hash, message) {
    if (message) flash = { text: message };
    if (location.hash === hash) render();
    else location.hash = hash;
  }

  function fail(err) {
    console.error(err);
    show(h("p", { class: "msg err" }, "Something went wrong: " + (err && err.message ? err.message : err)),
         h("p", {}, h("a", { href: "#/" }, "Back to Today")));
  }

  // Throw on a Supabase error so callers can use try/catch.
  function ok(result) {
    if (result.error) throw result.error;
    return result.data;
  }

  function isoDay(d) {
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }
  function today() { return isoDay(new Date()); }
  function addDays(n) { const d = new Date(); d.setDate(d.getDate() + n); return isoDay(d); }

  function niceDate(day) {
    if (!day) return "";
    const [y, m, d] = day.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    const sameYear = y === new Date().getFullYear();
    return date.toLocaleDateString(undefined,
      sameYear ? { weekday: "short", month: "short", day: "numeric" }
               : { month: "short", day: "numeric", year: "numeric" });
  }

  function dueLabel(day) {
    if (!day) return h("span", { class: "due" }, "No date");
    const t = today();
    if (day < t) return h("span", { class: "due over" }, "Overdue · " + niceDate(day));
    if (day === t) return h("span", { class: "due over" }, "Today");
    if (day === addDays(1)) return h("span", { class: "due" }, "Tomorrow");
    return h("span", { class: "due" }, niceDate(day));
  }

  function formData(form) {
    const out = {};
    for (const [k, v] of new FormData(form).entries()) out[k] = typeof v === "string" ? v.trim() : v;
    return out;
  }

  function busy(form, on) {
    for (const b of form.querySelectorAll("button")) b.disabled = on;
  }

  function field(label, input) {
    return h("div", {}, h("label", { for: input.id }, label), input);
  }

  // ---- data ---------------------------------------------------------------

  const api = {
    contacts: () => db.from("contacts").select("*").order("name"),
    contact: (id) => db.from("contacts").select("*").eq("id", id).maybeSingle(),
    openFollowups: () => db.from("followups")
      .select("id,title,due_on,done,contact_id,contacts(name)")
      .eq("done", false).order("due_on", { ascending: true, nullsFirst: false }),
    contactFollowups: (id) => db.from("followups").select("*").eq("contact_id", id)
      .order("done").order("due_on", { ascending: true, nullsFirst: false }),
    recentActions: () => db.from("actions")
      .select("id,kind,happened_on,summary,contact_id,contacts(name)")
      .order("happened_on", { ascending: false }).order("created_at", { ascending: false }).limit(10),
    contactActions: (id) => db.from("actions").select("*").eq("contact_id", id)
      .order("happened_on", { ascending: false }).order("created_at", { ascending: false }),
  };

  async function setDone(f, done) {
    ok(await db.from("followups")
      .update({ done, done_at: done ? new Date().toISOString() : null }).eq("id", f.id));
  }

  // ---- views --------------------------------------------------------------

  function notConfigured() {
    nav.hidden = true;
    show(h("div", { class: "card signin" },
      h("h1", {}, "Almost ready"),
      h("p", {}, "This CRM isn't connected to its database yet. Add the Supabase project URL and publishable key to crm/config.js.")));
  }

  function signInView(note) {
    nav.hidden = true;
    const email = h("input", { id: "email", name: "email", type: "email", required: true, autocomplete: "email" });
    const form = h("form", {
      onsubmit: async (e) => {
        e.preventDefault();
        busy(form, true);
        const { error } = await db.auth.signInWithOtp({
          email: email.value.trim(),
          options: { shouldCreateUser: false, emailRedirectTo: location.origin + "/crm/" },
        });
        busy(form, false);
        if (!error) {
          flash = { text: "Sign-in link sent to " + email.value.trim() + ". Check your inbox (and spam), then open it on this device." };
        } else if (error.status === 429 || /rate limit/i.test(error.message || "")) {
          flash = { text: "Too many sign-in emails were requested recently, so Supabase is holding off. Wait a few minutes and try again, or use the most recent link you received.", err: true };
        } else if (error.code === "otp_disabled" || /signups not allowed/i.test(error.message || "")) {
          flash = { text: "That email doesn't have access. Check it matches the user you added in Supabase.", err: true };
        } else {
          flash = { text: "Couldn't send the link: " + (error.message || "unknown error") + (error.status ? " (" + error.status + ")" : ""), err: true };
        }
        signInView();
      },
    }, field("Email", email), h("p", {}, h("button", { class: "btn", type: "submit" }, "Email me a sign-in link")));
    show(h("div", { class: "card signin" },
      h("h1", {}, "Sign in"),
      note ? h("p", { class: "msg err" }, note) : null,
      h("p", { class: "muted small" }, "This area is private. You'll get a one-time link by email."),
      form));
  }

  function followupItem(f, opts) {
    const box = h("input", {
      type: "checkbox", checked: f.done, "aria-label": "Mark done: " + f.title,
      onchange: async () => {
        box.disabled = true;
        try { await setDone(f, box.checked); render(); } catch (err) { fail(err); }
      },
    });
    const contactName = f.contacts && f.contacts.name;
    return h("li", { class: f.done ? "done" : "" },
      box,
      h("div", { class: "grow" },
        h("div", { class: "title" }, f.title),
        opts.showContact && contactName
          ? h("div", { class: "small" }, h("a", { href: "#/contact/" + f.contact_id }, contactName))
          : null),
      f.done ? h("span", { class: "due" }, "Done") : dueLabel(f.due_on),
      opts.onDelete ? h("button", { type: "button", class: "link danger small", onclick: () => opts.onDelete(f) }, "Delete") : null);
  }

  function actionItem(a, opts) {
    const contactName = a.contacts && a.contacts.name;
    return h("li", {},
      h("div", { class: "grow" },
        h("div", { class: "row" },
          h("span", { class: "kind" }, a.kind),
          h("span", { class: "due" }, niceDate(a.happened_on)),
          opts.showContact && contactName ? h("a", { class: "small", href: "#/contact/" + a.contact_id }, contactName) : null),
        h("div", { class: "notes" }, a.summary)),
      opts.onDelete ? h("button", { type: "button", class: "link danger small", onclick: () => opts.onDelete(a) }, "Delete") : null);
  }

  async function todayView() {
    const [open, recent] = await Promise.all([api.openFollowups(), api.recentActions()]).then((r) => r.map(ok));
    const t = today(), week = addDays(7);
    const overdue = open.filter((f) => f.due_on && f.due_on < t);
    const soon = open.filter((f) => f.due_on && f.due_on >= t && f.due_on <= week);
    const later = open.filter((f) => !f.due_on || f.due_on > week);

    const list = (items, empty) => items.length
      ? h("ul", { class: "items" }, items.map((f) => followupItem(f, { showContact: true })))
      : h("p", { class: "muted" }, empty);

    show(
      h("h1", {}, "Today"),
      overdue.length ? [h("h2", {}, "Overdue (" + overdue.length + ")"), h("div", { class: "card" }, list(overdue))] : null,
      h("h2", {}, "Due in the next 7 days"),
      h("div", { class: "card" }, list(soon, "Nothing due this week.")),
      later.length ? [h("h2", {}, "Later or no date"), h("div", { class: "card" }, list(later))] : null,
      h("h2", {}, "Recent activity"),
      h("div", { class: "card" }, recent.length
        ? h("ul", { class: "items" }, recent.map((a) => actionItem(a, { showContact: true })))
        : h("p", { class: "muted" }, "No activity logged yet. Open a contact to log a call, email or meeting.")));
  }

  async function contactsView() {
    const [contacts, open] = await Promise.all([api.contacts(), api.openFollowups()]).then((r) => r.map(ok));
    const nextDue = {};
    for (const f of open) {
      if (f.due_on && (!nextDue[f.contact_id] || f.due_on < nextDue[f.contact_id])) nextDue[f.contact_id] = f.due_on;
    }
    const listEl = h("div", {});
    const search = h("input", { id: "search", type: "search", placeholder: "Search name, company, email or tag", autocomplete: "off", "aria-label": "Search contacts" });

    function draw() {
      const q = search.value.trim().toLowerCase();
      const hits = contacts.filter((c) => !q || [c.name, c.company, c.title, c.email, c.phone, (c.tags || []).join(" ")]
        .some((v) => v && v.toLowerCase().includes(q)));
      listEl.replaceChildren(hits.length
        ? h("div", { class: "card" }, h("ul", { class: "items" }, hits.map((c) => h("li", {},
            h("a", { class: "contact grow", href: "#/contact/" + c.id },
              h("div", { class: "name" }, c.name),
              h("div", { class: "small muted" }, [c.title, c.company].filter(Boolean).join(", ")),
              (c.tags || []).length ? h("div", {}, c.tags.map((t) => h("span", { class: "tag" }, t))) : null),
            nextDue[c.id] ? dueLabel(nextDue[c.id]) : null))))
        : h("p", { class: "muted" }, contacts.length ? "No contacts match." : "No contacts yet."));
    }
    search.addEventListener("input", draw);
    draw();

    show(
      h("div", { class: "row spread" },
        h("h1", {}, "Contacts (" + contacts.length + ")"),
        h("div", { class: "row" },
          contacts.length ? h("button", { type: "button", class: "btn ghost", onclick: () => exportCsv(contacts) }, "Export CSV") : null,
          h("a", { class: "btn", href: "#/new" }, "+ Contact"))),
      h("p", {}, search),
      listEl);
    if (window.matchMedia("(min-width: 700px)").matches) search.focus();
  }

  function exportCsv(contacts) {
    const cols = ["name", "company", "title", "email", "phone", "tags", "notes", "created_at"];
    const cell = (v) => {
      let s = Array.isArray(v) ? v.join("; ") : (v === null || v === undefined ? "" : String(v));
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // keep spreadsheets from treating it as a formula
      return '"' + s.replace(/"/g, '""') + '"';
    };
    const csv = [cols.join(",")].concat(contacts.map((c) => cols.map((k) => cell(c[k])).join(","))).join("\r\n");
    const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" }));
    const a = h("a", { href: url, download: "headwaters-contacts-" + today() + ".csv" });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function contactView(id) {
    const [c, followups, actions] = await Promise.all([api.contact(id), api.contactFollowups(id), api.contactActions(id)]).then((r) => r.map(ok));
    if (!c) { flash = { text: "That contact wasn't found.", err: true }; return go("#/contacts"); }

    const fuTitle = h("input", { id: "fu-title", name: "title", required: true, placeholder: "e.g. Send proposal" });
    const fuDue = h("input", { id: "fu-due", name: "due_on", type: "date", value: addDays(7) });
    const fuForm = h("form", {
      onsubmit: async (e) => {
        e.preventDefault();
        const d = formData(fuForm);
        busy(fuForm, true);
        try { ok(await db.from("followups").insert({ contact_id: id, title: d.title, due_on: d.due_on || null })); render(); }
        catch (err) { fail(err); }
      },
    }, h("div", { class: "row" },
      h("div", { class: "grow" }, field("New follow-up", fuTitle)),
      h("div", {}, field("Due", fuDue))),
      h("p", {}, h("button", { class: "btn", type: "submit" }, "Add follow-up")));

    const acKind = h("select", { id: "ac-kind", name: "kind" },
      ["call", "email", "meeting", "note", "other"].map((k) => h("option", { value: k }, k[0].toUpperCase() + k.slice(1))));
    const acDay = h("input", { id: "ac-day", name: "happened_on", type: "date", value: today(), required: true });
    const acSummary = h("textarea", { id: "ac-summary", name: "summary", required: true, placeholder: "What happened, what was agreed" });
    const acForm = h("form", {
      onsubmit: async (e) => {
        e.preventDefault();
        const d = formData(acForm);
        busy(acForm, true);
        try { ok(await db.from("actions").insert({ contact_id: id, kind: d.kind, happened_on: d.happened_on, summary: d.summary })); render(); }
        catch (err) { fail(err); }
      },
    }, h("div", { class: "grid2" }, field("Type", acKind), field("Date", acDay)),
      field("Summary", acSummary),
      h("p", {}, h("button", { class: "btn", type: "submit" }, "Log action")));

    const remove = (table, what) => async (row) => {
      if (!confirm("Delete this " + what + "?")) return;
      try { ok(await db.from(table).delete().eq("id", row.id)); render(); } catch (err) { fail(err); }
    };

    const detail = [];
    if (c.email) detail.push(h("div", {}, h("a", { href: "mailto:" + c.email }, c.email)));
    if (c.phone) detail.push(h("div", {}, h("a", { href: "tel:" + c.phone.replace(/[^\d+]/g, "") }, c.phone)));

    show(
      h("p", { class: "small" }, h("a", { href: "#/contacts" }, "← All contacts")),
      h("div", { class: "card" },
        h("div", { class: "row spread" },
          h("div", { class: "grow" },
            h("h1", {}, c.name),
            [c.title, c.company].some(Boolean) ? h("div", { class: "muted" }, [c.title, c.company].filter(Boolean).join(", ")) : null),
          h("div", { class: "row" },
            h("a", { class: "btn ghost", href: "#/contact/" + id + "/edit" }, "Edit"))),
        detail.length ? h("div", { class: "small" }, detail) : null,
        (c.tags || []).length ? h("div", {}, c.tags.map((t) => h("span", { class: "tag" }, t))) : null,
        c.notes ? h("p", { class: "notes" }, c.notes) : null),

      h("h2", {}, "Follow-ups"),
      h("div", { class: "card" },
        followups.length ? h("ul", { class: "items" }, followups.map((f) => followupItem(f, { onDelete: remove("followups", "follow-up") }))) : h("p", { class: "muted" }, "No follow-ups yet."),
        fuForm),

      h("h2", {}, "Actions log"),
      h("div", { class: "card" },
        acForm,
        actions.length ? h("ul", { class: "items" }, actions.map((a) => actionItem(a, { onDelete: remove("actions", "action") }))) : h("p", { class: "muted" }, "Nothing logged yet.")));
  }

  async function editView(id) {
    const c = id ? ok(await api.contact(id)) : {};
    if (id && !c) return go("#/contacts");
    const input = (name, label, attrs) => field(label, h("input", Object.assign({ id: "c-" + name, name, value: c[name] || "" }, attrs)));
    const notes = h("textarea", { id: "c-notes", name: "notes" });
    notes.value = c.notes || "";

    const form = h("form", {
      onsubmit: async (e) => {
        e.preventDefault();
        const d = formData(form);
        const row = {
          name: d.name,
          company: d.company || null,
          title: d.title || null,
          email: d.email || null,
          phone: d.phone || null,
          tags: d.tags ? Array.from(new Set(d.tags.split(",").map((t) => t.trim()).filter(Boolean))) : [],
          notes: d.notes || null,
        };
        busy(form, true);
        try {
          const saved = ok(id
            ? await db.from("contacts").update(row).eq("id", id).select("id").single()
            : await db.from("contacts").insert(row).select("id").single());
          go("#/contact/" + saved.id, id ? "Saved." : "Contact added.");
        } catch (err) { busy(form, false); fail(err); }
      },
    },
      input("name", "Name *", { required: true, autocomplete: "off" }),
      h("div", { class: "grid2" },
        input("company", "Company", { autocomplete: "off" }),
        input("title", "Role / title", { autocomplete: "off" }),
        input("email", "Email", { type: "email", autocomplete: "off" }),
        input("phone", "Phone", { type: "tel", autocomplete: "off" })),
      input("tags", "Tags (comma separated)", { value: (c.tags || []).join(", "), placeholder: "e.g. prospect, healthcare", autocomplete: "off" }),
      field("Notes", notes),
      h("p", { class: "row" },
        h("button", { class: "btn", type: "submit" }, id ? "Save" : "Add contact"),
        h("a", { class: "btn ghost", href: id ? "#/contact/" + id : "#/contacts" }, "Cancel")));

    const del = id ? h("p", {}, h("button", {
      type: "button", class: "btn danger",
      onclick: async () => {
        if (!confirm("Delete " + c.name + " and all their follow-ups and actions? This can't be undone.")) return;
        try { ok(await db.from("contacts").delete().eq("id", id)); go("#/contacts", "Contact deleted."); } catch (err) { fail(err); }
      },
    }, "Delete contact")) : null;

    show(h("h1", {}, id ? "Edit " + c.name : "New contact"), h("div", { class: "card" }, form), del);
    document.getElementById("c-name").focus();
  }

  // ---- routing ------------------------------------------------------------

  async function render() {
    if (!session) return signInView();
    nav.hidden = false;
    const parts = location.hash.replace(/^#\/?/, "").split("/");
    try {
      if (parts[0] === "contacts") await contactsView();
      else if (parts[0] === "new") await editView(null);
      else if (parts[0] === "contact" && parts[1] && parts[2] === "edit") await editView(parts[1]);
      else if (parts[0] === "contact" && parts[1]) await contactView(parts[1]);
      else await todayView();
    } catch (err) { fail(err); }
    window.scrollTo(0, 0);
  }

  async function start() {
    if (!cfg.supabaseUrl || !cfg.supabaseKey || !window.supabase) return notConfigured();

    // A failed or expired sign-in link comes back as #error=...
    let linkError = null;
    if (/^#error/.test(location.hash)) {
      const p = new URLSearchParams(location.hash.slice(1));
      linkError = p.get("error_code") === "otp_expired"
        ? "That sign-in link has expired or was already used. Request a new one below."
        : "That sign-in link didn't work. Request a new one below.";
      history.replaceState(null, "", location.pathname);
    }

    db = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "implicit" },
    });
    // Waits for the library to read a sign-in link's token from the URL, if any.
    session = ok(await db.auth.getSession()).session;

    db.auth.onAuthStateChange((event, s) => {
      const changed = !!s !== !!session;
      session = s;
      if (changed) setTimeout(render, 0);
    });
    document.getElementById("signout").addEventListener("click", async () => {
      await db.auth.signOut();
      session = null;
      history.replaceState(null, "", location.pathname);
      signInView();
    });
    window.addEventListener("hashchange", render);

    if (!session && linkError) return signInView(linkError);
    render();
  }

  start().catch(fail);
})();
