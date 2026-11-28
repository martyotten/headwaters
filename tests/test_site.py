"""Checks for the Headwaters static site. Standard library only.

Run from the repo root:  python3 -m unittest discover -s tests -v
"""
import os
import re
import struct
import unittest
from html.parser import HTMLParser
from urllib.parse import urlparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGES = ["index.html", "privacy.html"]
SITE_URL = "https://headwatersadvisorymn.com/"
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link",
        "meta", "source", "track", "wbr"}
# Elements whose end tag the HTML spec lets you leave out.
OPTIONAL_END = {"p", "li", "dt", "dd", "option", "tr", "td", "th", "thead",
                "tbody", "tfoot", "colgroup", "optgroup", "rt", "rp"}
SVG_SELF_CLOSING = {"path", "circle", "rect", "line", "polyline", "polygon",
                    "ellipse", "use", "stop"}


class Page(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.elements = []   # (tag, attrs dict, line)
        self.errors = []
        self.stack = []
        self.ids = {}
        self.title = ""
        self._in_title = False
        self.doctype = None

    def handle_decl(self, decl):
        self.doctype = decl

    def _record(self, tag, attrs):
        a = dict(attrs)
        line = self.getpos()[0]
        self.elements.append((tag, a, line))
        if "id" in a:
            if a["id"] in self.ids:
                self.errors.append(f"line {line}: duplicate id '{a['id']}'")
            self.ids[a["id"]] = line
        return a

    def handle_starttag(self, tag, attrs):
        self._record(tag, attrs)
        if tag == "title":
            self._in_title = True
        if tag not in VOID:
            self.stack.append((tag, self.getpos()[0]))

    def handle_startendtag(self, tag, attrs):
        self._record(tag, attrs)
        if tag not in VOID and tag not in SVG_SELF_CLOSING:
            self.errors.append(f"line {self.getpos()[0]}: <{tag}/> is not a void element")

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        if tag in VOID:
            return
        while self.stack and self.stack[-1][0] != tag and self.stack[-1][0] in OPTIONAL_END:
            self.stack.pop()
        if self.stack and self.stack[-1][0] == tag:
            self.stack.pop()
        else:
            open_tag = self.stack[-1] if self.stack else None
            self.errors.append(
                f"line {self.getpos()[0]}: unexpected </{tag}>"
                + (f" (open <{open_tag[0]}> from line {open_tag[1]})" if open_tag else ""))

    def handle_data(self, data):
        if self._in_title:
            self.title += data

    def close(self):
        super().close()
        for tag, line in self.stack:
            if tag not in OPTIONAL_END and tag not in ("html", "body", "head"):
                self.errors.append(f"line {line}: <{tag}> never closed")

    def find(self, tag, **attrs):
        return [a for t, a, _ in self.elements if t == tag and
                all(a.get(k.replace("_", "-")) == v for k, v in attrs.items())]


def parse(name):
    p = Page()
    with open(os.path.join(ROOT, name), encoding="utf-8") as f:
        p.feed(f.read())
    p.close()
    return p


def local_target(ref):
    """Return the local file path a reference points to, or None if external."""
    u = urlparse(ref)
    if u.scheme in ("mailto", "tel", "data", "javascript"):
        return None
    if u.scheme in ("http", "https"):
        if not ref.startswith(SITE_URL):
            return None
        path = u.path.lstrip("/") or "index.html"
    else:
        path = u.path
        if not path:
            return None
    return os.path.join(ROOT, path)


class TestMarkup(unittest.TestCase):
    def test_pages_are_well_formed(self):
        for name in PAGES:
            with self.subTest(page=name):
                p = parse(name)
                self.assertEqual((p.doctype or "").lower(), "doctype html")
                self.assertEqual(p.errors, [])

    def test_head_basics(self):
        for name in PAGES:
            with self.subTest(page=name):
                p = parse(name)
                self.assertTrue(p.find("html") and p.find("html")[0].get("lang"), "missing <html lang>")
                self.assertTrue(p.find("meta", charset="utf-8"), "missing charset")
                self.assertTrue(p.find("meta", name="viewport"), "missing viewport")
                self.assertTrue(p.title.strip(), "missing <title>")
                desc = p.find("meta", name="description")
                self.assertTrue(desc and desc[0].get("content"), "missing meta description")
                self.assertTrue(p.find("link", rel="canonical"), "missing canonical link")
                self.assertTrue(p.find("link", rel="icon"), "missing favicon")

    def test_images_have_alt(self):
        for name in PAGES:
            for a in parse(name).find("img"):
                with self.subTest(page=name, src=a.get("src")):
                    self.assertIn("alt", a)


class TestSocialPreview(unittest.TestCase):
    def test_open_graph_and_twitter_tags(self):
        p = parse("index.html")
        props = {a.get("property"): a.get("content") for a in p.find("meta") if a.get("property")}
        names = {a.get("name"): a.get("content") for a in p.find("meta") if a.get("name")}
        for key in ("og:type", "og:title", "og:description", "og:url", "og:image"):
            self.assertTrue(props.get(key), f"missing {key}")
        for key in ("twitter:card", "twitter:title", "twitter:image"):
            self.assertTrue(names.get(key), f"missing {key}")
        self.assertTrue(props["og:image"].startswith("https://"), "og:image must be absolute")

    def test_og_image_matches_declared_size(self):
        p = parse("index.html")
        props = {a.get("property"): a.get("content") for a in p.find("meta") if a.get("property")}
        path = local_target(props["og:image"])
        self.assertTrue(os.path.isfile(path), f"{path} missing")
        with open(path, "rb") as f:
            head = f.read(24)
        self.assertEqual(head[:8], b"\x89PNG\r\n\x1a\n", "og image is not a PNG")
        w, h = struct.unpack(">II", head[16:24])
        self.assertEqual((str(w), str(h)), (props.get("og:image:width"), props.get("og:image:height")))


class TestContactForm(unittest.TestCase):
    """Netlify only detects a form when this markup is in the deployed HTML."""

    def setUp(self):
        self.page = parse("index.html")
        forms = self.page.find("form", name="contact")
        self.assertEqual(len(forms), 1, "expected exactly one form named 'contact'")
        self.form = forms[0]

    def test_netlify_attributes(self):
        self.assertEqual(self.form.get("data-netlify"), "true")
        self.assertEqual(self.form.get("method", "").upper(), "POST")
        self.assertEqual(self.form.get("netlify-honeypot"), "bot-field")

    def test_hidden_form_name_field(self):
        hidden = self.page.find("input", type="hidden", name="form-name")
        self.assertEqual(len(hidden), 1)
        self.assertEqual(hidden[0].get("value"), self.form["name"])

    def test_honeypot_field_exists(self):
        self.assertTrue(self.page.find("input", name="bot-field"))

    def test_expected_fields(self):
        fields = {a.get("name"): a for t, a, _ in self.page.elements
                  if t in ("input", "textarea", "select") and a.get("name")}
        for name in ("name", "email", "message"):
            self.assertIn(name, fields)
            self.assertIn("required", fields[name], f"{name} should be required")
        self.assertEqual(fields["email"].get("type"), "email")
        self.assertEqual(fields["phone"].get("type"), "tel")
        self.assertNotIn("required", fields["phone"], "phone should be optional")
        self.assertTrue(self.page.find("button", type="submit"))


class TestLinksAndAssets(unittest.TestCase):
    def test_local_references_resolve(self):
        for name in PAGES:
            p = parse(name)
            for tag, a, line in p.elements:
                for attr in ("href", "src"):
                    ref = a.get(attr)
                    if not ref or ref.startswith("#"):
                        continue
                    target = local_target(ref)
                    if target is None:
                        continue
                    with self.subTest(page=name, ref=ref, line=line):
                        self.assertTrue(os.path.isfile(target), f"{ref} not found")
                        frag = urlparse(ref).fragment
                        if frag and target.endswith(".html"):
                            self.assertIn(frag, parse(os.path.relpath(target, ROOT)).ids)

    def test_in_page_anchors_exist(self):
        for name in PAGES:
            p = parse(name)
            for tag, a, line in p.elements:
                ref = a.get("href", "")
                if ref.startswith("#") and len(ref) > 1:
                    with self.subTest(page=name, ref=ref, line=line):
                        self.assertIn(ref[1:], p.ids)

    def test_external_new_tab_links_are_safe(self):
        for name in PAGES:
            for a in parse(name).find("a", target="_blank"):
                with self.subTest(page=name, href=a.get("href")):
                    self.assertIn("noopener", a.get("rel", ""))

    def test_https_only(self):
        for name in PAGES:
            with open(os.path.join(ROOT, name), encoding="utf-8") as f:
                insecure = re.findall(r'(?:href|src)="(http://[^"]+)"', f.read())
            with self.subTest(page=name):
                self.assertEqual(insecure, [])


if __name__ == "__main__":
    unittest.main()
