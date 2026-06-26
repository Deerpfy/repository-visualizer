// remote.js — OPT-IN remote source: load a GitHub repository by URL.
// This is the ONLY part of the tool that touches the network, and only when the
// user pastes a repo link. The folder picker (Tier 1) stays fully offline.
//
// How it works: GitHub's REST API returns a repo's entire file tree in one request
// and allows cross-origin (CORS) calls, so it works both from file:// and when the
// page is hosted. File contents are fetched on click from raw.githubusercontent.com
// (a CDN, not subject to the API's hourly rate limit).
(function (RV) {
	"use strict";

	const TOKEN_KEY = "repo-visualizer:gh-token";
	let _token = ""; // in-memory token for the session

	function initToken() {
		try { _token = localStorage.getItem(TOKEN_KEY) || ""; } catch { _token = ""; }
		return _token;
	}
	function getToken() { return _token; }
	function hasRememberedToken() {
		try { return !!localStorage.getItem(TOKEN_KEY); } catch { return false; }
	}
	/** Set the session token; persist to this browser only if `remember`. Never committed. */
	function setToken(token, remember) {
		_token = (token || "").trim();
		try {
			if (_token && remember) localStorage.setItem(TOKEN_KEY, _token);
			else localStorage.removeItem(TOKEN_KEY);
		} catch { /* storage unavailable */ }
	}
	function clearToken() {
		_token = "";
		try { localStorage.removeItem(TOKEN_KEY); } catch {}
	}

	/**
	 * Parse a GitHub repo reference into { owner, repo, branch|null }.
	 * Accepts: full URLs, .git URLs, /tree/<branch>, /blob/<branch>, SSH form,
	 * and the bare "owner/repo" shorthand. Returns null for non-GitHub or invalid input.
	 */
	function parseRepoUrl(input) {
		if (!input) return null;
		let s = String(input).trim();

		// SSH: git@github.com:owner/repo(.git)
		let m = s.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
		if (m) return { owner: m[1], repo: m[2], branch: null };

		let host = null;
		const um = s.match(/^https?:\/\/([^/]+)\/(.*)$/i);
		if (um) { host = um[1].toLowerCase(); s = um[2]; }
		else { s = s.replace(/^(www\.)?github\.com\//i, ""); } // shorthand or github.com/…
		if (host && !/(^|\.)github\.com$/.test(host)) return null; // GitHub only

		s = s.replace(/[?#].*$/, ""); // drop query/hash
		const parts = s.split("/").filter(Boolean);
		if (parts.length < 2) return null;
		const owner = parts[0];
		const repo = parts[1].replace(/\.git$/i, "");
		if (!owner || !repo || owner.includes(".")) return null; // GitHub owners have no dots
		let branch = null;
		if ((parts[2] === "tree" || parts[2] === "blob") && parts[3]) branch = decodeURIComponent(parts[3]);
		return { owner, repo, branch };
	}

	function ghHeaders() {
		const h = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
		if (_token) h.Authorization = "Bearer " + _token;
		return h;
	}

	async function ghApi(url) {
		let res;
		try {
			res = await fetch(url, { headers: ghHeaders() });
		} catch {
			throw new Error("Could not reach GitHub — check your connection.");
		}
		if (res.status === 404) throw new Error("Repository not found (if it's private, add a token below).");
		if (res.status === 401) throw new Error("Invalid token.");
		if (res.status === 403) {
			const remaining = res.headers.get("x-ratelimit-remaining");
			throw new Error(remaining === "0"
				? "GitHub API rate limit reached. Add a token to raise it, or try again later."
				: "GitHub denied the request (403).");
		}
		if (!res.ok) throw new Error("GitHub returned HTTP " + res.status + ".");
		return res.json();
	}

	/** Fetch a GitHub repo's full file tree (metadata only) as raw index entries. */
	async function fetchGitHubRepo(ref, onStatus) {
		const { owner, repo } = ref;
		let branch = ref.branch;
		if (!branch) {
			if (onStatus) onStatus(`Resolving default branch for ${owner}/${repo}…`);
			const info = await ghApi(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
			branch = info.default_branch || "main";
		}
		if (onStatus) onStatus(`Fetching file tree (${owner}/${repo}@${branch})…`);
		const tree = await ghApi(
			`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`
		);
		const encPath = (p) => p.split("/").map(encodeURIComponent).join("/");
		const rawBase = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}/`;
		const rawEntries = (tree.tree || [])
			.filter((n) => n.type === "blob")
			.map((n) => ({
				path: `${repo}/${n.path}`,
				size: typeof n.size === "number" ? n.size : 0,
				mtime: null,
				url: rawBase + encPath(n.path),
			}));
		return {
			rawEntries,
			meta: { host: "github", owner, repo, branch, rootName: repo, truncated: !!tree.truncated, count: rawEntries.length },
		};
	}

	/** Parse + fetch in one call. Throws with a friendly message on bad input/errors. */
	async function loadGitRepo(input, onStatus) {
		const ref = parseRepoUrl(input);
		if (!ref) throw new Error("Couldn't read that link — try a GitHub URL like github.com/owner/repo.");
		return fetchGitHubRepo(ref, onStatus);
	}

	Object.assign(RV, {
		parseRepoUrl, loadGitRepo, fetchGitHubRepo,
		initToken, getToken, setToken, clearToken, hasRememberedToken,
	});
})(window.RV = window.RV || {});
