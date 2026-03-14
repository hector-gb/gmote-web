/**
 * serial.js
 * Web Serial ↔ CircuitPython raw-REPL file writer.
 *
 * Protocol used (same as mpremote / ampy):
 *   1. Ctrl+C  – interrupt any running script
 *   2. Ctrl+A  – enter raw REPL mode
 *   3. Send Python source + Ctrl+D  – execute it
 *   4. Read back "OK" + output + 0x04 + error + 0x04
 *
 * File writing strategy:
 *   Open the file, write it in ≤ 128-byte hex-encoded chunks to stay
 *   well within the raw-REPL 256-byte line limit, then close & reload.
 */

// ─── constants ───────────────────────────────────────────────────────────────

const CTRL_A = '\x01'; // raw REPL mode
const CTRL_B = '\x02'; // friendly REPL mode (exit raw)
const CTRL_C = '\x03'; // keyboard interrupt
const CTRL_D = '\x04'; // execute (raw REPL) / soft-reset (friendly)

const BAUD_RATE   = 115200;
const CHUNK_BYTES = 128;          // bytes of file data per write() call
const EXEC_TIMEOUT_MS = 5_000;   // max wait for each raw-REPL round-trip

// ─── public API ──────────────────────────────────────────────────────────────

export class CircuitPythonDevice {
  /** @type {SerialPort | null} */
  #port = null;

  /** @type {ReadableStreamDefaultReader | null} */
  #reader = null;

  /** @type {WritableStreamDefaultWriter | null} */
  #writer = null;

  #encoder = new TextEncoder();
  #decoder = new TextDecoder();

  /** @type {((msg: string, level?: 'ok'|'err'|'warn'|'info') => void) | null} */
  onLog = null;

  /** @type {((pct: number) => void) | null} */
  onProgress = null;

  get connected() {
    return this.#port !== null;
  }

  // ─── connect / disconnect ─────────────────────────────────────────────────

  /**
   * Open a browser port-picker dialog and connect.
   * @returns {Promise<void>}
   */
  async connect() {
    if (!('serial' in navigator)) {
      throw new Error('Web Serial API not supported. Use Chrome or Edge 89+.');
    }

    this.#port = await navigator.serial.requestPort();
    await this.#port.open({ baudRate: BAUD_RATE });

    this.#writer = this.#port.writable.getWriter();
    this.#reader = this.#port.readable.getReader();

    this.#log('Connected.', 'ok');

    // Interrupt any running script and switch to raw REPL
    await this.#enterRawRepl();
  }

  async disconnect() {
    try {
      await this.#exitRawRepl();
    } catch (_) { /* best-effort */ }

    try { this.#reader?.cancel(); } catch (_) {}
    try { this.#writer?.releaseLock(); } catch (_) {}
    try { await this.#port?.close(); } catch (_) {}

    this.#reader = null;
    this.#writer = null;
    this.#port   = null;

    this.#log('Disconnected.', 'warn');
  }

  // ─── read file ───────────────────────────────────────────────────────────

  /**
   * Read a text file from the device filesystem via raw REPL.
   * Returns null if the file doesn't exist.
   *
   * @param {string} path  e.g. '/version.txt'
   * @returns {Promise<string|null>}
   */
  async readFile(path) {
    if (!this.connected) throw new Error('Not connected.');
    try {
      const output = await this.#rawExec(
        `try:\n f=open(${JSON.stringify(path)},'r');print(f.read());f.close()\nexcept:pass`
      );
      return output.trim() || null;
    } catch {
      return null;
    }
  }

  // ─── flash ────────────────────────────────────────────────────────────────

  /**
   * Write text content to `destPath` on the device, then soft-reset.
   *
   * @param {string} content   - Text content of the file (e.g. code.py source)
   * @param {string} [destPath='/code.py']
   * @returns {Promise<void>}
   */
  async flashFile(content, destPath = '/code.py') {
    if (!this.connected) throw new Error('Not connected.');

    const bytes = this.#encoder.encode(content);
    const total = bytes.length;

    this.#log(`Writing ${total} bytes to ${destPath}…`, 'info');
    this.#progress(0);

    // Open file
    await this.#rawExec(`f=open(${JSON.stringify(destPath)},'wb')`);

    // Write in chunks
    let written = 0;
    while (written < total) {
      const slice = bytes.slice(written, written + CHUNK_BYTES);
      const hex   = bufToHexLiteral(slice);

      await this.#rawExec(`f.write(bytes.fromhex('${hex}'))`);

      written += slice.length;
      this.#progress(Math.round((written / total) * 90)); // 0-90 % for data
    }

    // Close file
    await this.#rawExec(`f.close()`);

    this.#progress(100);
    this.#log(`Done! ${destPath} flashed successfully.`, 'ok');
  }

  /** Soft-reset the device to run the newly flashed code. */
  async softReset() {
    this.#log('Reloading device…', 'info');
    await this.#rawExec(`import supervisor;supervisor.reload()`);
  }

  // ─── raw REPL helpers ────────────────────────────────────────────────────

  async #enterRawRepl() {
    // Interrupt, then switch to raw REPL. Send twice for reliability.
    await this.#write(CTRL_C + CTRL_C);
    await sleep(100);
    await this.#write(CTRL_A);
    await sleep(200);

    // Drain any buffered response; we just need to be in raw-REPL state.
    await this.#drainMs(300);
    this.#log('Raw REPL ready.', 'info');
  }

  async #exitRawRepl() {
    await this.#write(CTRL_B);
    await sleep(100);
  }

