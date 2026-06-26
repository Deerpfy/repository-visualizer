#!/usr/bin/env node
// api-server.js — OPTIONAL local HTTP API for the analysis engine. Node's built-in
// http only, ZERO npm dependencies. It reuses the SAME loader + engine + Markdown
// builder as the CLI (scripts/_load.js → js/engine.js → js/mapmd.js) so every surface
// returns identical results.
//
// SECURITY: binds to 127.0.0.1 ONLY (never 0.0.0.0). The `repo` parameter is validated
// (local paths must resolve under an allowed root; only http(s)/git URLs are remote).
// git is invoked via execFile with an arg array (never a shell string). No eval; file
// content is never executed. Tokens are read from env (GITHUB_TOKEN), never committed.
//
// Usage:  node scripts/api-server.js [--port 4317] [--root <allowed-local-root>]
//   GET  /api/health
//   POST /api/analyze            { repo, includeNoise? }      -> full AnalysisModel
//   GET  /api/flow?repo=         [&includeNoise=1]            -> { root, entries, terminals, cycles, layers, metrics }
//   GET  /api/graph?repo=&mode=  flow|containment             -> { nodes, edges }
//   GET  /api/export?repo=&format= md|json [&write=1]         -> Markdown text or JSON (write=1 → docs/repo-map.md)
//   GET  /                       (static)                     -> the visualizer UI
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { analyze, looksRemote } = require("./_load.js");
const { buildMarkdownMap } = require("../js/mapmd.js");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const NAME = "repository-visualizer";
const VERSION = readVersion();
const MAX_BODY = 256 * 1024; // request body cap (413 beyond)

// CLI flags.
let PORT = parseInt(process.env.PORT || "4317", 10);
let ALLOWED_ROOT = path.resolve(process.env.REPO_ROOT || process.cwd());
(function parseArgs() {
	const a = process.argv.slice(2);
	for (let i = 0; i < a.length; i++) {
		if (a[i] === "--port") PORT = parseInt(a[++i], 10);
		else if (a[i] === "--root") ALLOWED_ROOT = path.resolve(a[++i]);
	}
	if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) { console.error("Invalid --port."); process.exit(2); }
})();

function readVersion() {
	try {
		const txt = fs.readFileSync(path.join(PROJECT_ROOT, "README.md"), "utf8");
		const m = txt.match(/^version:\s*(.+)$/m);
		return m ? m[1].trim() : "0.0.0";
	} catch { return "0.0.0"; }
}

// ---- helpers ---------------------------------------------------------------

function sendJson(res, status, obj) {
	const body = JSON.stringify(obj, null, 2);
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
	res.end(body);
}
function sendText(res, status, text, type) {
	res.writeHead(status, { "Content-Type": (type || "text/plain") + "; charset=utf-8", "Cache-Control": "no-store" });
	res.end(text);
}
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

