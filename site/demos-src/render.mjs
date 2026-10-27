// Films every scene frame by frame and encodes WebM, MP4, a poster and (for README) a GIF.
//   PW_CORE=<path to playwright-core/index.mjs> CHROME=<chrome or msedge exe> node render.mjs [scene-id ...]
// Needs ffmpeg on PATH. Output: ../media/<id>.webm, .mp4 and -poster.jpg; for the README scenes, assets/demo-<id>.gif at the repo root.
import { createServer } from 'node:http';
import { readFile, mkdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, extname, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const site = resolve(here, '..');
const media = join(site, 'media');
const assets = resolve(site, '..', 'assets');
const FPS = 25;
const SCALE = 1.5; // 800x500 CSS px -> 1200x750 video
const GIF = { 'contact-email': true, 'dinner': true }; // the README GIFs
// Poster: a frame that explains the clip on its own (seconds after the title card).
const POSTER = { 'contact-email': 15.3, 'contact-id': 4.2, 'addresses-phone': 5.0, 'incoming': 5.6, 'dinner': 10.6, 'tasks-files': 12.9, 'group-chat': 24.0, 'scoped-grants': 9.6,'auto-approve': 11.4 };

const { chromium } = await import(process.env.PW_CORE ? pathToFileURL(process.env.PW_CORE).href : 'playwright-core');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
const server = createServer(async (req, res) => {
  const path = join(site, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!path.startsWith(site)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' }).end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/demos-src/index.html`;

function ff(args) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('ffmpeg failed: ' + args.join(' '));
}

const browser = await chromium.launch({ executablePath: process.env.CHROME });
const page = await browser.newPage({ viewport: { width: 800, height: 500 }, deviceScaleFactor: SCALE });
await mkdir(media, { recursive: true });
await page.goto(base + '?capture=1');
const all = await page.evaluate(() => window.RDV_SCENES.map((s) => s.id));
const want = process.argv.slice(2).length ? process.argv.slice(2) : all;

for (const id of want) {
  await page.goto(`${base}?scene=${id}&capture=1`);
  await page.evaluate(() => document.fonts.ready);
  const { duration, T0 } = await page.evaluate(() => ({ duration: window.sceneDuration, T0: window.RDV.T0 }));
  const dir = join(tmpdir(), 'rdv-frames-' + id);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const n = Math.round(duration * FPS);
  const stage = page.locator('.stage');
  for (let i = 0; i < n; i++) {
    await page.evaluate((t) => window.seek(t), i / FPS);
    await stage.screenshot({ path: join(dir, `f${String(i).padStart(5, '0')}.png`) });
  }
  await page.evaluate((t) => window.seek(t), T0 + POSTER[id]);
  await stage.screenshot({ path: join(dir, 'poster.png') });
  const frames = join(dir, 'f%05d.png');
  const out = (ext) => join(media, `${id}${ext}`);
  ff(['-framerate', String(FPS), '-i', frames, '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '45', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', '-pix_fmt', 'yuv420p', '-an', out('.webm')]);
  ff(['-framerate', String(FPS), '-i', frames, '-c:v', 'libx264', '-crf', '31', '-preset', 'slow', '-tune', 'animation', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', out('.mp4')]);
  ff(['-i', join(dir, 'poster.png'), '-q:v', '7', out('-poster.jpg')]);
  if (GIF[id]) {
    const pal = join(dir, 'palette.png');
    const vf = 'fps=12,scale=640:-1:flags=lanczos';
    ff(['-framerate', String(FPS), '-i', frames, '-vf', `${vf},palettegen=max_colors=96:stats_mode=diff`, pal]);
    ff(['-framerate', String(FPS), '-i', frames, '-i', pal, '-lavfi', `${vf}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, '-loop', '0', join(assets, `demo-${id}.gif`)]);
  }
  await rm(dir, { recursive: true, force: true });
  console.log(`${id}: ${n} frames, ${duration.toFixed(1)} s`);
}
await browser.close();
server.close();
