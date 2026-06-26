// snapshot.js — generate data/index.json entirely in-browser (no external runtime).
// Serializes the file index and, optionally, inlines small text files so the
// snapshot can render content as a shareable static page. Saved via the File
// System Access API where available, otherwise offered as a download.
(function (RV) {
	"use strict";
	const { classify, CATEGORY, hasContent, readText } = RV;

	const INLINE_FILE_CAP = 64 * 1024; // per-file inline cap
	const INLINE_TOTAL_BUDGET = 8 * 1024 * 1024; // total inline budget

	/** Build the snapshot object. `onStatus(text)` reports progress while inlining. */
	async function buildSnapshot(state, { inline }, onStatus) {
		const files = [];
		let inlinedBytes = 0;
		let inlinedCount = 0;

		for (let i = 0; i < state.entries.length; i++) {
			const e = state.entries[i];
			const rec = { path: e.path, name: e.name, ext: e.ext, size: e.size, mtime: e.mtime };
			if (inline && hasContent(e)) {
				const cat = classify(e);
				const inlineable = cat === CATEGORY.TEXT || cat === CATEGORY.CODE || cat === CATEGORY.MARKDOWN;
				if (inlineable && (e.size || 0) <= INLINE_FILE_CAP && inlinedBytes < INLINE_TOTAL_BUDGET) {
					try {
						const text = await readText(e);
						rec.inline = text;
						inlinedBytes += text.length;
						inlinedCount++;
					} catch {
						/* skip unreadable file content; metadata still recorded */
					}
				}
			}
			files.push(rec);
			if (onStatus && i % 250 === 0) onStatus(`Building snapshot… ${i}/${state.entries.length}`);
		}

		return {
			version: 1,
			generator: "repo-file-visualizer",
			generatedAt: new Date().toISOString(),
			root: state.source.rootName || "repository",
			count: files.length,
			inlinedCount,
			files,
		};
	}

	/** Build + write/download the snapshot. Returns a short result message. */
	async function exportSnapshot(state, { inline }, onStatus) {
		const snap = await buildSnapshot(state, { inline }, onStatus);
		const json = JSON.stringify(snap);
		const filename = "index.json";

		// Preferred: write directly to a file the user places in data/.
		if (typeof window.showSaveFilePicker === "function") {
			try {
				const handle = await window.showSaveFilePicker({
					suggestedName: filename,
					types: [{ description: "JSON snapshot", accept: { "application/json": [".json"] } }],
				});
				const writable = await handle.createWritable();
				await writable.write(json);
				await writable.close();
				return `Saved ${filename} (${snap.count} files, ${snap.inlinedCount} inlined). Place it in docs/visualizer/data/.`;
			} catch (err) {
				if (err && err.name === "AbortError") return "Snapshot export cancelled.";
				// Fall through to download on any write failure.
			}
		}

		// Universal fallback: download the file for the user to drop into data/.
		const blob = new Blob([json], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
		return `Downloaded ${filename} (${snap.count} files, ${snap.inlinedCount} inlined). Move it into docs/visualizer/data/.`;
	}

	Object.assign(RV, { buildSnapshot, exportSnapshot });
})(window.RV = window.RV || {});
