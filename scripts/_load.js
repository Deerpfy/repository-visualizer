// _load.js — the ONE shared repo loader for the Node automation layer. Both
// scripts/repo-analyze.js (CLI) and scripts/api-server.js (HTTP) require this so the
// analysis path is never forked. Built-ins only (fs, path, os, child_process, https,
// url) — ZERO npm dependencies.
//
// It turns a local folder OR a git/GitHub URL into the exact inputs js/engine.js
// expects, then runs RV.engine.buildModel — so the CLI, the server and the browser
// all produce the SAME AnalysisModel.
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const { execFile } = require("child_process");
const engine = require("../js/engine.js");

const CLONE_TIMEOUT_MS = 120000;

// ---- input classification --------------------------------------------------

// A reference is remote only if it's unambiguously a URL: http(s)://, SSH git@, or a
// github.com/ prefix. A BARE "owner/repo" is intentionally treated as LOCAL — it is
// indistinguishable from a relative path like "src/foo", so we never auto-clone it.
function looksRemote(input) {
	return /^https?:\/\//i.test(input) || /^git@/i.test(input) || /^(www\.)?github\.com\//i.test(input);
}
const isGitUrl = looksRemote;

/** owner/repo (+ optional branch) from a GitHub-style reference, or null. */
function parseGitHub(input) {
	let s = String(input).trim();
	let m = s.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
	if (m) return { owner: m[1], repo: m[2], branch: null };
	const um = s.match(/^https?:\/\/([^/]+)\/(.*)$/i);
	let host = null;
	if (um) { host = um[1].toLowerCase(); s = um[2]; }
	else s = s.replace(/^(www\.)?github\.com\//i, "");
	if (host && !/(^|\.)github\.com$/.test(host)) return null;
	s = s.replace(/[?#].*$/, "");
	const parts = s.split("/").filter(Boolean);
	if (parts.length < 2) return null;
	const owner = parts[0];
	const repo = parts[1].replace(/\.git$/i, "");
	if (!owner || !repo || owner.includes(".")) return null;
	let branch = null;
	if ((parts[2] === "tree" || parts[2] === "blob") && parts[3]) branch = decodeURIComponent(parts[3]);
	return { owner, repo, branch };
}

// ---- local filesystem walk -------------------------------------------------

/**
 * Walk a local directory into engine entries.
 * @returns {{ rootName, entries, readText, indexHtmlText, packageJson, cleanup }}
 */
async function loadLocal(absRoot, opts) {
	opts = opts || {};
	const includeNoise = !!opts.includeNoise;
	const rootName = opts.rootName || path.basename(absRoot.replace(/[\\/]+$/, "")) || "repository";
	const entries = [];

	async function walk(dir, rel) {
		let dirents;
		try { dirents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
		dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); // deterministic
		for (const d of dirents) {
			const name = d.name;
			if (name === ".git") continue; // never walk the VCS dir
			const childRel = rel ? `${rel}/${name}` : name;
			const abs = path.join(dir, name);
			if (d.isDirectory()) {
				if (!includeNoise && engine.isNoiseSegment(name)) continue; // skip node_modules/dist/…
				await walk(abs, childRel);
			} else if (d.isFile()) {
				let size = 0, mtime = null;
				try { const st = await fs.promises.stat(abs); size = st.size; mtime = st.mtimeMs; } catch { /* unreadable: keep listed */ }
				entries.push({ path: `${rootName}/${childRel}`, size, mtime, _abs: abs });
			}
		}
	}
	await walk(absRoot, "");

	// Read seed inputs (index.html, package.json) — shallowest match wins.
	const shallow = (base) => entries
		.filter((e) => e.path.toLowerCase().endsWith("/" + base))
		.sort((a, b) => a.path.split("/").length - b.path.split("/").length)[0] || null;
	let indexHtmlText = "";
	const idx = shallow("index.html");
	if (idx) { try { indexHtmlText = await fs.promises.readFile(idx._abs, "utf8"); } catch {} }
	let packageJson = null;
	const pkg = shallow("package.json");
	if (pkg) { try { packageJson = JSON.parse(await fs.promises.readFile(pkg._abs, "utf8")); } catch {} }

	const readText = async (entry) => fs.promises.readFile(entry._abs, "utf8");
	return { rootName, entries, readText, indexHtmlText, packageJson, cleanup: async () => {} };
}

// ---- git clone (preferred) + GitHub trees API (fallback) -------------------

function execFileP(cmd, args, options) {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, options || {}, (err, stdout, stderr) => {
			if (err) { err.stderr = stderr; reject(err); } else resolve({ stdout, stderr });
		});
	});
}

async function loadGit(url, opts, onLog) {
	const log = onLog || (() => {});
	const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "repo-analyze-"));
	const dest = path.join(tmp, "repo");
	const gh = parseGitHub(url);
	const rootName = gh ? gh.repo : "repository";
	try {
		log(`Cloning ${url} (shallow)…`);
		// execFile with an ARG ARRAY — never a shell string — so the URL can't inject.
		await execFileP("git", ["clone", "--depth", "1", url, dest], { timeout: CLONE_TIMEOUT_MS, windowsHide: true });
		const loaded = await loadLocal(dest, { includeNoise: opts.includeNoise, rootName });
		loaded.cleanup = async () => { await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {}); };
		return loaded;
	} catch (err) {
		await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
		if (!gh) throw new Error(`git clone failed and no GitHub API fallback for "${url}": ${err.message || err}`);
		log(`git unavailable or clone failed (${err.code || err.message}); falling back to the GitHub API…`);
		return loadGitHubApi(gh, opts, onLog);
	}
}

