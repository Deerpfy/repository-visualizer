// util.js — tiny, dependency-free helpers shared across the app.
// Classic script (not an ES module) so the tool runs from file:// in every
// browser; it attaches its public API to the shared window.RV namespace.
(function (RV) {
	"use strict";

	/** Debounce: call `fn` only after `ms` of quiet. Returns a cancelable wrapper. */
	function debounce(fn, ms) {
		let t = 0;
		const wrapped = (...args) => {
			clearTimeout(t);
			t = setTimeout(() => fn(...args), ms);
		};
		wrapped.cancel = () => clearTimeout(t);
		return wrapped;
	}

	/** requestAnimationFrame throttle: coalesce bursts into one call per frame. */
	function throttleRAF(fn) {
		let scheduled = false;
		let lastArgs = null;
		return (...args) => {
			lastArgs = args;
			if (scheduled) return;
			scheduled = true;
			requestAnimationFrame(() => {
				scheduled = false;
				fn(...lastArgs);
			});
		};
	}

	function clamp(n, lo, hi) {
		return Math.max(lo, Math.min(hi, n));
	}

	/** Human-readable byte size. */
	function formatBytes(n) {
		if (n == null || isNaN(n)) return "—";
		if (n < 1024) return `${n} B`;
		const units = ["KB", "MB", "GB", "TB"];
		let v = n / 1024;
		let i = 0;
		while (v >= 1024 && i < units.length - 1) {
			v /= 1024;
			i++;
		}
		return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
	}

	/** Escape text for safe interpolation into HTML. */
	function escapeHtml(s) {
		return String(s)
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#39;");
	}

	/** Lowercase extension without the dot, or "" if none. Handles dotfiles. */
	function extOf(name) {
		const base = name.toLowerCase();
		const dot = base.lastIndexOf(".");
		// Leading dot (e.g. ".gitignore") => treat as no extension, it's a dotfile name.
		if (dot <= 0) return "";
		return base.slice(dot + 1);
	}

	function basename(path) {
		const i = path.lastIndexOf("/");
		return i === -1 ? path : path.slice(i + 1);
	}

	function dirname(path) {
		const i = path.lastIndexOf("/");
		return i === -1 ? "" : path.slice(0, i);
	}

	/**
	 * Minimal hyperscript DOM builder.
	 * - props: { class, id, text, html(=SANITIZED only), title, dataset:{}, on:{event:fn}, ...attrs }
	 *   `text` is set via textContent (safe). `html` is set via innerHTML — pass ONLY
	 *   already-sanitized strings (DOMPurify output) here.
	 * - children: array of nodes/strings (strings become text nodes).
	 */
	function el(tag, props = {}, children = []) {
		const node = document.createElement(tag);
		for (const [k, v] of Object.entries(props)) {
			if (v == null || v === false) continue;
			if (k === "class") node.className = v;
			else if (k === "text") node.textContent = v;
			else if (k === "html") node.innerHTML = v; // caller guarantees sanitized
			else if (k === "dataset") Object.assign(node.dataset, v);
			else if (k === "on") for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
			else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
			else if (k in node && k !== "list") {
				try {
					node[k] = v;
				} catch {
					node.setAttribute(k, v);
				}
			} else node.setAttribute(k, v);
		}
		for (const c of [].concat(children)) {
			if (c == null) continue;
			node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
		}
		return node;
	}

	/** Remove all children of a node. */
	function clear(node) {
		while (node.firstChild) node.removeChild(node.firstChild);
	}

	/** Stable, fast 32-bit string hash (FNV-1a). Used for deterministic colors. */
	function hashStr(s) {
		let h = 0x811c9dc5;
		for (let i = 0; i < s.length; i++) {
			h ^= s.charCodeAt(i);
			h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
		}
		return h >>> 0;
	}

	Object.assign(RV, { debounce, throttleRAF, clamp, formatBytes, escapeHtml, extOf, basename, dirname, el, clear, hashStr });
})(window.RV = window.RV || {});
