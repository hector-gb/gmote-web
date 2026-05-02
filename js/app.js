/**
 * app.js – entry point
 * Wires the GitHub releases picker to the Web Serial flash flow.
 *
 * EDIT HERE to point at your repo / target filename:
 */
import { REPO_OWNER, REPO_NAME, fetchReleases, downloadAsset, formatBytes } from './github.js';
import { CircuitPythonDevice } from './serial.js';

// CircuitPython always runs /code.py — this never changes regardless of variant.
const DEST_PATH    = '/code.py';
const VERSION_PATH = '/version.txt'; // metadata sidecar written after each flash

/**
 * VARIANTS maps a GitHub release asset filename to display metadata.
 * Asset filenames (code-usb.py, code-bt.py, …) are only used to distinguish
 * variants inside a single GitHub release — they are always flashed to /code.py
 * on the device (CircuitPython's fixed entry point).
 *
 * Add or remove entries to match the assets you publish on GitHub.
 *
 * @type {Array<{ filename: string, label: string, badge: string, description: string }>}
 */
const VARIANTS = [
  {
    filename:    'code-usb.py',
    label:       'USB Only',
    badge:       'USB',
    description: 'Communicates via USB cable only.',
  },
  {
    filename:    'code-bt.py',
    label:       'Bluetooth',
    badge:       'BT',
    description: 'Wireless BLE control. Requires pairing with a host device before use.',
  },
  {
    filename:    'code-combined.py',
    label:       'USB + Bluetooth',
    badge:       'USB+BT',
    description: 'Full build with both USB and BLE support. Recommended for most users.',
  },
];

// ─── DOM refs ────────────────────────────────────────────────────────────────

const selectEl        = /** @type {HTMLSelectElement} */ (q('#release-select'));
const btnRefresh      = q('#btn-refresh');
const releaseMeta     = q('#release-meta');
const releaseDateEl   = q('#release-date');
const releaseNotesEl  = /** @type {HTMLAnchorElement} */ (q('#release-notes-link'));
const releaseBodyEl   = q('#release-body');
const assetListEl     = q('#asset-list');
const assetOptionsEl  = q('#asset-options');
const browserWarning  = q('#browser-warning');
const btnConnect      = q('#btn-connect');
const statusBadge     = q('#connection-status');
const btnFlash        = q('#btn-flash');
const progressWrap    = q('#progress-wrap');
const progressBar     = q('#progress-bar');
const logEl           = q('#log');
const installedBox       = q('#installed-version');
const installedTagEl     = q('#installed-tag');
const installedHashEl    = q('#installed-hash');
const installerCard      = q('#installer-card');
const installerDownload  = /** @type {HTMLAnchorElement} */ (q('#installer-download-btn'));
const installerVerLabel  = q('#installer-version-label');

// ─── state ───────────────────────────────────────────────────────────────────

/** @type {import('./github.js').Release[]} */
let releases = [];

const device = new CircuitPythonDevice();

device.onLog      = (msg, level) => appendLog(msg, level);
device.onProgress = (pct) => setProgress(pct);

// ─── boot ────────────────────────────────────────────────────────────────────

(async function init() {
  // Check Web Serial support
  if (!('serial' in navigator)) {
    browserWarning.classList.remove('hidden');
    btnConnect.disabled = true;
  }

  appendLog(`Fetching releases from ${REPO_OWNER}/${REPO_NAME}…`);
  await loadReleases();

  btnRefresh.addEventListener('click', loadReleases);
  selectEl.addEventListener('change', onReleaseChange);
  btnConnect.addEventListener('click', onConnectClick);
  btnFlash.addEventListener('click', onFlashClick);
})();

// ─── GitHub releases ─────────────────────────────────────────────────────────

async function loadReleases() {
  selectEl.disabled = true;
  selectEl.innerHTML = '<option value="">Loading…</option>';
  releaseMeta.classList.add('hidden');
  releaseBodyEl.classList.add('hidden');
  assetListEl.classList.add('hidden');

  try {
    releases = await fetchReleases();

    if (releases.length === 0) {
      selectEl.innerHTML = '<option value="">No releases found</option>';
      appendLog('No releases found in the repository.', 'warn');
      return;
    }

    selectEl.innerHTML = '<option value="">— select a version —</option>';
    releases.forEach((r, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `${r.name}  (${shortDate(r.publishedAt)})`;
      selectEl.appendChild(opt);
    });

    selectEl.disabled = false;
    appendLog(`Found ${releases.length} release(s).`, 'ok');
  } catch (err) {
    selectEl.innerHTML = '<option value="">Error loading releases</option>';
    appendLog(String(err.message), 'err');
  }
}

