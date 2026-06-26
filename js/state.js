// state.js — single source of truth + a minimal pub/sub event bus.
// Modules subscribe to events instead of referencing each other directly.
(function (RV) {
	"use strict";
	const { DEFAULT_SIZE_CAP } = RV;

	const SETTINGS_KEY = "repo-visualizer:settings:v1";

	/** Persisted, user-tweakable settings (the rest of `state` is session-only). */
	function defaultSettings() {
		return {
			theme: "auto", // "auto" | "dark" | "light"
			query: "",
			selectedExts: [], // active extension facet filter (empty = all)
			noise: { git: true, deps: true, build: true, dotfiles: true, binary: false },
			sizeCap: DEFAULT_SIZE_CAP,
			graphNodeCap: 1500,
			refOverlay: false,
			inlineSnapshot: true, // inline small text files when exporting a snapshot
		};
	}

	function loadSettings() {
		const s = defaultSettings();
		try {
			const raw = localStorage.getItem(SETTINGS_KEY);
			if (raw) {
				const saved = JSON.parse(raw);
				// Only merge known fields; ignore transient `query`.
				if (saved.theme) s.theme = saved.theme;
				if (saved.noise) Object.assign(s.noise, saved.noise);
				if (typeof saved.sizeCap === "number") s.sizeCap = saved.sizeCap;
				if (typeof saved.graphNodeCap === "number") s.graphNodeCap = saved.graphNodeCap;
				if (typeof saved.inlineSnapshot === "boolean") s.inlineSnapshot = saved.inlineSnapshot;
			}
		} catch {
			/* corrupt/unavailable storage => defaults */
		}
		return s;
	}

	const state = {
		// Source metadata
		source: { mode: null, rootName: null, handle: null }, // mode: input|fsaccess|snapshot
		// Index
		entries: [], // FileEntry[]
		byPath: new Map(), // path -> FileEntry
		tree: null, // root DirNode
		extCounts: new Map(), // ext -> total count (whole repo)
		// Derived (after filtering)
		filtered: [], // FileEntry[] passing current filters
		prunedTree: null, // DirNode tree containing only filtered files
		visibleExtCounts: new Map(),
		// Selection
		selectedPath: null,
		// Settings (persisted subset)
		settings: loadSettings(),
	};

	function persistSettings() {
		try {
			const { theme, noise, sizeCap, graphNodeCap, inlineSnapshot } = state.settings;
			localStorage.setItem(SETTINGS_KEY, JSON.stringify({ theme, noise, sizeCap, graphNodeCap, inlineSnapshot }));
		} catch {
			/* ignore storage failures (private mode, file://, etc.) */
		}
	}

	// ---- Tiny event bus ---------------------------------------------------

	const listeners = new Map(); // event -> Set<fn>

	function on(event, fn) {
		if (!listeners.has(event)) listeners.set(event, new Set());
		listeners.get(event).add(fn);
		return () => listeners.get(event)?.delete(fn);
	}

	function emit(event, payload) {
		const subs = listeners.get(event);
		if (!subs) return;
		for (const fn of [...subs]) {
			try {
				fn(payload);
			} catch (err) {
				// A buggy subscriber must never break the dispatch loop.
				console.error(`[state] listener for "${event}" threw:`, err);
			}
		}
	}

	/** Canonical event names. */
	const EV = {
		INDEX: "index", // new index loaded
		FILTER: "filter", // filtered set / pruned tree recomputed
		SELECT: "select", // selectedPath changed (payload: FileEntry|null)
		SETTINGS: "settings", // settings changed
		STATUS: "status", // status/progress message (payload: {text, kind, busy})
	};

	/** Convenience: push a status line to the UI. kind: info|warn|error|ok */
	function status(text, kind = "info", busy = false) {
		emit(EV.STATUS, { text, kind, busy });
	}

	Object.assign(RV, { state, persistSettings, on, emit, EV, status });
})(window.RV = window.RV || {});