/** Validate the `repo` parameter. Local paths must resolve UNDER the allowed root. */
function assertAllowedRepo(repo) {
	if (!repo || typeof repo !== "string") throw httpError(400, "Missing 'repo' parameter.");
	if (/[\x00-\x1f]/.test(repo)) throw httpError(400, "Invalid 'repo' (control characters)."); // reject NUL/poison-byte
	// SSH form (git@host:…) would `git clone` over SSH to an arbitrary host with the server
	// user's keys — refuse it; this surface allows ONLY http(s) git URLs.
	if (/^git@/i.test(repo)) throw httpError(400, "SSH git URLs are not allowed; use an https URL.");
	if (looksRemote(repo)) {
		if (/^[a-z][a-z0-9+.-]*:\/\//i.test(repo) && !/^https?:\/\//i.test(repo)) throw httpError(400, "Only http(s) git URLs are allowed.");
		return { kind: "remote", repo };
	}
	const abs = path.resolve(repo);
	const rel = path.relative(ALLOWED_ROOT, abs);
	if (rel.startsWith("..") || path.isAbsolute(rel)) throw httpError(403, `Local repo must be under the allowed root (${ALLOWED_ROOT}). Restart with --root to widen it.`);
	return { kind: "local", repo: abs };
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		let size = 0; const chunks = [];
		req.on("data", (c) => {
			size += c.length;
			if (size > MAX_BODY) { reject(httpError(413, "Request body too large.")); req.destroy(); return; }
			chunks.push(c);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

/** Build a containment graph (folder→child) directly from entries — no engine needed. */
function containmentGraph(rootName, entries) {
	const nodes = new Map(); // id -> node
	const edges = [];
	const ensureDir = (p, name) => { if (!nodes.has(p)) nodes.set(p, { id: p, name, type: "dir" }); };
	ensureDir(rootName, rootName);
	for (const e of entries) {
		const segs = e.path.split("/");
		let acc = segs[0];
		ensureDir(acc, segs[0]);
		for (let i = 1; i < segs.length; i++) {
			const parent = acc;
			acc = acc + "/" + segs[i];
			const isFile = i === segs.length - 1;
			if (isFile) nodes.set(acc, { id: acc, name: segs[i], type: "file", size: e.size || 0 });
			else ensureDir(acc, segs[i]);
			edges.push({ from: parent, to: acc });
		}
	}
	// Dedupe edges.
	const seen = new Set();
	const uniq = edges.filter((x) => { const k = x.from + " " + x.to; if (seen.has(k)) return false; seen.add(k); return true; });
	return { nodes: [...nodes.values()], edges: uniq };
}

async function runAnalyze(repoParam, opts) {
	const checked = assertAllowedRepo(repoParam);
	return analyze(checked.repo, opts || {});
}

// ---- static file serving (the visualizer UI) -------------------------------

const MIME = {
	".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript",
	".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
	".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".map": "application/json",
	".md": "text/markdown", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
};
async function serveStatic(req, res, pathname) {
	if (req.method !== "GET") throw httpError(405, "Method not allowed.");
	let rel = decodeURIComponent(pathname.replace(/^\/+/, ""));
	if (rel === "") rel = "index.html";
	const abs = path.resolve(PROJECT_ROOT, rel);
	// Never serve outside the project root (path-traversal guard).
	const relCheck = path.relative(PROJECT_ROOT, abs);
	if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) throw httpError(403, "Forbidden.");
	let st;
	try { st = await fs.promises.stat(abs); } catch { throw httpError(404, "Not found."); }
	if (st.isDirectory()) throw httpError(404, "Not found.");
	const ext = path.extname(abs).toLowerCase();
	res.writeHead(200, { "Content-Type": (MIME[ext] || "application/octet-stream") + (MIME[ext] && MIME[ext].startsWith("text") ? "; charset=utf-8" : ""), "Cache-Control": "no-store" });
	fs.createReadStream(abs).pipe(res);
}

// ---- request router --------------------------------------------------------

const server = http.createServer(async (req, res) => {
	let p = "/";
	try {
		// Parse INSIDE the try — a malformed request URI makes new URL() throw, and we must
		// still answer (otherwise the socket hangs with no response).
		const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
		p = u.pathname;
		if (p === "/api/health") return sendJson(res, 200, { ok: true, name: NAME, version: VERSION });

		if (p === "/api/analyze") {
			if (req.method !== "POST") throw httpError(405, "Use POST with a JSON body { repo }.");
			const raw = await readBody(req);
			let body = {};
			if (raw.trim()) { try { body = JSON.parse(raw); } catch { throw httpError(400, "Body must be valid JSON."); } }
			const { model } = await runAnalyze(body.repo, { includeNoise: !!body.includeNoise });
			return sendJson(res, 200, model);
		}

		if (p === "/api/flow") {
			const { model } = await runAnalyze(u.searchParams.get("repo"), { includeNoise: isTrue(u.searchParams.get("includeNoise")) });
			return sendJson(res, 200, { root: model.root, generatedAt: model.generatedAt, entries: model.entries, terminals: model.terminals, cycles: model.cycles, layers: model.layers, orphans: model.orphans, metrics: model.metrics });
		}

		if (p === "/api/graph") {
			const mode = (u.searchParams.get("mode") || "flow").toLowerCase();
			if (mode !== "flow" && mode !== "containment") throw httpError(400, "mode must be 'flow' or 'containment'.");
			const { model, rootName, entries } = await runAnalyze(u.searchParams.get("repo"), { includeNoise: isTrue(u.searchParams.get("includeNoise")) });
			if (mode === "containment") return sendJson(res, 200, containmentGraph(rootName, entries));
			return sendJson(res, 200, { nodes: model.nodes, edges: model.edges });
		}

		if (p === "/api/export") {
			const format = (u.searchParams.get("format") || "md").toLowerCase();
			if (format !== "md" && format !== "json") throw httpError(400, "format must be 'md' or 'json'.");
			const { model } = await runAnalyze(u.searchParams.get("repo"), { includeNoise: isTrue(u.searchParams.get("includeNoise")) });
			if (format === "json") {
				if (isTrue(u.searchParams.get("write"))) { const f = await writeExport("json", JSON.stringify(model, null, 2)); return sendJson(res, 200, { written: f, model }); }
				return sendJson(res, 200, model);
			}
			const md = buildMarkdownMap(model, { title: `Repository map — ${model.root}` });
			if (isTrue(u.searchParams.get("write"))) { const f = await writeExport("md", md); return sendJson(res, 200, { written: f }); }
			return sendText(res, 200, md, "text/markdown");
		}

		if (p.startsWith("/api/")) throw httpError(404, "Unknown endpoint.");

		// Anything else: serve the static visualizer UI.
		return await serveStatic(req, res, p);
	} catch (err) {
		const status = err && err.status ? err.status : 500;
		if (p.startsWith("/api/")) sendJson(res, status, { error: String(err.message || err) });
		else sendText(res, status, String(err.message || err));
	}
});

function isTrue(v) { return v === "1" || v === "true" || v === "yes"; }

// write=1 always targets the project's docs/ — never an arbitrary path.
async function writeExport(format, content) {
	const dir = path.join(PROJECT_ROOT, "docs");
	await fs.promises.mkdir(dir, { recursive: true });
	const file = path.join(dir, format === "md" ? "repo-map.md" : "repo-map.json");
	await fs.promises.writeFile(file, content);
	return path.relative(PROJECT_ROOT, file);
}

server.listen(PORT, "127.0.0.1", () => {
	console.log(`Repository Visualizer API → http://127.0.0.1:${PORT}`);
	console.log(`  UI:        http://127.0.0.1:${PORT}/`);
	console.log(`  Health:    http://127.0.0.1:${PORT}/api/health`);
	console.log(`  Allowed local root: ${ALLOWED_ROOT}`);
});
