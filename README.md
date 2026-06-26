---
title: Repository Visualizer
version: 1.2.0
last_updated: 2026-06-26
status: stable
---

# Repository Visualizer

A **single-page** tool that browses every file in a repository and draws a
force-directed *spider-web* graph of its folder/file hierarchy. Click any file to
render its contents (markdown, source code, text, images). Point it at a **local
folder** or a **GitHub repo URL**.

It runs by **opening `index.html` in a browser** — no server, no install, no build
step. The whole `docs/visualizer/` folder is self-contained and copy-paste portable:
drop it into any repo, or **host it as a static page** so anyone can use it.

The local folder path is **fully offline** (zero network requests). The optional
*Load from URL* feature is the only part that uses the network, and only when you
use it.

---

## Quick start

1. Open `docs/visualizer/index.html` in a modern browser (double-click it, or drag
   it onto a browser window — `file://` is fine).
2. Click **Open Folder** and pick the repository's root folder.
3. The file list and graph populate instantly (metadata only). Click any file to
   view it; press **`/`** to jump to the filter.

> Nothing is uploaded anywhere. File contents are read locally, in your browser,
> only when you click a file.

## Browser support

| Browser | Open Folder (Tier 1) | Persistent reopen / snapshot save (Tier 2) | Auto-load snapshot (Tier 3) |
|---------|:--:|:--:|:--:|
| Chrome / Edge (Chromium) | ✅ | ✅ File System Access API | ✅* |
| Firefox | ✅ | — (falls back to download) | ✅* |
| Safari | ✅ | — (falls back to download) | ✅* |

\* Auto-loading `data/index.json` over `file://` works in some browsers and is
blocked by others' security policy. When it's blocked, the **Open Folder** picker
is always available — the app never depends on it.

Everything degrades gracefully: Chromium-only capabilities are progressive
enhancements, never requirements.

## How it works — the 3-tier read model

Browsers forbid a bare `file://` page from enumerating a directory or fetching
arbitrary sibling files. The tool is designed *around* that, not against it:

- **Tier 1 — Directory picker (primary, universal).** An
  `<input type="file" webkitdirectory>` lets you pick the repo root. Works in every
  modern browser over `file://`. The app enumerates paths + sizes up front (fast,
  **no content read**) and reads a file's bytes **only when you click it**.
- **Tier 2 — File System Access API (enhancement, Chromium only).** When available,
  the folder handle is remembered in IndexedDB so you can **Reopen** it next session
  without re-picking, and **Export snapshot** can write straight to a file. Feature-
  detected; silently falls back to Tier 1 when absent or denied.
- **Tier 3 — Snapshot (static fallback).** On load the app tries to read
  `data/index.json`. If present (and your browser allows the read), it opens with
  zero interaction — useful for sharing the visualizer as a static page. The
  snapshot is generated **by the app itself**, in-browser (see below).
- **Tier 4 — Remote git URL (opt-in, networked).** Paste a GitHub repo link and the
  app fetches its full file tree from the GitHub API (one request) and reads file
  contents on click from `raw.githubusercontent.com`. Works locally and when hosted.
  This is the only feature that touches the network.

## Features

- Virtualized file tree (smooth at tens of thousands of files), collapsible folders.
- Debounced filter over the full path, clickable **extension chips**, and
  independent **noise toggles** (`.git`/tooling, `node_modules`, build output,
  dotfiles, binaries) — hidden by default, each switchable, with a live match count.
- Spider graph (vis-network): folder→file containment edges, color/size by type,
  collapse/expand folders, **Expand all** (expands every folder at once),
  click-to-open, hover for full path, a **node cap** with expand-on-demand for huge
  repos, and **Fit graph** to reframe.
- **Graph screenshot** → save the graph as a PNG at a chosen resolution
  (Current size, 720p, 1080p, 1440p, 4K, 5K, 8K, 12K, up to **16K**). It re-renders
  the graph off-screen at the target resolution, so high-res exports stay crisp
  rather than upscaled — pick a higher resolution when you need node names to be
  legible on a large project.
- Optional **reference overlay** (off by default): parses `import` / `require` /
  `#include` / `from … import` and overlays code-reference edges. It reads file
  contents, so it runs only when toggled on and never blocks core load.
