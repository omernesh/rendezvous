// The static site in site/: the generated docs are not stale, llms.txt points at files
// that exist, nothing runs inline or loads from a third party (the CSP would block it),
// and every internal link and anchor resolves.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(import.meta.dirname, '..', '..', '..', '..');
const SITE = join(REPO, 'site');
const ORIGIN = 'https://rendezvous.nesher.co';
const GITHUB = 'https://github.com/';
const text = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

/** Every file under a directory, as paths relative to it with forward slashes. */
function walk(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p, base) : [relative(base, p).split('\\').join('/')];
  });
}

const FILES = walk(SITE);
const PAGES = FILES.filter((f) => f.endsWith('.html'));

// ---- build_docs.py --check ------------------------------------------------

/** The first of `python` / `python3` that can import `markdown`, or why there is none. */
function findPython(): { cmd: string } | { reason: string } {
  let reason = 'python is not installed';
  for (const cmd of ['python', 'python3']) {
    const r = spawnSync(cmd, ['-c', 'import markdown'], { encoding: 'utf8' });
    if (r.error) continue;
    if (r.status === 0) return { cmd };
    reason = `the Python package "markdown" is missing for ${cmd} (pip install markdown)`;
  }
  return { reason };
}
const py = findPython();
const skip = 'reason' in py ? py.reason : null;

describe('generated docs', () => {
  it.skipIf(skip !== null)(`site/build_docs.py --check finds no stale output${skip ? ` (SKIPPED: ${skip})` : ''}`, () => {
    if ('reason' in py) return;
    const r = spawnSync(py.cmd, [join(SITE, 'build_docs.py'), '--check'], { encoding: 'utf8', cwd: REPO });
    expect(r.stderr + r.stdout, 'run: python site/build_docs.py, then commit the result').toMatch(/up to date/);
    expect(r.status).toBe(0);
  });

  it('every docs page has its markdown twin and is linked from the docs index', () => {
    const index = text(join(SITE, 'docs', 'index.html'));
    const slugs = FILES.filter((f) => /^docs\/[a-z-]+\.md$/.test(f)).map((f) => f.slice(5, -3));
    expect(slugs.length).toBeGreaterThanOrEqual(6);
    for (const s of slugs) {
      expect(existsSync(join(SITE, 'docs', `${s}.html`)), `${s}.html`).toBe(true);
      expect(index, s).toContain(`href="/docs/${s}.html"`);
    }
  });
});

// ---- llms.txt ---------------------------------------------------------------

