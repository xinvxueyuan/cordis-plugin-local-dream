#!/usr/bin/env node
/**
 * vendor-platform-tools.mjs
 *
 * Reproducibly vendors Google's official Android SDK platform-tools (adb) into
 * `vendor/platform-tools/` so the plugin can control a USB-connected Android
 * device on machines that have no Android SDK installed.
 *
 * Design constraints (deliberate):
 *   - Zero npm dependencies, no build step. Node >= 20 built-ins only.
 *   - A minimal ZIP reader is implemented in this file, so extraction works
 *     identically on Windows, macOS and Linux without shelling out to
 *     `tar`, `unzip` or `Expand-Archive`.
 *   - Everything is explicit and readable: no eval, no new Function, no
 *     obfuscation, no `curl | bash`, no network tricks beyond `fetch`.
 *
 * Usage:
 *   node scripts/vendor-platform-tools.mjs [--platform win32-x64|linux-x64|darwin|all] [--force]
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const VENDOR_DIR = path.join(REPO_ROOT, 'vendor', 'platform-tools');
const VERSION_FILE = path.join(VENDOR_DIR, 'version.json');

/** Official Google Android repository (the Android SDK distribution endpoint). */
const SOURCES = {
  'win32-x64': 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip',
  'linux-x64': 'https://dl.google.com/android/repository/platform-tools-latest-linux.zip',
  darwin: 'https://dl.google.com/android/repository/platform-tools-latest-darwin.zip',
};

const PLATFORMS = Object.keys(SOURCES);

/**
 * What we extract, and where it lands. `from` is the path inside the official
 * zip; `to` is POSIX-relative to `vendor/platform-tools/`.
 * The darwin `adb` is a universal x86_64 + arm64 binary, so one directory
 * serves both Mac architectures.
 */
const PLANS = {
  'win32-x64': [
    { from: 'platform-tools/adb.exe', to: 'win32-x64/adb.exe', adb: true },
    { from: 'platform-tools/AdbWinApi.dll', to: 'win32-x64/AdbWinApi.dll' },
    { from: 'platform-tools/AdbWinUsbApi.dll', to: 'win32-x64/AdbWinUsbApi.dll' },
    { from: 'platform-tools/NOTICE.txt', to: 'win32-x64/NOTICE.txt' },
  ],
  'linux-x64': [
    { from: 'platform-tools/adb', to: 'linux-x64/adb', adb: true },
    { from: 'platform-tools/NOTICE.txt', to: 'linux-x64/NOTICE.txt' },
  ],
  darwin: [
    { from: 'platform-tools/adb', to: 'darwin/adb', adb: true },
    { from: 'platform-tools/NOTICE.txt', to: 'darwin/NOTICE.txt' },
  ],
};

