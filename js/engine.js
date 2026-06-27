// engine.js — the shared, framework-free ANALYSIS ENGINE (single source of truth).
// Dual-runtime: a classic <script> on window.RV in the browser AND require()-able
// in Node (CommonJS). NO DOM, NO vendor deps — pure logic, like classify.js.
//
// It owns:
//   parseRefs(text)                  -> [specifier...]   (import/require/include/from)
//   resolveRef(target, from, files)  -> resolvedPath|null
//   normalizePath(path)              -> collapsed "./.." path
//   buildModel({...})                -> AnalysisModel    (nodes/edges/cycles/layers/…)
//
// js/graph.js (browser overlay) and scripts/repo-analyze.js (CLI) both CONSUME these —
// the parser/model logic is never forked or re-implemented elsewhere.
(function (root, factory) {
	const api = factory();
	if (typeof module !== "undefined" && module.exports) module.exports = api; // Node (CommonJS)
	else (root.RV = root.RV || {}).engine = api; // browser → RV.engine
})(typeof self !== "undefined" ? self : this, function () {
	"use strict";

	// ---- tiny path helpers (self-contained; no util.js dependency) --------

	function baseName(path) {
		const i = path.lastIndexOf("/");
		return i === -1 ? path : path.slice(i + 1);
	}
	function dirName(path) {
		const i = path.lastIndexOf("/");
		return i === -1 ? "" : path.slice(0, i);
	}
	/** Lowercase extension without the dot, or "" for none/dotfiles. */
	function extOf(name) {
		const base = baseName(name).toLowerCase();
		const dot = base.lastIndexOf(".");
		return dot <= 0 ? "" : base.slice(dot + 1);
	}
	/** Collapse "." / ".." segments. Mirrors the old graph.js normalize(). */
	function normalizePath(path) {
		const parts = [];
		for (const seg of String(path).split("/")) {
			if (seg === "" || seg === ".") continue;
			if (seg === "..") parts.pop();
			else parts.push(seg);
		}
		return parts.join("/");
	}

	// ---- reference parsing (best-effort, conservative) -------------------
	// Lifted verbatim (behavior-preserving) from the old private copy in graph.js.

	function parseRefs(text) {
		const refs = [];
		const push = (s) => { if (s) refs.push(s.trim()); };
		let m;
		const reFrom = /(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]/g;
		while ((m = reFrom.exec(text))) push(m[1]);
		const reBareImport = /\bimport\s*['"]([^'"]+)['"]/g;
		while ((m = reBareImport.exec(text))) push(m[1]);
		const reReq = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
		while ((m = reReq.exec(text))) push(m[1]);
		const reInc = /#\s*include\s*[<"]([^>"]+)[>"]/g;
		while ((m = reInc.exec(text))) push(m[1]);
		const rePyFrom = /^\s*from\s+([.\w]+)\s+import\b/gm;
		while ((m = rePyFrom.exec(text))) push(m[1].replace(/\./g, "/"));
		return refs.slice(0, 200); // safety cap per file
	}

	/**
	 * Resolve a raw specifier to a real indexed file path, or null.
	 * `files` is any array of objects carrying a `.path` (FileEntry, node, etc.).
	 * Path-only (derives the basename itself) so it works for every consumer.
	 */
	function resolveRef(target, fromPath, files) {
		const fromDir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
		const exts = ["", ".js", ".mjs", ".ts", ".tsx", ".jsx", ".py", ".h", ".hpp", ".cpp", ".c", ".css", ".json"];
		if (target.startsWith(".")) {
			const base = normalizePath(`${fromDir}/${target}`);
			for (const ext of exts) {
				const cand = base + ext;
				const hit = files.find((f) => f.path === cand || f.path === `${cand}/index.js` || f.path === `${cand}/index.ts`);
				if (hit) return hit.path;
			}
			return null;
		}
		const baseTarget = target.replace(/\\/g, "/");
		const bySuffix = files.find((f) => f.path.endsWith("/" + baseTarget) || f.path === baseTarget);
		if (bySuffix) return bySuffix.path;
		const justName = baseTarget.split("/").pop();
		const byName = files.find((f) => f.path.endsWith("/" + justName) || baseName(f.path) === justName);
		return byName ? byName.path : null;
	}

	// ---- analyzability (engine-owned; no classify.js dependency) ----------
	// A narrow, self-contained notion of "can I parse references from this file".
	// Mirrors the overlay's skip rule (binary/image + size cap) without importing
	// the browser-only classify.js, so the engine stays pure and dual-runtime.

	const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "avif"]);
	const BINARY_EXTS = new Set([
		"exe", "dll", "so", "dylib", "bin", "o", "obj", "a", "lib", "class", "jar",
		"war", "pdb", "node", "wasm", "pyc", "pyo", "pyd",
		"zip", "gz", "tar", "tgz", "bz2", "xz", "7z", "rar", "zst",
		"pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods",
		"mp3", "wav", "ogg", "flac", "aac", "m4a",
		"mp4", "avi", "mov", "mkv", "webm", "wmv", "flv",
		"ttf", "otf", "woff", "woff2", "eot",
		"db", "sqlite", "sqlite3", "mdb", "dat", "iso", "img", "dmg", "msi", "cab",
		"psd", "ai", "sketch", "fig",
	]);
	const MD_EXTS = new Set(["md", "markdown", "mdx"]);
	// Source-ish extensions → these nodes count as "code" in the model/metrics.
	const CODE_EXTS = new Set([
		"c", "h", "cc", "cpp", "cxx", "hpp", "hh", "hxx", "cs", "vb", "fs", "fsx",
		"java", "kt", "kts", "scala", "groovy", "gradle", "clj", "cljs",
		"go", "rs", "swift", "dart",
		"js", "mjs", "cjs", "jsx", "ts", "tsx",
		"py", "rb", "php", "pl", "pm", "lua", "sh", "bash", "zsh", "ksh",
		"ps1", "psm1", "bat", "cmd", "r", "ex", "exs", "erl", "hrl", "hs",
		"m", "mm", "sql", "css", "scss", "sass", "less", "vue", "svelte",
	]);
	// Extensionless source filenames worth analyzing as code.
	const SPECIAL_CODE_NAMES = new Set(["dockerfile", "makefile", "gnumakefile", "jenkinsfile", "rakefile", "gemfile", "vagrantfile"]);

	// Default-hidden directories (mirrors classify.js NOISE_DIRS + BUILD_DIRS, plus the
	// agent-tooling dirs .claude/.github which are config, not application architecture).
	const NOISE_SEGMENTS = new Set([
		".git", "node_modules", ".svn", ".hg", ".idea", ".vs", ".vscode", ".claude", ".github",
		"__pycache__", ".pytest_cache", ".mypy_cache", ".gradle", ".cache",
		"bin", "obj", "dist", "build", "out", "target", "coverage", ".next",
		".nuxt", ".turbo", ".parcel-cache", "vendor", "packages", "_site", "venv", ".venv",
	]);

	function isBinaryLike(ext) { return BINARY_EXTS.has(ext) || IMAGE_EXTS.has(ext); }
	/** True if a single path segment (directory name) is default-hidden noise. */
	function isNoiseSegment(name) { return NOISE_SEGMENTS.has(String(name).toLowerCase()); }
	function isNoisePath(path) {
		const segs = path.split("/");
		for (let i = 0; i < segs.length - 1; i++) if (isNoiseSegment(segs[i])) return true;
		return false;
	}
	/** Coarse node type for the model/inventory. */
	function typeOf(name, ext) {
		if (MD_EXTS.has(ext)) return "markdown";
		if (CODE_EXTS.has(ext) || SPECIAL_CODE_NAMES.has(name.toLowerCase())) return "code";
		return "text";
	}

	// ---- seeded entry detection ------------------------------------------
	// "Start" must be meaningful even when everything is imported by something.

	/** Pull `<script src="…">` specifiers out of an index.html string. */
	function scriptSrcs(html) {
		const out = [];
		if (!html) return out;
		const re = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
		let m;
		while ((m = re.exec(html))) out.push(m[1].trim());
		return out;
	}
	const SEED_NAME_RE = /^(main|index|app|program)\.[a-z0-9]+$/i;
	function isSeedName(name) {
		const low = name.toLowerCase();
		return SEED_NAME_RE.test(low) || low === "__main__.py" || low === "program.cs";
	}

	// ---- strongly-connected components (iterative Tarjan) ----------------
	// Iterative to stay safe on large graphs (no recursion depth limit).

	function tarjanSCC(ids, adj) {
		const index = new Map();
		const low = new Map();
		const onStack = new Map();
		const stack = [];
		const comps = []; // array of arrays of ids
		let idx = 0;

		for (const start of ids) {
			if (index.has(start)) continue;
			// work stack of { node, edgeIndex }
			const work = [{ v: start, i: 0 }];
			while (work.length) {
				const frame = work[work.length - 1];
				const v = frame.v;
				if (frame.i === 0) {
					index.set(v, idx);
					low.set(v, idx);
					idx++;
					stack.push(v);
					onStack.set(v, true);
				}
				const neighbors = adj.get(v) || [];
				if (frame.i < neighbors.length) {
					const w = neighbors[frame.i];
					frame.i++;
					if (!index.has(w)) {
						work.push({ v: w, i: 0 });
					} else if (onStack.get(w)) {
						low.set(v, Math.min(low.get(v), index.get(w)));
					}
				} else {
					// done with v: if root of an SCC, pop it
					if (low.get(v) === index.get(v)) {
						const comp = [];
						let w;
						do {
							w = stack.pop();
							onStack.set(w, false);
							comp.push(w);
						} while (w !== v);
						comps.push(comp);
					}
					work.pop();
					if (work.length) {
						const parent = work[work.length - 1].v;
						low.set(parent, Math.min(low.get(parent), low.get(v)));
					}
				}
			}
		}
		return comps;
	}

	// ---- the model builder ------------------------------------------------

	/**
	 * Build an AnalysisModel from a list of entries.
	 *
	 * opts:
	 *   rootName       string   first path segment / repo name (for labeling)
	 *   entries        [{ path, size, ext?, name? }]  (extra fields ignored; reader gets the original)
	 *   readText       async (entry) => string        per-file content reader (may throw → file skipped)
	 *   indexHtmlText  string?  index.html source, to seed <script src> entry points
	 *   packageJson    object?  parsed package.json, to seed main/bin entry points
	 *   includeNoise   bool?    include node_modules/dist/… (default false)
	 *   sizeCap        number?  skip files larger than this many bytes (default 256 KB)
	 *   nodeCap        number?  cap analyzable files for determinism/scale (default 4000)
	 *   generatedAt    string?  ISO timestamp supplied by the caller
	 */
	async function buildModel(opts) {
		opts = opts || {};
		const rootName = opts.rootName || "repository";
		const entries = opts.entries || [];
		const readText = typeof opts.readText === "function" ? opts.readText : null;
		const includeNoise = !!opts.includeNoise;
		const sizeCap = typeof opts.sizeCap === "number" ? opts.sizeCap : 256 * 1024;
		const nodeCap = typeof opts.nodeCap === "number" ? opts.nodeCap : 4000;
		const generatedAt = opts.generatedAt || new Date().toISOString();

		// 1) Select analyzable files (not binary/image, under cap, non-noise). Keep a
		//    private `_src` reference so readText() gets the ORIGINAL entry (which may
		//    carry a File/handle/url in the browser, or an absolute path in Node).
		let files = [];
		for (const e of entries) {
			if (!e || !e.path) continue;
			const path = String(e.path).replace(/\\/g, "/");
			if (!path || path.endsWith("/")) continue;
			if (!includeNoise && isNoisePath(path)) continue;
			const name = baseName(path);
			const ext = e.ext || extOf(name);
			if (isBinaryLike(ext)) continue;
			const size = typeof e.size === "number" ? e.size : 0;
			if (size > sizeCap) continue;
			files.push({ path, name, ext, size, type: typeOf(name, ext), _src: e });
		}
		// Stable order + node cap.
		files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
		let truncated = false;
		if (files.length > nodeCap) { files = files.slice(0, nodeCap); truncated = true; }

		const byPath = new Map(files.map((f) => [f.path, f]));

		// 2) Parse refs → directed edges (deduped). A bad/unreadable file is skipped,
		//    never thrown — analysis of the rest continues.
		const edgeSet = new Set();
		const edges = [];
		if (readText) {
			for (const f of files) {
				// Only CODE files originate import edges. Markdown/text are kept as nodes
				// (they can be entries/targets/orphans) but never fabricate edges from a
				// fenced `require(...)` / `import …` example in prose.
				if (f.type !== "code") continue;
				let text;
				try { text = await readText(f._src); } catch { continue; }
				if (typeof text !== "string") continue;
				for (const target of parseRefs(text)) {
					const to = resolveRef(target, f.path, files);
					if (!to || to === f.path || !byPath.has(to)) continue;
					const key = JSON.stringify([f.path, to]); // collision-proof (paths can't break JSON)
					if (edgeSet.has(key)) continue;
					edgeSet.add(key);
					edges.push({ from: f.path, to, kind: "import", inCycle: false });
				}
			}
		}
		edges.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0));

		// 3) Degrees + adjacency.
		const inDeg = new Map(files.map((f) => [f.path, 0]));
		const outDeg = new Map(files.map((f) => [f.path, 0]));
		const adj = new Map(files.map((f) => [f.path, []]));
		for (const e of edges) {
			outDeg.set(e.from, outDeg.get(e.from) + 1);
			inDeg.set(e.to, inDeg.get(e.to) + 1);
			adj.get(e.from).push(e.to);
		}
		for (const list of adj.values()) list.sort(); // determinism in DFS/SCC

		// 4) Seeded entry points (so START is meaningful even when imported).
		const seeded = new Set();
		const htmlBaseDir = (() => {
			// Resolve <script src> relative to index.html's folder (root if top-level).
			const idx = files.find((f) => f.name.toLowerCase() === "index.html");
			return idx ? dirName(idx.path) : rootName;
		})();
		for (const src of scriptSrcs(opts.indexHtmlText)) {
			if (/^https?:|^\/\//i.test(src)) continue; // external/CDN — not a local module
			const resolved = normalizePath(`${htmlBaseDir}/${src}`);
			if (byPath.has(resolved)) seeded.add(resolved);
		}
		if (opts.packageJson && typeof opts.packageJson === "object") {
			const pj = opts.packageJson;
			const pjDir = (() => {
				const p = files.find((f) => f.name.toLowerCase() === "package.json");
				return p ? dirName(p.path) : rootName;
			})();
			const seedSpec = (spec) => {
				if (typeof spec !== "string") return;
				const r = normalizePath(`${pjDir}/${spec.replace(/^\.\//, "")}`);
				if (byPath.has(r)) seeded.add(r);
			};
			seedSpec(pj.main);
			if (typeof pj.bin === "string") seedSpec(pj.bin);
			else if (pj.bin && typeof pj.bin === "object") for (const k of Object.keys(pj.bin)) seedSpec(pj.bin[k]);
		}
		// Name-pattern + bin/ seeds.
		for (const f of files) {
			if (isSeedName(f.name)) seeded.add(f.path);
			else if (f.path.split("/").slice(0, -1).some((s) => s.toLowerCase() === "bin")) seeded.add(f.path);
		}

		// 5) SCCs → cycles. Members of an SCC of size>1 are cyclic; mark internal edges.
		const comps = tarjanSCC(files.map((f) => f.path), adj);
		const compOf = new Map();
		comps.forEach((comp, ci) => comp.forEach((p) => compOf.set(p, ci)));
		const cyclic = new Set();
		const cycleComps = []; // ci values with size>1
		for (let ci = 0; ci < comps.length; ci++) {
			if (comps[ci].length > 1) { cycleComps.push(ci); for (const p of comps[ci]) cyclic.add(p); }
		}
		for (const e of edges) if (compOf.get(e.from) === compOf.get(e.to) && cyclic.has(e.from)) e.inCycle = true;

		// Per-cycle records with the specific back-edges (DFS closing edges within the SCC).
		const cycles = cycleComps
			.map((ci) => {
				const members = comps[ci].slice().sort();
				const memberSet = new Set(members);
				const backEdges = findBackEdges(members, memberSet, adj);
				return { id: `cycle-${members[0]}`, members, backEdges };
			})
			.sort((a, b) => (a.members[0] < b.members[0] ? -1 : 1));

		// 6) Roles + entry/terminal booleans. The node BOOLEANS stay literal (entry =
		//    in-degree 0 OR seeded; terminal = out-degree 0) so a node can be "both" and
		//    every consumer can read them. The role and the START/END LISTS are made
		//    clean & non-overlapping via the priority cycle > entry > terminal > normal,
		//    so each file lands in at most one of {entries, terminals, orphans}.
		const orphans = [];
		const entriesList = [];
		const terminals = [];
		const nodeRole = new Map();
		const roleFlags = new Map();
		for (const f of files) {
			const i = inDeg.get(f.path);
			const o = outDeg.get(f.path);
			const isSeed = seeded.has(f.path);
			const isCyclic = cyclic.has(f.path);
			const orphan = i === 0 && o === 0 && !isSeed;
			const entryBool = isSeed || i === 0;   // literal
			const terminalBool = o === 0;           // literal
			const inEntries = !orphan && !isCyclic && entryBool;
			const inTerminals = !orphan && !isCyclic && terminalBool && !inEntries;
			let role = "normal";
			if (isCyclic) role = "cycle";
			else if (inEntries) role = "entry";
			else if (inTerminals) role = "terminal";
			nodeRole.set(f.path, role);
			roleFlags.set(f.path, { entry: entryBool, terminal: terminalBool, cycle: isCyclic, seeded: isSeed });
			if (orphan) orphans.push(f.path);
			else if (inEntries) entriesList.push(f.path);
			else if (inTerminals) terminals.push(f.path);
		}
		entriesList.sort(); terminals.sort(); orphans.sort();

		// 7) Layered flow: condense SCCs, topo-sort the DAG, layer = longest distance.
		const layerOfComp = computeLayers(comps, edges, compOf, seeded, inDeg);
		const nodeLayer = new Map();
		for (const f of files) nodeLayer.set(f.path, layerOfComp.get(compOf.get(f.path)) || 0);
		const maxLayer = files.length ? Math.max(0, ...[...nodeLayer.values()]) : 0;
		const layers = [];
		for (let L = 0; L <= maxLayer; L++) {
			const bucket = files.filter((f) => nodeLayer.get(f.path) === L).map((f) => f.path).sort();
			layers.push(bucket);
		}

		// 8) Assemble nodes (clean projection — no _src leak).
		const nodes = files.map((f) => ({
			id: f.path,
			path: f.path,
			name: f.name,
			ext: f.ext,
			type: f.type,
			size: f.size,
			inDeg: inDeg.get(f.path),
			outDeg: outDeg.get(f.path),
			role: nodeRole.get(f.path),
			layer: nodeLayer.get(f.path),
			entry: roleFlags.get(f.path).entry,
			terminal: roleFlags.get(f.path).terminal,
			cycle: roleFlags.get(f.path).cycle,
			seeded: roleFlags.get(f.path).seeded,
		}));

		const codeFiles = nodes.reduce((n, x) => n + (x.type === "code" ? 1 : 0), 0);
		const metrics = {
			files: nodes.length,
			codeFiles,
			edges: edges.length,
			entryCount: entriesList.length,
			terminalCount: terminals.length,
			cycleCount: cycles.length,
			maxDepth: layers.length,
		};

		return {
			root: rootName,
			generatedAt,
			nodes,
			edges,
			entries: entriesList,
			terminals,
			cycles,
			layers,
			orphans,
			metrics,
			truncated,
		};
	}

	/** Find the cycle-closing (back) edges within one SCC via iterative DFS. */
	function findBackEdges(members, memberSet, adj) {
		const onStack = new Set();
		const visited = new Set();
		const back = [];
		const seen = new Set();
		for (const start of members) {
			if (visited.has(start)) continue;
			const work = [{ v: start, i: 0 }];
			onStack.add(start);
			visited.add(start);
			while (work.length) {
				const frame = work[work.length - 1];
				const neighbors = (adj.get(frame.v) || []).filter((w) => memberSet.has(w));
				if (frame.i < neighbors.length) {
					const w = neighbors[frame.i];
					frame.i++;
					if (onStack.has(w)) {
						const key = JSON.stringify([frame.v, w]);
						if (!seen.has(key)) { seen.add(key); back.push({ from: frame.v, to: w }); }
					} else if (!visited.has(w)) {
						visited.add(w);
						onStack.add(w);
						work.push({ v: w, i: 0 });
					}
				} else {
					onStack.delete(frame.v);
					work.pop();
				}
			}
		}
		return back.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : 1));
	}

	/** Longest-distance layering over the SCC-condensed DAG (Kahn topo order). */
	function computeLayers(comps, edges, compOf, seeded, inDeg) {
		const n = comps.length;
		const succ = new Map(); // ci -> Set(cj)
		const indeg = new Map();
		for (let ci = 0; ci < n; ci++) { succ.set(ci, new Set()); indeg.set(ci, 0); }
		for (const e of edges) {
			const a = compOf.get(e.from), b = compOf.get(e.to);
			if (a === b) continue;
			if (!succ.get(a).has(b)) { succ.get(a).add(b); indeg.set(b, indeg.get(b) + 1); }
		}
		const layer = new Map();
		for (let ci = 0; ci < n; ci++) layer.set(ci, 0);
		// Kahn topo order. Longest-path layer numbers are order-INDEPENDENT (a comp is only
		// enqueued once all its predecessors are processed), so no per-push re-sort is needed;
		// the final buckets are sorted by path anyway. Seed sorted for a stable starting order.
		const queue = [];
		for (let ci = 0; ci < n; ci++) if (indeg.get(ci) === 0) queue.push(ci);
		queue.sort((a, b) => a - b);
		const left = new Map(indeg);
		while (queue.length) {
			const u = queue.shift();
			const succs = [...succ.get(u)].sort((a, b) => a - b);
			for (const v of succs) {
				if (layer.get(v) < layer.get(u) + 1) layer.set(v, layer.get(u) + 1);
				left.set(v, left.get(v) - 1);
				if (left.get(v) === 0) queue.push(v);
			}
		}
		return layer;
	}

	// ======================================================================
	// FUNCTION-LEVEL CALL GRAPH (best-effort, like parseRefs) — the "code flow".
	// Nodes = functions; edges = "caller calls/points to callee". Resolution is
	// conservative: a call resolves to a function defined in the SAME file, else to a
	// project-wide UNIQUELY-named function, else it's treated as external (no edge) —
	// this avoids wrong edges from ambiguous method names. Series vs parallel is a
	// heuristic: calls inside Promise.all/allSettled/race (or a parallel(...) helper)
	// are flagged parallel; everything else is sequential (series).
	// ======================================================================

	const JS_CALL_KEYWORDS = new Set([
		"if", "for", "while", "switch", "catch", "return", "function", "typeof", "instanceof",
		"new", "delete", "void", "do", "else", "case", "await", "yield", "throw", "with",
		"super", "in", "of", "constructor", "set", "get", "async", "static", "var", "let", "const",
		// C# / Java / C++ control & contextual keywords that take "(...)" — so they are not
		// mistaken for a function definition or a call.
		"foreach", "using", "lock", "fixed", "unchecked", "checked", "sizeof", "nameof",
		"default", "when", "synchronized", "namespace", "goto", "operator",
	]);
	// Built-in library methods/globals: never resolve these as user functions — they are
	// the dominant source of false edges (e.g. `arr.push(...)` would otherwise "call" any
	// local helper named `push`). Skipping them keeps the call graph conservative.
	const BUILTINS = new Set([
		// Array / iterable
		"push", "pop", "shift", "unshift", "slice", "splice", "concat", "join", "map", "filter",
		"forEach", "reduce", "reduceRight", "find", "findIndex", "findLast", "some", "every",
		"includes", "indexOf", "lastIndexOf", "sort", "reverse", "flat", "flatMap", "fill", "at",
		"keys", "values", "entries", "from", "of", "isArray",
		// Map / Set
		"get", "set", "has", "add", "delete", "clear",
		// Promise / async
		"then", "catch", "finally", "all", "allSettled", "race", "resolve", "reject",
		// String
		"replace", "replaceAll", "trim", "trimStart", "trimEnd", "toLowerCase", "toUpperCase",
		"split", "startsWith", "endsWith", "padStart", "padEnd", "repeat", "charAt", "charCodeAt",
		"codePointAt", "substring", "substr", "match", "matchAll", "normalize", "localeCompare",
		// Number / Math / JSON / Object
		"toFixed", "toString", "toJSON", "parseInt", "parseFloat", "isNaN", "isFinite", "valueOf",
		"max", "min", "round", "floor", "ceil", "abs", "pow", "sqrt", "random", "sign", "trunc",
		"stringify", "parse", "assign", "freeze", "create", "defineProperty", "getPrototypeOf",
		"hasOwnProperty", "isInteger", "fromCharCode", "fromEntries", "getOwnPropertyNames",
		// timers / console / fn / global
		"setTimeout", "setInterval", "clearTimeout", "clearInterval", "requestAnimationFrame",
		"log", "warn", "error", "info", "debug", "assert", "call", "apply", "bind", "fetch",
		"require", "test", "exec", "now", "isTrue",
		// DOM-ish (browser app)
		"querySelector", "querySelectorAll", "getElementById", "getElementsByClassName",
		"appendChild", "removeChild", "replaceChild", "insertBefore", "append", "prepend", "remove",
		"setAttribute", "getAttribute", "removeAttribute", "addEventListener", "removeEventListener",
		"createElement", "createTextNode", "focus", "blur", "click", "dispatchEvent", "preventDefault",
		"stopPropagation", "getComputedStyle", "getPropertyValue", "getBoundingClientRect",
		"createObjectURL", "revokeObjectURL", "toBlob", "getContext", "setPointerCapture",
		"releasePointerCapture", "replaceChildren", "createWritable", "write", "close", "matchMedia",
		"getItem", "setItem", "removeItem", "createReadStream", "writeHead", "end", "pipe", "destroy",
	]);
	const PY_KEYWORDS = new Set(["if", "for", "while", "elif", "else", "with", "print", "return", "def", "class", "and", "or", "not", "in", "is", "lambda", "yield", "await", "assert", "raise", "except"]);

	/** Replace comment + string CONTENTS with spaces (preserving length/newlines) so
	 *  braces/parens inside strings or comments don't confuse the scanners. */
	function maskCode(text, isPy) {
		const out = text.split("");
		const n = text.length;
		let i = 0;
		const blank = (a, b) => { for (let k = a; k < b && k < n; k++) if (out[k] !== "\n") out[k] = " "; };
		while (i < n) {
			const c = text[i], c2 = text[i + 1];
			if (!isPy && c === "/" && c2 === "/") { let j = i; while (j < n && text[j] !== "\n") j++; blank(i, j); i = j; continue; }
			if (isPy && c === "#") { let j = i; while (j < n && text[j] !== "\n") j++; blank(i, j); i = j; continue; }
			if (!isPy && c === "/" && c2 === "*") { let j = i + 2; while (j < n && !(text[j] === "*" && text[j + 1] === "/")) j++; j = Math.min(n, j + 2); blank(i, j); i = j; continue; }
			if (isPy && (c === "'" || c === '"') && text[i + 1] === c && text[i + 2] === c) { // triple-quoted
				const q = c; let j = i + 3; while (j < n && !(text[j] === q && text[j + 1] === q && text[j + 2] === q)) j++; j = Math.min(n, j + 3); blank(i, j); i = j; continue;
			}
			if (c === '"' || c === "'" || c === "`") {
				const q = c; let j = i + 1;
				while (j < n) { if (text[j] === "\\") { j += 2; continue; } if (text[j] === q || (q !== "`" && text[j] === "\n")) { j++; break; } j++; }
				blank(i, j); i = j; continue;
			}
			i++;
		}
		return out.join("");
	}

	function lineAt(text, idx) { let ln = 1; for (let i = 0; i < idx && i < text.length; i++) if (text[i] === "\n") ln++; return ln; }
	/** From `{`/`(` at openIdx, return the matching close index, or -1. */
	function matchPair(masked, openIdx, open, close) {
		let depth = 0;
		for (let i = openIdx; i < masked.length; i++) {
			if (masked[i] === open) depth++;
			else if (masked[i] === close) { depth--; if (depth === 0) return i; }
		}
		return -1;
	}

	/** Extract JS/TS function definitions with their body ranges. */
	function extractFunctionsJS(masked) {
		const defs = [];
		const seen = new Set(); // dedupe by body-open index
		const addBraced = (name, kind, headIdx, braceIdx) => {
			if (braceIdx < 0 || seen.has(braceIdx)) return;
			const end = matchPair(masked, braceIdx, "{", "}");
			if (end < 0) return;
			seen.add(braceIdx);
			defs.push({ name, kind, headIdx, bodyStart: braceIdx, bodyEnd: end });
		};
		// Locate the body "{" after a parameter list that starts at parenIdx.
		const braceAfterParams = (parenIdx) => {
			const close = matchPair(masked, parenIdx, "(", ")");
			if (close < 0) return -1;
			let j = close + 1;
			while (j < masked.length && /\s/.test(masked[j])) j++;
			return masked[j] === "{" ? j : -1;
		};
		let m;
		// function NAME(...) { ... }
		const reNamed = /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g;
		while ((m = reNamed.exec(masked))) addBraced(m[1], "function", m.index, braceAfterParams(masked.indexOf("(", m.index + 8)));
		// NAME = function(...) {  |  NAME = async function(...) {
		const reAssignFn = /\b([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s+)?function\s*\*?\s*[A-Za-z_$]*\s*\(/g;
		while ((m = reAssignFn.exec(masked))) addBraced(m[1], "function", m.index, braceAfterParams(masked.indexOf("(", m.index + m[0].length - 1)));
		// NAME = (args) => {  |  NAME: arg => {   (only braced arrow bodies get a range)
		const reArrow = /\b([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s+)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/g;
		while ((m = reArrow.exec(masked))) { const b = masked.indexOf("{", m.index + m[0].length - 1); addBraced(m[1], "arrow", m.index, b); }
		// Method shorthand / class method:  NAME(...) {   (statement/member position, not a keyword)
		const reMethod = /(^|[\s{};,])(?:async\s+|get\s+|set\s+|static\s+|\*\s*)*([A-Za-z_$][\w$]*)\s*\(/gm;
		while ((m = reMethod.exec(masked))) {
			const name = m[2];
			if (JS_CALL_KEYWORDS.has(name)) continue;
			const parenIdx = masked.indexOf("(", m.index + m[0].length - 1);
			const b = braceAfterParams(parenIdx);
			if (b >= 0) addBraced(name, "method", m.index, b);
		}
		return defs;
	}

	/** Extract Python def's with their indentation-based body ranges. */
	function extractFunctionsPy(masked) {
		const defs = [];
		const lines = masked.split("\n");
		let offset = 0;
		const lineStart = [];
		for (const ln of lines) { lineStart.push(offset); offset += ln.length + 1; }
		for (let i = 0; i < lines.length; i++) {
			const m = lines[i].match(/^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/);
			if (!m) continue;
			const indent = m[1].length;
			let end = masked.length;
			for (let j = i + 1; j < lines.length; j++) {
				if (!lines[j].trim()) continue;
				const ind = lines[j].match(/^(\s*)/)[1].length;
				if (ind <= indent) { end = lineStart[j] - 1; break; }
			}
			defs.push({ name: m[2], kind: "def", headIdx: lineStart[i], bodyStart: lineStart[i], bodyEnd: end });
		}
		return defs;
	}

	/** All call sites (identifier immediately followed by "("), excluding keywords, defs,
	 *  and built-in library methods/globals (the main source of false edges). */
	function extractCalls(masked, isPy) {
		const calls = [];
		const kw = isPy ? PY_KEYWORDS : JS_CALL_KEYWORDS;
		const re = /([A-Za-z_$][\w$]*)\s*\(/g;
		let m;
		while ((m = re.exec(masked))) {
			const name = m[1];
			if (kw.has(name) || BUILTINS.has(name)) continue;
			// Skip a "definition" paren that follows the `function`/`def` keyword token.
			const before = masked.slice(Math.max(0, m.index - 9), m.index);
			if (/\b(function|def)\s*\*?\s*$/.test(before)) continue;
			// Skip a method/function DEFINITION header `name(params) {` — in C#/Java/C++ a
			// method has no `function`/`def` keyword, so its name+paren would otherwise be
			// double-counted as a call to itself (spurious `<module> -> method` edges).
			if (!isPy) {
				const parenIdx = m.index + m[0].length - 1;
				const close = matchPair(masked, parenIdx, "(", ")");
				if (close > parenIdx) { let j = close + 1; while (j < masked.length && /\s/.test(masked[j])) j++; if (masked[j] === "{") continue; }
			}
			// member call? (preceded by `.`, ignoring whitespace) — recorded for callers who care.
			let k = m.index - 1; while (k >= 0 && /\s/.test(masked[k])) k--;
			calls.push({ name, idx: m.index, member: masked[k] === "." });
		}
		return calls;
	}

	/** Ranges of Promise.all/allSettled/race(...) or parallel(...) — calls inside ⇒ parallel. */
	function parallelRanges(masked) {
		const ranges = [];
		// JS Promise.all/allSettled/race + a parallel(...) helper, and C#/.NET Task.WhenAll/WhenAny.
		const re = /\b(?:Promise\s*\.\s*(?:all|allSettled|race)|Task\s*\.\s*(?:WhenAll|WhenAny)|parallel)\s*\(/g;
		let m;
		while ((m = re.exec(masked))) {
			const open = masked.indexOf("(", m.index + m[0].length - 1);
			const close = matchPair(masked, open, "(", ")");
			if (close > open) ranges.push([open, close]);
		}
		return ranges;
	}

	/**
	 * Build the function-level call graph.
	 * Returns { root, generatedAt, functions:[...], calls:[...], cycles, metrics }.
	 */
	async function buildCallGraph(opts) {
		opts = opts || {};
		const rootName = opts.rootName || "repository";
		const entries = opts.entries || [];
		const readText = typeof opts.readText === "function" ? opts.readText : null;
		const includeNoise = !!opts.includeNoise;
		const sizeCap = typeof opts.sizeCap === "number" ? opts.sizeCap : 256 * 1024;
		const funcCap = typeof opts.funcCap === "number" ? opts.funcCap : 4000;
		const generatedAt = opts.generatedAt || new Date().toISOString();

		// Select code files (call graphs only make sense for code).
		const files = [];
		for (const e of entries) {
			if (!e || !e.path) continue;
			const path = String(e.path).replace(/\\/g, "/");
			if (!path || path.endsWith("/")) continue;
			if (!includeNoise && isNoisePath(path)) continue;
			const ext = e.ext || extOf(path);
			if (typeOf(baseName(path), ext) !== "code") continue;
			if ((typeof e.size === "number" ? e.size : 0) > sizeCap) continue;
			files.push({ path, ext, _src: e });
		}
		files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

		const functions = []; // { id, file, name, kind, line, bodyStart, bodyEnd }
		const perFile = []; // { file, funcs:[...], moduleId, calls, pranges, masked, text }
		let truncated = false;

		for (const f of files) {
			if (functions.length >= funcCap) { truncated = true; break; }
			let text;
			try { text = await readText(f._src); } catch { continue; }
			if (typeof text !== "string") continue;
			const isPy = f.ext === "py";
			const masked = maskCode(text, isPy);
			const rawDefs = isPy ? extractFunctionsPy(masked) : extractFunctionsJS(masked);
			rawDefs.sort((a, b) => a.bodyStart - b.bodyStart);
			const funcs = [];
			for (const d of rawDefs) {
				if (functions.length >= funcCap) { truncated = true; break; }
				const node = { id: `${f.path}::${d.name}#${lineAt(text, d.headIdx)}`, file: f.path, name: d.name, kind: d.kind, line: lineAt(text, d.headIdx), bodyStart: d.bodyStart, bodyEnd: d.bodyEnd };
				functions.push(node);
				funcs.push(node);
			}
			const moduleId = `${f.path}::<module>`;
			perFile.push({ file: f.path, funcs, moduleId, calls: extractCalls(masked, isPy), pranges: parallelRanges(masked) });
		}

		// Resolution indexes: per-file name→func, and global name→[funcs] for uniqueness.
		const globalByName = new Map();
		for (const fn of functions) { if (!globalByName.has(fn.name)) globalByName.set(fn.name, []); globalByName.get(fn.name).push(fn); }
		const fileNameMap = new Map(); // file -> Map(name -> func)
		for (const fn of functions) {
			if (!fileNameMap.has(fn.file)) fileNameMap.set(fn.file, new Map());
			if (!fileNameMap.get(fn.file).has(fn.name)) fileNameMap.get(fn.file).set(fn.name, fn);
		}

		// Synthetic module-top-level nodes (calls made by a file's body on load).
		const moduleNodes = new Map();
		const ensureModule = (pf) => {
			if (!moduleNodes.has(pf.file)) moduleNodes.set(pf.file, { id: pf.moduleId, file: pf.file, name: "(module top-level)", kind: "module", line: 1, bodyStart: -1, bodyEnd: -1 });
			return moduleNodes.get(pf.file);
		};

		// Attribute each call to its innermost enclosing function (or the module node),
		// resolve the callee, and emit edges.
		const edgeSet = new Set();
		const edges = []; // { from, to, file, parallel, self }
		const orderCounter = new Map();
		for (const pf of perFile) {
			const enclosers = pf.funcs.slice().sort((a, b) => (a.bodyEnd - a.bodyStart) - (b.bodyEnd - b.bodyStart)); // smallest first = innermost
			const inParallel = (idx) => pf.pranges.some(([a, b]) => idx > a && idx < b);
			for (const call of pf.calls) {
				// Resolve the callee FIRST: same-file, then a project-wide unique name. Only a
				// resolved call produces an edge (so non-callable files don't get empty nodes).
				let callee = (fileNameMap.get(pf.file) && fileNameMap.get(pf.file).get(call.name)) || null;
				if (!callee) { const g = globalByName.get(call.name); if (g && g.length === 1) callee = g[0]; }
				if (!callee) continue; // external/ambiguous → no edge
				// caller = innermost function body containing the call site, else the module node
				// (materialised only now, when there is a real top-level edge to draw).
				let caller = null;
				for (const fn of enclosers) { if (call.idx > fn.bodyStart && call.idx < fn.bodyEnd) { caller = fn; break; } }
				if (!caller) caller = ensureModule(pf);
				const self = caller.id === callee.id;
				const key = caller.id + " => " + callee.id;
				if (edgeSet.has(key)) continue;
				edgeSet.add(key);
				const ord = (orderCounter.get(caller.id) || 0); orderCounter.set(caller.id, ord + 1);
				edges.push({ from: caller.id, to: callee.id, file: pf.file, parallel: inParallel(call.idx), self, order: ord });
			}
		}

		// Assemble node list (functions + the module nodes that actually made calls), then
		// hand off to the shared finalizer (degrees / SCC / roles / metrics).
		const allNodes = functions.map((fn) => ({ id: fn.id, file: fn.file, name: fn.name, kind: fn.kind, line: fn.line }));
		for (const mn of moduleNodes.values()) allNodes.push({ id: mn.id, file: mn.file, name: mn.name, kind: mn.kind, line: mn.line });
		return finalizeCallGraph(rootName, allNodes, edges, { generatedAt, truncated, files: perFile.length, provider: "heuristic" });
	}

	/**
	 * Shared call-graph finalizer: the SINGLE place that turns raw { nodes, edges } into
	 * the standard CallGraph (degrees, recursion via SCC, roles, metrics). Both the
	 * regex heuristic AND the external language providers (Roslyn, etc.) emit raw
	 * nodes/edges and call this, so every surface gets an identical shape.
	 *   nodes: [{ id, file, name, kind, line }]   edges: [{ from, to, parallel?, self? }]
	 */
	function finalizeCallGraph(rootName, allNodes, rawEdges, opts) {
		opts = opts || {};
		const generatedAt = opts.generatedAt || new Date().toISOString();
		const nodeIds = new Set(allNodes.map((n) => n.id));
		const liveEdges = rawEdges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to)).map((e) => ({ ...e, inCycle: false }));

		const inDeg = new Map(allNodes.map((n) => [n.id, 0]));
		const outDeg = new Map(allNodes.map((n) => [n.id, 0]));
		const adj = new Map(allNodes.map((n) => [n.id, []]));
		for (const e of liveEdges) { outDeg.set(e.from, outDeg.get(e.from) + 1); inDeg.set(e.to, inDeg.get(e.to) + 1); if (!e.self) adj.get(e.from).push(e.to); }
		for (const l of adj.values()) l.sort();

		// Recursion cycles (mutual recursion = SCC>1; direct recursion = self edge).
		const comps = tarjanSCC(allNodes.map((n) => n.id), adj);
		const compOf = new Map();
		comps.forEach((c, ci) => c.forEach((p) => compOf.set(p, ci)));
		const cyclic = new Set();
		const cycles = [];
		for (const c of comps) if (c.length > 1) { for (const p of c) cyclic.add(p); cycles.push({ members: c.slice().sort() }); }
		for (const e of liveEdges) { if (e.self) cyclic.add(e.from); if (compOf.get(e.from) === compOf.get(e.to) && cyclic.has(e.from)) e.inCycle = true; }
		for (const e of liveEdges) if (e.self && !cycles.some((c) => c.members.includes(e.from))) cycles.push({ members: [e.from], self: true });

		const nodes = allNodes.map((n) => {
			const i = inDeg.get(n.id), o = outDeg.get(n.id);
			let role = "normal";
			if (cyclic.has(n.id)) role = "cycle";
			else if (n.kind === "module" || i === 0) role = (o > 0 ? "entry" : "orphan");
			else if (o === 0) role = "leaf";
			return { ...n, inDeg: i, outDeg: o, role };
		}).sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : (a.line || 0) - (b.line || 0)));

		let maxFanOut = 0; for (const o of outDeg.values()) if (o > maxFanOut) maxFanOut = o;
		const fileCount = typeof opts.files === "number" ? opts.files : new Set(allNodes.map((n) => n.file)).size;
		const metrics = {
			files: fileCount,
			functions: allNodes.filter((n) => n.kind !== "module").length,
			nodes: nodes.length,
			calls: liveEdges.length,
			parallelCalls: liveEdges.filter((e) => e.parallel).length,
			recursive: cycles.length,
			maxFanOut,
		};
		return { root: rootName, generatedAt, kind: "callgraph", provider: opts.provider || "heuristic", nodes, edges: liveEdges, cycles, metrics, truncated: !!opts.truncated };
	}

	return {
		parseRefs,
		resolveRef,
		normalizePath,
		buildModel,
		buildCallGraph,
		finalizeCallGraph,
		// small helpers exposed for consumers/tests (e.g. the Node walker reuses the
		// noise list so there is a single source of truth for what to skip)
		baseName,
		dirName,
		extOf,
		isNoiseSegment,
		isNoisePath,
	};
});
