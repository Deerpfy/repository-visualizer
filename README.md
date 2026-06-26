---
title: Repository Visualizer
version: 1.0.0
last_updated: 2026-06-26
status: stable
---

# Repository Visualizer

A **local, offline, single-page** tool that browses every file in a repository and
draws a force-directed *spider-web* graph of its folder/file hierarchy. Click any
file to render its contents (markdown, source code, text, images).

It runs by **opening `index.html` in a browser** — no server, no install, no build
step, and **zero network requests at runtime**. The whole `docs/visualizer/` folder
is self-contained and copy-paste portable: drop it into any repo and it behaves
identically.

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

## Copy into another repo

1. Copy the entire `docs/visualizer/` folder anywhere inside the target repo (the
   path doesn't matter — it uses only relative references).
2. Open `index.html`, click **Open Folder**, pick that repo's root. Done — identical
   behavior. (Optionally delete `data/index.json` so it starts from the picker.)

Nothing outside this folder is referenced, so it is fully relocatable.

## Security & offline guarantees

- **Zero network at runtime.** No CDNs, web fonts, analytics, or telemetry. Every
  asset is under `vendor/`. Rendered markdown/SVG with remote `<img>` has its `src`
  stripped so nothing fetches the network; external links open in a new tab with
  `rel="noopener noreferrer"`.
- **All file content is untrusted.** Markdown, code highlight output, and SVG are
  sanitized through **DOMPurify** before insertion. No `eval`; raw file text is never
  assigned to `innerHTML`. If DOMPurify is missing, the app refuses to inject HTML
  and shows inert text instead.

## File layout

```
docs/visualizer/
  index.html        # shell: loads vendored globals, then the app modules
  app.css           # all styling + dark/light theme tokens
  js/               # app modules (classic scripts on a shared window.RV namespace)
    util.js classify.js state.js indexer.js sources.js filters.js
    list.js graph.js viewer.js snapshot.js app.js
  vendor/           # vendored libraries (see vendor/README.md) — no network at runtime
  data/             # optional generated index.json snapshot (.gitkeep committed)
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
