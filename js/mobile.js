// mobile.js — additive mobile enhancement for Repository Visualizer.
//
// On small viewports the three-pane desktop shell can't be shown at once, so this
// module provides a bottom workspace tab bar (Files / Graph / Code) and folds the
// dense toolbar into a Tools bottom sheet. It is intentionally decoupled from the
// RV module graph: it only toggles a data attribute / class that the mobile CSS
// layer reacts to, and reuses the app's existing "resize" hook so vis-network and
// the virtualized list re-measure the newly visible pane.
//
// Loaded last and fully defensive: a failure here must never break the desktop app.
(function (RV) {
	"use strict";

	const app = document.getElementById("app");
	const tabbar = document.getElementById("tabbar");
	if (!app || !tabbar) return;

	const mq = window.matchMedia("(max-width: 767px)");
	const tabs = Array.prototype.slice.call(tabbar.querySelectorAll(".tab"));
	const STORE = "repo-visualizer:mobile-tab";

	// ----------------------------- workspace tabs -----------------------------

	function fireResize() { window.dispatchEvent(new Event("resize")); }

	// vis-network can initialize while its pane is display:none (0x0). When the
	// Graph workspace becomes visible we re-fire resize after layout settles so it
	// re-measures the canvas, then frame the view via the app's own Fit handler.
	function nudgeGraph() {
		requestAnimationFrame(fireResize);
		setTimeout(() => {
			fireResize();
			const fit = document.getElementById("fit-graph");
			if (fit) fit.click(); // app.js guards this on view.available
		}, 240);
	}

	function setTab(name, persist) {
		if (!name) return;
		app.dataset.mobileTab = name;
		for (const t of tabs) t.setAttribute("aria-pressed", t.dataset.tab === name ? "true" : "false");
		if (persist !== false) { try { localStorage.setItem(STORE, name); } catch (e) {} }
		// Defer so the pane swap lands before vis/list re-measure.
		if (name === "graph") nudgeGraph();
		else requestAnimationFrame(fireResize);
	}

	for (const t of tabs) t.addEventListener("click", () => setTab(t.dataset.tab));

	// Restore the last-used workspace; default to Files.
	let initial = "files";
	try { initial = localStorage.getItem(STORE) || "files"; } catch (e) {}
	if (!tabs.some((t) => t.dataset.tab === initial)) initial = "files";
	setTab(initial, false);

	// Opening a file jumps to the Code workspace — but only when coming from Files,
	// so tapping a node while exploring the Graph doesn't yank you off the diagram.
	if (RV && typeof RV.on === "function" && RV.EV) {
		RV.on(RV.EV.SELECT, (entry) => {
			if (!mq.matches || !entry) return;
			if (app.dataset.mobileTab === "files") setTab("code");
		});
	}

	// ------------------------------ Tools sheet ------------------------------

	const toggle = document.getElementById("tools-toggle");
	const closeBtn = document.getElementById("tools-close");
	const backdrop = document.getElementById("tools-backdrop");

	function openTools() {
		app.classList.add("tools-open");
		if (toggle) toggle.setAttribute("aria-expanded", "true");
		if (closeBtn) closeBtn.focus();
	}
	function closeTools(restoreFocus) {
		if (!app.classList.contains("tools-open")) return;
		app.classList.remove("tools-open");
		if (toggle) toggle.setAttribute("aria-expanded", "false");
		if (restoreFocus !== false && toggle) toggle.focus();
	}

	if (toggle) toggle.addEventListener("click", () => {
		app.classList.contains("tools-open") ? closeTools() : openTools();
	});
	if (closeBtn) closeBtn.addEventListener("click", () => closeTools());
	if (backdrop) backdrop.addEventListener("click", () => closeTools());

	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape" && app.classList.contains("tools-open")) closeTools();
	});

	// Choosing a diagram mode from the sheet implies you want to see it: jump to the
	// Graph workspace and dismiss the sheet.
	["mode-graph", "mode-flow"].forEach((id) => {
		const b = document.getElementById(id);
		if (b) b.addEventListener("click", () => { if (mq.matches) { setTab("graph"); closeTools(false); } });
	});
	// One-shot actions dismiss the sheet after firing; multi-adjust controls (toggles,
	// the resolution select, expand-all, theme) deliberately leave it open.
	["fit-graph", "btn-screenshot", "btn-snapshot", "btn-export-map"].forEach((id) => {
		const b = document.getElementById(id);
		if (b) b.addEventListener("click", () => { if (mq.matches) closeTools(false); });
	});

	// Growing back to a desktop viewport must never leave the sheet stuck open.
	const onMQ = (e) => { if (!e.matches) closeTools(false); };
	if (mq.addEventListener) mq.addEventListener("change", onMQ);
	else if (mq.addListener) mq.addListener(onMQ); // older Safari

})(window.RV = window.RV || {});
