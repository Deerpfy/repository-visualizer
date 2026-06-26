// sources.js — the three-tier, browser-only file-access model.
//   Tier 1 (primary, universal): <input type=file webkitdirectory>
//   Tier 2 (enhancement, Chromium): File System Access API + IndexedDB handle
//   Tier 3 (static fallback): fetch data/index.json snapshot
// Plus lazy, on-demand content reading. Designed around browser security:
// never assume a server or network; everything degrades.
(function (RV) {
	"use strict";

	// ---- Tier 1: directory <input webkitdirectory> -----------------------

	/** Convert a FileList from a webkitdirectory input into raw entries (metadata only). */
	function rawEntriesFromFileList(fileList) {
		const out = [];
		for (const file of fileList) {
			const rel = file.webkitRelativePath || file.name;
			out.push({ path: rel, size: file.size, mtime: file.lastModified || null, file });
		}
		return out;
	}

	// ---- Tier 2: File System Access API ----------------------------------

	function supportsFSAccess() {
		return typeof window.showDirectoryPicker === "function";
	}

	/** Open a directory via FS Access API. Returns the handle (or null if cancelled). */
	async function pickDirectoryHandle() {
		try {
			return await window.showDirectoryPicker({ mode: "read" });
		} catch (err) {
			if (err && err.name === "AbortError") return null; // user cancelled
			throw err;
		}
	}

	/**
	 * Recursively enumerate a directory handle into raw entries (metadata only —
	 * file contents are read later, on click, via the stored handle).
	 */
	async function enumerateDirectoryHandle(rootHandle, onProgress) {
		const out = [];
		let count = 0;
		const rootName = rootHandle.name || "root";

		async function walk(dirHandle, prefix) {
			for await (const handle of dirHandle.values()) {
				const path = `${prefix}/${handle.name}`;
				if (handle.kind === "file") {
					let size = 0;
					let mtime = null;
					try {
						const f = await handle.getFile();
						size = f.size;
						mtime = f.lastModified || null;
					} catch {
						/* unreadable entry: keep it listed with zeroed metadata */
					}
					out.push({ path, size, mtime, handle });
					if (++count % 200 === 0 && onProgress) onProgress(count);
				} else if (handle.kind === "directory") {
					await walk(handle, path);
				}
			}
		}

		await walk(rootHandle, rootName);
		if (onProgress) onProgress(count);
		return out;
	}

	// ---- IndexedDB persistence for the directory handle ------------------

	const DB_NAME = "repo-visualizer";
	const STORE = "handles";
	const HANDLE_KEY = "lastDir";

	function openDB() {
		return new Promise((resolve, reject) => {
			let req;
			try {
				req = indexedDB.open(DB_NAME, 1);
			} catch (err) {
				reject(err);
				return;
			}
			req.onupgradeneeded = () => req.result.createObjectStore(STORE);
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
	}

	async function saveDirHandle(handle) {
		try {
			const db = await openDB();
			await new Promise((resolve, reject) => {
				const tx = db.transaction(STORE, "readwrite");
				tx.objectStore(STORE).put(handle, HANDLE_KEY);
				tx.oncomplete = resolve;
				tx.onerror = () => reject(tx.error);
			});
			db.close();
		} catch {
			/* persistence is best-effort */
		}
	}

	async function loadDirHandle() {
		try {
			const db = await openDB();
			const handle = await new Promise((resolve, reject) => {
				const tx = db.transaction(STORE, "readonly");
				const req = tx.objectStore(STORE).get(HANDLE_KEY);
				req.onsuccess = () => resolve(req.result || null);
				req.onerror = () => reject(req.error);
			});
			db.close();
			return handle || null;
		} catch {
			return null;
		}
	}

	/** Verify (and if needed request) read permission for a persisted handle. */
	async function ensureReadPermission(handle, interactive) {
		if (!handle || typeof handle.queryPermission !== "function") return false;
		const opts = { mode: "read" };
		if ((await handle.queryPermission(opts)) === "granted") return true;
		if (interactive && (await handle.requestPermission(opts)) === "granted") return true;
		return false;
	}

	// ---- Tier 3: snapshot (data/index.json) ------------------------------

	/**
	 * Try to load a static snapshot from data/index.json next to index.html.
	 * On a bare file:// page this fetch may be blocked by the browser — that's
	 * expected and handled: we return null and the picker remains the path.
	 */
	async function loadSnapshot() {
		try {
			const res = await fetch("data/index.json", { cache: "no-store" });
			if (!res.ok) return null;
			const json = await res.json();
			return normalizeSnapshot(json);
		} catch {
			return null; // blocked by file:// policy, missing, or invalid — non-fatal
		}
	}

	/** Validate + normalize a snapshot object into { meta, rawEntries }. */
	function normalizeSnapshot(json) {
		if (!json || !Array.isArray(json.files)) return null;
		const rawEntries = json.files
			.filter((f) => f && typeof f.path === "string")
			.map((f) => ({
				path: f.path,
				size: typeof f.size === "number" ? f.size : 0,
				mtime: f.mtime ?? null,
				inline: typeof f.inline === "string" ? f.inline : null,
			}));
		return {
			meta: { version: json.version, generatedAt: json.generatedAt, root: json.root, count: rawEntries.length },
			rawEntries,
		};
	}

	// ---- Lazy content reading (used by the viewer on click) --------------

	/** Resolve a File object for an entry, or null if content is not available. */
	async function getFile(entry) {
		if (entry.file) return entry.file;
		if (entry.handle && typeof entry.handle.getFile === "function") {
			return await entry.handle.getFile();
		}
		return null;
	}

	/** True if the entry's bytes can be read in this session. */
	function hasContent(entry) {
		return !!(entry.file || entry.handle || entry.inline != null || entry.url);
	}

	/** Fetch a remote entry (GitHub raw URL). Throws a friendly error on failure. */
	async function fetchRemote(entry) {
		let res;
		try {
			res = await fetch(entry.url);
		} catch {
			throw new Error("Could not fetch file (network error).");
		}
		if (!res.ok) throw new Error("Could not fetch file (HTTP " + res.status + ").");
		return res;
	}

	/** Read an entry's content as text (UTF-8). Throws if no content source. */
	async function readText(entry) {
		if (entry.inline != null) return entry.inline;
		const file = await getFile(entry);
		if (file) return await file.text();
		if (entry.url) return await (await fetchRemote(entry)).text();
		throw new Error("no-content-source");
	}

	/** Read an entry's content as an ArrayBuffer. Throws if no content source. */
	async function readBytes(entry) {
		const file = await getFile(entry);
		if (file) return await file.arrayBuffer();
		if (entry.url) return await (await fetchRemote(entry)).arrayBuffer();
		throw new Error("no-content-source");
	}

	/**
	 * Produce an object URL for an entry (for <img>). Returns { url, revoke } or null.
	 * Remote entries return their raw URL directly; snapshots may carry a data URL.
	 */
	async function objectUrlFor(entry) {
		const file = await getFile(entry);
		if (file) {
			const url = URL.createObjectURL(file);
			return { url, revoke: () => URL.revokeObjectURL(url) };
		}
		if (entry.url) return { url: entry.url, revoke: () => {} }; // remote raw URL — <img> loads it directly
		if (entry.inline != null && entry.inline.startsWith("data:")) {
			return { url: entry.inline, revoke: () => {} };
		}
		return null;
	}

	Object.assign(RV, {
		rawEntriesFromFileList, supportsFSAccess, pickDirectoryHandle, enumerateDirectoryHandle,
		saveDirHandle, loadDirHandle, ensureReadPermission, loadSnapshot, normalizeSnapshot,
		getFile, hasContent, readText, readBytes, objectUrlFor,
	});
})(window.RV = window.RV || {});
