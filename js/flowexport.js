// flowexport.js — browser glue for the Markdown "full picture" export. It turns an
// AnalysisModel (RV.engine.buildModel) into Markdown via RV.buildMarkdownMap (the
// pure, shared builder in js/mapmd.js) and saves it with the File System Access API
// where available, otherwise offers a download. Mirrors js/snapshot.js exactly.
(function (RV) {
	"use strict";

	const DEFAULT_NAME = "repo-map.md";

	/**
	 * Build + write/download the Markdown map. Returns a short result message.
	 * @param {object} model  AnalysisModel
	 * @param {object} [meta] passed through to buildMarkdownMap ({ title, commands, … })
	 * @param {function} [onStatus] progress callback
	 */
	async function exportRepoMap(model, meta, onStatus) {
		if (!RV.buildMarkdownMap) throw new Error("Markdown builder unavailable: js/mapmd.js failed to load.");
		if (!model || !model.nodes) throw new Error("No analysis model — switch to Flow to build one first.");
		if (onStatus) onStatus("Rendering Markdown map…");
		const md = RV.buildMarkdownMap(model, meta || {});
		const filename = (meta && meta.suggestedName) || DEFAULT_NAME;

		// Preferred: write directly via a save dialog (Chromium).
		if (typeof window.showSaveFilePicker === "function") {
			try {
				const handle = await window.showSaveFilePicker({
					suggestedName: filename,
					types: [{ description: "Markdown", accept: { "text/markdown": [".md"] } }],
				});
				const writable = await handle.createWritable();
				await writable.write(md);
				await writable.close();
				return `Saved ${filename} (${model.metrics.files} files, ${model.metrics.edges} edges). Place it in docs/.`;
			} catch (err) {
				if (err && err.name === "AbortError") return "Map export cancelled.";
				// Fall through to a download on any write failure.
			}
		}

		// Universal fallback: download for the user to drop into docs/.
		const blob = new Blob([md], { type: "text/markdown" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
		return `Downloaded ${filename} (${model.metrics.files} files, ${model.metrics.edges} edges). Move it into docs/.`;
	}

	Object.assign(RV, { exportRepoMap });
})(window.RV = window.RV || {});
