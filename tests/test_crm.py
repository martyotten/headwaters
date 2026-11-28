"""Checks for the private CRM page (crm/) and its database setup. Standard library only.

The repo is public, so these guard the things that keep contact data private:
no secret keys in the page, row-level security on every table, and the page
kept out of search engines.
"""
import base64
import json
import os
import re
import unittest

from test_site import ROOT, parse

CRM = os.path.join(ROOT, "crm")


def read(*parts):
    with open(os.path.join(ROOT, *parts), encoding="utf-8") as f:
        return f.read()


def config_values():
    src = read("crm", "config.js")
    url = re.search(r'supabaseUrl:\s*"([^"]*)"', src)
    key = re.search(r'supabaseKey:\s*"([^"]*)"', src)
    assert url and key, "config.js must define supabaseUrl and supabaseKey as strings"
    return url.group(1), key.group(1)


def headers_for(path):
    """Parse Netlify's _headers file into {path: {header: value}}."""
    rules, current = {}, None
    for line in read("_headers").splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if not line[0].isspace():
            current = rules.setdefault(line.strip(), {})
        elif current is not None and ":" in line:
            k, v = line.strip().split(":", 1)
            current[k.strip().lower()] = v.strip()
    return rules.get(path, {})


class TestCrmPage(unittest.TestCase):
    def setUp(self):
        self.page = parse(os.path.join("crm", "index.html"))

    def test_well_formed(self):
        self.assertEqual((self.page.doctype or "").lower(), "doctype html")
        self.assertEqual(self.page.errors, [])
        self.assertTrue(self.page.title.strip())

    def test_kept_out_of_search_engines(self):
        robots = self.page.find("meta", name="robots")
        self.assertTrue(robots and "noindex" in robots[0].get("content", ""))

    def test_not_linked_from_public_pages(self):
        for name in ("index.html", "privacy.html"):
            with self.subTest(page=name):
                self.assertNotIn("/crm", read(name))

    def test_assets_exist_and_scripts_are_local(self):
        for tag, a, _ in self.page.elements:
            ref = a.get("src") or (a.get("href") if tag == "link" else None)
            if not ref:
                continue
            with self.subTest(ref=ref):
                self.assertTrue(ref.startswith("/"), "use local, root-relative assets so the CSP allows them")
                self.assertTrue(os.path.isfile(os.path.join(ROOT, ref.lstrip("/"))), f"{ref} not found")

    def test_no_inline_scripts_or_styles(self):
        # The CSP in _headers allows only same-origin scripts and styles.
        html = read("crm", "index.html")
        self.assertIsNone(re.search(r"<script(?![^>]*\bsrc=)[^>]*>", html), "inline <script> would be blocked")
        self.assertNotIn("<style", html)
        self.assertIsNone(re.search(r'\sstyle="', html))
        self.assertIsNone(re.search(r'\son[a-z]+="', html), "inline event handlers would be blocked")

    def test_app_never_injects_html(self):
        js = read("crm", "app.js")
        for pattern in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval("):
            with self.subTest(pattern=pattern):
                self.assertNotIn(pattern, js)

    def test_sign_in_cannot_create_accounts(self):
        self.assertIn("shouldCreateUser: false", read("crm", "app.js"))


class TestCrmConfig(unittest.TestCase):
    def test_only_a_public_key_is_committed(self):
        url, key = config_values()
        if url:
            self.assertRegex(url, r"^https://[a-z0-9]+\.supabase\.co$")
        if not key:
            return
        self.assertFalse(key.startswith("sb_secret_"), "never commit the secret key")
        if key.startswith("sb_publishable_"):
            return
        parts = key.split(".")
        self.assertEqual(len(parts), 3, "key should be a publishable key or the legacy anon JWT")
        payload = json.loads(base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4)))
        self.assertEqual(payload.get("role"), "anon", "only the anon key may be committed")

    def test_no_secrets_anywhere_in_crm(self):
        dirs = [CRM, os.path.join(ROOT, "netlify")]
        for dirpath, _, files in (w for d in dirs for w in os.walk(d)):
            for name in files:
                if "vendor" in dirpath:
                    continue
                with self.subTest(file=name):
                    text = read(os.path.relpath(os.path.join(dirpath, name), ROOT))
                    self.assertIsNone(re.search(r"sb_secret_[A-Za-z0-9_-]{8,}", text), "secret key found")
                    for jwt in re.findall(r"eyJ[A-Za-z0-9_-]+\.(eyJ[A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+", text):
                        payload = json.loads(base64.urlsafe_b64decode(jwt + "=" * (-len(jwt) % 4)))
                        self.assertNotEqual(payload.get("role"), "service_role", "service_role key found")


class TestFormFunction(unittest.TestCase):
    def test_secret_key_comes_from_environment(self):
        src = read("netlify", "functions", "submission-created.js")
        for var in ("SUPABASE_URL", "SUPABASE_SECRET_KEY", "CRM_OWNER_ID"):
            self.assertIn(var, src)
        self.assertIn("process.env", src)


class TestHeaders(unittest.TestCase):
    def test_crm_paths_have_private_headers(self):
        for path in ("/crm", "/crm/*"):
            h = headers_for(path)
            with self.subTest(path=path):
                self.assertIn("noindex", h.get("x-robots-tag", ""))
                self.assertEqual(h.get("cache-control"), "no-store")
                csp = h.get("content-security-policy", "")
                self.assertIn("script-src 'self'", csp)
                self.assertIn("frame-ancestors 'none'", csp)
                self.assertNotIn("unsafe-inline", csp)
                self.assertNotIn("unsafe-eval", csp)


class TestDatabaseSetup(unittest.TestCase):
    def setUp(self):
        self.sql = read("supabase", "setup.sql")
        self.tables = re.findall(r"create table if not exists public\.(\w+)", self.sql)

    def test_expected_tables(self):
        self.assertEqual(sorted(self.tables), ["actions", "contacts", "followups"])

    def test_every_table_is_locked_to_its_owner(self):
        for t in self.tables:
            with self.subTest(table=t):
                self.assertRegex(self.sql, rf"alter table public\.{t}\s+enable row level security")
                self.assertRegex(self.sql, rf"alter table public\.{t}\s+force row level security")
                policy = re.search(rf'create policy "[^"]+" on public\.{t}\b(.*?);', self.sql, re.S)
                self.assertTrue(policy, f"no policy on {t}")
                body = policy.group(1)
                self.assertIn("to authenticated", body)
                self.assertIn("using (owner_id = (select auth.uid()))", body)
                self.assertIn("with check", body)
                table_def = re.search(rf"create table if not exists public\.{t} \((.*?)\n\);", self.sql, re.S).group(1)
                self.assertRegex(table_def, r"owner_id\s+uuid not null default auth\.uid\(\)")

    def test_anonymous_visitors_get_nothing(self):
        self.assertIn("revoke all on public.contacts, public.followups, public.actions from anon", self.sql)
        self.assertNotRegex(self.sql, r"grant [^;]* to anon")
        self.assertNotRegex(self.sql, r"using \(\s*true\s*\)")


if __name__ == "__main__":
    unittest.main()