- Content rendering: markdown (sanitized), syntax-highlighted source across a wide
  language map, plain text as monospace, images inline, binary/oversized as a
  metadata-only panel with **Load anyway**.
- **Load from URL** → browse any GitHub repo by link (no clone), with optional token
  for private repos / higher rate limits.
- Dark / light / auto theme, full keyboard navigation, copy-path.

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `/` | Focus the filter |
| `Esc` | Clear filter (when focused) |
| `↑` / `↓` | Move selection in the file tree |
| `←` / `→` | Collapse / expand the focused folder |
| `Enter` / `Space` | Open file / toggle folder |
| `Home` / `End`, `PgUp` / `PgDn` | Jump within the tree |

## Caps & limits

- **Auto-render size cap: 2 MB.** Larger files show a metadata panel with a **Load
  anyway** button (forced text views are truncated to 512 KB to stay responsive).
- **Binary files** (by extension or detected null bytes) show metadata only, with a
  **Load anyway (as text)** option.
- **Graph node cap: 1500** (configurable in `js/state.js`). Beyond it, deeper
  folders stay collapsed and expand on click.
- These defaults live in `js/state.js` (`settings`) and `js/classify.js`.

## Export / refresh a snapshot

Click **Export snapshot**. The app serializes the file index to `index.json`
(optionally inlining small text files when **Inline** is checked, so a shared
snapshot can render content). In Chromium it writes via a save dialog; elsewhere it
downloads. Put the file at `docs/visualizer/data/index.json`, and next time the page
loads it will try to auto-open from that snapshot.

## Graph screenshot

Pick a resolution from the dropdown next to **Screenshot** (Current size = the panel
at device-pixel scale, or a preset up to **12K**) and click **Screenshot** to
download a PNG of the current graph. The image is produced by re-rendering the graph
(with its current layout and any reference-overlay edges) off-screen at the exact
target resolution, then encoding to PNG — so a 12K export is sharp, not an upscaled
screenshot, and node names stay readable when you zoom in. The background uses the
active theme's graph color.

> Very high resolutions use a lot of memory while encoding. 12K (≈75 MP) and 16K
> (≈133 MP) work on a typical desktop browser; 16K (15360×8640) is near the browser's
> hard per-side canvas limit (16384px). If a size exceeds what your browser supports
> the app reports it and you can pick a smaller one. **Tip:** combine a high
> resolution with **Expand all** to capture every labeled node in one readable image.

## Load a GitHub repo by URL

Paste a repository link into the **Load from URL** box in the sidebar and press
**Load** (or Enter). Accepted forms:

```
github.com/owner/repo
https://github.com/owner/repo
https://github.com/owner/repo/tree/<branch>
owner/repo
```

The app fetches the whole file tree from the GitHub API in one request, then loads
file contents on click from `raw.githubusercontent.com`. It works the same whether
you opened `index.html` locally or it's hosted — GitHub allows these cross-origin
reads. Everything downstream (filter, graph, viewer, screenshot, snapshot) behaves
exactly as it does for a local folder.

- **Public repos** need no setup.
- **Private repos / rate limits:** open **Private repo / token**, paste a GitHub
  personal access token (a fine-grained token with read-only "Contents" access is
  enough). Without a token, unauthenticated GitHub API calls are limited to ~60/hour;
  a token raises that to 5000/hour. Tick **Remember in this browser** to keep it in
  this browser's local storage (it's used only for GitHub calls, never sent elsewhere
  or committed); use **Clear** to remove it.
- **Very large repos:** GitHub truncates trees beyond ~100k entries; the app loads
  what it returns and tells you it was truncated.

## Host it publicly (GitHub Pages)

The tool is static, so anyone can use it from a public URL — they just open the page
and **Open Folder** (or **Load from URL**) to see the same structure as local. Over
`https://`, the folder picker, File System Access, and snapshot auto-load all work
(snapshot fetch actually works *better* than over `file://`).

A ready-to-use workflow is included at
[`deploy/github-pages.yml`](deploy/github-pages.yml):

1. **Either** put the tool in its own repo (copy the contents of `docs/visualizer/`
   to the repo root), **or** keep it at `docs/visualizer/` inside a larger repo.
