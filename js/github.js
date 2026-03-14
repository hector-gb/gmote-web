/**
 * github.js
 * Fetches releases and their assets from a public GitHub repository.
 *
 * Configure REPO_OWNER and REPO_NAME to point at your firmware repo.
 */

export const REPO_OWNER = 'hector-gb';
export const REPO_NAME  = 'gmote-releases';

const API_BASE = 'https://api.github.com';

/**
 * @typedef {Object} Asset
 * @property {number} id          - GitHub asset ID
 * @property {string} name        - Filename (e.g. "code.py")
 * @property {number} size        - Size in bytes
 * @property {string} contentType - MIME type
 */

/**
 * @typedef {Object} Release
 * @property {string}  tag         - e.g. "v1.2.3"
 * @property {string}  name        - Human-readable release title
 * @property {string}  publishedAt - ISO 8601 date string
 * @property {string}  htmlUrl     - Link to the GitHub release page
 * @property {string}  body        - Release notes (raw markdown from GitHub)
 * @property {Asset[]} assets      - Downloadable files attached to the release
 */

/**
 * Returns all releases for the configured repo, newest first.
 * Filters to assets that look like CircuitPython source files (*.py).
 *
 * @param {number} [perPage=20]
 * @returns {Promise<Release[]>}
 */
export async function fetchReleases(perPage = 20) {
  const url = `${API_BASE}/repos/${REPO_OWNER}/${REPO_NAME}/releases?per_page=${perPage}`;

  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json' },
  });

  if (!res.ok) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (res.status === 403 && remaining === '0') {
      const reset = res.headers.get('x-ratelimit-reset');
      const resetDate = reset ? new Date(Number(reset) * 1000).toLocaleTimeString() : 'soon';
      throw new Error(`GitHub API rate limit exceeded. Resets at ${resetDate}.`);
    }
    throw new Error(`GitHub API error ${res.status}: ${res.statusText}`);
  }

  /** @type {any[]} */
  const data = await res.json();

  return data.map((r) => ({
    tag:         r.tag_name,
    name:        r.name || r.tag_name,
    publishedAt: r.published_at,
    htmlUrl:     r.html_url,
    body:        r.body ?? '',
    assets: (r.assets ?? [])
      .filter((a) => isPythonAsset(a.name))
      .map((a) => ({
        id:          a.id,
        name:        a.name,
        size:        a.size,
        contentType: a.content_type,
      })),
  }));
}

/**
 * Downloads an asset and returns its text content.
 *
 * @param {Asset} asset
 * @returns {Promise<string>}
 */
export async function downloadAsset(asset) {
  const url = `${API_BASE}/repos/${REPO_OWNER}/${REPO_NAME}/releases/assets/${asset.id}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/octet-stream' },
  });
  if (!res.ok) throw new Error(`Failed to download ${asset.name}: ${res.statusText}`);
  return res.text();
}

// ─── helpers ────────────────────────────────────────────────────────────────

/** Returns true for .py files (the only thing CircuitPython flashing needs). */
function isPythonAsset(name) {
  return name.endsWith('.py');
}

/** Formats a byte count to a human-readable string. */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
