// filters.js — compute the visible subset from the full index + current settings.
// Pure: reads state.entries/settings, returns derived data. Fast enough to run on
// every (debounced) keystroke.
(function (RV) {
	"use strict";
	const { noiseFlags, pruneTree } = RV;

	/**
	 * Apply all active filters and recompute derived view data.
	 * Returns { filtered, prunedTree, visibleExtCounts, visiblePaths }.
	 */
	function computeFiltered(state) {
		const { entries, settings, tree } = state;
		const q = settings.query.trim().toLowerCase();
		const selExts = settings.selectedExts;
		const useExtFilter = selExts && selExts.length > 0;
		const selSet = useExtFilter ? new Set(selExts) : null;
		const noise = settings.noise;

		const filtered = [];
		const visiblePaths = new Set();
		const visibleExtCounts = new Map();

		for (const e of entries) {
			// Noise filters (each independently toggleable). Memoize per entry so we
			// don't re-split every path on every keystroke.
			const nf = e._noise || (e._noise = noiseFlags(e));
			if (noise.git && nf.git) continue;
			if (noise.deps && nf.deps) continue;
			if (noise.build && nf.build) continue;
			if (noise.dotfiles && nf.dotfile) continue;
			if (noise.binary && nf.binary) continue;

			// Extension facet.
			if (useExtFilter && !selSet.has(e.ext)) continue;

			// Text query over the full path (covers name too).
			if (q && !e.path.toLowerCase().includes(q)) continue;

			filtered.push(e);
			visiblePaths.add(e.path);
			visibleExtCounts.set(e.ext, (visibleExtCounts.get(e.ext) || 0) + 1);
		}

		const prunedTree = tree ? pruneTree(tree, visiblePaths) : null;
		return { filtered, prunedTree, visibleExtCounts, visiblePaths };
	}

	/**
	 * Build the extension facet model for the chips UI: [{ ext, total }], sorted by
	 * total desc then name. Counts come from the noise-filtered universe (so chips
	 * reflect what the noise toggles removed) but ignore the text query / ext selection.
	 */
	function extFacets(state) {
		const { entries, settings } = state;
		const noise = settings.noise;
		const totals = new Map();
		for (const e of entries) {
			const nf = e._noise || (e._noise = noiseFlags(e));
			if (noise.git && nf.git) continue;
			if (noise.deps && nf.deps) continue;
			if (noise.build && nf.build) continue;
			if (noise.dotfiles && nf.dotfile) continue;
			if (noise.binary && nf.binary) continue;
			const key = e.ext || "(none)";
			totals.set(key, (totals.get(key) || 0) + 1);
		}
		return [...totals.entries()]
			.map(([ext, total]) => ({ ext, total }))
			.sort((a, b) => b.total - a.total || a.ext.localeCompare(b.ext));
	}

	Object.assign(RV, { computeFiltered, extFacets });
})(window.RV = window.RV || {});
