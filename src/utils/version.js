/**
 * utils/version.js
 *
 * Reports the OpenClaw version situation for the setup/admin UI:
 *  - which version is actually installed in the image (from `entry.js --version`)
 *  - what the deployer pinned via the OPENCLAW_VERSION build arg
 *  - whether the Docker build auto-bumped an old pin up to the compatibility floor
 *
 * The build records its decision in /app/openclaw-build-info.json (written by the
 * Dockerfile). At runtime we can't change the installed version — this module is
 * purely for surfacing what happened so users understand any auto-bump.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { OPENCLAW_ENTRY, OPENCLAW_NODE } from '../config/index.js';
import { log } from './log.js';

// Minimum OpenClaw version this template's code is compatible with.
// Keep in sync with ARG OPENCLAW_MIN_VERSION in the Dockerfile.
export const MIN_VERSION = '2026.6.6';

let _installed;       // cached parsed version string | null
let _versionInfo;     // cached getVersionInfo() result

/**
 * Compare two CalVer strings (YYYY.M.P). Pre-release suffixes (-beta.1) are
 * ignored for ordering. Returns -1 if a < b, 0 if equal, 1 if a > b.
 */
export function compareCalVer(a, b) {
  const norm = (v) => String(v).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const A = norm(a);
  const B = norm(b);
  const len = Math.max(A.length, B.length);
  for (let i = 0; i < len; i++) {
    const x = A[i] || 0;
    const y = B[i] || 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/** Actual installed OpenClaw version (e.g. "2026.6.6"), or null if undetectable. */
export function getInstalledOpenclawVersion() {
  if (_installed !== undefined) return _installed;
  try {
    const out = execFileSync(OPENCLAW_NODE, [OPENCLAW_ENTRY, '--version'], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'], // capture stdout, silence child stderr
    });
    const m = out.match(/(\d{4}\.\d+\.\d+(?:-[\w.]+)?)/);
    _installed = m ? m[1] : null;
  } catch (err) {
    log.warn(`Could not read installed openclaw version: ${err.message}`);
    _installed = null;
  }
  return _installed;
}

/** Build-time decision written by the Dockerfile, or null (e.g. local dev). */
function readBuildInfo() {
  const candidates = [
    path.join(process.cwd(), 'openclaw-build-info.json'),
    '/app/openclaw-build-info.json',
  ];
  for (const p of candidates) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch { /* try next */ }
  }
  return null;
}

/**
 * Summary for the UI:
 *  - installed:  actual installed version (ground truth)
 *  - min:        minimum the template supports
 *  - requested:  what the deployer pinned (OPENCLAW_VERSION), if known
 *  - bumped:     true if the build auto-installed `min` instead of an older pin
 *  - belowMin:   true if the *installed* version is still below `min`
 *                (a safety-net: should be false once a rebuild applies the floor)
 */
export function getVersionInfo() {
  if (_versionInfo) return _versionInfo;
  const build = readBuildInfo();
  const installed = getInstalledOpenclawVersion();
  const min = (build && build.min) || MIN_VERSION;
  const isConcrete = installed && /^\d{4}\.\d+\.\d+$/.test(installed);
  const belowMin = isConcrete ? compareCalVer(installed, min) < 0 : false;

  _versionInfo = {
    installed: installed || null,
    min,
    requested: build ? build.requested : null,
    bumped: build ? Boolean(build.bumped) : false,
    belowMin,
  };
  return _versionInfo;
}