/** Map a rendezvous.nesher.co URL to the file nginx would serve for it, or null if it is not ours. */
function localFile(url: string): string | null {
  if (!url.startsWith(ORIGIN) || !/^$|[/?#]/.test(url.slice(ORIGIN.length, ORIGIN.length + 1))) return null;
  let path = url.slice(ORIGIN.length).replace(/[?#].*$/, '');
  if (path === '' || path.endsWith('/')) path += 'index.html';
  return path.replace(/^\//, '');
}

describe('llms.txt', () => {
  const llms = text(join(SITE, 'llms.txt'));
  const links = [...llms.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);

  it('follows the llmstxt.org shape: H1, blockquote summary, H2 sections of links', () => {
    const lines = llms.split('\n');
    expect(lines[0]).toMatch(/^# \S/);
    expect(lines.slice(1).find((l) => l.trim() !== '')).toMatch(/^> \S/);
    const h2 = lines.filter((l) => l.startsWith('## ')).map((l) => l.slice(3));
    expect(h2).toEqual(['Docs', 'Spec', 'Setup for agents', 'Optional']);
    for (const l of lines.filter((l) => l.startsWith('- '))) expect(l).toMatch(/^- \[[^\]]+\]\([^)]+\)(: .+)?$/);
  });

  it('every link is an absolute site URL that resolves to a file in site/, or a GitHub link', () => {
    expect(links.length).toBeGreaterThan(8);
    for (const url of links) {
      const file = localFile(url);
      if (file === null) {
        expect(url, 'only github.com links may leave the site').toMatch(/^https:\/\/github\.com\/omernesh\/rendezvous/);
      } else {
        expect(FILES, url).toContain(file);
      }
    }
  });

  it('llms-full.txt stays under 400 KB and says what it includes', () => {
    const p = join(SITE, 'llms-full.txt');
    expect(statSync(p).size).toBeLessThan(400 * 1024);
    const full = text(p);
    expect(full).toMatch(/^# /);
    expect(full).toMatch(/Included, in order:/);
    for (const slug of ['agents', 'plugin', 'cli', 'mcp', 'spec', 'contributing']) {
      expect(full, slug).toContain(`Source: ${ORIGIN}/docs/${slug}.md`);
    }
  });

  it('nginx serves .txt as text/plain and .md as text/markdown, both with a charset', () => {
    const conf = text(join(REPO, 'impl', 'deploy', 'site', 'nginx.conf'));
    expect(conf).toMatch(/text\/plain\s+txt;/);
    expect(conf).toMatch(/text\/markdown\s+md;/);
    expect(conf).toMatch(/charset_types[^;]*text\/plain[^;]*text\/markdown/);
    expect(text(join(SITE, 'robots.txt'))).toContain('llms.txt');
  });
});

// ---- CSP: no inline code, nothing third-party -------------------------------

/** Vendor documentation hosts the agent setup docs link to. Plain <a href> links only. */
const DOC_HOSTS = new Set([
  'cursor.com',
  'code.claude.com',
  'code.visualstudio.com',
  'developers.openai.com',
  'docs.devin.ai',
  'docs.openclaw.ai',
  'docs.x.ai',
  'geminicli.com',
  'hermes-agent.nousresearch.com',
  'modelcontextprotocol.io',
]);

describe('site CSP', () => {
  const headers = text(join(REPO, 'impl', 'deploy', 'site', 'security-headers.conf'));

  it('the policy still allows scripts and styles from the site only', () => {
    const csp = headers.match(/Content-Security-Policy "([^"]+)"/)?.[1] ?? '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
  });

  it.each(PAGES)('%s has no inline script, style or event handler', (page) => {
    const html = text(join(SITE, page));
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      expect(m[1], `${page}: <script> without src`).toMatch(/\bsrc="[^"]+"/);
      expect(m[2].trim(), `${page}: inline script body`).toBe('');
    }
    expect(html, `${page}: <style> block`).not.toMatch(/<style\b/i);
    expect(html, `${page}: style attribute`).not.toMatch(/<[a-z][^>]*\sstyle\s*=/i);
    expect(html, `${page}: inline event handler`).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
    expect(html, `${page}: javascript: URL`).not.toMatch(/(?:href|src)\s*=\s*"\s*javascript:/i);
  });

  it.each(PAGES)('%s loads nothing from a third party, and links out only to GitHub or vendor docs', (page) => {
    const html = text(join(SITE, page));
    for (const m of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*?\s(src|href|srcset|poster|action)="([^"]*)"/gi)) {
      const [, tag, attr, value] = m;
      if (!/^(https?:)?\/\//i.test(value)) continue; // relative, root-relative, #, mailto:, data:
      if (value.startsWith(ORIGIN)) continue; // our own absolute URLs (canonical, og:image)
      const isLink = tag.toLowerCase() === 'a' && attr === 'href';
      expect(isLink, `${page}: <${tag} ${attr}="${value}"> loads from another origin`).toBe(true);
      const host = new URL(value).hostname;
      const ok = value.startsWith(GITHUB) || DOC_HOSTS.has(host);
      expect(ok, `${page}: link to ${host} (allowed: GitHub and the vendor docs listed in site.test.ts)`).toBe(true);
    }
  });

  it('stylesheets and scripts pull in nothing from elsewhere', () => {
    for (const f of FILES.filter((f) => /\.(css|js)$/.test(f))) {
      const src = text(join(SITE, f));
      expect(src, `${f}: @import`).not.toMatch(/@import/);
      expect(src, `${f}: external url()`).not.toMatch(/url\(\s*['"]?(https?:)?\/\//i);
      expect(src, `${f}: network call`).not.toMatch(/\b(fetch\s*\(|new\s+(XMLHttpRequest|WebSocket|EventSource)\b|sendBeacon\s*\()/);
    }
  });
});

// ---- links ------------------------------------------------------------------

describe('internal links', () => {
  const ids = new Map<string, Set<string>>();
  for (const p of PAGES) ids.set(p, new Set([...text(join(SITE, p)).matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));

  /** Resolve an internal URL to a file in site/ (root-relative, or relative to the page). */
  function target(page: string, value: string): { file: string; frag: string } | null {
    if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(value)) {
      const f = localFile(value);
      return f === null ? null : { file: f, frag: value.split('#')[1] ?? '' };
    }
    const [path, frag = ''] = value.split('#');
    const q = path.replace(/\?.*$/, '');
    let file: string;
    if (q === '') file = page;
    else if (q.startsWith('/')) file = q.slice(1);
    else file = join(page.split('/').slice(0, -1).join('/'), q).split('\\').join('/');
    if (file === '' || file.endsWith('/')) file += 'index.html';
    return { file, frag };
  }

  it.each(PAGES)('%s: every internal link and #anchor resolves', (page) => {
    const html = text(join(SITE, page));
    for (const m of html.matchAll(/<(?:a|link|script|img)\b[^>]*?\s(?:href|src)="([^"]*)"/gi)) {
      const t = target(page, m[1]);
      if (!t || /^(mailto|data):/i.test(m[1])) continue;
      expect(FILES, `${page}: ${m[1]}`).toContain(t.file);
      if (t.frag && t.file.endsWith('.html')) {
        expect(ids.get(t.file)?.has(t.frag), `${page}: ${m[1]} (no id "${t.frag}" in ${t.file})`).toBe(true);
      }
    }
  });
});