function onReleaseChange() {
  const idx = selectEl.value;

  if (idx === '') {
    releaseMeta.classList.add('hidden');
    releaseBodyEl.classList.add('hidden');
    assetListEl.classList.add('hidden');
    installerCard.classList.remove('installer-card--highlight');
    installerVerLabel.classList.add('hidden');
    updateFlashButton();
    return;
  }

  const release = releases[Number(idx)];

  // Meta row
  releaseDateEl.textContent = new Date(release.publishedAt).toLocaleDateString(undefined, { dateStyle: 'medium' });
  releaseNotesEl.href       = release.htmlUrl;
  releaseMeta.classList.remove('hidden');

  // Release description (body)
  if (release.body.trim()) {
    releaseBodyEl.textContent = truncate(stripMarkdown(release.body), 300);
    releaseBodyEl.classList.remove('hidden');
  } else {
    releaseBodyEl.classList.add('hidden');
  }

  // Installer banner
  if (release.installerUrl) {
    installerDownload.href = release.installerUrl;
    installerVerLabel.textContent = `✓ ${release.tag}`;
    installerVerLabel.classList.remove('hidden');
    installerCard.classList.add('installer-card--highlight');
  } else {
    installerVerLabel.classList.add('hidden');
    installerCard.classList.remove('installer-card--highlight');
  }

  // Variant cards
  assetOptionsEl.innerHTML = '';

  if (release.assets.length === 0) {
    assetOptionsEl.innerHTML = `<p class="no-assets-msg">
      No .py assets found in this release. Check the release on GitHub.</p>`;
    assetListEl.classList.remove('hidden');
    updateFlashButton();
    return;
  }

  release.assets.forEach((asset, i) => {
    const variant = VARIANTS.find((v) => v.filename === asset.name);
    const label   = variant?.label       ?? asset.name;
    const badge   = variant?.badge       ?? null;
    const desc    = variant?.description ?? '';

    const el = document.createElement('label');
    el.className = 'variant-card';
    el.innerHTML = `
      <input type="radio" name="asset" value="${i}" ${i === 0 ? 'checked' : ''} />
      <div class="variant-card-body">
        <div class="variant-card-header">
          <span class="variant-label">${label}</span>
          ${badge ? `<span class="variant-badge">${badge}</span>` : ''}
          <span class="variant-size">${formatBytes(asset.size)}</span>
        </div>
        ${desc ? `<p class="variant-desc">${desc}</p>` : ''}
      </div>
    `;
    assetOptionsEl.appendChild(el);
  });

  assetListEl.classList.remove('hidden');
  updateFlashButton();
}

// ─── connect / disconnect ────────────────────────────────────────────────────

async function onConnectClick() {
  if (device.connected) {
    setUiBusy(true);
    await device.disconnect();
    setConnectionStatus(false);
    installedBox.classList.add('hidden');
    setUiBusy(false);
    return;
  }

  setUiBusy(true);
  try {
    await device.connect();
    setConnectionStatus(true);
    await readInstalledVersion();
  } catch (err) {
    appendLog(err.message, 'err');
  } finally {
    setUiBusy(false);
  }
}

// ─── flash ───────────────────────────────────────────────────────────────────

async function onFlashClick() {
  const release = getSelectedRelease();
  const asset   = getSelectedAsset(release);
  if (!release || !asset) return;

  setUiBusy(true);
  progressWrap.classList.remove('hidden');
  setProgress(0);

  try {
    appendLog(`Downloading ${asset.name} from release ${release.tag}…`, 'info');
    const content = await downloadAsset(asset);
    appendLog(`Download complete (${formatBytes(content.length)} chars). Flashing…`, 'info');

    const variant = VARIANTS.find((v) => v.filename === asset.name);

    // Fetch the source SHA from the release's version.txt sidecar
    let sourceSha = null;
    if (release.sourceVersionUrl) {
      sourceSha = await fetch(release.sourceVersionUrl).then((r) => r.text()).then((t) => t.trim()) || null;
    }

    // Flash boot.py first (silently — it's tiny and not user-selectable)
    if (release.bootAsset) {
      appendLog('Downloading boot.py…', 'info');
      const bootContent = await downloadAsset(release.bootAsset);
      appendLog(`Flashing boot.py (${formatBytes(bootContent.length)} bytes)…`, 'info');
      device.onProgress = null;
      await device.flashFile(bootContent, '/boot.py');
      device.onProgress = (pct) => setProgress(pct);
      appendLog('boot.py flashed.', 'ok');
      setProgress(0);
    }

    await device.flashFile(content, DEST_PATH);

    // Write sidecar metadata so we can read back what's installed
    const meta = JSON.stringify({
      version:   release.tag,
      asset:     asset.name,
      variant:   variant?.label ?? null,
      sourceSha,
      flashed:   new Date().toISOString(),
    });
    await device.flashFile(meta, VERSION_PATH);
    appendLog(`Version metadata written to ${VERSION_PATH}.`, 'info');
    await device.softReset();

    showInstalledVersion({ tag: release.tag, variant: variant?.label ?? null, sourceSha });
    appendLog('Power cycle the device (unplug and replug) to fully initialize the new firmware.', 'warn');
  } catch (err) {
    appendLog(err.message, 'err');
    // If the device disconnected mid-flash, update UI
    if (!device.connected) setConnectionStatus(false);
  } finally {
    setUiBusy(false);
  }
}

