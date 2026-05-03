/**
 * services/pairingService.js
 *
 * Device pairing management.
 *
 * Listing/approval go through openclaw's in-process plugin SDK
 * (`openclaw/plugin-sdk/device-bootstrap`) instead of the WS-based CLI.
 * This sidesteps two bugs in current openclaw releases:
 *
 *   1. WS handshake race against loopback gateway (issue #45504) which
 *      causes `openclaw devices list/approve --token` to hang/timeout.
 *   2. `missing scope: operator.admin` errors (issue #51779) — the shared
 *      gateway token doesn't carry operator scopes; the SDK lets us pass
 *      `callerScopes: ["operator.admin"]` explicitly because the wrapper
 *      runs with filesystem access to the state dir and is the trusted
 *      bootstrap admin surface (guarded by WRAPPER_ADMIN_PASSWORD).
 *
 * Reject/revoke still use the CLI because the SDK doesn't export them yet.
 */

import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import fs from 'fs/promises';
import path from 'path';
import chokidar from 'chokidar';
import {
  OPENCLAW_HOME,
  DATA_DIR,
  OPENCLAW_GATEWAY_TOKEN,
  OPENCLAW_ENTRY,
  OPENCLAW_NODE,
} from '../config/index.js';
import { log } from '../utils/log.js';

const PENDING_PATH = path.join(OPENCLAW_HOME, 'nodes', 'pending.json');
const PAIRED_PATH  = path.join(OPENCLAW_HOME, 'nodes', 'paired.json');

// ─── SDK loader ─────────────────────────────────────────────────────
// openclaw/plugin-sdk/device-bootstrap is an internal SDK; resolve its
// path relative to the openclaw entry.js so it works regardless of where
// openclaw is installed.

let deviceBootstrapSdkPromise = null;

function resolveDeviceBootstrapSdkPath() {
  const entryPath = path.resolve(OPENCLAW_ENTRY);
  try {
    const requireFromOpenclaw = createRequire(entryPath);
    return requireFromOpenclaw.resolve('openclaw/plugin-sdk/device-bootstrap');
  } catch {
    // Fallback: assume standard openclaw layout
    const openclawRoot = path.dirname(path.dirname(entryPath));
    return path.join(openclawRoot, 'dist', 'plugin-sdk', 'device-bootstrap.js');
  }
}

async function loadDeviceBootstrapSdk() {
  if (!deviceBootstrapSdkPromise) {
    deviceBootstrapSdkPromise = import(
      pathToFileURL(resolveDeviceBootstrapSdkPath()).href
    ).catch((err) => {
      deviceBootstrapSdkPromise = null;
      throw err;
    });
  }
  return deviceBootstrapSdkPromise;
}

/**
 * Public probe — log SDK readiness on boot. Called from server.js so we know
 * immediately if openclaw's dist layout changed and our resolver broke.
 */
