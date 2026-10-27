// The Rendezvous mark for the gateway's pages. The mark is inline SVG (no
// request, no CSP change) coloured by classes in the same-origin stylesheet,
// since the page CSP forbids inline styles. The favicon is the site's file,
// served by the gateway at /favicon.svg.

const MARK_PATHS =
  '<path class="mk-a" d="M18.98 27.11A11.5 11.5 0 0 1 4.89 13.02"/><path class="mk-a" d="M13.02 4.89A11.5 11.5 0 0 1 27.11 18.98"/>' +
  '<path class="mk-d" d="M16 10.6Q16.6 10.6 17 11L21 15Q21.4 15.4 21.4 16Q21.4 16.6 21 17L17 21Q16.6 21.4 16 21.4Q15.4 21.4 15 21L11 17Q10.6 16.6 10.6 16Q10.6 15.4 11 15L15 11Q15.4 10.6 16 10.6Z"/>';

/** The header every gateway page starts with: the mark and the wordmark. */
export const BRAND_HEADER =
  `<header class="site-header"><span class="brand"><svg class="mark" viewBox="0 0 32 32" role="img" aria-labelledby="rdv-logo-title" focusable="false"><title id="rdv-logo-title">Rendezvous</title>${MARK_PATHS}</svg>` +
  '<span class="brand-word">rendezvous</span></span></header>';

export const BRAND_CSS = `
.site-header{border-bottom:1px solid var(--line);background:var(--bg)}.brand{display:flex;align-items:center;gap:10px;max-width:760px;margin:0 auto;padding:12px 16px;color:var(--fg)}
.brand .mark{width:30px;height:30px;flex:none;--mk-a:#2b3290;--mk-d:#3f7fe0}.brand-word{font-weight:600;font-size:1.2rem;letter-spacing:-.02em}
@media (prefers-color-scheme:dark){.brand .mark{--mk-a:#c7cffd;--mk-d:#7fb0ff}}
.mark .mk-a{fill:none;stroke:var(--mk-a);stroke-width:4.6;stroke-linecap:round}.mark .mk-d{fill:var(--mk-d)}`;

/** The site's favicon: a standalone document, so its own style block is fine. */
export const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="Rendezvous"><style>.a{stroke:#2b3290}.d{fill:#3f7fe0}@media (prefers-color-scheme:dark){.a{stroke:#c7cffd}.d{fill:#7fb0ff}}</style>' +
  '<path class="a" d="M18.98 27.11A11.5 11.5 0 0 1 4.89 13.02" fill="none" stroke-width="4.6" stroke-linecap="round"/><path class="a" d="M13.02 4.89A11.5 11.5 0 0 1 27.11 18.98" fill="none" stroke-width="4.6" stroke-linecap="round"/>' +
  '<path class="d" d="M16 10.6Q16.6 10.6 17 11L21 15Q21.4 15.4 21.4 16Q21.4 16.6 21 17L17 21Q16.6 21.4 16 21.4Q15.4 21.4 15 21L11 17Q10.6 16.6 10.6 16Q10.6 15.4 11 15L15 11Q15.4 10.6 16 10.6Z"/></svg>';
