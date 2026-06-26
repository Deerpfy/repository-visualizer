// viewer.js — lazy content loading + rendering. Reads a file's bytes ONLY when
// shown. Every file-derived HTML/SVG/markdown is sanitized through DOMPurify
// before it touches the DOM; when DOMPurify is unavailable we fall back to inert
// textContent and never inject HTML.
(function (RV) {
	"use strict";
	const { el, clear, formatBytes } = RV;
	const { classify, CATEGORY, languageFor, looksBinary } = RV;
	const { hasContent, readText, objectUrlFor } = RV;

	const marked = window.marked;
	const DOMPurify = window.DOMPurify;
	const hljs = window.hljs;
	const FORCE_TEXT_CAP = 512 * 1024; // truncate forced/huge text views to stay responsive

	// Configure libraries once (guarded — any may be missing if a vendor file failed).
	if (marked && typeof marked.setOptions === "function") {
		marked.setOptions({ gfm: true, breaks: false });
	}
	if (DOMPurify && typeof DOMPurify.addHook === "function") {
		// Prevent rendered markdown/SVG from making automatic network requests:
		// strip remote <img src>, harden links. Keeps the runtime fully offline.
		DOMPurify.addHook("afterSanitizeAttributes", (node) => {
			if (node.tagName === "IMG") {
				const src = node.getAttribute("src") || "";
				if (/^(https?:)?\/\//i.test(src) || /^\/\//.test(src)) {
					node.removeAttribute("src");
					node.setAttribute("alt", `${node.getAttribute("alt") || ""} [external image suppressed]`.trim());
					node.classList.add("ext-suppressed");
				}
			}
			if (node.tagName === "A") {
				node.setAttribute("target", "_blank");
				node.setAttribute("rel", "noopener noreferrer");
			}
		});
	}

	function createViewer(container, { sizeCapRef } = {}) {
		let current = 0; // race token: latest show() wins
		let revoke = null; // active object-URL revoker

		const root = el("div", { class: "viewer" });
		const header = el("div", { class: "viewer-header" });
		const body = el("div", { class: "viewer-body", tabindex: "0" });
		root.appendChild(header);
		root.appendChild(body);
		clear(container);
		container.appendChild(root);

		function freePrevUrl() {
			if (revoke) { try { revoke(); } catch {} revoke = null; }
		}
		function sizeCap() {
			return sizeCapRef ? sizeCapRef() : 2 * 1024 * 1024;
		}

		// ---- header -------------------------------------------------------

		function renderHeader(entry) {
			clear(header);
			if (!entry) {
				header.appendChild(el("span", { class: "viewer-title muted", text: "No file selected" }));
				return;
			}
			const cat = classify(entry);
			const title = el("div", { class: "viewer-title" }, [
				el("span", { class: "name", text: entry.name }),
				el("span", { class: "path muted", text: entry.dir ? `  ${entry.dir}/` : "" }),
			]);
			const meta = el("div", { class: "viewer-meta" }, [
				chip(cat),
				chip(formatBytes(entry.size)),
				entry.mtime ? chip(new Date(entry.mtime).toLocaleString()) : null,
			]);
			const copyBtn = el("button", {
				class: "btn small", type: "button", title: "Copy path", text: "Copy path",
				on: { click: () => copyText(entry.path, copyBtn) },
			});
			header.appendChild(title);
			header.appendChild(el("div", { class: "viewer-header-right" }, [meta, copyBtn]));
		}
		function chip(text) {
			return el("span", { class: "vchip", text });
		}

		// ---- main entry ---------------------------------------------------

		async function show(entry, opts = {}) {
			const token = ++current;
			freePrevUrl();
			renderHeader(entry);
			clear(body);

			if (!entry) { body.appendChild(el("div", { class: "panel-empty", text: "Select a file to view its contents." })); return; }

			if (!hasContent(entry)) {
				renderMessage("Content not loaded", "This entry came from a snapshot without inlined content. Pick the source folder (Open Folder) to read it.");
				return;
			}

			const cat = classify(entry);
			const overCap = (entry.size || 0) > sizeCap();
			const force = !!opts.force;

			try {
				if (cat === CATEGORY.IMAGE) {
					if (overCap && !force) return renderTooLarge(entry, "image");
					return await renderImage(entry, token);
				}
				if (cat === CATEGORY.BINARY && !force) return renderBinary(entry);
				if (overCap && !force) return renderTooLarge(entry, "file");

				// Text-like (markdown / code / text), or a forced load.
				let text = await readText(entry);
				if (token !== current) return; // superseded
				let truncatedNote = "";
				if (text.length > FORCE_TEXT_CAP && (force || overCap)) {
					text = text.slice(0, FORCE_TEXT_CAP);
					truncatedNote = ` (truncated to ${formatBytes(FORCE_TEXT_CAP)})`;
				}
				if (!force && cat !== CATEGORY.MARKDOWN && looksBinary(text)) {
					return renderBinary(entry, "Content looks binary.");
				}

				if (cat === CATEGORY.MARKDOWN) renderMarkdown(text);
				else if (cat === CATEGORY.CODE) renderCode(text, entry, truncatedNote);
				else renderText(text, truncatedNote);
			} catch (err) {
				renderMessage("Could not read file", String((err && err.message) || err));
			}
		}

		// ---- renderers ----------------------------------------------------

		function renderMarkdown(text) {
			if (!marked || !DOMPurify) {
				return renderText(text, marked ? " (sanitizer unavailable — shown as text)" : " (markdown renderer unavailable — shown as text)");
			}
			let html;
			try { html = marked.parse(text); } catch { return renderText(text, " (markdown parse failed — shown as text)"); }
			const clean = DOMPurify.sanitize(html, { ADD_ATTR: ["target"] });
			body.appendChild(el("div", { class: "md", html: clean }));
		}

		function renderCode(text, entry, note = "") {
			const lang = languageFor(entry);
			const pre = el("pre", { class: "code" });
			const code = el("code");
			if (hljs && lang && hljs.getLanguage && hljs.getLanguage(lang)) {
				let out;
				try { out = hljs.highlight(text, { language: lang, ignoreIllegal: true }).value; } catch { out = null; }
				if (out != null) {
					const clean = DOMPurify ? DOMPurify.sanitize(out) : null;
					if (clean != null) { code.innerHTML = clean; code.className = "hljs"; }
					else code.textContent = text; // no sanitizer => inert text
				} else code.textContent = text;
			} else {
				code.textContent = text; // no highlighter / unknown language => plain monospace
			}
			pre.appendChild(code);
			body.appendChild(pre);
			if (note) body.appendChild(el("div", { class: "viewer-note muted", text: note.trim() }));
		}

		function renderText(text, note = "") {
			body.appendChild(el("pre", { class: "code plaintext" }, [el("code", { text })]));
			if (note) body.appendChild(el("div", { class: "viewer-note muted", text: note.trim() }));
		}

		async function renderImage(entry, token) {
			// SVG is active content: sanitize and inline it rather than trusting the blob.
			if (entry.ext === "svg") {
				try {
					const svg = await readText(entry);
					if (token !== current) return;
					if (DOMPurify) {
						const clean = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
						body.appendChild(el("div", { class: "image-wrap svg", html: clean }));
					} else {
						renderMessage("Cannot display SVG", "Sanitizer (DOMPurify) unavailable; refusing to render untrusted SVG.");
					}
				} catch (err) {
					renderMessage("Could not read image", String(err));
				}
				return;
			}
			const handle = await objectUrlFor(entry);
			if (token !== current) { if (handle) handle.revoke(); return; }
			if (!handle) { renderMessage("Image not available", "No content source for this image."); return; }
			revoke = handle.revoke;
			const img = el("img", { class: "image", alt: entry.name, src: handle.url });
			img.addEventListener("error", () => renderMessage("Could not display image", entry.name));
			body.appendChild(el("div", { class: "image-wrap" }, [img]));
		}

		function renderTooLarge(entry, kind) {
			clear(body);
			body.appendChild(
				el("div", { class: "meta-panel" }, [
					el("h3", { text: kind === "image" ? "Large image" : "Large file" }),
					metaTable(entry),
					el("p", { class: "muted", text: `Auto-rendering is disabled above the ${formatBytes(sizeCap())} cap to keep the UI responsive.` }),
					el("button", { class: "btn", type: "button", text: "Load anyway", on: { click: () => show(entry, { force: true }) } }),
				])
			);
		}

		function renderBinary(entry, reason) {
			clear(body);
			body.appendChild(
				el("div", { class: "meta-panel" }, [
					el("h3", { text: "Binary / non-text file" }),
					reason ? el("p", { class: "muted", text: reason }) : null,
					metaTable(entry),
					el("button", { class: "btn", type: "button", text: "Load anyway (as text)", on: { click: () => show(entry, { force: true }) } }),
				])
			);
		}

		function renderMessage(title, detail) {
			clear(body);
			body.appendChild(el("div", { class: "meta-panel" }, [el("h3", { text: title }), el("p", { class: "muted", text: detail })]));
		}

		function metaTable(entry) {
			const rows = [
				["Path", entry.path],
				["Name", entry.name],
				["Extension", entry.ext || "(none)"],
				["Size", formatBytes(entry.size)],
				["Modified", entry.mtime ? new Date(entry.mtime).toLocaleString() : "—"],
			];
			return el("table", { class: "meta-table" }, rows.map(([k, v]) => el("tr", {}, [el("th", { text: k }), el("td", { text: v })])));
		}

		// ---- copy-to-clipboard with file:// fallback ----------------------

		function copyText(text, btn) {
			const ok = () => { if (btn) { const t = btn.textContent; btn.textContent = "Copied!"; setTimeout(() => (btn.textContent = t), 1200); } };
			if (navigator.clipboard && navigator.clipboard.writeText) {
				navigator.clipboard.writeText(text).then(ok, () => fallbackCopy(text, ok));
			} else fallbackCopy(text, ok);
		}
		function fallbackCopy(text, ok) {
			const ta = el("textarea", { value: text, style: { position: "fixed", left: "-9999px" } });
			document.body.appendChild(ta);
			ta.select();
			try { document.execCommand("copy"); ok(); } catch {}
			document.body.removeChild(ta);
		}

		// ---- public API ---------------------------------------------------

		show(null);
		return {
			el: root,
			show,
			clear() { freePrevUrl(); current++; renderHeader(null); clear(body); body.appendChild(el("div", { class: "panel-empty", text: "Select a file to view its contents." })); },
		};
	}

	Object.assign(RV, { createViewer });
})(window.RV = window.RV || {});