export async function probeDeviceBootstrapSdk() {
  try {
    await loadDeviceBootstrapSdk();
    log.info(`device bootstrap SDK ready: ${resolveDeviceBootstrapSdkPath()}`);
  } catch (err) {
    log.warn(
      `device bootstrap SDK unavailable at ${resolveDeviceBootstrapSdkPath()}: ${err?.message || String(err)}`
    );
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

function devicePairingTimestamp(request) {
  const ts = request?.ts;
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'string') {
    const parsed = Date.parse(ts);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function newestPendingDevicePairing(pending) {
  if (!Array.isArray(pending) || pending.length === 0) return null;
  return pending.reduce((latest, current) =>
    devicePairingTimestamp(current) > devicePairingTimestamp(latest) ? current : latest
  );
}

function describeDeviceApprovalForbidden(result) {
  const scope = result?.scope || 'unknown';
  const role  = result?.role  || 'unknown';

  switch (result?.reason) {
    case 'caller-scopes-required':
    case 'caller-missing-scope':
      return `missing scope: ${scope}`;
    case 'scope-outside-requested-roles':
      return `invalid scope for requested roles: ${scope}`;
    case 'bootstrap-role-not-allowed':
      return `bootstrap profile does not allow role: ${role}`;
    case 'bootstrap-scope-not-allowed':
      return `bootstrap profile does not allow scope: ${scope}`;
    default:
      return 'Device approval is forbidden by bootstrap policy.';
  }
}

class PairingService extends EventEmitter {
  constructor() {
    super();
    this._watcher = null;
    this._startWatching();
  }

  // ─── Listing — SDK with file fallback ────────────────────────────

  async listDevices() {
    try {
      const { listDevicePairing } = await loadDeviceBootstrapSdk();
      const data = await listDevicePairing();
      return {
        pending: Array.isArray(data?.pending) ? data.pending : [],
        paired:  Array.isArray(data?.paired)  ? data.paired  : [],
      };
    } catch (err) {
      log.warn(`SDK listDevicePairing failed (${err?.message || err}); reading files`);
      return {
        pending: await this._readFile(PENDING_PATH, []),
        paired:  await this._readFile(PAIRED_PATH,  []),
      };
    }
  }

  async getPending() {
    const { pending } = await this.listDevices();
    return pending;
  }

  async getPaired() {
    const { paired } = await this.listDevices();
    return paired;
  }

  // ─── Approve — SDK only (CLI route hits the operator.admin scope bug) ─

  async approve(requestId) {
    const { approveDevicePairing, listDevicePairing } = await loadDeviceBootstrapSdk();

    let targetRequestId = requestId ? String(requestId).trim() : '';

    // Resolve "approve latest" for callers who omit requestId
    if (!targetRequestId) {
      const pairings = await listDevicePairing();
      const latest = newestPendingDevicePairing(pairings?.pending || []);
      targetRequestId = latest?.requestId || '';
      if (!targetRequestId) {
        throw new Error('No pending device pairing requests.');
      }
    }

    log.info(`Approving pairing request: ${targetRequestId}`);

    const result = await approveDevicePairing(targetRequestId, {
      // The wrapper has filesystem access to the state dir and is guarded by
      // WRAPPER_ADMIN_PASSWORD, so it acts as the trusted bootstrap admin.
      callerScopes: ['operator.admin'],
    });

    if (!result) {
      throw new Error(`Unknown pending device pairing request: ${targetRequestId}`);
    }

    if (result.status === 'forbidden') {
      throw new Error(describeDeviceApprovalForbidden(result));
    }

    log.info(`Approved device pairing ${targetRequestId}`);
    this.emit('pairingUpdate', { action: 'approved', requestId: targetRequestId, device: result.device });
    return { requestId: targetRequestId, device: result.device };
  }

  // ─── Reject / Revoke — CLI fallback (SDK does not export these yet) ──

  async reject(requestId) {
    log.info(`Rejecting pairing request: ${requestId}`);
    const args = ['devices', 'reject', String(requestId)];
    if (OPENCLAW_GATEWAY_TOKEN) args.push('--token', OPENCLAW_GATEWAY_TOKEN);
    await this._runOpenclaw(args);
    this.emit('pairingUpdate', { action: 'rejected', requestId });
  }

  async revoke(deviceId, role) {
    log.info(`Revoking device: ${deviceId} role: ${role}`);

    // Step 1: Revoke the device token (best-effort, may already be revoked)
    if (role) {
      try {
        const args = ['devices', 'revoke', '--device', deviceId, '--role', role];
        if (OPENCLAW_GATEWAY_TOKEN) args.push('--token', OPENCLAW_GATEWAY_TOKEN);
        await this._runOpenclaw(args);
      } catch (err) {
        log.warn(`Revoke token failed (may already be revoked): ${err.message}`);
      }
    }

    // Step 2: Remove the device entry
    const args = ['devices', 'remove', deviceId];
    if (OPENCLAW_GATEWAY_TOKEN) args.push('--token', OPENCLAW_GATEWAY_TOKEN);
    await this._runOpenclaw(args);

    this.emit('pairingUpdate', { action: 'revoked', deviceId });
  }

  // ─── Private ────────────────────────────────────────────────────────

  /**
   * Spawn `node $OPENCLAW_ENTRY <args>` (matches reference template).
   * Returns stdout on success, throws Error with combined output on failure.
   * 30s timeout — well above the usual WS race window.
   */
  _runOpenclaw(args, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        HOME: DATA_DIR,
        OPENCLAW_STATE_DIR: OPENCLAW_HOME,
      };
      const proc = spawn(OPENCLAW_NODE, [OPENCLAW_ENTRY, ...args], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let out = '';
      proc.stdout?.on('data', (d) => { out += d.toString('utf8'); });
      proc.stderr?.on('data', (d) => { out += d.toString('utf8'); });

      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        out += '\n[timeout] command exceeded ' + timeoutMs + 'ms\n';
      }, timeoutMs);

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`spawn failed: ${err.message}\n${out}`));
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else reject(new Error(`openclaw ${args[0]} ${args[1] || ''} exit ${code}: ${out.trim()}`));
      });
    });
  }

  async _readFile(filePath, defaultVal) {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
      return Object.entries(parsed).map(([id, v]) => ({ id, ...v }));
    } catch {
      return defaultVal;
    }
  }

  _startWatching() {
    this._watcher = chokidar.watch(PENDING_PATH, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
    });

    // Read pending.json directly on change — do NOT call listDevices() because
    // we want the SSE push to be instant, before any SDK overhead.
    const pushPending = async () => {
      try {
        const pending = await this._readFile(PENDING_PATH, []);
        this.emit('pendingChanged', pending);
        log.info(`Pairing pending list updated (${pending.length} pending)`);
      } catch { /* file may not exist yet */ }
    };

    this._watcher.on('change', pushPending);
    this._watcher.on('add', pushPending);
    this._watcher.on('error', (err) => {
      log.warn('Pairing file watcher error (non-fatal):', err.message);
    });
  }
}

export const pairingService = new PairingService();
