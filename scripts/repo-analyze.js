#!/usr/bin/env node
// repo-analyze.js — "API by scripts": analyze ANY repository (a local folder or a
// git/GitHub URL) headlessly and emit the JSON model + the Markdown "full picture".
// CommonJS, Node built-ins only, ZERO npm dependencies. It require()s the SAME
// js/engine.js and js/mapmd.js the browser uses — one source of truth.
//
// Usage:
//   node scripts/repo-analyze.js <path-or-giturl> [--json <out.json>] [--md <out.md>] [--include-noise] [--stdout]
//
//   <path-or-giturl>   "." (this repo), any folder path, or https://github.com/owner/repo
//   --json <file>      write the full AnalysisModel JSON          (default: docs/repo-map.json only if asked)
//   --md   <file>      write the Markdown map                     (default: docs/repo-map.md)
//   --include-noise    also analyze node_modules/dist/… (hidden by default)
//   --stdout           print the Markdown to stdout
"use strict";

const fs = require("fs");
const path = require("path");
const { analyze } = require("./_load.js");
const { buildMarkdownMap } = require("../js/mapmd.js");

const PROJECT_ROOT = path.resolve(__dirname, ".."); // the repository-visualizer project

function usage() {
	console.error("Usage: node scripts/repo-analyze.js <path-or-giturl> [--json <out.json>] [--md <out.md>] [--include-noise] [--stdout]");
}

// Resolve an output path. Absolute paths are allowed as-is (explicit opt-in); relative
// paths resolve under the project root and MUST NOT escape it (no traversal writes).
function resolveOut(arg, def) {
	const raw = arg != null ? arg : def;
	if (path.isAbsolute(raw)) return raw;
	const resolved = path.resolve(PROJECT_ROOT, raw);
	const rel = path.relative(PROJECT_ROOT, resolved);
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		throw new Error(`Refusing to write outside the project (use an absolute --path to override): ${raw}`);
	}
	return resolved;
}

async function writeFileEnsured(file, content) {
	await fs.promises.mkdir(path.dirname(file), { recursive: true });
	await fs.promises.writeFile(file, content);
}

async function main() {
	const argv = process.argv.slice(2);
	let input = null, mdArg, jsonArg;
	const flags = { includeNoise: false, stdout: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--include-noise") flags.includeNoise = true;
		else if (a === "--stdout") flags.stdout = true;
		else if (a === "--md") mdArg = argv[++i];
		else if (a === "--json") jsonArg = argv[++i];
		else if (a === "-h" || a === "--help") { usage(); process.exit(0); }
		else if (a.startsWith("--")) { console.error(`Unknown flag: ${a}`); usage(); process.exit(2); }
		else if (input == null) input = a;
		else { console.error(`Unexpected argument: ${a}`); usage(); process.exit(2); }
	}
	if (input == null) { usage(); process.exit(2); }

	const wantMd = mdArg !== undefined;
	const wantJson = jsonArg !== undefined;
	const wantDefault = !wantMd && !wantJson && !flags.stdout; // nothing asked → write the default map
	const mdPath = wantMd || wantDefault ? resolveOut(mdArg, "docs/repo-map.md") : null;
	const jsonPath = wantJson ? resolveOut(jsonArg, "docs/repo-map.json") : null;

	// Logs + summary go to stderr when Markdown is streamed to stdout, else stdout.
	const sink = flags.stdout ? console.error : console.log;

	const { model } = await analyze(input, {
		includeNoise: flags.includeNoise,
		generatedAt: new Date().toISOString(),
	}, (m) => console.error(m));

	const md = buildMarkdownMap(model, { title: `Repository map — ${model.root}` });

	if (mdPath) { await writeFileEnsured(mdPath, md); sink(`Wrote ${path.relative(process.cwd(), mdPath) || mdPath}`); }
	if (jsonPath) { await writeFileEnsured(jsonPath, JSON.stringify(model, null, 2)); sink(`Wrote ${path.relative(process.cwd(), jsonPath) || jsonPath}`); }
	if (flags.stdout) process.stdout.write(md + "\n");

	const m = model.metrics;
	sink(`Analyzed "${model.root}": ${m.files} files, ${m.edges} edges, ${m.entryCount} entries, ${m.terminalCount} terminals, ${m.cycleCount} cycles.`);
}

main().catch((err) => { console.error("Error:", err.message || err); process.exit(1); });
