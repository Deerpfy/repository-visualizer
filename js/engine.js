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
// js/graph.js (browser overlay), scripts/repo-analyze.js (CLI) and scripts/api-server.js
// all CONSUME these — the parser/model logic is never forked or re-implemented elsewhere.
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

	return {
		parseRefs,
		resolveRef,
		normalizePath,
		buildModel,
		// small helpers exposed for consumers/tests (e.g. the Node walker reuses the
		// noise list so there is a single source of truth for what to skip)
		baseName,
		dirName,
		extOf,
		isNoiseSegment,
		isNoisePath,
	};
});
