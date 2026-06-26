// flowgraph.js — the DIRECTED program/architecture flow diagram (start → END),
// rendered with the vendored vis-network UMD global (window.vis) in a hierarchical
// layout. It consumes an AnalysisModel from RV.engine.buildModel: nodes coloured by
// role (entry / terminal / cycle / normal), arrowed import edges, and cycle edges
// highlighted (dashed, red, labelled "cycle"). This sits ALONGSIDE the containment
// spider graph (js/graph.js) — it does not replace it.
(function (RV) {
	"use strict";
	const { el } = RV;

	const RENDER_CAP = 900; // hierarchical layout gets slow past this; cap + message

	function createFlowView(container, { onSelect, getRootName } = {}) {
		const vis = window.vis;

		if (!vis || !vis.Network) {
			container.appendChild(
				el("div", { class: "panel-empty", text: "Flow diagram unavailable: vendor/vis-network.min.js failed to load." })
			);
			return {
				available: false,
				setModel() { return { shown: 0, cycles: 0, truncated: false }; },
				setSelected() {}, refreshTheme() {}, fit() {},
				exportImage() { return Promise.reject(new Error("Flow diagram unavailable.")); },
			};
		}

		let network = null;
		let nodes = null;
		let edges = null;
		let model = null;
		const nodeMeta = new Map(); // id(path) -> { path, name }
		let shouldFit = false;

		// Custom XSS-safe tooltip (textContent only) — same pattern as the graph view.
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
			const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
			return {
				edge: v("--graph-edge", "#7a7a7a"),
				font: v("--graph-font", "#ddd"),
				bg: v("--graph-bg", "#0c0e12"),
				entry: v("--flow-entry", "#1f6feb"),
				terminal: v("--flow-terminal", "#2ea043"),
				cycle: v("--flow-cycle", v("--graph-ref", "#e0556b")),
				node: v("--flow-node", "#39414f"),
			};
		}

		function nodeColor(role, colors) {
			if (role === "entry") return colors.entry;
			if (role === "terminal") return colors.terminal;
			if (role === "cycle") return colors.cycle;
			return colors.node;
		}

		// Pick which nodes to draw when a model is large: keep entries, cycle members
		// and terminals first, then the highest-degree nodes — mirrors the export cap.
		function selectRenderNodes(all) {
			if (all.length <= RENDER_CAP) return { list: all, truncated: false };
			const score = (n) => (n.entry ? 4 : 0) + (n.cycle ? 4 : 0) + (n.terminal ? 2 : 0) + (n.inDeg + n.outDeg) / 1000;
			const list = all.slice().sort((a, b) => score(b) - score(a) || (a.path < b.path ? -1 : 1)).slice(0, RENDER_CAP);
			return { list, truncated: true };
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
					nodes: { shape: "box", margin: 6, font: { color: colors.font, size: 12, face: "system-ui" }, borderWidth: 1, shapeProperties: { borderRadius: 4 } },
					edges: { arrows: { to: { enabled: true, scaleFactor: 0.6 } }, smooth: { type: "cubicBezier", forceDirection: "horizontal", roundness: 0.4 }, color: { color: colors.edge, opacity: 0.7 }, width: 0.9 },
					layout: { hierarchical: { enabled: true, direction: "LR", sortMethod: "directed", shakeTowards: "roots", levelSeparation: 140, nodeSpacing: 90, treeSpacing: 120 } },
					physics: false,
				}
			);

			network.on("click", (params) => {
				if (!params.nodes.length) return;
				const meta = nodeMeta.get(params.nodes[0]);
				if (meta && onSelect) onSelect(meta, { fromFlow: true });
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
			network.on("afterDrawing", () => { if (shouldFit) { try { network.fit(); } catch {} shouldFit = false; } });
		}

		function build() {
			if (!network) ensureNetwork();
			const colors = themeColors();
			nodeMeta.clear();

			if (!model || !model.nodes.length) {
				nodes.clear(); edges.clear();
				return { shown: 0, cycles: 0, truncated: false };
			}

			const { list, truncated } = selectRenderNodes(model.nodes);
			const renderSet = new Set(list.map((n) => n.path));

			const vnodes = list.map((n) => {
				nodeMeta.set(n.path, { path: n.path, name: n.name, entry: n });
				const bg = nodeColor(n.role, colors);
				const isPlain = n.role === "normal";
				return {
					id: n.path,
					label: n.name,
					level: typeof n.layer === "number" ? n.layer : undefined,
					shape: "box",
					color: { background: bg, border: isPlain ? colors.edge : "#ffffff" },
					font: { color: isPlain ? colors.font : "#ffffff", size: 12 },
					borderWidth: n.seeded ? 2 : 1,
				};
			});

			const vedges = (model.edges || [])
				.filter((e) => renderSet.has(e.from) && renderSet.has(e.to))
				.map((e, i) => e.inCycle
					? { id: `e${i}`, from: e.from, to: e.to, dashes: true, label: "cycle", font: { color: colors.cycle, size: 9, strokeWidth: 0 }, color: { color: colors.cycle, opacity: 0.95 }, width: 1.4 }
					: { id: `e${i}`, from: e.from, to: e.to, color: { color: colors.edge, opacity: 0.7 }, width: 0.9 }
				);

			nodes.clear(); edges.clear();
			nodes.add(vnodes);
			edges.add(vedges);
			return { shown: vnodes.length, cycles: model.cycles ? model.cycles.length : 0, truncated };
		}

		// ---- off-screen PNG export (mirrors graph.js exportImage) ----------

		function exportImage({ width, height, transparent } = {}) {
			return new Promise((resolve, reject) => {
				if (!network || !nodes) return reject(new Error("Switch to Flow and let the diagram render first."));
				const liveNodes = nodes.get();
				if (!liveNodes.length) return reject(new Error("The flow diagram is empty."));
				if (width > 16384 || height > 16384) return reject(new Error("Resolution exceeds the browser's 16384px canvas limit. Pick a smaller one."));
				if (width * height > 200 * 1e6) return reject(new Error("That resolution needs too much memory for this browser. Pick a smaller one."));
				const positions = network.getPositions();
				const staticNodes = liveNodes.map((n) => ({ ...n, x: positions[n.id]?.x ?? 0, y: positions[n.id]?.y ?? 0, fixed: true, physics: false }));
				const liveEdges = edges.get();
				const colors = themeColors();
				const dpr = window.devicePixelRatio || 1;

				const off = document.createElement("div");
				off.style.cssText = `position:fixed;left:-100000px;top:0;pointer-events:none;width:${Math.max(1, width / dpr)}px;height:${Math.max(1, height / dpr)}px;`;
				document.body.appendChild(off);

				let tmp = null, done = false;
				const finish = (fn) => { if (done) return; done = true; try { tmp && tmp.destroy(); } catch {} off.remove(); fn(); };
				const capture = () => {
					try {
						const src = off.querySelector("canvas");
						if (!src || !src.width) throw new Error("nothing to capture");
						src.toBlob((blob) => finish(() => (blob ? resolve(blob) : reject(new Error("PNG encoding failed — try a smaller resolution.")))), "image/png");
					} catch (err) { finish(() => reject(err)); }
				};

				try {
					tmp = new vis.Network(
						off,
						{ nodes: new vis.DataSet(staticNodes), edges: new vis.DataSet(liveEdges) },
						{
							autoResize: false,
							physics: false,
							interaction: { dragNodes: false, dragView: false, zoomView: false, hover: false, selectable: false },
							nodes: { shape: "box", margin: 6, font: { color: colors.font, size: 12, face: "system-ui" }, borderWidth: 1 },
							edges: { arrows: { to: { enabled: true, scaleFactor: 0.6 } }, smooth: false, color: { color: colors.edge, opacity: 0.7 }, width: 0.9 },
							layout: { hierarchical: false },
						}
					);
				} catch (err) { return finish(() => reject(err)); }

				if (!transparent) {
					tmp.on("beforeDrawing", (ctx) => {
						ctx.save();
						ctx.setTransform(1, 0, 0, 1, 0, 0);
						ctx.fillStyle = colors.bg;
						ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
						ctx.restore();
					});
				}
				tmp.on("afterDrawing", () => requestAnimationFrame(capture));
				tmp.fit();
				setTimeout(() => { if (!done) capture(); }, 2000);
			});
		}

		// ---- public API ---------------------------------------------------

		return {
			available: true,
			el: container,
			setModel(newModel) {
				model = newModel;
				shouldFit = true;
				return build();
			},
			setSelected(path) {
				if (!network || !nodeMeta.has(path)) return;
				try {
					network.selectNodes([path]);
					network.focus(path, { scale: Math.max(0.6, network.getScale()), animation: { duration: 300 } });
				} catch { /* node may be capped out of the render set */ }
			},
			refreshTheme() {
				if (!network) return;
				build();
				const colors = themeColors();
				network.setOptions({ nodes: { font: { color: colors.font } }, edges: { color: { color: colors.edge, opacity: 0.7 } } });
			},
			fit() { if (network) try { network.fit({ animation: true }); } catch {} },
			exportImage,
			hasModel: () => !!(model && model.nodes && model.nodes.length),
		};
	}

	Object.assign(RV, { createFlowView });
})(window.RV = window.RV || {});
