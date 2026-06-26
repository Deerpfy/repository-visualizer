# Vendored libraries

Every third-party dependency the visualizer needs is committed here. **No file in
this folder is fetched from the network at runtime** — the app loads them all from
`vendor/` over `file://`. If any file is missing, the app still starts and shows an
in-UI degraded-mode banner naming what's gone; restore the file(s) below to fix it.

All libraries are loaded as **classic UMD scripts** (they attach a global:
`window.vis`, `window.marked`, `window.DOMPurify`, `window.hljs`). This is
deliberate — ES-module `import` is blocked by browsers over `file://`, so classic
scripts are what make the tool work by double-clicking `index.html`.

## Pinned files & versions

| File | Library | Version | Source URL to re-download |
|------|---------|---------|---------------------------|
| `vis-network.min.js` | vis-network (graph) | 9.1.9 | https://cdn.jsdelivr.net/npm/vis-network@9.1.9/standalone/umd/vis-network.min.js |
| `marked.min.js` | marked (markdown) | 13.0.2 | https://cdn.jsdelivr.net/npm/marked@13.0.2/marked.min.js |
| `purify.min.js` | DOMPurify (sanitizer) | 3.1.6 | https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js |
| `highlight.min.js` | highlight.js (common build) | 11.10.0 | https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.10.0/highlight.min.js |
| `hljs-github-dark.min.css` | highlight.js theme (dark) | 11.10.0 | https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.10.0/styles/github-dark.min.css |
| `hljs-github.min.css` | highlight.js theme (light) | 11.10.0 | https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.10.0/styles/github.min.css |

### Extra highlight.js languages (`hljs-languages/`)

The highlight.js **common** build omits some languages the visualizer maps. These
small files each self-register against `window.hljs` and are loaded after the core:

`powershell, dockerfile, dos, scala, dart, fsharp, clojure, elixir, erlang, haskell, groovy, cmake`

Each is at: `https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.10.0/languages/<name>.min.js`

> `vis-network` needs no CSS for canvas rendering, so no `vis-network.min.css` is
> shipped (keeps the payload lean). Tooltips are drawn by the app itself.

## Re-vendoring (only needs network at build time, never at runtime)

From this `vendor/` directory:

```bash
V=9.1.9; curl -fsSL "https://cdn.jsdelivr.net/npm/vis-network@$V/standalone/umd/vis-network.min.js" -o vis-network.min.js
curl -fsSL "https://cdn.jsdelivr.net/npm/marked@13.0.2/marked.min.js" -o marked.min.js
curl -fsSL "https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js" -o purify.min.js
H=@highlightjs/cdn-assets@11.10.0
curl -fsSL "https://cdn.jsdelivr.net/npm/$H/highlight.min.js" -o highlight.min.js
curl -fsSL "https://cdn.jsdelivr.net/npm/$H/styles/github-dark.min.css" -o hljs-github-dark.min.css
curl -fsSL "https://cdn.jsdelivr.net/npm/$H/styles/github.min.css" -o hljs-github.min.css
mkdir -p hljs-languages
for L in powershell dockerfile dos scala dart fsharp clojure elixir erlang haskell groovy cmake; do
  curl -fsSL "https://cdn.jsdelivr.net/npm/$H/languages/$L.min.js" -o "hljs-languages/$L.min.js"
done
```

After re-vendoring, no further build step is required — just open `index.html`.
