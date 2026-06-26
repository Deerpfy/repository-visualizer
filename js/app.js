// app.js — entry point. Wires sources, index, filters, list, graph and viewer
// together and owns the top-level UI behavior. Loaded last, after the vendored
// UMD globals (vis/marked/DOMPurify/hljs) and the other RV modules.
(function (RV) {
	"use strict";
	const { debounce, state, on, emit, EV, status, persistSettings } = RV;
	const { buildIndex, computeFiltered, extFacets } = RV;
	const {
		rawEntriesFromFileList, supportsFSAccess, pickDirectoryHandle, enumerateDirectoryHandle,
		saveDirHandle, loadDirHandle, ensureReadPermission, loadSnapshot,
	} = RV;
	const { createListView, createGraphView, createViewer, exportSnapshot } = RV;

	// ---- element lookup ---------------------------------------------------

	const dom = {
		openFolder: document.getElementById("open-folder"),
		folderInput: document.getElementById("folder-input"),
		openFs: document.getElementById("open-fsaccess"),
		reopen: document.getElementById("reopen-last"),
		sourceLabel: document.getElementById("source-label"),
		filter: document.getElementById("filter"),
		matchCount: document.getElementById("match-count"),
		extChips: document.getElementById("ext-chips"),
		noise: {
			git: document.getElementById("noise-git"),
			deps: document.getElementById("noise-deps"),
			build: document.getElementById("noise-build"),
			dotfiles: document.getElementById("noise-dotfiles"),
			binary: document.getElementById("noise-binary"),
		},
		expandAll: document.getElementById("expand-all"),
		collapseAll: document.getElementById("collapse-all"),
		fileList: document.getElementById("file-list"),
		graphPanel: document.getElementById("graph-panel"),
		viewerPanel: document.getElementById("viewer-panel"),
		vsplit: document.getElementById("vsplit"),
		fitGraph: document.getElementById("fit-graph"),
		graphExpandAll: document.getElementById("graph-expand-all"),
		refOverlay: document.getElementById("ref-overlay"),
		shotRes: document.getElementById("shot-res"),
		screenshot: document.getElementById("btn-screenshot"),
		snapshot: document.getElementById("btn-snapshot"),
		snapshotInline: document.getElementById("snapshot-inline"),
		theme: document.getElementById("btn-theme"),
		vendorWarning: document.getElementById("vendor-warning"),
		statusEl: document.getElementById("status"),
	};

	// ---- vendor presence / graceful degradation --------------------------

	function checkVendors() {
		const missing = [];
		if (!window.vis || !window.vis.Network) missing.push("vis-network (graph disabled)");
		if (!window.marked) missing.push("marked (markdown shown as plain text)");
		if (!window.hljs) missing.push("highlight.js (code shown without highlighting)");
		if (!window.DOMPurify) missing.push("DOMPurify (HTML/markdown/SVG rendering disabled for safety — shown as text)");
		if (missing.length && dom.vendorWarning) {
			dom.vendorWarning.hidden = false;
			dom.vendorWarning.querySelector(".vw-list").textContent = missing.join("; ");
		}
		return missing;
	}

	// ---- views ------------------------------------------------------------

	const viewer = createViewer(dom.viewerPanel, { sizeCapRef: () => state.settings.sizeCap });
	const list = createListView(dom.fileList, { onSelect: (entry) => selectEntry(entry, "list") });
	const graph = createGraphView(dom.graphPanel, {
		onSelect: (entry) => selectEntry(entry, "graph"),
		getRootName: () => state.source.rootName,
	});

	function selectEntry(entry, from) {
		if (!entry) return;
		state.selectedPath = entry.path;
		emit(EV.SELECT, entry);
		viewer.show(entry);
		if (from !== "list") list.setSelected(entry.path);
		if (from !== "graph" && graph.available) graph.setSelected(entry.path);
	}

	// ---- load pipeline ----------------------------------------------------

	async function loadRawEntries(rawEntries, source) {
		if (!rawEntries || !rawEntries.length) { status("No files found in the selected folder.", "warn"); return; }
		status(`Indexing ${rawEntries.length} files…`, "info", true);
		// Yield once so the busy status paints before a large synchronous index build.
		await new Promise((r) => setTimeout(r, 0));

		const { entries, byPath, tree, extCounts } = buildIndex(rawEntries);
		state.entries = entries;
		state.byPath = byPath;
		state.tree = tree;
		state.extCounts = extCounts;
		state.source = source;
		state.selectedPath = null;

		if (dom.sourceLabel) dom.sourceLabel.textContent = `${source.rootName || "repository"} · ${entries.length} files`;
		emit(EV.INDEX, { count: entries.length });
		viewer.clear();
		recomputeFilters();

		const note = source.mode === "snapshot" ? " (snapshot — pick the folder to view file contents)" : "";
		status(`Loaded ${entries.length} files from “${source.rootName}”.${note}`, "ok");
	}

	// The graph rebuild restarts physics, so it runs on a short trailing debounce —
	// keeping list filtering snappy while the graph catches up after typing settles.
	const updateGraph = debounce(() => {
		if (!graph.available || !state.prunedTree) return;
		// A structural rebuild clears any reference overlay; keep the toggle honest.
		if (dom.refOverlay && dom.refOverlay.checked) { dom.refOverlay.checked = false; state.settings.refOverlay = false; }
		const gstats = graph.setTree(state.prunedTree, state.settings.graphNodeCap) || {};
		if (state.selectedPath) graph.setSelected(state.selectedPath);
		if (gstats.truncated) {
			status(`Showing ${state.filtered.length} files. Graph capped at ${state.settings.graphNodeCap} nodes — expand folders to see more.`, "info");
		}
	}, 300);

	function recomputeFilters() {
		if (!state.tree) return;
		const { filtered, prunedTree, visibleExtCounts } = computeFiltered(state);
		state.filtered = filtered;
		state.prunedTree = prunedTree;
		state.visibleExtCounts = visibleExtCounts;

		// List + chips update immediately (cheap, virtualized).
		list.setTree(prunedTree, state.settings.query);
		if (dom.matchCount) dom.matchCount.textContent = `${filtered.length} / ${state.entries.length}`;
		renderChips();
		if (state.selectedPath) list.setSelected(state.selectedPath);
		updateGraph();
	}

	// ---- extension facet chips -------------------------------------------

	function renderChips() {
		if (!dom.extChips) return;
		const facets = extFacets(state).slice(0, 60); // keep the chip bar bounded
		const selected = new Set(state.settings.selectedExts);
		dom.extChips.replaceChildren();
		for (const { ext, total } of facets) {
			const isNone = ext === "(none)";
			const value = isNone ? "" : ext;
			const btn = document.createElement("button");
			btn.type = "button";
			btn.className = "chip" + (selected.has(value) ? " active" : "");
			btn.dataset.ext = value;
			btn.textContent = `${isNone ? "(none)" : "." + ext} ${total}`;
			btn.addEventListener("click", () => toggleExt(value));
			dom.extChips.appendChild(btn);
		}
	}

	function toggleExt(ext) {
		const arr = state.settings.selectedExts;
		const i = arr.indexOf(ext);
		if (i >= 0) arr.splice(i, 1);
		else arr.push(ext);
		recomputeFilters();
	}

	// ---- source controls --------------------------------------------------

	function rootNameFromEntries(rawEntries) {
		const first = rawEntries.find((e) => e.path && e.path.includes("/"));
		return first ? first.path.split("/")[0] : (rawEntries[0]?.path || "repository");
	}

	dom.openFolder?.addEventListener("click", () => dom.folderInput?.click());

	dom.folderInput?.addEventListener("change", (e) => {
		const files = e.target.files;
		if (!files || !files.length) return;
		const raw = rawEntriesFromFileList(files);
		loadRawEntries(raw, { mode: "input", rootName: rootNameFromEntries(raw), handle: null });
		dom.folderInput.value = ""; // allow re-picking the same folder
	});

	if (supportsFSAccess() && dom.openFs) {
		dom.openFs.hidden = false;
		dom.openFs.addEventListener("click", async () => {
			try {
				const handle = await pickDirectoryHandle();
				if (!handle) return;
				status("Reading folder…", "info", true);
				const raw = await enumerateDirectoryHandle(handle, (n) => status(`Reading folder… ${n} files`, "info", true));
				await loadRawEntries(raw, { mode: "fsaccess", rootName: handle.name, handle });
				saveDirHandle(handle);
			} catch (err) {
				status(`Could not open folder: ${err.message || err}`, "error");
			}
		});
	}

	async function tryReopen(handle, interactive) {
		const ok = await ensureReadPermission(handle, interactive);
		if (!ok) { if (interactive) status("Permission to reopen the folder was denied.", "warn"); return; }
		status("Reopening folder…", "info", true);
		const raw = await enumerateDirectoryHandle(handle, (n) => status(`Reading folder… ${n} files`, "info", true));
		await loadRawEntries(raw, { mode: "fsaccess", rootName: handle.name, handle });
		saveDirHandle(handle);
	}

	// ---- filter + noise wiring -------------------------------------------

	const onFilter = debounce(() => {
		state.settings.query = dom.filter.value;
		recomputeFilters();
	}, 160);
	dom.filter?.addEventListener("input", onFilter);

	for (const [key, cb] of Object.entries(dom.noise)) {
		if (!cb) continue;
		cb.checked = state.settings.noise[key];
		cb.addEventListener("change", () => {
			state.settings.noise[key] = cb.checked;
			persistSettings();
			recomputeFilters();
		});
	}

	dom.expandAll?.addEventListener("click", () => list.expandAll());
	dom.collapseAll?.addEventListener("click", () => list.collapseAll());

	// ---- toolbar ----------------------------------------------------------

	dom.fitGraph?.addEventListener("click", () => graph.available && graph.fit());

	dom.graphExpandAll?.addEventListener("click", () => {
		if (!graph.available) { status("Graph is not available.", "warn"); return; }
		if (!state.entries.length) { status("Open a folder first.", "warn"); return; }
		status("Expanding every folder in the graph…", "info", true);
		// Defer so the busy status paints before a large (re)layout.
		setTimeout(() => {
			const st = graph.expandAllFolders() || {};
			if (st.truncated) status(`Expanded to the ${st.shown}-node safety limit (repo has ~${st.projected} nodes). Filter to narrow it down.`, "warn");
			else status(`Expanded all folders — ${st.shown} nodes.`, "ok");
		}, 0);
	});

	dom.screenshot?.addEventListener("click", async () => {
		if (!graph.available) { status("Graph is not available.", "warn"); return; }
		if (!state.entries.length) { status("Open a folder first.", "warn"); return; }
		const { width, height } = screenshotResolution();
		try {
			status(`Rendering ${width}×${height} graph screenshot…`, "info", true);
			const blob = await graph.exportImage({ width, height });
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = `graph-${(state.source.rootName || "repo").replace(/[^\w.-]+/g, "_")}-${width}x${height}.png`;
			document.body.appendChild(a);
			a.click();
			a.remove();
			setTimeout(() => URL.revokeObjectURL(url), 1500);
			status(`Saved graph screenshot (${width}×${height}, ${Math.round(blob.size / 1024)} KB).`, "ok");
		} catch (err) {
			status(`Screenshot failed: ${err.message || err}`, "error");
		}
	});

	function screenshotResolution() {
		const sel = (dom.shotRes && dom.shotRes.value) || "current";
		if (sel === "current") {
			const r = dom.graphPanel.getBoundingClientRect();
			const dpr = window.devicePixelRatio || 1;
			return { width: Math.max(64, Math.round(r.width * dpr)), height: Math.max(64, Math.round(r.height * dpr)) };
		}
		const [w, h] = sel.split("x").map(Number);
		return { width: w, height: h };
	}

	dom.refOverlay?.addEventListener("change", () => {
		state.settings.refOverlay = dom.refOverlay.checked;
		if (graph.available) {
			if (dom.refOverlay.checked) status("Building reference overlay (reads file contents)…", "info", true);
			graph.setRefOverlay(dom.refOverlay.checked, (msg) => status(msg, "info"));
		}
	});

	dom.snapshot?.addEventListener("click", async () => {
		if (!state.entries.length) { status("Open a folder before exporting a snapshot.", "warn"); return; }
		try {
			status("Exporting snapshot…", "info", true);
			const msg = await exportSnapshot(state, { inline: !!dom.snapshotInline?.checked }, (m) => status(m, "info", true));
			status(msg, "ok");
		} catch (err) {
			status(`Snapshot export failed: ${err.message || err}`, "error");
		}
	});

	// ---- theme ------------------------------------------------------------

	const themeOrder = ["auto", "dark", "light"];
	const darkLink = document.getElementById("hljs-dark");
	const lightLink = document.getElementById("hljs-light");

	function resolvedTheme() {
		if (state.settings.theme !== "auto") return state.settings.theme;
		return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
	}
	function applyTheme() {
		const t = resolvedTheme();
		document.documentElement.dataset.theme = t;
		if (darkLink) darkLink.disabled = t !== "dark";
		if (lightLink) lightLink.disabled = t !== "light";
		if (dom.theme) dom.theme.textContent = `Theme: ${state.settings.theme}`;
		if (graph.available) graph.refreshTheme();
	}
	dom.theme?.addEventListener("click", () => {
		const i = themeOrder.indexOf(state.settings.theme);
		state.settings.theme = themeOrder[(i + 1) % themeOrder.length];
		persistSettings();
		applyTheme();
	});
	window.matchMedia?.("(prefers-color-scheme: light)").addEventListener?.("change", () => {
		if (state.settings.theme === "auto") applyTheme();
	});

	// ---- global keyboard --------------------------------------------------

	document.addEventListener("keydown", (e) => {
		const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "");
		if (e.key === "/" && !typing) { e.preventDefault(); dom.filter?.focus(); dom.filter?.select(); }
		else if (e.key === "Escape" && document.activeElement === dom.filter) {
			dom.filter.value = ""; state.settings.query = ""; recomputeFilters(); dom.filter.blur();
		}
	});

	// ---- vertical split resizer ------------------------------------------

	(function initSplitter() {
		if (!dom.vsplit || !dom.graphPanel) return;
		let dragging = false;
		const onMove = (clientY) => {
			const main = dom.graphPanel.parentElement;
			const rect = main.getBoundingClientRect();
			const h = Math.max(120, Math.min(rect.height - 120, clientY - rect.top));
			dom.graphPanel.style.height = `${h}px`;
			dom.graphPanel.style.flex = "0 0 auto";
			window.dispatchEvent(new Event("resize")); // let vis-network re-fit
		};
		dom.vsplit.addEventListener("pointerdown", (e) => { dragging = true; dom.vsplit.setPointerCapture(e.pointerId); e.preventDefault(); });
		dom.vsplit.addEventListener("pointermove", (e) => { if (dragging) onMove(e.clientY); });
		dom.vsplit.addEventListener("pointerup", (e) => { dragging = false; try { dom.vsplit.releasePointerCapture(e.pointerId); } catch {} });
	})();

	window.addEventListener("resize", () => list.relayout());

	// ---- status bar -------------------------------------------------------

	on(EV.STATUS, ({ text, kind, busy }) => {
		if (!dom.statusEl) return;
		dom.statusEl.textContent = text;
		dom.statusEl.className = `statusbar ${kind || "info"}` + (busy ? " busy" : "");
	});

	// ---- boot -------------------------------------------------------------

	async function boot() {
		checkVendors();
		applyTheme();
		if (dom.snapshotInline) dom.snapshotInline.checked = state.settings.inlineSnapshot;
		dom.snapshotInline?.addEventListener("change", () => { state.settings.inlineSnapshot = dom.snapshotInline.checked; persistSettings(); });
		if (dom.filter) dom.filter.value = "";

		// Tier 2: offer to reopen the last folder if a handle was persisted.
		if (supportsFSAccess()) {
			const handle = await loadDirHandle();
			if (handle && dom.reopen) {
				dom.reopen.hidden = false;
				dom.reopen.textContent = `Reopen “${handle.name}”`;
				dom.reopen.addEventListener("click", () => tryReopen(handle, true));
				if (await ensureReadPermission(handle, false)) tryReopen(handle, false); // silent if still granted
			}
		}

		// Tier 3: auto-load a static snapshot if one is present and nothing loaded yet.
		if (!state.entries.length) {
			const snap = await loadSnapshot();
			if (snap && !state.entries.length) {
				loadRawEntries(snap.rawEntries, { mode: "snapshot", rootName: snap.meta.root || "repository", handle: null });
			}
		}

		if (!state.entries.length) status("Open a folder to begin (works in every modern browser, no server needed).", "info");
	}

	boot();
})(window.RV = window.RV || {});
