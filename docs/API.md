# Repository Visualizer — Analysis API reference

The directed module-flow analysis exposes **three surfaces over one shared engine**. The
engine (`js/engine.js`) and the Markdown builder (`js/mapmd.js`) are the **single source of
truth**; the browser views, the CLI (`scripts/repo-analyze.js`) and the HTTP server
(`scripts/api-server.js`) all consume them.

- [Engine API](#engine-api) — `RV.engine.*` in the browser, `require("./js/engine.js")` in Node
- [The AnalysisModel](#the-analysismodel) — the shape every surface returns
- [Markdown builder](#markdown-builder) — `RV.buildMarkdownMap` / `require("./js/mapmd.js")`
- [CLI](#cli) — `scripts/repo-analyze.js`
- [HTTP API](#http-api) — `scripts/api-server.js`
- [Security](#security)

---

## Engine API

`js/engine.js` is dual-runtime (a classic `window.RV` script in the browser **and** a
CommonJS module in Node). It has no DOM and no vendor dependency.

### `buildModel(options) → Promise<AnalysisModel>`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `rootName` | `string` | `"repository"` | First path segment / repo name, used for labels. |
| `entries` | `Array<{ path, size, ext?, name? }>` | `[]` | The files to analyze. Extra fields are passed back to `readText`. |
| `readText` | `async (entry) => string` | — | Per-file content reader. May throw → that file is skipped, never fatal. |
| `indexHtmlText` | `string` | `""` | `index.html` source; its `<script src>` targets are seeded as entry points. |
| `packageJson` | `object` | `null` | Parsed `package.json`; `main` / `bin` are seeded as entry points. |
| `includeNoise` | `boolean` | `false` | Include `node_modules`, `dist`, `vendor`, `.git`, `.claude`, … |
| `sizeCap` | `number` | `262144` | Skip files larger than this many bytes (256 KB). |
| `nodeCap` | `number` | `4000` | Cap analyzable files for determinism/scale (sets `model.truncated`). |
| `generatedAt` | `string` | now (ISO) | Timestamp recorded in the model; pass your own for reproducibility. |

`readText` receives the **original** entry object you passed in `entries`, so it works with
browser `FileEntry` objects (which carry a `File`/handle/URL) and with Node entries (which
carry a filesystem path) alike.

```js
// Node
const engine = require("./js/engine.js");
const entries = [{ path: "demo/a.js", size: 20 }, { path: "demo/b.js", size: 20 }];
const contents = { "demo/a.js": 'require("./b")', "demo/b.js": 'require("./a")' };
const model = await engine.buildModel({
  rootName: "demo",
  entries,
  readText: async (e) => contents[e.path],
});
console.log(model.metrics.cycleCount); // 1  (a ↔ b)
```

### Parser helpers (also the single source of truth for `js/graph.js`)

| Function | Signature | Notes |
|----------|-----------|-------|
| `parseRefs(text)` | `(string) → string[]` | Extracts `import … from`, bare `import`, `require()`, `#include`, Python `from … import`. Capped at 200/file. |
| `resolveRef(target, fromPath, files)` | `→ resolvedPath \| null` | Resolves a specifier against the file list (relative `./..` with extension/`index.*` guessing, plus suffix/basename matches). `files` is any array of `{ path }`. |
| `normalizePath(path)` | `(string) → string` | Collapses `.` / `..` segments. |
| `isNoiseSegment(name)` | `(string) → boolean` | True for a default-hidden directory name (the Node walker reuses this). |

---

## The AnalysisModel

```jsonc
{
  "root": "repository-visualizer",
  "generatedAt": "2026-06-26T00:00:00.000Z",
  "nodes": [
    { "id": "demo/a.js", "path": "demo/a.js", "name": "a.js", "ext": "js",
      "type": "code",            // "code" | "markdown" | "text"
      "size": 20, "inDeg": 1, "outDeg": 1,
      "role": "cycle",           // "entry" | "terminal" | "cycle" | "normal" (priority cycle>entry>terminal>normal)
      "layer": 1,                // tier in the START→END layering (0 = START)
      "entry": false, "terminal": false, "cycle": true, "seeded": false }
  ],
  "edges": [
    { "from": "demo/a.js", "to": "demo/b.js", "kind": "import", "inCycle": true }
  ],
  "entries":   ["demo/main.js"],          // START nodes (seeded, or nothing imports them)
  "terminals": ["demo/util.js"],          // END nodes (imported leaves)
  "cycles": [
    { "id": "cycle-demo/a.js", "members": ["demo/a.js", "demo/b.js"],
      "backEdges": [{ "from": "demo/b.js", "to": "demo/a.js" }] }
  ],
  "layers":  [["demo/main.js"], ["demo/a.js", "demo/b.js"]],  // ordered START → END tiers
  "orphans": ["demo/notes.js"],           // no in- and no out-edges (and not seeded)
  "metrics": { "files": 4, "codeFiles": 4, "edges": 3,
               "entryCount": 1, "terminalCount": 1, "cycleCount": 1, "maxDepth": 2 },
  "truncated": false                      // true if the nodeCap clipped the file list
}
```

**Roles.** The node booleans `entry` (in-degree 0 **or** seeded) and `terminal`
(out-degree 0) are literal, so a node can be both. The single `role` and the `entries` /
`terminals` lists are made non-overlapping via the priority **cycle > entry > terminal >
normal**, so each file appears in at most one of `entries` / `terminals` / `orphans`.

**Cycles** are the strongly-connected components of size > 1 (iterative Tarjan). Every edge
inside an SCC has `inCycle: true`; `backEdges` are the specific loop-closing edges.

**Layers** condense each SCC to one node, topologically sort the resulting DAG, and assign
`layer = longest distance from any START`. `metrics.maxDepth` is the number of tiers.

Output is **deterministic** (everything sorted by path), bounded (per-file ref cap, node
cap) and never throws on a single odd file.

---

## Markdown builder

`js/mapmd.js` — `buildMarkdownMap(model, meta?) → string`. Pure, no DOM. Produces, in order:
title + summary, a fenced **Mermaid** flowchart (`flowchart LR`, one subgraph per
top-level folder, `classDef` for entry/terminal/cycle, cycle links dashed and labelled),
**Entry points (START)**, **Terminal modules (END)**, **Cycles**, **Execution / dependency
flow (START → END)**, **Module inventory** (table), and **Metrics**. Mermaid node ids are
sanitized to `[A-Za-z0-9_]` and de-duplicated; the diagram is capped at ~300 nodes (the
full list always remains in the inventory table).

`meta`: `{ title?, generatedAt?, suggestedName? }`.

---

## CLI

`scripts/repo-analyze.js` — Node built-ins only, zero dependencies.

```bash
node scripts/repo-analyze.js <path-or-giturl> [--json <out.json>] [--md <out.md>] [--include-noise] [--stdout]
```

| Argument / flag | Description |
|-----------------|-------------|
| `<path-or-giturl>` | `.`, any folder path, `https://github.com/owner/repo`, or `git@github.com:owner/repo`. |
| `--md <file>` | Write the Markdown map. Default target `docs/repo-map.md` when nothing else is requested. |
| `--json <file>` | Write the full `AnalysisModel` JSON. |
| `--include-noise` | Also analyze `node_modules` / `dist` / `vendor` / `.claude` / … (hidden by default). |
| `--stdout` | Print the Markdown to stdout (progress + summary then go to stderr). |

Output paths: a **relative** `--md`/`--json` resolves under the project root and may not
escape it; an **absolute** path is honored as given. Parent directories are created. A git
URL is shallow-cloned with `git` (arg array, no shell); if `git` is unavailable the loader
falls back to the GitHub trees API over HTTPS (`GITHUB_TOKEN` env for auth/limits).

```bash
$ node scripts/repo-analyze.js . --md docs/repo-map.md --json docs/repo-map.json
Wrote docs/repo-map.md
Wrote docs/repo-map.json
Analyzed "repository-visualizer": 29 files, 7 edges, 21 entries, 0 terminals, 0 cycles.
```

---

## HTTP API

`scripts/api-server.js` — Node built-in `http` only. **Binds to `127.0.0.1` exclusively.**

```bash
node scripts/api-server.js [--port 4317] [--root <allowed-local-root>]
# PORT and REPO_ROOT env vars are also honored.
```

### `GET /api/health`

```bash
curl http://127.0.0.1:4317/api/health
```
```json
{ "ok": true, "name": "repository-visualizer", "version": "1.2.0" }
```

### `POST /api/analyze` — `{ repo, includeNoise? }` → full `AnalysisModel`

```bash
curl -X POST -H "Content-Type: application/json" -d '{"repo":"."}' \
     http://127.0.0.1:4317/api/analyze
```
```jsonc
// { "root": "...", "nodes": [...], "edges": [...], "entries": [...],
//   "terminals": [...], "cycles": [...], "layers": [...], "metrics": {...} }
```

### `GET /api/flow?repo=…` → flow summary

```bash
curl "http://127.0.0.1:4317/api/flow?repo=."
```
```jsonc
// { "root": "...", "generatedAt": "...", "entries": [...], "terminals": [...],
//   "cycles": [...], "layers": [...], "orphans": [...], "metrics": {...} }
```

### `GET /api/graph?repo=…&mode=flow|containment` → `{ nodes, edges }`

`mode=flow` returns the directed model graph; `mode=containment` returns the folder→child
tree (built directly from the file list).

```bash
curl "http://127.0.0.1:4317/api/graph?repo=.&mode=flow"
curl "http://127.0.0.1:4317/api/graph?repo=.&mode=containment"
```

### `GET /api/export?repo=…&format=md|json[&write=1]`

Returns the Markdown map (`format=md`) or the JSON model (`format=json`). With `write=1`
the server also writes `docs/repo-map.md` (or `docs/repo-map.json`) and reports the path.

```bash
curl "http://127.0.0.1:4317/api/export?repo=.&format=md"            # → Markdown text
curl "http://127.0.0.1:4317/api/export?repo=.&format=md&write=1"    # → { "written": "docs/repo-map.md" }
```

### `GET /` (and any non-`/api/` path) — static UI

Serves the visualizer (`index.html`, `app.css`, `js/`, `vendor/`, …) from the project root,
with a path-traversal guard. Lets you open the full UI at `http://127.0.0.1:4317/`.

### Errors

`400` invalid/missing parameters · `403` local `repo` outside the allowed root, or static
traversal · `404` unknown endpoint / missing file · `405` wrong method · `413` request body
over 256 KB. API errors are JSON `{ "error": "…" }`.

---

## Security

- The HTTP server binds to **`127.0.0.1` only** — never `0.0.0.0`, no open CORS.
- `repo` is validated: local paths must resolve **under the allowed root**; only
  `http(s)`/git URLs are treated as remote (a bare `owner/repo` is treated as a local path,
  never auto-cloned).
- `git` is invoked via `execFile` with an **argument array**, never a shell string. File
  content is **never executed** (no `eval`). GitHub tokens are read from `GITHUB_TOKEN` /
  `GH_TOKEN` env vars only and are never written to a committed file.
- The analysis treats all file content as untrusted and is read-only except for the
  explicit `--md`/`--json` / `write=1` outputs, which only ever target the project `docs/`
  (or an explicit absolute path on the CLI).