  /**
   * Execute a single Python statement in raw REPL and return any output.
   * Throws if the device returns a Python traceback.
   *
   * @param {string} code
   * @returns {Promise<string>}
   */
  async #rawExec(code) {
    // Send: <code>\x04
    await this.#write(code + CTRL_D);

    // Response: "OK" <stdout> \x04 <stderr> \x04
    const response = await this.#readUntilDoubleCtrlD(EXEC_TIMEOUT_MS);

    // Strip any leading prompt characters ('>' ) before the OK marker
    const stripped = response.replace(/^[>\s]*/, '');
    if (!stripped.startsWith('OK')) {
      throw new Error(`Unexpected raw-REPL response: ${JSON.stringify(response.slice(0, 80))}`);
    }

    // Split on the first \x04 (end of stdout) then get stderr
    const afterOk   = stripped.slice(2);
    const parts     = afterOk.split('\x04');
    const stderr    = parts[1] ?? '';

    if (stderr.trim()) {
      throw new Error(`CircuitPython error:\n${stderr.trim()}`);
    }

    return parts[0]; // stdout
  }

  // ─── I/O primitives ──────────────────────────────────────────────────────

  async #write(text) {
    await this.#writer.write(this.#encoder.encode(text));
  }

  /**
   * Read until we see two consecutive 0x04 bytes (raw-REPL end markers)
   * or the timeout elapses.
   *
   * @param {number} timeoutMs
   * @returns {Promise<string>}
   */
  async #readUntilDoubleCtrlD(timeoutMs) {
    const chunks = [];
    const deadline = Date.now() + timeoutMs;

    let ctrlDcount = 0;

    while (Date.now() < deadline) {
      const { value, done } = await Promise.race([
        this.#reader.read(),
        sleep(timeoutMs).then(() => ({ value: null, done: true })),
      ]);

      if (done || !value) break;

      chunks.push(...value);

      for (const byte of value) {
        if (byte === 0x04) ctrlDcount++;
      }

      if (ctrlDcount >= 2) break;
    }

    return this.#decoder.decode(Uint8Array.from(chunks));
  }

  /**
   * Read and discard everything available for `ms` milliseconds.
   * @param {number} ms
   */
  async #drainMs(ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const race = await Promise.race([
        this.#reader.read(),
        sleep(ms).then(() => null),
      ]);
      if (!race || race.done) break;
    }
  }

  // ─── helpers ─────────────────────────────────────────────────────────────

  #log(msg, level = 'info') {
    this.onLog?.(msg, level);
  }

  #progress(pct) {
    this.onProgress?.(pct);
  }
}

// ─── module-level helpers ────────────────────────────────────────────────────

/** Convert a Uint8Array to a lowercase hex string (no prefix). */
function bufToHexLiteral(buf) {
  return Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
