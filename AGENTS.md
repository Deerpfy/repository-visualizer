# AGENTS.md

Guidance for AI agents (and humans) working in this repository. 2026 convention: this
file points you at the authoritative contract; it does not duplicate it.

## One-line contract

**Before editing, obtain the architecture: run the analysis and read
[`docs/repo-map.md`](docs/repo-map.md). After any structural change, regenerate it.**

`docs/repo-map.md` is the authoritative map — **entry points = START**, **terminal
modules = END**, plus every import **cycle** and the layered START→END flow.

## Get the full picture

```bash
# This repo (or pass any folder path / GitHub URL instead of ".").
node scripts/repo-analyze.js . --md docs/repo-map.md --json docs/repo-map.json
```

No dependencies — Node built-ins only, no `npm install`. A `GITHUB_TOKEN` env var is used
for private repos / higher rate limits (never hard-code or commit a token).

Optional local HTTP API (localhost only):

```bash
node scripts/api-server.js            # http://127.0.0.1:4317
curl "http://127.0.0.1:4317/api/export?repo=.&format=md&write=1"
```

In the browser UI (`index.html`, no server): toggle **Flow** for the directed diagram and
click **Export map (.md)**.

## Where the contract lives

- **README → "AI agent instructions & repository API"** (the `<!-- AI-API -->` managed
  block): the directive, the three surfaces (engine / CLI / HTTP), the endpoint table, and
  a machine-readable surface map.
- **[`docs/API.md`](docs/API.md):** the complete reference — engine API + AnalysisModel
  shape, every CLI flag, every HTTP endpoint with request/response examples.

## Hard rules (see `.claude/rules/security.md` and the README "Security & offline guarantees")

- The browser app must keep running by opening `index.html` over `file://` — **no server,
  no CDN, no build step, no `npm` dependency, no ES-module `import`/`export`** in browser
  files (they are classic scripts on `window.RV`).
- The reference parser and model live **only** in `js/engine.js`; the Markdown builder
  **only** in `js/mapmd.js`. The browser views, the CLI and the HTTP server **consume**
  these — never fork or re-implement the logic.
- All file content is **untrusted**: no `eval`, sanitize rendered HTML/markdown/SVG through
  DOMPurify, validate paths, bind the HTTP server to `127.0.0.1` only, prefer `execFile`
  with argument arrays over shell strings, and never write secrets into committed files.
- Additive changes only: do not regress the containment graph, viewer, filters, snapshot,
  or remote loaders. The Flow view and exports sit **alongside** them.
