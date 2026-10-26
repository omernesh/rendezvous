# Demo clips

The "See it in action" clips on the site and the GIFs in the top-level README are
rendered from these files. Each scene is an HTML/CSS stage (800 × 500 CSS px)
driven by a deterministic timeline, filmed frame by frame and encoded with ffmpeg.

| File | What it is |
|---|---|
| `scenes.js` | The scripts: who types what, which tool runs, which form opens, when. |
| `engine.js` | The timeline: `seek(t)` rebuilds the stage for time `t`, so every frame is exact. |
| `demo.css` | The look: a neutral agent chat window, approval forms, terminal, relay lane. |
| `index.html` + `preview.js` | Preview in a browser: `index.html?scene=dinner` plays live, `&t=12` freezes at 12 s after the title card. |
| `render.mjs` | Films every scene and writes `../media/<id>.webm`, `.mp4` and `-poster.jpg`, plus `assets/demo-<id>.gif` for the README scenes. |

## Keep it true

Every tool name, argument, form title and checkbox label is the real one from
`rdv-mcp` (`impl/packages/mcp/src/server.ts`) or the `rdv` CLI. Before changing a
scene, check the flow still exists, and don't depict anything that is not built.
Use only the anonymized personas: Omer (`omer@example.com`) and John
(`john@doe.com`), with `+1555…` phone numbers; the group clip adds Dana
(`dana@example.com`). The fingerprints are the ones of the fixed test keys in
`impl/packages/core/vectors/v1.json` (seeds `0x11…` Omer, `0x22…` John); Dana's is
the key of seed `0x33…`, the next one in that series. The `trio` layout (three
agents side by side, the relay as a strip underneath) is for the group clip.

## Re-render

Needs Node 20+, ffmpeg on `PATH` and a Chrome or Edge install. Playwright stays
out of the repo: install `playwright-core` in any scratch folder and point
`render.mjs` at it.

```bash
# in a scratch folder outside the repo
npm i playwright-core
# from the repo root (bash; in PowerShell use $env:PW_CORE='…'; $env:CHROME='…')
PW_CORE=/path/to/scratch/node_modules/playwright-core/index.mjs \
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe" \
node site/demos-src/render.mjs            # all scenes; add scene ids (e.g. dinner) for just those
```

The README GIFs land in `assets/demo-<id>.gif` (scenes listed in `GIF` in `render.mjs`).
Keep each GIF under about 2 MB and the whole `site/media` folder under about 10 MB.