const HOST_PLATFORM =
  process.platform === 'win32' ? 'win32-x64' : process.platform === 'darwin' ? 'darwin' : 'linux-x64';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { force: false, platform: 'all' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--force' || arg === '-f') {
      opts.force = true;
    } else if (arg === '--platform' || arg === '-p') {
      const value = argv[++i];
      if (!value) fail('--platform requires a value');
      opts.platform = value;
    } else if (arg.startsWith('--platform=')) {
      opts.platform = arg.slice('--platform='.length);
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        [
          'Usage: node scripts/vendor-platform-tools.mjs [options]',
          '',
          '  --platform <win32-x64|linux-x64|darwin|all>   default: all',
          '  --force, -f                                   re-download and re-extract',
          '  --help, -h                                    show this help',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  const valid = new Set(['all', ...PLATFORMS]);
  if (!valid.has(opts.platform)) {
    fail(`invalid --platform "${opts.platform}" (expected one of: ${[...valid].join(', ')})`);
  }
  return opts;
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Checksums
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

// ---------------------------------------------------------------------------
// Minimal ZIP reader (stored + deflate, central-directory driven)
// ---------------------------------------------------------------------------

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function readZip(buffer, label) {
  const EOCD_MIN_SIZE = 22;
  const MAX_COMMENT = 0xffff;
  if (buffer.length < EOCD_MIN_SIZE) throw new Error(`${label}: file is too small to be a zip`);

  let eocd = -1;
  const lowest = Math.max(0, buffer.length - EOCD_MIN_SIZE - MAX_COMMENT);
  for (let i = buffer.length - EOCD_MIN_SIZE; i >= lowest; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`${label}: End-Of-Central-Directory record not found`);

  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (centralOffset + centralSize > buffer.length) {
    throw new Error(`${label}: central directory is outside the file bounds`);
  }

  const entries = new Map();
  let cursor = centralOffset;
  for (let n = 0; n < entryCount; n++) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_SIG) {
      throw new Error(`${label}: malformed central directory entry #${n}`);
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const expectedCrc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    if (flags & 0x0001) throw new Error(`${label}: encrypted entry is not supported (${name})`);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error(`${label}: ZIP64 entry is not supported (${name})`);
    }
    if (method !== 0 && method !== 8) {
      throw new Error(`${label}: unsupported compression method ${method} for ${name}`);
    }

    entries.set(name, { name, method, expectedCrc, compressedSize, uncompressedSize, localOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  function read(name) {
    const entry = entries.get(name);
    if (!entry) throw new Error(`${label}: entry not found in archive: ${name}`);
    const at = entry.localOffset;
    if (at + 30 > buffer.length || buffer.readUInt32LE(at) !== LOCAL_SIG) {
      throw new Error(`${label}: malformed local file header for ${name}`);
    }
    const localNameLength = buffer.readUInt16LE(at + 26);
    const localExtraLength = buffer.readUInt16LE(at + 28);
    const dataStart = at + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > buffer.length) throw new Error(`${label}: truncated data for ${name}`);

    const raw = buffer.subarray(dataStart, dataEnd);
    let out;
    if (entry.method === 0) {
      out = Buffer.from(raw);
    } else {
      try {
        out = zlib.inflateRawSync(raw);
      } catch (cause) {
        throw new Error(`${label}: inflate failed for ${name}: ${cause.message}`);
      }
    }
    if (out.length !== entry.uncompressedSize) {
      throw new Error(
        `${label}: size mismatch for ${name} (expected ${entry.uncompressedSize}, got ${out.length})`,
      );
    }
    const actualCrc = crc32(out);
    if (actualCrc !== entry.expectedCrc) {
      throw new Error(
        `${label}: CRC-32 mismatch for ${name} (expected ${entry.expectedCrc.toString(16)}, got ${actualCrc.toString(16)})`,
      );
    }
    return out;
  }

  return { entries, read };
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

async function download(url) {
  console.log(`  downloading ${url}`);
  let response;
  try {
    response = await fetch(url, { redirect: 'follow' });
  } catch (cause) {
    throw new Error(`download failed for ${url}: ${cause.message}`);
  }
  if (!response.ok) {
    throw new Error(`download failed for ${url}: HTTP ${response.status} ${response.statusText}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw new Error(`download failed for ${url}: empty response body`);
  console.log(`  received ${bytes.length} bytes`);
  return bytes;
}

// ---------------------------------------------------------------------------
// adb version probe
// ---------------------------------------------------------------------------

function firstLine(text) {
  const line = String(text ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s.length > 0);
  return line ?? null;
}

/**
 * Return the first line of `adb version` for a vendored binary. The preferred
 * candidate is the binary for this host; the win32-x64 binary is also tried as
 * a fallback because all three archives come from the same platform-tools
 * release and therefore report the same banner.
 */
function probeAdbVersion() {
  const order = [];
  if (HOST_PLATFORM) order.push(HOST_PLATFORM);
  if (!order.includes('win32-x64')) order.push('win32-x64');

  for (const platform of order) {
    const rel = PLANS[platform].find((p) => p.adb)?.to;
    if (!rel) continue;
    const absolute = path.join(VENDOR_DIR, ...rel.split('/'));
    if (!fs.existsSync(absolute)) continue;
    const result = spawnSync(absolute, ['version'], { encoding: 'utf8', timeout: 60_000 });
    if (result.error) continue;
    const line = firstLine(result.stdout) ?? firstLine(result.stderr);
    if (line && result.status === 0) return { line, binary: rel, platform };
    if (line) return { line, binary: rel, platform };
  }
  return null;
}

function revisionFromProperties(raw, label) {
  try {
    const zip = readZip(raw, label);
    if (!zip.entries.has('platform-tools/source.properties')) return null;
    const text = zip.read('platform-tools/source.properties').toString('utf8');
    const match = text.match(/Pkg\.Revision\s*=\s*(\S+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function vendorPlatform(platform, opts, state) {
  const plan = PLANS[platform];
  const targets = plan.map((entry) => ({
    ...entry,
    absolute: path.join(VENDOR_DIR, ...entry.to.split('/')),
    repoRelative: `vendor/platform-tools/${entry.to}`,
  }));

  const missing = targets.filter((t) => !fs.existsSync(t.absolute));

  if (!opts.force && missing.length === 0) {
    console.log(`[${platform}] all ${targets.length} files present — skipping download (use --force to refresh)`);
    for (const target of targets) {
      const data = fs.readFileSync(target.absolute);
      state.files[target.repoRelative] = sha256(data);
      report('kept', target.repoRelative, data.length);
    }
    return;
  }

  const buffer = await download(SOURCES[platform]);
  state.archives[platform] = buffer;
  const zip = readZip(buffer, SOURCES[platform]);

  for (const target of targets) {
    if (!opts.force && fs.existsSync(target.absolute)) {
      const data = fs.readFileSync(target.absolute);
      state.files[target.repoRelative] = sha256(data);
      report('kept', target.repoRelative, data.length);
      continue;
    }
    if (!zip.entries.has(target.from)) {
      throw new Error(`${SOURCES[platform]}: expected archive entry is missing: ${target.from}`);
    }
    const data = zip.read(target.from);
    fs.mkdirSync(path.dirname(target.absolute), { recursive: true });
    fs.writeFileSync(target.absolute, data);
    if (target.adb && process.platform !== 'win32') {
      fs.chmodSync(target.absolute, 0o755);
    }
    state.files[target.repoRelative] = sha256(data);
    report('wrote', target.repoRelative, data.length);
  }
}

function report(action, repoRelative, size) {
  console.log(`  ${action.padEnd(5)} ${repoRelative}  ${size} bytes`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const selected = opts.platform === 'all' ? PLATFORMS : [opts.platform];

  console.log(`vendoring Android platform-tools into ${path.relative(REPO_ROOT, VENDOR_DIR) || 'vendor/platform-tools'}`);
  console.log(`platforms: ${selected.join(', ')}${opts.force ? ' (force refresh)' : ''}`);

  /** @type {{ files: Record<string, string>, archives: Record<string, Buffer> }} */
  const state = { files: {}, archives: {} };

  for (const platform of selected) {
    if (!PLANS[platform]) throw new Error(`no extraction plan for platform ${platform}`);
    await vendorPlatform(platform, opts, state);
  }

  const probe = probeAdbVersion();
  let adbVersion = probe?.line ?? null;
  let adbVersionSource = probe ? `executed ${probe.binary}` : null;
  if (!adbVersion) {
    for (const platform of Object.keys(state.archives)) {
      const revision = revisionFromProperties(state.archives[platform], SOURCES[platform]);
      if (revision) {
        adbVersion = `platform-tools release ${revision} (adb banner not obtainable on this host)`;
        adbVersionSource = 'platform-tools/source.properties';
        break;
      }
    }
  }

  const files = {};
  for (const key of Object.keys(state.files).sort()) files[key] = state.files[key];

  const manifest = {
    source: PLATFORMS.map((platform) => SOURCES[platform]),
    platforms: selected,
    retrievedAt: new Date().toISOString(),
    adbVersion,
    files,
  };
  if (adbVersionSource) manifest.adbVersionSource = adbVersionSource;

  fs.mkdirSync(VENDOR_DIR, { recursive: true });
  fs.writeFileSync(VERSION_FILE, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log('');
  console.log('summary');
  for (const [key, digest] of Object.entries(files)) {
    const size = fs.statSync(path.join(REPO_ROOT, ...key.split('/'))).size;
    console.log(`  ${key}  ${size} bytes  sha256=${digest}`);
  }
  console.log(`  vendor/platform-tools/version.json  ${fs.statSync(VERSION_FILE).size} bytes`);
  console.log('');
  console.log(`adb version: ${adbVersion ?? 'unknown'}${adbVersionSource ? ` (${adbVersionSource})` : ''}`);
}

main().catch((error) => {
  console.error(`error: ${error.message}`);
  process.exit(1);
});
