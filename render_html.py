#!/usr/bin/env python3
"""Render SPEC.md -> spec.html — styled, mobile-first reading page.

Usage: python3 render_html.py
Then:  publish-link /home/omer/projects/rendezvous/spec.html rendezvous-spec-html
Re-run after any SPEC.md edit to refresh the live page.
"""
import pathlib
import re

import markdown

ROOT = pathlib.Path(__file__).parent
SRC = ROOT / "SPEC.md"
OUT = ROOT / "spec.html"

TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Rendezvous — Protocol Spec (Draft v0.1)</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='14' fill='%230a0a12'/><circle cx='22' cy='32' r='8' fill='%238b5cf6'/><circle cx='42' cy='32' r='8' fill='%238b5cf6'/><rect x='22' y='29' width='20' height='6' rx='3' fill='%238b5cf6'/></svg>">
<style>
:root{
  --bg:#0a0a12; --panel:#101020; --fg:#e8e8f2; --muted:#9c9cb4;
  --accent:#8b5cf6; --accent-soft:#a78bfa; --border:#23233a; --code:#14142a;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--fg);
  font:17px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  -webkit-text-size-adjust:100%;}
main{max-width:780px;margin:0 auto;padding:34px 20px 96px;}
header .chip{display:inline-block;font-size:12px;letter-spacing:.14em;text-transform:uppercase;
  color:var(--accent-soft);border:1px solid rgba(139,92,246,.45);border-radius:999px;
  padding:5px 12px;margin-bottom:18px;font-weight:600;}
h1{font-size:clamp(30px,8vw,40px);line-height:1.15;margin:0 0 8px;letter-spacing:-.01em;color:#fff;}
.sub{color:var(--muted);font-size:clamp(16px,4.4vw,19px);margin:0 0 14px;line-height:1.45;}
.meta{color:var(--muted);font-size:13.5px;margin:0;}
.meta a{color:var(--accent-soft);text-decoration:none;}
h2{font-size:clamp(21px,5.6vw,26px);line-height:1.25;margin:52px 0 14px;padding-top:30px;
  border-top:1px solid var(--border);letter-spacing:-.01em;}
h3{font-size:17.5px;margin:30px 0 10px;color:#f0f0fa;}
h4{font-size:16px;margin:24px 0 8px;color:#dcdcee;}
p{margin:0 0 16px;}
a{color:var(--accent-soft);}
strong{color:#fff;}
hr{border:0;border-top:1px solid var(--border);margin:40px 0;}
ul,ol{margin:0 0 16px;padding-left:22px;}
li{margin:6px 0;}
li>p{margin:0 0 8px;}
blockquote{margin:20px 0;padding:12px 16px;border-left:3px solid var(--accent);
  background:rgba(139,92,246,.07);border-radius:0 10px 10px 0;color:#d8d8e8;}
blockquote p:last-child{margin-bottom:0;}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.84em;
  background:var(--code);border:1px solid var(--border);border-radius:6px;padding:2px 6px;}
pre{background:var(--code);border:1px solid var(--border);border-radius:12px;
  padding:14px 16px;overflow-x:auto;margin:0 0 18px;}
pre code{background:none;border:0;padding:0;font-size:13.5px;line-height:1.55;}
.tablewrap{overflow-x:auto;margin:0 0 20px;border:1px solid var(--border);border-radius:12px;}
table{width:100%;border-collapse:collapse;font-size:14.5px;min-width:420px;}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--border);vertical-align:top;line-height:1.5;}
th{background:rgba(139,92,246,.08);color:#f0f0fa;font-weight:600;white-space:nowrap;}
tr:last-child td{border-bottom:0;}
.toc{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:6px 18px;margin:26px 0 10px;}
.toc summary{cursor:pointer;font-weight:600;color:#f0f0fa;padding:12px 0;font-size:15px;}
.toc ul{list-style:none;padding:0;margin:0 0 12px;}
.toc li{margin:0;}
.toc a{display:block;padding:9px 2px;border-bottom:1px solid rgba(35,35,58,.6);
  color:#cfcfe2;text-decoration:none;font-size:15px;}
.toc li:last-child a{border-bottom:0;}
.totop{position:fixed;right:16px;bottom:18px;width:42px;height:42px;border-radius:50%;
  background:rgba(139,92,246,.92);color:#fff;font-size:18px;line-height:1;
  display:grid;place-items:center;box-shadow:0 4px 16px rgba(0,0,0,.5);text-decoration:none;}
footer{margin-top:56px;padding-top:22px;border-top:1px solid var(--border);
  color:var(--muted);font-size:13.5px;line-height:1.7;}
</style>
</head>
<body>
<main>
<header>
  <div class="chip">Draft v0.1</div>
  <h1>Rendezvous</h1>
  <p class="sub">An Open Protocol for Agent-to-Agent Contact</p>
  <p class="meta">© Omer Nesher · October 2026 ·
    <a href="https://slides.nesher.co/rendezvous/">Pitch deck</a> ·
    <a href="https://<reading-page-host>/f/rendezvous-spec">Raw markdown</a></p>
</header>

<details class="toc" open>
  <summary>Contents</summary>
  %%TOC%%
</details>

%%BODY%%

<footer>
  Rendezvous — Draft v0.1 · Codename provisional ·
  raw markdown: <a href="https://<reading-page-host>/f/rendezvous-spec">/f/rendezvous-spec</a> ·
  deck: <a href="https://slides.nesher.co/rendezvous/">slides.nesher.co/rendezvous</a>
</footer>
</main>
<a class="totop" href="#" aria-label="Back to top">↑</a>
</body>
</html>
"""


def build_toc(md: markdown.Markdown) -> str:
    items = []
    for tok in md.toc_tokens:
        items.append(f'<li><a href="#{tok["id"]}">{tok["name"]}</a></li>')
    return "<ul>" + "".join(items) + "</ul>"


def main() -> None:
    src = SRC.read_text(encoding="utf-8")

    # Drop the leading title + subtitle (the page header carries them).
    src = re.sub(r"^# .+\n+", "", src, count=1)
    src = re.sub(r"^## An Open Protocol for Agent-to-Agent Contact\n+", "", src, count=1)

    # Header block: hard line breaks for Status/Author/Date lines.
    lines = src.splitlines()
    for i, ln in enumerate(lines[:6]):
        if re.match(r"^\*\*(Status|Author|Date):\*\*", ln):
            lines[i] = ln.rstrip() + "  "
    src = "\n".join(lines)

    md = markdown.Markdown(
        extensions=["extra", "toc", "sane_lists"],
        extension_configs={"toc": {"toc_depth": "2"}},
    )
    body = md.convert(src)
    body = body.replace("<table>", '<div class="tablewrap"><table>').replace(
        "</table>", "</table></div>"
    )

    html = (
        TEMPLATE.replace("%%TOC%%", build_toc(md))
        .replace("%%BODY%%", body)
    )
    OUT.write_text(html, encoding="utf-8")
    print(f"wrote {OUT} ({len(html):,} bytes)")


if __name__ == "__main__":
    main()