2. Copy `deploy/github-pages.yml` to `.github/workflows/pages.yml` and, if needed,
   adjust the `path:` (default `docs/visualizer`; use `.` if the tool is the repo
   root) and the trigger branch.
3. In the repo: **Settings → Pages → Source: GitHub Actions**.
4. Push. The Action publishes the page; its URL appears in the run summary.

Any static host (Netlify, Cloudflare Pages, S3, nginx…) works too — just serve the
folder; there is no build step.

## Copy into another repo

1. Copy the entire `docs/visualizer/` folder anywhere inside the target repo (the
   path doesn't matter — it uses only relative references).
2. Open `index.html`, click **Open Folder**, pick that repo's root. Done — identical
   behavior. (Optionally delete `data/index.json` so it starts from the picker.)

Nothing outside this folder is referenced, so it is fully relocatable.

## Security & offline guarantees

- **No CDNs, ever.** All libraries and assets are vendored under `vendor/` and load
  locally. No web fonts, analytics, or telemetry.
- **The local folder path is fully offline** — zero network requests. The **only**
  network calls the app makes are the opt-in *Load from URL* feature:
  `api.github.com` (the file tree) and `raw.githubusercontent.com` (file contents),
  and only after you paste a URL and press Load.
- **Tokens stay local.** A GitHub token you enter is used only for GitHub API calls.
  It is kept in memory, or in this browser's local storage if you tick *Remember* —
  never sent anywhere else and never written into a committed file.
- **All file content is untrusted** (local or remote). Markdown, code-highlight
  output, and SVG are sanitized through **DOMPurify** before insertion. No `eval`;
  raw file text is never assigned to `innerHTML`. Rendered markdown/SVG with a remote
  `<img>` has its `src` stripped; external links open with `rel="noopener noreferrer"`.
  If DOMPurify is missing, the app refuses to inject HTML and shows inert text.

## File layout

```
docs/visualizer/
  index.html        # shell: loads vendored globals, then the app modules
  app.css           # all styling + dark/light theme tokens
  js/               # app modules (classic scripts on a shared window.RV namespace)
    util.js classify.js state.js indexer.js sources.js remote.js
    filters.js list.js graph.js viewer.js snapshot.js app.js
  vendor/           # vendored libraries (see vendor/README.md) — all local
  data/             # optional generated index.json snapshot (.gitkeep committed)
  deploy/           # github-pages.yml — copy to .github/workflows/ to host on Pages
  README.md         # this file
```

### Why classic scripts, not ES modules?

Browsers block ES-module `import` over `file://` (CORS, `origin: null`). To honor
the "just open `index.html`" requirement in **every** browser, the app uses small
classic scripts that share a `window.RV` namespace (a lightweight module pattern) —
no bundler, no transpiler, no server.

## Vendored libraries

vis-network 9.1.9 · marked 13.0.2 · DOMPurify 3.1.6 · highlight.js 11.10.0
(common build + extra language packs). Exact files, versions, and re-download
commands are in [`vendor/README.md`](vendor/README.md).

<!-- AI-API:BEGIN (managed) -->
## AI agent instructions & repository API

> **Directive — read this first.** Any AI agent working with this repository **MUST
> obtain the architecture before editing**: run the analysis and read
> [`docs/repo-map.md`](docs/repo-map.md). Treat that file as the **authoritative map** —
> its entry points are the **START** of the program flow, its terminal modules are the
> **END**, and it lists every import **cycle** and the layered START→END flow.
> **Regenerate it after any structural change** (added/removed/renamed modules or
> changed imports) so the map never goes stale. You can point the analysis at **any
> repository anywhere** by passing a local path or a git/GitHub URL.

Beyond the folder spider-graph, this repo ships a **directed module-flow analysis** with
**three interchangeable surfaces over one shared engine** (`js/engine.js` +
`js/mapmd.js` — the single source of truth; the browser, the CLI and the HTTP server all
consume them, none re-implement the logic):

### 1. ENGINE (in-process)

```js
// Browser (already loaded as window.RV): build the model from the current index.
const model = await RV.engine.buildModel({ rootName, entries, readText: RV.readText, indexHtmlText, packageJson });
const markdown = RV.buildMarkdownMap(model, { title: "Repository map" });

// Node (CommonJS): same logic, headless.
const engine = require("./js/engine.js");
const { buildMarkdownMap } = require("./js/mapmd.js");
const model = await engine.buildModel({ rootName, entries, readText /* async (entry)=>string */ });
```

### 2. CLI (`scripts/repo-analyze.js`) — analyze any repo, emit JSON + Markdown

```bash
# This repo → write the full picture into docs/.
node scripts/repo-analyze.js . --md docs/repo-map.md --json docs/repo-map.json

# Any other local folder, or a GitHub URL (shallow clone; falls back to the GitHub API).
node scripts/repo-analyze.js ../some-other-repo --md docs/repo-map.md
node scripts/repo-analyze.js https://github.com/owner/repo --md docs/repo-map.md
# Print the Markdown to stdout instead of writing a file:
node scripts/repo-analyze.js . --stdout
```

Node built-ins only — **no `npm install`, no dependencies, no `node_modules`.** A token
for private repos / higher GitHub rate limits is read from `GITHUB_TOKEN` (env only).

### 3. HTTP API (`scripts/api-server.js`) — optional local endpoints

```bash
node scripts/api-server.js            # binds http://127.0.0.1:4317 (localhost only)
node scripts/api-server.js --port 5000 --root ..   # widen the allowed local-repo root
```

| Method | Path | Params | Returns |
|--------|------|--------|---------|
| `GET`  | `/api/health` | — | `{ ok, name, version }` |
| `POST` | `/api/analyze` | JSON body `{ repo, includeNoise? }` | the full **AnalysisModel** |
| `GET`  | `/api/flow` | `repo`, `includeNoise?` | `{ root, entries, terminals, cycles, layers, metrics }` |
| `GET`  | `/api/graph` | `repo`, `mode=flow\|containment` | `{ nodes, edges }` |
| `GET`  | `/api/export` | `repo`, `format=md\|json`, `write=1?` | Markdown text or JSON (`write=1` → writes `docs/repo-map.md`) |
| `GET`  | `/` | — | serves the visualizer UI |

```bash
# Example request:
curl "http://127.0.0.1:4317/api/health"
# Example (trimmed) response:
# { "ok": true, "name": "repository-visualizer", "version": "1.2.0" }

curl "http://127.0.0.1:4317/api/export?repo=.&format=md&write=1"
# → { "written": "docs/repo-map.md" }   (and the same Markdown the CLI writes)
```

`repo` is validated: local paths must resolve **under the allowed root** (the directory
the server was launched in, or `--root`), and only `http(s)`/git URLs are treated as
remote. The server binds to **127.0.0.1 only**, never executes file content, and invokes
`git` via an argument array (never a shell string).

### Get the full picture (procedure)

1. Run the analyzer on the target repository (`.` for this one, or any path / git URL).
2. Write [`docs/repo-map.md`](docs/repo-map.md) (and optionally `docs/repo-map.json`).
3. Read `docs/repo-map.md`: **entry points = START**, **terminal modules = END**,
   plus the **Cycles** section and the layered **Execution / dependency flow**.
4. After structural edits, regenerate it so the map stays authoritative.

In the browser UI, the same is available without scripts: toggle **Flow** in the topbar
to render the directed diagram (cycles highlighted in red), and click **Export map (.md)**
to save `repo-map.md`.

### Machine-readable surface map

```json
{
  "engine": { "browser": "RV.engine.buildModel(...)", "node": "require('./js/engine.js').buildModel(...)", "markdown": "RV.buildMarkdownMap / require('./js/mapmd.js')" },
  "cli": "node scripts/repo-analyze.js <repo> --md docs/repo-map.md --json docs/repo-map.json",
  "http": { "start": "node scripts/api-server.js", "base": "http://127.0.0.1:4317", "endpoints": ["GET /api/health", "POST /api/analyze", "GET /api/flow", "GET /api/graph", "GET /api/export"] },
  "export": "docs/repo-map.md",
  "reference": "docs/API.md"
}
```

See [`docs/API.md`](docs/API.md) for the complete engine, CLI and HTTP reference (every
field, flag and endpoint with request/response examples) and [`AGENTS.md`](AGENTS.md) for
the one-line contract.
<!-- AI-API:END -->
