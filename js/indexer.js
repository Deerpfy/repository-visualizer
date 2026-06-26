// indexer.js — turn raw enumerated entries into the in-memory index + folder tree.
// METADATA ONLY: never reads file contents here.
(function (RV) {
	"use strict";
	const { extOf, basename, dirname } = RV;

	let _id = 0;
	const nextId = () => `n${(_id++).toString(36)}`;

	/**
	 * A raw entry is the lowest-common-denominator descriptor produced by any source:
	 *   { path, size, mtime, file?, handle?, inline? }
	 * `path` includes the picked root folder name as its first segment.
	 */
	function makeEntry(raw) {
		const path = raw.path.replace(/\\/g, "/").replace(/^\.?\//, "");
		const name = basename(path);
		return {
			id: nextId(),
			path,
			name,
			dir: dirname(path),
			ext: extOf(name),
			size: typeof raw.size === "number" ? raw.size : 0,
			mtime: raw.mtime ?? null,
			file: raw.file ?? null, // File object (Tier 1)
			handle: raw.handle ?? null, // FileSystemFileHandle (Tier 2)
			inline: raw.inline ?? null, // inlined text content (Tier 3 snapshot)
			url: raw.url ?? null, // remote raw URL (git-URL loader)
		};
	}

	/** DirNode: a folder in the tree. */
	function makeDir(path, name, depth) {
		return {
			type: "dir",
			id: nextId(),
			path,
			name,
			depth,
			dirs: new Map(), // name -> DirNode
			files: [], // FileEntry[]
			fileCount: 0, // total files in subtree (filled in finalize)
		};
	}

	/**
	 * Build the index from raw entries. Returns { entries, byPath, tree, extCounts }.
	 */
	function buildIndex(rawEntries) {
		const entries = [];
		const byPath = new Map();
		const extCounts = new Map();
		const root = makeDir("", "", -1);

		for (const raw of rawEntries) {
			if (!raw || !raw.path) continue;
			const entry = makeEntry(raw);
			if (!entry.path || entry.path.endsWith("/")) continue;
			if (byPath.has(entry.path)) continue; // dedupe
			entries.push(entry);
			byPath.set(entry.path, entry);
			extCounts.set(entry.ext, (extCounts.get(entry.ext) || 0) + 1);

			// Walk/insert directory chain.
			const segs = entry.path.split("/");
			let node = root;
			let acc = "";
			for (let i = 0; i < segs.length - 1; i++) {
				const seg = segs[i];
				acc = acc ? `${acc}/${seg}` : seg;
				let child = node.dirs.get(seg);
				if (!child) {
					child = makeDir(acc, seg, i);
					node.dirs.set(seg, child);
				}
				node = child;
			}
			node.files.push(entry);
		}

		finalizeCounts(root);
		sortTree(root);
		return { entries, byPath, tree: root, extCounts };
	}

	/** Recursively compute subtree file counts. */
	function finalizeCounts(node) {
		let total = node.files.length;
		for (const child of node.dirs.values()) total += finalizeCounts(child);
		node.fileCount = total;
		return total;
	}

	/** Sort dirs (folders first, alpha) and files (alpha) for stable display. */
	function sortTree(node) {
		const cmp = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
		node.dirsSorted = [...node.dirs.values()].sort(cmp);
		node.files.sort(cmp);
		for (const child of node.dirsSorted) sortTree(child);
	}

	/**
	 * Build a pruned copy of the tree containing only the given visible entries
	 * (a Set of paths). Folders with no surviving descendants are dropped.
	 */
	function pruneTree(tree, visiblePathSet) {
		function walk(node) {
			const files = node.files.filter((f) => visiblePathSet.has(f.path));
			const dirs = [];
			for (const child of node.dirsSorted || node.dirs.values()) {
				const pruned = walk(child);
				if (pruned) dirs.push(pruned);
			}
			if (files.length === 0 && dirs.length === 0) return null;
			return {
				type: "dir",
				id: node.id,
				path: node.path,
				name: node.name,
				depth: node.depth,
				dirsSorted: dirs,
				files,
				fileCount: files.length + dirs.reduce((s, d) => s + d.fileCount, 0),
			};
		}
		const root = walk(tree);
		return (
			root || { type: "dir", id: tree.id, path: "", name: "", depth: -1, dirsSorted: [], files: [], fileCount: 0 }
		);
	}

	Object.assign(RV, { makeEntry, buildIndex, pruneTree });
})(window.RV = window.RV || {});
