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
	const { loadGitRepo, setToken, clearToken, initToken } = RV;
	const { createListView, createGraphView, createFlowView, createViewer, exportSnapshot, exportRepoMap } = RV;

	// ---- element lookup ---------------------------------------------------

	const dom = {
		openFolder: document.getElementById("open-folder"),
		folderInput: document.getElementById("folder-input"),
		openFs: document.getElementById("open-fsaccess"),
		reopen: document.getElementById("reopen-last"),
		sourceLabel: document.getElementById("source-label"),
		repoUrl: document.getElementById("repo-url"),
		loadUrl: document.getElementById("load-url"),
		ghToken: document.getElementById("gh-token"),
		ghTokenRemember: document.getElementById("gh-token-remember"),
		ghTokenClear: document.getElementById("gh-token-clear"),
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
		flowPanel: document.getElementById("flow-panel"),
		viewerPanel: document.getElementById("viewer-panel"),
		vsplit: document.getElementById("vsplit"),
		modeGraph: document.getElementById("mode-graph"),
		modeFlow: document.getElementById("mode-flow"),
		fitGraph: document.getElementById("fit-graph"),
		graphExpandAll: document.getElementById("graph-expand-all"),
		refOverlay: document.getElementById("ref-overlay"),
		shotRes: document.getElementById("shot-res"),
		screenshot: document.getElementById("btn-screenshot"),
		snapshot: document.getElementById("btn-snapshot"),
		exportMap: document.getElementById("btn-export-map"),
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
	// Directed flow diagram (sits alongside the containment graph; off by default).
	const flow = createFlowView(dom.flowPanel, {
		onSelect: (meta) => { const real = state.byPath.get(meta.path); if (real) selectEntry(real, "flow"); },
		getRootName: () => state.source.rootName,
	});

	function selectEntry(entry, from) {
		if (!entry) return;
		state.selectedPath = entry.path;
		emit(EV.SELECT, entry);
		viewer.show(entry);
		if (from !== "list") list.setSelected(entry.path);
		if (from !== "graph" && graph.available) graph.setSelected(entry.path);
		if (from !== "flow" && flow.available) flow.setSelected(entry.path);
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

	// ---- flow diagram (directed module graph from the shared engine) -----

	let viewMode = "graph"; // "graph" (containment) | "flow" (directed)
	let flowModel = null;
	let flowDirty = true; // rebuild the model on the next Flow render / export

	// Read the shallowest entry with a given basename (index.html / package.json) to
	// seed entry points. Returns "" if absent or unreadable — analysis still proceeds.
	async function readNamed(name) {
		const matches = state.entries.filter((e) => e.name.toLowerCase() === name);
		if (!matches.length) return "";
		matches.sort((a, b) => a.path.split("/").length - b.path.split("/").length);
		try { return await RV.readText(matches[0]); } catch { return ""; }
	}

	// Build (and cache) the AnalysisModel from the current index. Reuses RV.readText so
	// content is read lazily, exactly like the viewer/overlay.
	async function buildFlowModel() {
		if (flowModel && !flowDirty) return flowModel;
		if (!RV.engine || !RV.engine.buildModel) throw new Error("analysis engine (js/engine.js) failed to load");
		if (!state.entries.length) return null;
		const indexHtmlText = await readNamed("index.html");
		let packageJson = null;
		const pkgText = await readNamed("package.json");
		if (pkgText) { try { packageJson = JSON.parse(pkgText); } catch { /* malformed package.json — ignore */ } }
		const model = await RV.engine.buildModel({
			rootName: state.source.rootName || "repository",
			entries: state.entries,
			readText: RV.readText,
			indexHtmlText,
			packageJson,
			includeNoise: false,
			generatedAt: new Date().toISOString(),
		});
		flowModel = model;
		flowDirty = false;
		return model;
	}

	async function renderFlow() {
		if (!flow.available) { status("Flow diagram unavailable — vendor/vis-network.min.js missing.", "warn"); return; }
		if (!state.entries.length) { status("Open a folder first to see the module flow.", "warn"); return; }
		if (!flowDirty && flowModel) { flow.fit(); return; }
		status("Analyzing module flow (reads file contents)…", "info", true);
		await new Promise((r) => setTimeout(r, 0)); // let the busy status paint
		try {
			const model = await buildFlowModel();
			const st = flow.setModel(model) || {};
			const cyc = model.cycles.length;
			let msg = cyc ? `${cyc} import cycle(s) found — highlighted in red.` : "No import cycles — flow reads start → END.";
			if (st.truncated) msg = `Showing the ${st.shown} most-connected of ${model.nodes.length} modules. ` + msg;
			status(msg, cyc ? "warn" : "ok");
		} catch (err) {
			status(`Flow analysis failed: ${err.message || err}`, "error");
		}
	}

	function setViewMode(mode) {
		if (mode === viewMode) { (mode === "flow" ? flow : graph).available && (mode === "flow" ? flow : graph).fit(); return; }
		viewMode = mode;
		const isFlow = mode === "flow";
		dom.graphPanel.hidden = isFlow;
		dom.flowPanel.hidden = !isFlow;
		dom.modeGraph?.classList.toggle("active", !isFlow);
		dom.modeFlow?.classList.toggle("active", isFlow);
		dom.modeGraph?.setAttribute("aria-pressed", String(!isFlow));
		dom.modeFlow?.setAttribute("aria-pressed", String(isFlow));
		// Containment-only controls don't apply to the flow view.
		if (dom.graphExpandAll) dom.graphExpandAll.disabled = isFlow;
		if (dom.refOverlay) dom.refOverlay.disabled = isFlow;
		window.dispatchEvent(new Event("resize")); // let vis re-fit the now-visible canvas
		if (isFlow) renderFlow();
	}
	dom.modeGraph?.addEventListener("click", () => setViewMode("graph"));
	dom.modeFlow?.addEventListener("click", () => setViewMode("flow"));

	// A new index invalidates the cached model; rebuild if Flow is currently showing.
	on(EV.INDEX, () => { flowDirty = true; flowModel = null; if (viewMode === "flow") renderFlow(); });

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

	// ---- remote: load a GitHub repo by URL (opt-in; the only networked feature) ----

	async function loadFromUrl() {
		const input = (dom.repoUrl?.value || "").trim();
		if (!input) { status("Paste a GitHub repo URL first (e.g. github.com/owner/repo).", "warn"); dom.repoUrl?.focus(); return; }
		if (dom.ghToken) setToken(dom.ghToken.value, !!dom.ghTokenRemember?.checked);
		try {
			status("Loading repository from GitHub…", "info", true);
			const { rawEntries, meta } = await loadGitRepo(input, (m) => status(m, "info", true));
			if (!rawEntries.length) { status("That repository appears to be empty.", "warn"); return; }
			await loadRawEntries(rawEntries, { mode: "remote", rootName: meta.rootName, handle: null });
			let msg = `Loaded ${rawEntries.length} files from ${meta.owner}/${meta.repo}@${meta.branch}.`;
			if (meta.truncated) status(`${msg} GitHub truncated the list (repo is very large).`, "warn");
			else status(msg, "ok");
		} catch (err) {
			status(err.message || String(err), "error");
		}
	}

	dom.loadUrl?.addEventListener("click", loadFromUrl);
	dom.repoUrl?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); loadFromUrl(); } });
	dom.ghTokenClear?.addEventListener("click", () => {
		clearToken();
		if (dom.ghToken) dom.ghToken.value = "";
		if (dom.ghTokenRemember) dom.ghTokenRemember.checked = false;
		status("GitHub token cleared.", "ok");
	});

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

	function activeView() { return viewMode === "flow" ? flow : graph; }

	dom.fitGraph?.addEventListener("click", () => { const v = activeView(); if (v.available) v.fit(); });

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
		const view = activeView();
		if (!view.available) { status(`${viewMode === "flow" ? "Flow diagram" : "Graph"} is not available.`, "warn"); return; }
		if (!state.entries.length) { status("Open a folder first.", "warn"); return; }
		if (viewMode === "flow" && !flow.hasModel()) { status("Switch to Flow and let the diagram render before a screenshot.", "warn"); return; }
		const { width, height } = screenshotResolution();
		try {
			status(`Rendering ${width}×${height} ${viewMode} screenshot…`, "info", true);
			const blob = await view.exportImage({ width, height });
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = `${viewMode}-${(state.source.rootName || "repo").replace(/[^\w.-]+/g, "_")}-${width}x${height}.png`;
			document.body.appendChild(a);
			a.click();
			a.remove();
			setTimeout(() => URL.revokeObjectURL(url), 1500);
			status(`Saved ${viewMode} screenshot (${width}×${height}, ${Math.round(blob.size / 1024)} KB).`, "ok");
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

	// Export the directed flow as a Markdown "full picture" map (docs/repo-map.md).
	dom.exportMap?.addEventListener("click", async () => {
		if (!state.entries.length) { status("Open a folder before exporting the map.", "warn"); return; }
		if (!exportRepoMap) { status("Map export unavailable — js/flowexport.js failed to load.", "warn"); return; }
		try {
			status("Building repository map…", "info", true);
			await new Promise((r) => setTimeout(r, 0));
			const model = await buildFlowModel();
			if (!model) { status("Nothing to export yet.", "warn"); return; }
			const msg = await exportRepoMap(model, {
				title: `Repository map — ${state.source.rootName || "repository"}`,
				suggestedName: "repo-map.md",
			}, (m) => status(m, "info", true));
			status(msg, "ok");
		} catch (err) {
			status(`Map export failed: ${err.message || err}`, "error");
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
		if (flow.available) flow.refreshTheme();
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
			// Size both panels; only the visible one is laid out (the other is [hidden]).
			for (const p of [dom.graphPanel, dom.flowPanel]) {
				if (!p) continue;
				p.style.height = `${h}px`;
				p.style.flex = "0 0 auto";
			}
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

		// Remote loader: restore a remembered GitHub token (if any) into the field.
		const savedToken = initToken();
		if (savedToken && dom.ghToken) {
			dom.ghToken.value = savedToken;
			if (dom.ghTokenRemember) dom.ghTokenRemember.checked = true;
		}

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