// ---- https helpers (built-in; no fetch dependency) -------------------------

function httpsRequest(urlStr, headers) {
	return new Promise((resolve, reject) => {
		let req;
		try {
			const u = new URL(urlStr);
			if (u.protocol !== "https:") return reject(new Error("Only https URLs are allowed."));
			req = https.request({ method: "GET", hostname: u.hostname, path: u.pathname + u.search, headers: Object.assign({ "User-Agent": "repo-visualizer" }, headers || {}) }, (res) => {
				const chunks = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
			});
		} catch (e) { return reject(e); }
		req.on("error", reject);
		req.setTimeout(60000, () => req.destroy(new Error("request timed out")));
		req.end();
	});
}
function ghHeaders() {
	const h = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
	const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN; // env only — never committed
	if (token) h.Authorization = "Bearer " + token;
	return h;
}
async function ghApiJson(url) {
	const res = await httpsRequest(url, ghHeaders());
	if (res.status === 404) throw new Error("Repository not found (private? set GITHUB_TOKEN).");
	if (res.status === 401) throw new Error("Invalid GITHUB_TOKEN.");
	if (res.status === 403) throw new Error("GitHub API rate limit or access denied (set GITHUB_TOKEN to raise limits).");
	if (res.status >= 400) throw new Error("GitHub returned HTTP " + res.status + ".");
	return JSON.parse(res.body);
}

async function loadGitHubApi(gh, opts, onLog) {
	const log = onLog || (() => {});
	const { owner, repo } = gh;
	let branch = gh.branch;
	if (!branch) {
		const info = await ghApiJson(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
		branch = info.default_branch || "main";
	}
	log(`Fetching file tree ${owner}/${repo}@${branch} via the GitHub API…`);
	const tree = await ghApiJson(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
	const encPath = (p) => p.split("/").map(encodeURIComponent).join("/");
	const rawBase = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}/`;
	const entries = (tree.tree || [])
		.filter((n) => n.type === "blob")
		.map((n) => ({ path: `${repo}/${n.path}`, size: typeof n.size === "number" ? n.size : 0, mtime: null, _url: rawBase + encPath(n.path) }));

	const readText = async (entry) => {
		const res = await httpsRequest(entry._url, {});
		if (res.status >= 400) throw new Error("HTTP " + res.status);
		return res.body;
	};
	// Seed inputs over the network (shallowest index.html / package.json).
	const shallow = (base) => entries.filter((e) => e.path.toLowerCase().endsWith("/" + base)).sort((a, b) => a.path.split("/").length - b.path.split("/").length)[0] || null;
	let indexHtmlText = "";
	const idx = shallow("index.html");
	if (idx) { try { indexHtmlText = await readText(idx); } catch {} }
	let packageJson = null;
	const pkg = shallow("package.json");
	if (pkg) { try { packageJson = JSON.parse(await readText(pkg)); } catch {} }

	return { rootName: repo, entries, readText, indexHtmlText, packageJson, cleanup: async () => {} };
}

// ---- public: load + analyze ------------------------------------------------

/**
 * Resolve any input (local path or git/GitHub URL) to engine inputs.
 * Validates local paths (must exist and be a directory). Never shells out the URL.
 */
async function loadRepo(input, opts, onLog) {
	opts = opts || {};
	if (!input || typeof input !== "string") throw new Error("A repository path or git URL is required.");
	if (looksRemote(input)) return loadGit(input, opts, onLog);

	const abs = path.resolve(input);
	const st = await fs.promises.stat(abs).catch(() => null);
	if (!st) throw new Error(`Path does not exist: ${input}`);
	if (!st.isDirectory()) throw new Error(`Not a directory: ${input}`);
	return loadLocal(abs, opts);
}

/**
 * Full pipeline: load → engine.buildModel → cleanup. Returns the AnalysisModel plus
 * the raw entries (used by the server's containment view) and the resolved root name.
 */
async function analyze(input, opts, onLog) {
	opts = opts || {};
	const loaded = await loadRepo(input, opts, onLog);
	try {
		const model = await engine.buildModel({
			rootName: loaded.rootName,
			entries: loaded.entries,
			readText: loaded.readText,
			indexHtmlText: loaded.indexHtmlText,
			packageJson: loaded.packageJson,
			includeNoise: opts.includeNoise,
			generatedAt: opts.generatedAt || new Date().toISOString(),
		});
		return { model, rootName: loaded.rootName, entries: loaded.entries };
	} finally {
		try { await loaded.cleanup(); } catch { /* best-effort temp cleanup */ }
	}
}

module.exports = { analyze, loadRepo, isGitUrl, looksRemote, parseGitHub, engine };
