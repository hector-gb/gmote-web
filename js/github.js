/**
 * github.js
 * Fetches releases and their assets from a public GitHub repository.
 *
 * Configure REPO_OWNER and REPO_NAME to point at your firmware repo.
 *
 * Release metadata comes from releases.json at the root of the releases repo
 * (written by gmote's publish.sh), served from raw.githubusercontent.com. The
 * GitHub REST API is deliberately not used here: unauthenticated it allows only
 * 60 requests/hour per IP, which users behind a shared office/VPN IP exhausted.
 */

export const REPO_OWNER = 'hector-gb';
export const REPO_NAME  = 'gmote-releases';

const RAW_BASE = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main`;
const HTML_BASE = `https://github.com/${REPO_OWNER}/${REPO_NAME}`;

/**
 * @typedef {Object} Asset
 * @property {string} name        - Filename (e.g. "code.py")
 * @property {string} downloadUrl - Raw download URL
 * @property {number} size        - Size in bytes
 * @property {string} contentType - MIME type
 */

/**
 * @typedef {Object} Release
 * @property {string}      tag              - e.g. "v1.2.3"
 * @property {string}      name             - Human-readable release title
 * @property {string}      publishedAt      - ISO 8601 date string
 * @property {string}      htmlUrl          - Link to the GitHub release page
 * @property {string}      body             - Release notes (raw markdown)
 * @property {Asset[]}     assets           - Selectable .py variants (excludes boot.py)
 * @property {Asset|null}  bootAsset        - boot.py asset for this release, or null
 * @property {string|null} sourceVersionUrl - Download URL for source-sha.txt, or null
 * @property {string|null} installerUrl     - Download URL for gmote-installer.zip, or null
 */

/**
 * Returns all releases listed in releases.json, newest first.
 * Each release's files live in a folder named after its tag on the main branch.
 *
 * @returns {Promise<Release[]>}
 */
export async function fetchReleases() {
  const res = await fetch(`${RAW_BASE}/releases.json`);
  if (!res.ok) throw new Error(`Failed to load releases.json: ${res.status} ${res.statusText}`);

  /** @type {{ releases: any[] }} */
  const manifest = await res.json();

  return manifest.releases.map((r) => {
    const tag = r.tag;
    /** @type {{ name: string, size: number }[]} */
    const files = r.files ?? [];
    const find = (name) => files.find((f) => f.name === name);

    const urlFor = (name) => `${RAW_BASE}/${tag}/${name}`;
    const toAsset = (f) => ({
      name:        f.name,
      downloadUrl: urlFor(f.name),
      size:        f.size,
      contentType: 'text/x-python',
    });

    const bootFile      = find('boot.py');
    const shaFile       = find('source-sha.txt');
    const installerFile = find('gmote-installer_macOS.zip');

    return {
      tag,
      name:        r.name || tag,
      publishedAt: r.publishedAt,
      htmlUrl:     `${HTML_BASE}/releases/tag/${tag}`,
      body:        r.notes ?? '',
      assets: files
        .filter((f) => isPythonAsset(f.name) && f.name !== 'boot.py')
        .map(toAsset),
      bootAsset:        bootFile      ? toAsset(bootFile)              : null,
      sourceVersionUrl: shaFile       ? urlFor(shaFile.name)           : null,
      installerUrl:     installerFile ? urlFor(installerFile.name)     : null,
    };
  });
}

/**
 * Downloads an asset and returns its text content.
 *
 * @param {Asset} asset
 * @returns {Promise<string>}
 */
export async function downloadAsset(asset) {
  const res = await fetch(asset.downloadUrl);
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
