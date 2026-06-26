// classify.js — file-type classification, language mapping, noise detection, caps.
// Pure data + functions; no DOM, no vendor deps.
(function (RV) {
	"use strict";
	const { extOf, basename, hashStr } = RV;

	/** Content categories used by the viewer. */
	const CATEGORY = {
		MARKDOWN: "markdown",
		CODE: "code",
		TEXT: "text",
		IMAGE: "image",
		BINARY: "binary",
	};

	/** Default size cap (bytes) above which content is NOT auto-rendered. */
	const DEFAULT_SIZE_CAP = 2 * 1024 * 1024; // 2 MB

	const set = (arr) => new Set(arr);

	const MD_EXTS = set(["md", "markdown", "mdx"]);

	const IMAGE_EXTS = set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "avif"]);

	// Plain-text / data files shown as monospace text.
	const TEXT_EXTS = set([
		"txt", "log", "csv", "tsv", "text", "rtf", "diff", "patch", "env", "lock",
		"map", "list", "out", "err", "nfo", "me", "todo", "conf", "cfg",
	]);

	// Known-binary extensions: never auto-rendered as text.
	const BINARY_EXTS = set([
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

	/**
	 * Extension -> highlight.js language id. Covers the full required map.
	 * Languages beyond highlight.js's "common" build are vendored separately
	 * (see vendor/hljs-languages) and registered at load.
	 */
	const LANG_MAP = {
		// C family
		c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp",
		// .NET
		cs: "csharp", vb: "vbnet", fs: "fsharp", fsx: "fsharp",
		// JVM / Android
		java: "java", kt: "kotlin", kts: "kotlin", scala: "scala", groovy: "groovy", gradle: "groovy", clj: "clojure", cljs: "clojure",
		// Go / Rust / Swift / Dart
		go: "go", rs: "rust", swift: "swift", dart: "dart",
		// JS / TS
		js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
		ts: "typescript", tsx: "typescript",
		// Scripting
		py: "python", rb: "ruby", php: "php", pl: "perl", pm: "perl", lua: "lua",
		sh: "bash", bash: "bash", zsh: "bash", ksh: "bash",
		ps1: "powershell", psm1: "powershell", bat: "dos", cmd: "dos",
		r: "r", ex: "elixir", exs: "elixir", erl: "erlang", hrl: "erlang", hs: "haskell",
		// Apple
		m: "objectivec", mm: "objectivec",
		// Data / query
		sql: "sql",
		// Config / markup
		json: "json", jsonc: "json", yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini",
		xml: "xml", html: "xml", htm: "xml", xhtml: "xml", svg: "xml",
		css: "css", scss: "scss", sass: "scss", less: "less",
		cmake: "cmake", dockerfile: "dockerfile",
		// MSBuild / .NET project files are XML
		props: "xml", targets: "xml", csproj: "xml", vbproj: "xml", fsproj: "xml",
		vcxproj: "xml", proj: "xml", nuspec: "xml", config: "xml", resx: "xml",
		plist: "xml", xaml: "xml",
		// graphql etc. (in common build)
		graphql: "graphql", gql: "graphql",
	};

	// Source-like extensions = anything we have a language mapping for.
	const CODE_EXTS = set(Object.keys(LANG_MAP));

	// Extensionless filenames that should still be treated as source/text.
	const SPECIAL_CODE_NAMES = new Map([
		["dockerfile", "dockerfile"],
		["makefile", "makefile"],
		["gnumakefile", "makefile"],
		["cmakelists.txt", "cmake"],
		["jenkinsfile", "groovy"],
		["vagrantfile", "ruby"],
		["gemfile", "ruby"],
		["rakefile", "ruby"],
		["procfile", "plaintext"],
		[".editorconfig", "ini"],
		[".gitignore", "plaintext"],
		[".gitattributes", "plaintext"],
		[".dockerignore", "plaintext"],
		[".npmrc", "ini"],
		[".env", "bash"],
	]);

	/** Returns hljs language id for an entry, or null if unknown/plain. */
	function languageFor(entry) {
		const lowerName = entry.name.toLowerCase();
		if (SPECIAL_CODE_NAMES.has(lowerName)) {
			const lang = SPECIAL_CODE_NAMES.get(lowerName);
			return lang === "plaintext" ? null : lang;
		}
		// Handle composite names like "webpack.config.js" via the real extension.
		return LANG_MAP[entry.ext] || null;
	}

	/** Classify an index entry into a CATEGORY. Metadata-only (no content read). */
	function classify(entry) {
		const ext = entry.ext;
		const lowerName = entry.name.toLowerCase();
		if (MD_EXTS.has(ext)) return CATEGORY.MARKDOWN;
		if (IMAGE_EXTS.has(ext)) return CATEGORY.IMAGE;
		if (BINARY_EXTS.has(ext)) return CATEGORY.BINARY;
		if (CODE_EXTS.has(ext)) return CATEGORY.CODE;
		if (SPECIAL_CODE_NAMES.has(lowerName)) {
			return SPECIAL_CODE_NAMES.get(lowerName) === "plaintext" ? CATEGORY.TEXT : CATEGORY.CODE;
		}
		if (TEXT_EXTS.has(ext)) return CATEGORY.TEXT;
		// Dotfiles with no extension (e.g. ".babelrc") are usually text/config.
		if (ext === "" && lowerName.startsWith(".")) return CATEGORY.TEXT;
		// Unknown: treat as text (readable monospace). The viewer sniffs for binary
		// content and falls back to a metadata-only view if it looks like a blob.
		return CATEGORY.TEXT;
	}

	/** Heuristic: does this decoded text look like binary (null bytes / control noise)? */
	function looksBinary(text, sampleLen = 4096) {
		const n = Math.min(text.length, sampleLen);
		if (n === 0) return false;
		let suspicious = 0;
		for (let i = 0; i < n; i++) {
			const c = text.charCodeAt(i);
			if (c === 0) return true; // NUL => definitely binary
			// Control chars except tab(9), LF(10), CR(13), and the replacement char.
			if (c < 9 || (c > 13 && c < 32) || c === 0xfffd) suspicious++;
		}
		return suspicious / n > 0.1;
	}

	/** Color palette per category (CSS color strings) for list dots and graph nodes. */
	const CATEGORY_COLOR = {
		[CATEGORY.MARKDOWN]: "#4aa3ff",
		[CATEGORY.CODE]: "#7ee081",
		[CATEGORY.TEXT]: "#c9c9c9",
		[CATEGORY.IMAGE]: "#f0a35e",
		[CATEGORY.BINARY]: "#9a9a9a",
		dir: "#f2c14e",
	};

	/** Deterministic hue for an extension, for a bit of per-type color variety. */
	function extHue(ext) {
		return hashStr(ext || "none") % 360;
	}

	// ---- Noise detection (default-hidden paths) ---------------------------

	const NOISE_DIRS = [
		".git", "node_modules", ".svn", ".hg", ".idea", ".vs", ".vscode",
		"__pycache__", ".pytest_cache", ".mypy_cache", ".gradle", ".cache",
	];
	const BUILD_DIRS = [
		"bin", "obj", "dist", "build", "out", "target", "coverage", ".next",
		".nuxt", ".turbo", ".parcel-cache", "vendor", "packages", "_site", "venv", ".venv",
	];

	/**
	 * Classify a path against noise buckets so the UI can hide each independently.
	 * Returns flags: { git, deps, build, dotfile, binary }.
	 */
	function noiseFlags(entry) {
		const segs = entry.path.split("/");
		let git = false, deps = false, build = false;
		for (const s of segs.slice(0, -1)) {
			const low = s.toLowerCase();
			if (NOISE_DIRS.includes(low)) git = true; // VCS / editor / tooling noise
			if (low === "node_modules") deps = true;
			if (BUILD_DIRS.includes(low)) build = true;
		}
		const dotfile = basename(entry.path).startsWith(".");
		const binary = BINARY_EXTS.has(entry.ext);
		return { git, deps, build, dotfile, binary };
	}

	Object.assign(RV, {
		CATEGORY, DEFAULT_SIZE_CAP, MD_EXTS, IMAGE_EXTS, TEXT_EXTS, BINARY_EXTS, LANG_MAP, CODE_EXTS,
		languageFor, classify, looksBinary, CATEGORY_COLOR, extHue, noiseFlags,
	});
})(window.RV = window.RV || {});
