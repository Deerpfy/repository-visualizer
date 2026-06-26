// list.js — virtualized, collapsible file tree.
// Renders only the rows visible in the viewport so tens of thousands of files
// stay smooth. The tree is flattened to a row array honoring per-folder collapse.
(function (RV) {
	"use strict";
	const { el, clear, formatBytes, clamp, classify, CATEGORY_COLOR } = RV;

	const ROW_H = 24; // px, fixed row height (required for virtualization math)
	const OVERSCAN = 8; // rows rendered above/below the viewport
	const INDENT = 14; // px per depth level

	function createListView(container, { onSelect, onActivateDir } = {}) {
		const collapsed = new Set(); // dir paths that are collapsed
		let tree = null;
		let rows = []; // flattened visible rows
		let selectedPath = null;
		let focusedIndex = -1;
		let query = ""; // when non-empty, force-expand so matches show

		// DOM scaffold: viewport (scroll) > sizer (full height) > windowEl (translated).
		const viewport = el("div", { class: "list-viewport", tabindex: "0", role: "tree", "aria-label": "Repository files" });
		const sizer = el("div", { class: "list-sizer" });
		const windowEl = el("div", { class: "list-window" });
		sizer.appendChild(windowEl);
		viewport.appendChild(sizer);
		clear(container);
		container.appendChild(viewport);

		// ---- flattening ---------------------------------------------------

		function isCollapsed(path) {
			if (query) return false; // searching: show everything that matched
			return collapsed.has(path);
		}

		function flatten() {
			rows = [];
			if (!tree) return;
			const walk = (node) => {
				for (const dir of node.dirsSorted || []) {
					rows.push({ kind: "dir", node: dir, depth: dir.depth, path: dir.path });
					if (!isCollapsed(dir.path)) walk(dir);
				}
				for (const f of node.files) {
					rows.push({ kind: "file", entry: f, depth: node.depth + 1, path: f.path });
				}
			};
			walk(tree);
		}

		// ---- rendering ----------------------------------------------------

		function rowLabel(r) {
			if (r.kind === "dir") {
				const open = !isCollapsed(r.path);
				const twisty = el("span", { class: "twisty", text: open ? "▾" : "▸", "aria-hidden": "true" });
				const dot = el("span", { class: "dot", text: "▣", style: { color: CATEGORY_COLOR.dir } });
				const label = el("span", { class: "label", text: r.node.name || "(root)" });
				const meta = el("span", { class: "meta", text: String(r.node.fileCount) });
				return [twisty, dot, label, meta];
			}
			const cat = classify(r.entry);
			const spacer = el("span", { class: "twisty", text: "", "aria-hidden": "true" });
			const dot = el("span", { class: "dot", text: "●", style: { color: CATEGORY_COLOR[cat] } });
			const label = el("span", { class: "label", text: r.entry.name });
			const meta = el("span", { class: "meta", text: formatBytes(r.entry.size) });
			return [spacer, dot, label, meta];
		}

		function renderWindow() {
			const scrollTop = viewport.scrollTop;
			const viewH = viewport.clientHeight || 1;
			const start = clamp(Math.floor(scrollTop / ROW_H) - OVERSCAN, 0, Math.max(0, rows.length - 1));
			const visibleCount = Math.ceil(viewH / ROW_H) + OVERSCAN * 2;
			const end = Math.min(rows.length, start + visibleCount);

			sizer.style.height = `${rows.length * ROW_H}px`;
			windowEl.style.transform = `translateY(${start * ROW_H}px)`;
			clear(windowEl);

			for (let i = start; i < end; i++) {
				const r = rows[i];
				const row = el("div", {
					class: "row" + (r.path === selectedPath ? " selected" : "") + (i === focusedIndex ? " focused" : ""),
					role: "treeitem",
					"aria-level": String((r.depth ?? 0) + 1),
					"aria-selected": r.path === selectedPath ? "true" : "false",
					style: { height: `${ROW_H}px`, paddingLeft: `${6 + (r.depth ?? 0) * INDENT}px` },
					dataset: { idx: String(i) },
					title: r.path,
				}, rowLabel(r));
				if (r.kind === "dir") row.setAttribute("aria-expanded", String(!isCollapsed(r.path)));
				windowEl.appendChild(row);
			}
		}

		let rafPending = false;
		function scheduleRender() {
			if (rafPending) return;
			rafPending = true;
			requestAnimationFrame(() => {
				rafPending = false;
				renderWindow();
			});
		}

		// ---- interaction --------------------------------------------------

		function activateRow(i, viaKeyboard) {
			const r = rows[i];
			if (!r) return;
			focusedIndex = i;
			if (r.kind === "dir") {
				toggleDir(r.path);
				if (onActivateDir) onActivateDir(r.node);
			} else {
				selectedPath = r.path;
				if (onSelect) onSelect(r.entry, { viaKeyboard });
				renderWindow();
			}
		}

		function toggleDir(path) {
			if (collapsed.has(path)) collapsed.delete(path);
			else collapsed.add(path);
			flatten();
			renderWindow();
		}

		viewport.addEventListener("scroll", scheduleRender, { passive: true });

		viewport.addEventListener("click", (e) => {
			const rowEl = e.target.closest(".row");
			if (!rowEl) return;
			const i = Number(rowEl.dataset.idx);
			const r = rows[i];
			if (!r) return;
			focusedIndex = i;
			if (r.kind === "dir") {
				toggleDir(r.path);
				if (onActivateDir) onActivateDir(r.node);
			} else {
				selectedPath = r.path;
				if (onSelect) onSelect(r.entry, { viaKeyboard: false });
				renderWindow();
			}
		});

		function moveFocus(delta) {
			if (!rows.length) return;
			focusedIndex = clamp((focusedIndex < 0 ? 0 : focusedIndex) + delta, 0, rows.length - 1);
			ensureVisible(focusedIndex);
			renderWindow();
		}

		function ensureVisible(i) {
			const top = i * ROW_H;
			const bottom = top + ROW_H;
			if (top < viewport.scrollTop) viewport.scrollTop = top;
			else if (bottom > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = bottom - viewport.clientHeight;
		}

		viewport.addEventListener("keydown", (e) => {
			switch (e.key) {
				case "ArrowDown": e.preventDefault(); moveFocus(1); break;
				case "ArrowUp": e.preventDefault(); moveFocus(-1); break;
				case "Home": e.preventDefault(); focusedIndex = 0; ensureVisible(0); renderWindow(); break;
				case "End": e.preventDefault(); focusedIndex = rows.length - 1; ensureVisible(focusedIndex); renderWindow(); break;
				case "PageDown": e.preventDefault(); moveFocus(Math.floor(viewport.clientHeight / ROW_H)); break;
				case "PageUp": e.preventDefault(); moveFocus(-Math.floor(viewport.clientHeight / ROW_H)); break;
				case "Enter":
				case " ": e.preventDefault(); if (focusedIndex >= 0) activateRow(focusedIndex, true); break;
				case "ArrowRight": {
					e.preventDefault();
					const r = rows[focusedIndex];
					if (r && r.kind === "dir" && isCollapsed(r.path)) toggleDir(r.path);
					else moveFocus(1);
					break;
				}
				case "ArrowLeft": {
					e.preventDefault();
					const r = rows[focusedIndex];
					if (r && r.kind === "dir" && !isCollapsed(r.path)) toggleDir(r.path);
					else moveFocus(-1);
					break;
				}
			}
		});

		// ---- public API ---------------------------------------------------

		return {
			el: viewport,
			setTree(newTree, newQuery) {
				tree = newTree;
				query = (newQuery || "").trim();
				flatten();
				focusedIndex = clamp(focusedIndex, -1, rows.length - 1);
				viewport.scrollTop = 0;
				renderWindow();
			},
			setSelected(path) {
				selectedPath = path;
				const i = rows.findIndex((r) => r.path === path);
				if (i >= 0) {
					focusedIndex = i;
					ensureVisible(i);
				}
				renderWindow();
			},
			expandAll() {
				collapsed.clear();
				flatten();
				renderWindow();
			},
			collapseAll() {
				const addDirs = (node, depth) => {
					for (const d of node.dirsSorted || []) {
						if (depth >= 1) collapsed.add(d.path);
						addDirs(d, depth + 1);
					}
				};
				if (tree) addDirs(tree, 0);
				flatten();
				renderWindow();
			},
			rowCount: () => rows.length,
			relayout: scheduleRender,
		};
	}

	Object.assign(RV, { createListView });
})(window.RV = window.RV || {});
