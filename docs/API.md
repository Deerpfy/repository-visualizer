# Repository Visualizer — Analysis API reference

The directed module-flow analysis exposes **two surfaces over one shared engine**. The
engine (`js/engine.js`) and the Markdown builder (`js/mapmd.js`) are the **single source of
truth**; the browser views and the CLI (`scripts/repo-analyze.js`) both consume them. There
is **no server** — the browser app runs entirely offline.

- [Engine API](#engine-api) — `RV.engine.*` in the browser, `require("./js/engine.js")` in Node
- [The AnalysisModel](#the-analysismodel) — the shape every surface returns
- [Markdown builder](#markdown-builder) — `RV.buildMarkdownMap` / `require("./js/mapmd.js")`
- [CLI](#cli) — `scripts/repo-analyze.js`
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

### `buildCallGraph(options) → Promise<CallGraph>` — the function CODE FLOW

Same `{ rootName, entries, readText, includeNoise?, sizeCap?, generatedAt? }` inputs as
`buildModel`. Best-effort (regex + brace matching, like `parseRefs`): it finds function
definitions (named/arrow/method, plus Python `def`) and the calls inside each body, then
links **caller → callee**. Resolution is conservative — a call resolves to a function in
the **same file**, else to a project-wide **uniquely-named** function, else it is external
(no edge); built-in methods (`push`, `map`, `get`, …) are never resolved. Series vs
parallel is heuristic: calls inside `Promise.all`/`allSettled`/`race` or `parallel(...)`
are flagged `parallel`. Recursion (self + mutual, via the same SCC pass) is detected.

```jsonc
{
  "root": "demo", "generatedAt": "…", "kind": "callgraph",
  "provider": "heuristic",            // "heuristic" | "roslyn" | "mixed (roslyn + heuristic)"
  "nodes": [ { "id": "demo/m.js::run#5", "file": "demo/m.js", "name": "run", "kind": "function",
               "line": 5, "inDeg": 0, "outDeg": 3, "role": "entry" } ],   // role: entry|leaf|cycle|module|normal
  "edges": [ { "from": "demo/m.js::run#5", "to": "demo/m.js::worker#3", "file": "demo/m.js",
               "parallel": true, "self": false, "via": "call", "inCycle": false } ],   // via: call|dispatch|event|new
  "cycles": [ { "members": ["demo/m.js::loop#9"], "self": true } ],       // recursion groups
  "metrics": { "files": 1, "functions": 5, "nodes": 5, "calls": 4, "parallelCalls": 2, "recursive": 1, "maxFanOut": 3 }
}
```

A synthetic `file::<module>` node (kind `module`) carries calls made by a file's top-level
body. `buildMarkdownMap(model, meta, callGraph)` renders this as the headline **Function
call flow** section (Mermaid: solid = series, dashed `parallel` / `recurses` / `virtual`
(dispatch) / `event`). The in-browser **Flow → Functions** toggle renders the same graph.

### Compiler-accurate language providers

The heuristic above is pure-JS and always available (incl. the browser). For real type
resolution, the Node CLI/API delegate supported languages to the language's own compiler
front-end and merge the result via `finalizeCallGraph` (same shape). The browser app stays
dependency-free; providers run only in the Node layer when the SDK is present.

| Language | Provider | Needs | Follows |
|----------|----------|-------|---------|
| C# | `tools/CSharpCallGraph` (Roslyn) via `scripts/providers/csharp.js` | .NET SDK (`dotnet`) | virtual & interface dispatch, overrides, events (`+=`/`Invoke`), constructors, `Task.WhenAll`/`Parallel.*` |
| Go / Python / C++ | (architecture in place; not yet shipped) | go / python / clang | — |

Selection is automatic: a C# project analyzed with `dotnet` present → `provider: "roslyn"`
(or `"mixed (roslyn + heuristic)"` alongside other languages); otherwise `"heuristic"`. The
first C# run does a one-time `dotnet restore`/`build` of the analyzer tool. Edges carry a
`via` tag (`call` / `dispatch` / `event` / `new`) so dispatch targets and event handlers are
visible. To view the accurate graph in the browser (which can't run SDKs), generate a JSON
snapshot with the CLI and open the folder — **Flow → Functions** loads `repo-map.json` /
`callgraph.json` if present.

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

## Security

- **No server, no network listener.** The browser app is fully offline; the CLI is a local
  process. The only outbound network use is the opt-in GitHub loader (`api.github.com` /
  `raw.githubusercontent.com`).
- `git` and the optional C# analyzer (`dotnet`) are invoked via `execFile` with an **argument
  array**, never a shell string. File content is **never executed** (no `eval`). GitHub tokens
  are read from `GITHUB_TOKEN` / `GH_TOKEN` env vars only and never written to a committed file.
- The analysis treats all file content as untrusted and is read-only except for the explicit
  `--md` / `--json` CLI outputs, which resolve under the project (or an explicit absolute path).
