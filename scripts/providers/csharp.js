// providers/csharp.js — OPTIONAL accurate C# call-graph provider. It drives the Roslyn
// analyzer in tools/CSharpCallGraph via the installed `dotnet` SDK (invoked with an arg
// ARRAY, never a shell). Node built-ins only. If `dotnet` or the tool is unavailable it
// throws, and the caller falls back to the regex heuristic — so this never breaks the
// dependency-free, offline guarantees of the visualizer itself.
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

const TOOL_DIR = path.resolve(__dirname, "..", "..", "tools", "CSharpCallGraph");
const DLL = path.join(TOOL_DIR, "bin", "Release", "net8.0", "CSharpCallGraph.dll");
const CSPROJ = path.join(TOOL_DIR, "CSharpCallGraph.csproj");

let _dotnet; // cached availability

function execFileP(cmd, args, opts) {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, opts || {}, (err, stdout, stderr) => {
			if (err) { err.stderr = stderr; reject(err); } else resolve({ stdout, stderr });
		});
	});
}

/** Is the .NET SDK present? (cached) */
async function hasDotnet() {
	if (_dotnet !== undefined) return _dotnet;
	try { await execFileP("dotnet", ["--version"], { timeout: 20000, windowsHide: true }); _dotnet = true; }
	catch { _dotnet = false; }
	return _dotnet;
}

/** True if this provider can run at all (SDK present + tool sources present). */
async function available() {
	return fs.existsSync(CSPROJ) && (await hasDotnet());
}

let _buildPromise; // shared so concurrent callers (startup warmup + a request) build once.

/** Build the analyzer once (restores Roslyn the first time). Idempotent + concurrency-safe. */
async function ensureBuilt(onLog) {
	if (fs.existsSync(DLL)) return true;
	if (!_buildPromise) {
		_buildPromise = (async () => {
			if (onLog) onLog("Building the C# analyzer (first run — restores Roslyn from NuGet; this can take a minute)…");
			await execFileP("dotnet", ["build", "-c", "Release", "--nologo", "-v", "quiet"], { cwd: TOOL_DIR, timeout: 600000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
			return fs.existsSync(DLL);
		})().catch((e) => { _buildPromise = undefined; throw e; }); // allow retry on failure
	}
	return _buildPromise;
}

/** Build the analyzer ahead of time (called at server startup) so the first analyze is fast.
 *  Best-effort: resolves to false (never throws) if the SDK/tool isn't available. */
async function warmup(onLog) {
	try { if (await available()) return await ensureBuilt(onLog); } catch (e) { if (onLog) onLog("C# analyzer warmup skipped: " + e.message); }
	return false;
}

/**
 * Analyze a C# project directory with Roslyn.
 * @returns {{ provider, files, functions:[{id,file,name,kind,line}], calls:[{from,to,self,parallel,via}], warnings }}
 */
async function analyze(rootDir, rootName, onLog) {
	if (!fs.existsSync(CSPROJ)) throw new Error("C# analyzer tool is missing (tools/CSharpCallGraph).");
	if (!(await hasDotnet())) throw new Error("dotnet SDK not found on PATH.");
	if (!(await ensureBuilt(onLog))) throw new Error("C# analyzer failed to build.");
	const out = path.join(os.tmpdir(), `cscg-${process.pid}-${Date.now()}.json`);
	try {
		if (onLog) onLog("Running Roslyn C# call-graph analysis (compiler-accurate)…");
		// --out writes JSON to a file, so MSBuild/host noise can never corrupt the result.
		await execFileP("dotnet", [DLL, "--root", rootDir, "--root-name", rootName, "--out", out],
			{ timeout: 600000, windowsHide: true, maxBuffer: 128 * 1024 * 1024 });
		const json = JSON.parse(fs.readFileSync(out, "utf8"));
		if (!json || !Array.isArray(json.functions)) throw new Error("analyzer produced no result.");
		return json;
	} finally {
		try { fs.unlinkSync(out); } catch { /* best-effort */ }
	}
}

module.exports = { analyze, available, hasDotnet, warmup, TOOL_DIR };