// ─── UI helpers ──────────────────────────────────────────────────────────────

// ─── version readback ────────────────────────────────────────────────────────

async function readInstalledVersion() {
  installedBox.classList.add('hidden');
  try {
    const raw = await device.readFile(VERSION_PATH);
    if (!raw) {
      appendLog('No version file found on device.', 'warn');
      return;
    }
    const meta = JSON.parse(raw);
    showInstalledVersion({ tag: meta.version, variant: meta.variant ?? null, sourceSha: meta.sourceSha ?? null });
    const variantStr = meta.variant ? ` · ${meta.variant}` : '';
    appendLog(`Device has ${meta.version}${variantStr} (flashed ${new Date(meta.flashed).toLocaleString()}).`, 'ok');
  } catch (err) {
    appendLog(`Could not read version metadata: ${err.message}`, 'warn');
  }
}

function showInstalledVersion({ tag, variant, sourceSha }) {
  installedTagEl.textContent  = variant ? `${tag} · ${variant}` : tag;
  installedHashEl.textContent = sourceSha ? `source sha: ${sourceSha.slice(0, 12)}…` : '';
  installedHashEl.title       = sourceSha ? `Source SHA: ${sourceSha}` : '';
  installedBox.classList.remove('hidden');
}


function setConnectionStatus(connected) {
  statusBadge.textContent = connected ? 'Connected' : 'Disconnected';
  statusBadge.className   = `status-badge ${connected ? 'status-connected' : 'status-disconnected'}`;
  btnConnect.textContent  = connected ? 'Disconnect' : 'Connect to device';
  updateFlashButton();
}

function updateFlashButton() {
  const hasRelease = selectEl.value !== '';
  const hasAsset   = !!q('input[name="asset"]:checked');
  btnFlash.disabled = !(device.connected && hasRelease && hasAsset);
}

function setUiBusy(busy) {
  btnConnect.disabled  = busy;
  btnRefresh.disabled  = busy;
  selectEl.disabled    = busy || releases.length === 0;
  if (busy) {
    btnFlash.disabled  = true;
    statusBadge.className = 'status-badge status-busy';
    statusBadge.textContent = 'Busy…';
  } else {
    setConnectionStatus(device.connected);
  }
}

function setProgress(pct) {
  progressBar.style.width = `${pct}%`;
}

function appendLog(msg, level = 'info') {
  const span = document.createElement('span');
  span.className = `log-${level}`;
  span.textContent = `${timestamp()}  ${msg}\n`;
  logEl.appendChild(span);
  logEl.scrollTop = logEl.scrollHeight;
}

// ─── selection helpers ───────────────────────────────────────────────────────

function getSelectedRelease() {
  const idx = selectEl.value;
  return idx !== '' ? releases[Number(idx)] : null;
}

function getSelectedAsset(release) {
  if (!release) return null;
  const radio = /** @type {HTMLInputElement|null} */ (q('input[name="asset"]:checked'));
  if (!radio) return null;
  return release.assets[Number(radio.value)] ?? null;
}

// ─── tiny utils ──────────────────────────────────────────────────────────────

function q(sel) { return document.querySelector(sel); }

function timestamp() {
  return new Date().toLocaleTimeString(undefined, { hour12: false });
}

function shortDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'short' });
}

/** Strip the most common markdown syntax for plain-text display. */
function stripMarkdown(md) {
  return md
    .replace(/^#+\s+/gm, '')          // headings
    .replace(/\*\*(.+?)\*\*/g, '$1')  // bold
    .replace(/\*(.+?)\*/g, '$1')      // italic
    .replace(/`{1,3}[^`]*`{1,3}/g, '') // inline code / fenced
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links
    .replace(/^\s*[-*+]\s+/gm, '• ')  // bullet lists
    .trim();
}

function truncate(str, maxLen) {
  return str.length > maxLen ? str.slice(0, maxLen).trimEnd() + '…' : str;
}
