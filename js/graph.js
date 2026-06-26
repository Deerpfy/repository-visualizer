// graph.js — force-directed "spider web" of the folder/file hierarchy, via the
// vendored vis-network UMD global (window.vis). Containment edges = folder→child.
// Folders collapse/expand; a node cap with expand-on-demand keeps huge repos fast.
// Optional, off-by-default code-reference overlay parses import/include/require.
(function (RV) {
	"use strict";
	const { el, classify, CATEGORY, CATEGORY_COLOR, readText } = RV;

	const ROOT_ID = "__root__";

	function createGraphView(container, { onSelect, getRootName } = {}) {
		const vis = window.vis;
		let network = null;
		let nodes = null;
		let edges = null;
		let tree = null;
		let nodeCap = 1500;
		const expanded = new Set(); // dir paths currently expanded
		const nodeMeta = new Map(); // node id -> { kind, path, entry?, node? }
		let refEdges = []; // ids of overlay edges (so we can remove them)
		let truncated = false;
		let shouldFit = false; // fit the view only after an initial setTree, not on expand/collapse

		if (!vis || !vis.Network) {
			container.appendChild(
				el("div", { class: "panel-empty", text: "Graph unavailable: vendor/vis-network.min.js failed to load." })
			);
			return {
				setTree() {}, setSelected() {}, refreshTheme() {}, setRefOverlay() {}, fit() {},
				expandAllFolders() { return { truncated: false, shown: 0 }; },
				exportImage() { return Promise.reject(new Error("Graph unavailable.")); },
				available: false,
			};
		}

		// Custom, XSS-safe tooltip (textContent only) — avoids vis HTML titles + CSS.
		const tip = el("div", { class: "graph-tip", role: "tooltip" });
		tip.style.display = "none";
		container.appendChild(tip);
		let lastPointer = { x: 0, y: 0 };
		container.addEventListener("mousemove", (e) => {
			const r = container.getBoundingClientRect();
			lastPointer = { x: e.clientX - r.left, y: e.clientY - r.top };
			if (tip.style.display !== "none") positionTip();
		});
		function positionTip() {
			tip.style.left = `${lastPointer.x + 12}px`;
			tip.style.top = `${lastPointer.y + 12}px`;
		}

		function themeColors() {
			const cs = getComputedStyle(container);
			return {
				edge: cs.getPropertyValue("--graph-edge").trim() || "#7a7a7a",
				font: cs.getPropertyValue("--graph-font").trim() || "#ddd",
				ref: cs.getPropertyValue("--graph-ref").trim() || "#e0556b",
				bg: cs.getPropertyValue("--graph-bg").trim() || "#0c0e12",
			};
		}

		function dirSize(fileCount) {
			return Math.max(12, Math.min(38, 12 + Math.log2(fileCount + 1) * 3));
		}
		function fileColor(entry) {
			return CATEGORY_COLOR[classify(entry)] || CATEGORY_COLOR[CATEGORY.TEXT];
		}

		function computeAutoExpansion() {
			expanded.clear();
			if (!tree) return;
			let count = 1 + tree.dirsSorted.length + tree.files.length; // root + immediate children
			const queue = [...tree.dirsSorted];
			while (queue.length) {
				const dir = queue.shift();
				const childCount = dir.dirsSorted.length + dir.files.length;
				if (count + childCount <= nodeCap) {
					expanded.add(dir.path);
					count += childCount;
					for (const d of dir.dirsSorted) queue.push(d);
				}
			}
		}

		function seedPos(node, prev) {
			// Reuse a node's previous position so expand/collapse feels incremental
			// rather than re-shuffling the whole layout.
			if (prev && prev[node.id]) {
				node.x = prev[node.id].x;
				node.y = prev[node.id].y;
			}
			return node;
		}

		function build(prevPositions) {
			const colors = themeColors();
			const ns = [];
			const es = [];
			nodeMeta.clear();
			truncated = false;
			let count = 0;

			const rootName = (getRootName && getRootName()) || "repository";
			ns.push(seedPos({ id: ROOT_ID, label: rootName, shape: "diamond", size: 20, color: { background: CATEGORY_COLOR.dir, border: "#ffffff" }, font: { color: colors.font, size: 13 } }, prevPositions));
			nodeMeta.set(ROOT_ID, { kind: "root", path: "" });
			count++;

			const visit = (treeNode, parentId) => {
				for (const dir of treeNode.dirsSorted) {
					if (count >= nodeCap) { truncated = true; return; }
					const isExp = expanded.has(dir.path);
					const hasChildren = dir.dirsSorted.length + dir.files.length > 0;
					const marker = !hasChildren ? "" : isExp ? "  ▾" : `  ▸ (${dir.fileCount})`;
					ns.push(seedPos({
						id: dir.path,
						label: (dir.name || "(root)") + marker,
						shape: "dot",
						size: dirSize(dir.fileCount),
						color: { background: CATEGORY_COLOR.dir, border: isExp ? "#bd8b1d" : "#ffffff" },
						borderWidth: isExp ? 1 : 2,
						font: { color: colors.font, size: 12 },
					}, prevPositions));
					nodeMeta.set(dir.path, { kind: "dir", path: dir.path, node: dir });
					es.push({ from: parentId, to: dir.path });
					count++;
					if (isExp) visit(dir, dir.path);
				}
				for (const f of treeNode.files) {
					if (count >= nodeCap) { truncated = true; return; }
					ns.push(seedPos({
						id: f.path,
						label: f.name,
						shape: "dot",
						size: 7,
						color: { background: fileColor(f), border: fileColor(f) },
						font: { color: colors.font, size: 10 },
					}, prevPositions));
					nodeMeta.set(f.path, { kind: "file", path: f.path, entry: f });
					es.push({ from: parentId, to: f.path });
					count++;
				}
			};
			if (tree) visit(tree, ROOT_ID);

			nodes.clear();
			edges.clear();
			nodes.add(ns);
			edges.add(es.map((e, i) => ({ id: `c${i}`, ...e, color: { color: colors.edge, opacity: 0.5 }, width: 0.7 })));
			refEdges = [];
		}

		function rebuild() {
			const prev = network ? network.getPositions() : null;
			build(prev);
		}

		const STAB_ITERATIONS = 250;
		let freezeTimer = 0;

		function freezePhysics() {
			clearTimeout(freezeTimer);
			if (network) { try { network.setOptions({ physics: false }); } catch {} }
		}

		// Run a bounded stabilization on the current data, then freeze physics. Freezing
		// is what stops a dense folder (a hub node with hundreds of file children) from
		// jittering forever — without it, the simulation never reaches rest.
		function restabilize() {
			if (!network) return;
			clearTimeout(freezeTimer);
			try {
				network.setOptions({ physics: true });
				network.stabilize(STAB_ITERATIONS);
			} catch {}
			// Guaranteed freeze even if stabilizationIterationsDone doesn't fire.
			freezeTimer = setTimeout(freezePhysics, 3500);
		}

		function ensureNetwork() {
			nodes = new vis.DataSet([]);
			edges = new vis.DataSet([]);
			const colors = themeColors();
			network = new vis.Network(
				container,
				{ nodes, edges },
				{
					autoResize: true,
					interaction: { hover: true, tooltipDelay: 1e9, navigationButtons: false, keyboard: false, multiselect: false, hideEdgesOnDrag: true },
					nodes: { shape: "dot", font: { color: colors.font, size: 11, face: "system-ui" }, borderWidth: 1 },
					edges: { smooth: false, color: { color: colors.edge, opacity: 0.5 }, width: 0.7 },
					physics: {
						solver: "forceAtlas2Based",
						forceAtlas2Based: { gravitationalConstant: -45, centralGravity: 0.008, springLength: 110, springConstant: 0.08, avoidOverlap: 0.1, damping: 0.5 },
						stabilization: { enabled: true, iterations: STAB_ITERATIONS, fit: false, updateInterval: 50 },
						adaptiveTimestep: true,
						minVelocity: 1,
						timestep: 0.4,
					},
					layout: { improvedLayout: false },
				}
			);

			network.on("click", (params) => {
				if (!params.nodes.length) return;
				const meta = nodeMeta.get(params.nodes[0]);
				if (!meta) return;
				if (meta.kind === "dir") toggleExpand(meta.path);
				else if (meta.kind === "file" && onSelect) onSelect(meta.entry, { fromGraph: true });
			});
			network.on("hoverNode", (params) => {
				const meta = nodeMeta.get(params.node);
				if (!meta) return;
				tip.textContent = meta.path || (getRootName && getRootName()) || "repository";
				tip.style.display = "block";
				positionTip();
			});
			network.on("blurNode", () => (tip.style.display = "none"));
			network.on("dragStart", () => (tip.style.display = "none"));
			network.on("stabilizationIterationsDone", () => {
				if (shouldFit) { try { network.fit(); } catch {} shouldFit = false; }
				freezePhysics(); // freeze once settled — prevents dense folders from jittering
			});
		}

		function toggleExpand(path) {
			if (expanded.has(path)) expanded.delete(path);
			else expanded.add(path);
			rebuild();
			restabilize();
		}

		// ---- reference overlay (optional, off by default) -----------------

		let overlayToken = 0;

		async function setRefOverlay(on, onStatus) {
			const myToken = ++overlayToken;
			if (refEdges.length) { edges.remove(refEdges); refEdges = []; }
			if (!on) { if (onStatus) onStatus("Reference overlay off."); return; }
			// The parser lives in the shared engine (single source of truth).
			if (!RV.engine || !RV.engine.parseRefs) { if (onStatus) onStatus("Reference overlay unavailable: js/engine.js failed to load."); return; }

			const fileMetas = [...nodeMeta.values()].filter((m) => m.kind === "file");
			let parsed = 0;
			const newEdges = [];
			const colors = themeColors();

			for (const m of fileMetas) {
				if (myToken !== overlayToken) return; // toggled again; abort
				const e = m.entry;
				const cat = classify(e);
				if (cat === CATEGORY.BINARY || cat === CATEGORY.IMAGE) continue;
				if ((e.size || 0) > 256 * 1024) continue;
				let text;
				try { text = await readText(e); } catch { continue; }
				for (const target of RV.engine.parseRefs(text)) {
					const resolved = RV.engine.resolveRef(target, e.path, fileMetas);
					if (resolved && resolved !== e.path) {
						newEdges.push({ id: `r${newEdges.length}_${m.path}`, from: e.path, to: resolved, dashes: true, color: { color: colors.ref, opacity: 0.7 }, width: 0.8, smooth: { type: "curvedCW", roundness: 0.2 } });
					}
				}
				if (++parsed % 40 === 0 && onStatus) onStatus(`Reference overlay: parsed ${parsed}/${fileMetas.length}…`);
			}
			if (myToken !== overlayToken) return;
			const present = new Set(nodeMeta.keys());
			const valid = newEdges.filter((x) => present.has(x.to));
			edges.add(valid);
			refEdges = valid.map((x) => x.id);
			if (onStatus) onStatus(`Reference overlay: ${valid.length} link(s) from ${fileMetas.length} files.`);
		}

		// ---- expand every folder ------------------------------------------

		const HARD_EXPAND_MAX = 5000; // safety ceiling for a full expansion

		function expandAllFolders() {
			if (!network || !tree) return { truncated: false, shown: 0 };
			const addAll = (node) => {
				for (const d of node.dirsSorted) { expanded.add(d.path); addAll(d); }
			};
			addAll(tree);
			// Raise the cap so the full tree is actually shown — bounded for safety.
			const countNodes = (n) => {
				let c = n.files.length + n.dirsSorted.length;
				for (const d of n.dirsSorted) c += countNodes(d);
				return c;
			};
			const projected = 1 + countNodes(tree);
			nodeCap = Math.min(Math.max(projected, nodeCap), HARD_EXPAND_MAX);
			shouldFit = true;
			rebuild();
			restabilize();
			return { truncated, shown: nodeMeta.size, projected };
		}

		// ---- export the graph to a PNG at an exact resolution -------------

		function exportImage({ width, height, transparent } = {}) {
			return new Promise((resolve, reject) => {
				if (!network || !nodes) return reject(new Error("Open a folder and let the graph render first."));
				const liveNodes = nodes.get();
				if (!liveNodes.length) return reject(new Error("The graph is empty."));
				// Browsers cap canvas size (≈16384px/side) and area; refuse impossible sizes up front.
				if (width > 16384 || height > 16384) return reject(new Error("Resolution exceeds the browser's 16384px canvas limit. Pick a smaller one."));
				if (width * height > 200 * 1e6) return reject(new Error("That resolution needs too much memory for this browser. Pick a smaller one."));
				const positions = network.getPositions();
				// Re-render the graph (not the on-screen pixels) so high resolutions stay crisp.
				const staticNodes = liveNodes.map((n) => ({ ...n, x: positions[n.id]?.x ?? 0, y: positions[n.id]?.y ?? 0, fixed: true, physics: false }));
				const liveEdges = edges.get();
				const colors = themeColors();
				const dpr = window.devicePixelRatio || 1;

				// Off-screen container sized so the device-pixel canvas equals width×height.
				// Size the off-screen container so its device-pixel canvas is exactly
				// width×height (canvas px = CSS px × dpr). The presets divide cleanly by
				// common dprs, so the captured image matches the requested resolution.
				const off = document.createElement("div");
				off.style.cssText = `position:fixed;left:-100000px;top:0;pointer-events:none;width:${Math.max(1, width / dpr)}px;height:${Math.max(1, height / dpr)}px;`;
				document.body.appendChild(off);

				let tmp = null, done = false;
				const finish = (fn) => { if (done) return; done = true; try { tmp && tmp.destroy(); } catch {} off.remove(); fn(); };

				// Capture the graph canvas directly — one big canvas, not two — so even 16K
				// stays within memory limits.
				const capture = () => {
					try {
						const src = off.querySelector("canvas");
						if (!src || !src.width) throw new Error("nothing to capture");
						src.toBlob((blob) => finish(() => (blob ? resolve(blob) : reject(new Error("PNG encoding failed — the resolution may be too large for this browser. Try a smaller one.")))), "image/png");
					} catch (err) {
						finish(() => reject(err));
					}
				};

				try {
					tmp = new vis.Network(
						off,
						{ nodes: new vis.DataSet(staticNodes), edges: new vis.DataSet(liveEdges) },
						{
							autoResize: false,
							physics: false,
							interaction: { dragNodes: false, dragView: false, zoomView: false, hover: false, selectable: false },
							nodes: { shape: "dot", font: { color: colors.font, size: 11, face: "system-ui" }, borderWidth: 1 },
							edges: { smooth: false, color: { color: colors.edge, opacity: 0.5 }, width: 0.7 },
							layout: { improvedLayout: false },
						}
					);
				} catch (err) {
					return finish(() => reject(err));
				}

				// Paint the background straight onto the graph canvas (reset transform so it
				// covers the whole frame), then draw the graph on top.
				if (!transparent) {
					tmp.on("beforeDrawing", (ctx) => {
						ctx.save();
						ctx.setTransform(1, 0, 0, 1, 0, 0);
						ctx.fillStyle = colors.bg;
						ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
						ctx.restore();
					});
				}
				// fit() updates the view synchronously, so the first draw is already framed.
				tmp.on("afterDrawing", () => requestAnimationFrame(capture));
				tmp.fit();
				setTimeout(() => { if (!done) capture(); }, 2000); // fallback if the event never fires
			});
		}

		// ---- public API ---------------------------------------------------

		return {
			available: true,
			el: container,
			setTree(newTree, cap) {
				if (!network) ensureNetwork();
				tree = newTree;
				if (typeof cap === "number") nodeCap = cap;
				computeAutoExpansion();
				shouldFit = true; // fit once after this (re)load; preserved view on expand/collapse
				rebuild();
				restabilize();
				return { truncated, shown: nodeMeta.size };
			},
			setSelected(path) {
				if (!network || !nodeMeta.has(path)) return;
				try {
					network.selectNodes([path]);
					network.focus(path, { scale: Math.max(0.6, network.getScale()), animation: { duration: 300 } });
				} catch { /* node may be collapsed away */ }
			},
			refreshTheme() {
				if (!network) return;
				rebuild();
				const colors = themeColors();
				network.setOptions({ nodes: { font: { color: colors.font } }, edges: { color: { color: colors.edge, opacity: 0.5 } } });
			},
			setRefOverlay,
			setNodeCap(cap) { nodeCap = cap; },
			fit() { if (network) network.fit({ animation: true }); },
			expandAllFolders,
			exportImage,
			stats: () => ({ truncated, shown: nodeMeta.size }),
		};
	}

	// The reference parser (extractRefs/resolveRef/normalize) used to live here.
	// It now lives in js/engine.js as RV.engine.parseRefs / resolveRef / normalizePath
	// — the single source of truth shared by the overlay, the flow diagram, and the
	// Node CLI/HTTP API. See setRefOverlay() above for the call sites.

	Object.assign(RV, { createGraphView });
})(window.RV = window.RV || {});
