/**
 * gitSyncService.js
 *
 * Handles GitHub-backed persistence for /data/.openclaw:
 *  - Verify and optionally create the remote GitHub repo
 *  - Initialize a local git repo in OPENCLAW_HOME
 *  - Commit + push changes (git-sync)
 *  - Restore openclaw.json from remote if missing on boot
 *  - Hourly auto-sync via setInterval
 */

import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFileSync, execSync } from 'child_process';
import { OPENCLAW_HOME, OPENCLAW_CONFIG_PATH } from '../config/index.js';
import { log } from '../utils/log.js';

// ── GitHub API helpers ────────────────────────────────────────────

const GH_HEADERS = (token) => ({
  Authorization: `token ${token}`,
  'User-Agent': 'openclaw-railway',
  Accept: 'application/vnd.github+json',
});

async function ghErrorMsg(res) {
  try {
    const p = await res.json();
    const base = typeof p?.message === 'string' ? p.message.trim() : '';
    const detail = Array.isArray(p?.errors)
      ? p.errors.map((e) => (typeof e?.message === 'string' ? e.message.trim() : '')).filter(Boolean).join('; ')
      : '';
    if (base && detail) return `${base} (${detail})`;
    return base || detail || res.statusText || `HTTP ${res.status}`;
  } catch {
    return res.statusText || `HTTP ${res.status}`;
  }
}

// Repo is "empty" if it has no commits yet, or only boilerplate files
const BOILERPLATE = new Set(['readme', 'readme.md', 'readme.txt', 'license', 'license.md', '.gitignore', '.gitattributes']);

async function repoIsBoilerplateOnly(repoPath, headers) {
  try {
    const r = await fetch(`https://api.github.com/repos/${repoPath}/contents/`, { headers });
    if (!r.ok) return false;
    const entries = await r.json();
    if (!Array.isArray(entries)) return false;
    if (entries.length === 0) return true;
    return entries.every((e) => e.type === 'file' && BOILERPLATE.has(e.name.toLowerCase()));
  } catch { return false; }
}

// ── verifyGithubRepo ─────────────────────────────────────────────

/**
 * Verify a GitHub token + repo combination.
 * mode: 'new' (repo should not exist / will be created) | 'existing' (must already exist)
 * Returns: { ok, repoExists, repoIsEmpty, createOwnerType?, viewerLogin?, error?, status? }
 */
export async function verifyGithubRepo({ githubToken, repoPath, mode = 'new' }) {
  const headers = GH_HEADERS(githubToken);
  const [repoOwner = '', repoName = ''] = String(repoPath || '').split('/');
  const isExisting = mode === 'existing';

  try {
    // 1. Validate token
    const userRes = await fetch('https://api.github.com/user', { headers });
    if (!userRes.ok) {
      return { ok: false, status: 400, error: `Cannot verify GitHub token: ${await ghErrorMsg(userRes)}` };
    }

    // Check classic PAT scope
    const scopeHeader = (userRes.headers.get?.('x-oauth-scopes') || '').toLowerCase();
    if (String(githubToken).startsWith('ghp_') && scopeHeader && !scopeHeader.includes('repo') && !scopeHeader.includes('public_repo')) {
      return { ok: false, status: 400, error: `Your token needs the "repo" scope. Current scopes: ${scopeHeader}` };
    }

    const userPayload = await userRes.json().catch(() => ({}));
    const viewerLogin = String(userPayload?.login || '').trim();

    // 2. Check repo existence
    const checkRes = await fetch(`https://api.github.com/repos/${repoPath}`, { headers });

    if (checkRes.status === 404) {
      if (isExisting) {
        return { ok: false, status: 400, error: `Repository "${repoPath}" not found. Check the repo name and token permissions.` };
      }
      // New repo: verify ownership
      if (!viewerLogin) {
        return { ok: false, status: 400, error: 'Cannot verify GitHub account owner for this token.' };
      }
      if (repoOwner.toLowerCase() !== viewerLogin.toLowerCase()) {
        // Check if it's an org the token can access
        const orgRes = await fetch('https://api.github.com/user/orgs?per_page=100', { headers });
        if (orgRes.ok) {
          const orgs = await orgRes.json().catch(() => []);
          const found = Array.isArray(orgs) && orgs.some((o) => String(o?.login || '').toLowerCase() === repoOwner.toLowerCase());
          if (found) return { ok: true, repoExists: false, repoIsEmpty: false, createOwnerType: 'org', viewerLogin };
        }
        return {
          ok: false, status: 400,
          error: `Repository owner "${repoOwner}" does not match your GitHub user "${viewerLogin}" and was not found in your organizations.`,
        };
      }
      return { ok: true, repoExists: false, repoIsEmpty: false, createOwnerType: 'user', viewerLogin };
    }

    if (checkRes.ok) {
      // Repo exists — check if it has commits
      const commitsRes = await fetch(`https://api.github.com/repos/${repoPath}/commits?per_page=1`, { headers });
      if (commitsRes.status === 409) {
        // 409 = empty repo (no commits)
        return { ok: true, repoExists: true, repoIsEmpty: true, viewerLogin };
      }
      if (commitsRes.ok) {
        const onlyBoilerplate = await repoIsBoilerplateOnly(repoPath, headers);
        if (onlyBoilerplate) return { ok: true, repoExists: true, repoIsEmpty: true, viewerLogin };
        if (isExisting) return { ok: true, repoExists: true, repoIsEmpty: false, viewerLogin };
        return {
          ok: false, status: 400,
          error: `Repository "${repoPath}" already exists and is not empty. Use "Import existing repo" instead.`,
        };
      }
    }

    if (String(githubToken).startsWith('github_pat_') && checkRes.status === 403) {
      return { ok: false, status: 400, error: `Your fine-grained token needs Contents (read/write) and Metadata (read) permissions for "${repoPath}".` };
    }
    return { ok: false, status: 400, error: `Cannot verify repo "${repoPath}": ${await ghErrorMsg(checkRes)}` };
  } catch (e) {
    return { ok: false, status: 400, error: `GitHub verification error: ${e.message}` };
  }
}

// ── ensureGithubRepoExists ────────────────────────────────────────

/**
 * Verify the repo is accessible, creating it if it doesn't exist yet.
 */
export async function ensureGithubRepoExists({ githubToken, repoPath, mode = 'new' }) {
  const [repoOwner = '', repoName = ''] = String(repoPath || '').split('/');
  const headers = GH_HEADERS(githubToken);

  const verification = await verifyGithubRepo({ githubToken, repoPath, mode });

  if (!verification.ok) return verification;
  if (verification.repoExists) {
    log.info(`[git-sync] Using existing repo ${repoPath}`);
    return { ok: true, repoExists: true, repoIsEmpty: verification.repoIsEmpty };
  }

  try {
    log.info(`[git-sync] Creating repo ${repoPath}...`);
    const createUrl = verification.createOwnerType === 'org'
      ? `https://api.github.com/orgs/${repoOwner}/repos`
      : 'https://api.github.com/user/repos';
    const createRes = await fetch(createUrl, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: repoName, private: true, auto_init: false }),
    });
    if (!createRes.ok) {
      const details = await ghErrorMsg(createRes);
      return { ok: false, status: 400, error: `Failed to create repo: ${details}` };
    }
    log.info(`[git-sync] Repo ${repoPath} created`);
    return { ok: true };
  } catch (e) {
    return { ok: false, status: 400, error: `GitHub error: ${e.message}` };
  }
}

// ── .gitignore contents ──────────────────────────────────────────

const GITIGNORE = `# Ignore everything by default.
*

# Whitelist specific files/dirs.
!workspace/
!workspace/**
workspace/.openclaw/
workspace/.openclaw/**
!openclaw.json
!.gitignore
`;

// ── Git helpers ──────────────────────────────────────────────────

function writeAskPass(askPassPath, githubToken) {
  fs.writeFileSync(
    askPassPath,
    [
      '#!/usr/bin/env sh',
      'case "$1" in',
      '  *Username*) printf "%s\\n" "x-access-token" ;;',
      '  *) printf "%s\\n" "$_GIT_TOKEN" ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o700 },
  );
}

function makeGitEnv(githubToken) {
  return {
    ...process.env,
    _GIT_TOKEN: githubToken,
    GIT_TERMINAL_PROMPT: '0',
    HOME: process.env.HOME || os.homedir(),
  };
}

function runGit(args, { cwd = OPENCLAW_HOME, askPassPath = null, githubToken = null } = {}) {
  const env = githubToken ? { ...makeGitEnv(githubToken), GIT_ASKPASS: askPassPath } : { ...process.env };
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', env });
}

// ── initGitRepo ──────────────────────────────────────────────────

/**
 * Initialize /data/.openclaw as a git repo (idempotent).
 * - git init + set remote
 * - Write .gitignore
 * - Commit + push initial state
 * - If existing repo: clone to temp, promote, restore config if missing
 */
export async function initGitRepo({ githubToken, repoPath, repoIsEmpty }) {
  const originUrl = `https://github.com/${repoPath}.git`;
  const gitDir = path.join(OPENCLAW_HOME, '.git');

  try {
    // Ensure OPENCLAW_HOME exists
    await fsp.mkdir(OPENCLAW_HOME, { recursive: true });

    const askPassPath = path.join(os.tmpdir(), `ocgit-askpass-${process.pid}.sh`);
    writeAskPass(askPassPath, githubToken);

    try {
      if (fs.existsSync(gitDir)) {
        // Repo already initialized — just update remote URL
        runGit(['remote', 'set-url', 'origin', originUrl]);
        log.info('[git-sync] Git remote updated');
      } else {
        // Fresh init
        runGit(['init', '-b', 'main'], { cwd: OPENCLAW_HOME });
        runGit(['remote', 'add', 'origin', originUrl]);
        log.info('[git-sync] Git repo initialized');
      }

      // Write .gitignore if missing
      const gitignorePath = path.join(OPENCLAW_HOME, '.gitignore');
      if (!fs.existsSync(gitignorePath)) {
        fs.writeFileSync(gitignorePath, GITIGNORE);
      }

      // Set git identity
      runGit(['config', 'user.name', 'OpenClaw Railway']);
      runGit(['config', 'user.email', 'agent@openclaw.railway']);

      if (!repoIsEmpty) {
        // Existing repo with data — fetch + restore config if missing
        try {
          runGit(['fetch', '--quiet', '--depth=1', 'origin', 'main'], { askPassPath, githubToken });
          runGit(['branch', '--set-upstream-to=origin/main', 'main']);

          if (!fs.existsSync(OPENCLAW_CONFIG_PATH)) {
            try {
              const remoteConfig = runGit(['show', 'origin/main:openclaw.json']);
              if (remoteConfig && remoteConfig.trim()) {
                fs.writeFileSync(OPENCLAW_CONFIG_PATH, remoteConfig);
                log.info('[git-sync] Restored openclaw.json from remote');
              }
            } catch {
              log.info('[git-sync] No openclaw.json on remote yet');
            }
          }
        } catch (e) {
          log.warn(`[git-sync] Could not fetch existing repo: ${e.message}`);
        }
      }

      // Initial commit + push (if there's anything to commit)
      try {
        runGit(['add', '-A']);
        const diff = execFileSync('git', ['diff', '--cached', '--quiet'], {
          cwd: OPENCLAW_HOME, stdio: 'pipe', env: { ...process.env },
        }).toString();
      } catch {
        // diff --cached --quiet exits 1 when there ARE changes
        try {
          runGit(['commit', '-m', 'chore: initial openclaw-railway commit']);
          runGit(['push', '-u', 'origin', 'main'], { askPassPath, githubToken });
          log.info('[git-sync] Initial commit pushed');
        } catch (e) {
          // May already be up to date — not fatal
          log.info(`[git-sync] Initial push: ${e.message?.slice(0, 100)}`);
        }
      }

      return { ok: true };
    } finally {
      try { fs.rmSync(askPassPath, { force: true }); } catch {}
    }
  } catch (e) {
    log.error(`[git-sync] initGitRepo failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// ── gitSync ──────────────────────────────────────────────────────

let _lastSyncResult = null;

/**
 * Pull + commit + push the current state of OPENCLAW_HOME.
 * Returns { ok, hash?, error? }
 */
export async function gitSync(message) {
  const githubToken = String(process.env.GITHUB_TOKEN || '').trim();
  const repoPath = resolveRepoPath(process.env.GITHUB_WORKSPACE_REPO || '');

  if (!githubToken) return { ok: false, error: 'GITHUB_TOKEN not set' };
  if (!repoPath) return { ok: false, error: 'GITHUB_WORKSPACE_REPO not set' };

  const gitDir = path.join(OPENCLAW_HOME, '.git');
  if (!fs.existsSync(gitDir)) return { ok: false, error: 'Git repo not initialized' };

  const originUrl = `https://github.com/${repoPath}.git`;
  const askPassPath = path.join(os.tmpdir(), `ocgit-sync-${process.pid}-${Date.now()}.sh`);

  try {
    writeAskPass(askPassPath, githubToken);

    const env = { ...makeGitEnv(githubToken), GIT_ASKPASS: askPassPath };

    // Update remote URL (in case it changed)
    execFileSync('git', ['remote', 'set-url', 'origin', originUrl], { cwd: OPENCLAW_HOME, stdio: 'pipe', env: { ...process.env } });
    execFileSync('git', ['config', 'user.name', 'OpenClaw Railway'], { cwd: OPENCLAW_HOME, stdio: 'pipe', env: { ...process.env } });
    execFileSync('git', ['config', 'user.email', 'agent@openclaw.railway'], { cwd: OPENCLAW_HOME, stdio: 'pipe', env: { ...process.env } });

    // Pull (rebase) to stay in sync
    try {
      execFileSync('git', ['ls-remote', '--exit-code', '--heads', 'origin', 'main'], { cwd: OPENCLAW_HOME, stdio: 'ignore', env });
      execFileSync('git', ['pull', '--rebase', '--autostash', 'origin', 'main'], { cwd: OPENCLAW_HOME, stdio: 'pipe', env });
    } catch {
      // No remote branch yet — will push on first commit
    }

    // Stage all
    execFileSync('git', ['add', '-A'], { cwd: OPENCLAW_HOME, stdio: 'pipe', env: { ...process.env } });

    // Check if there's anything to commit
    try {
      execFileSync('git', ['diff', '--cached', '--quiet'], { cwd: OPENCLAW_HOME, stdio: 'pipe', env: { ...process.env } });
      // Exit 0 → nothing to commit
      const result = { ok: true, hash: null, message: 'No changes to commit', ts: new Date().toISOString() };
      _lastSyncResult = result;
      log.info('[git-sync] No changes to commit');
      return result;
    } catch {
      // Exit 1 → there are staged changes — proceed with commit
    }

    execFileSync('git', ['commit', '-m', message || 'chore: auto-sync'], { cwd: OPENCLAW_HOME, stdio: 'pipe', env: { ...process.env } });
    execFileSync('git', ['push', 'origin', 'main'], { cwd: OPENCLAW_HOME, stdio: 'pipe', env });

    const hash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: OPENCLAW_HOME, encoding: 'utf8', stdio: 'pipe', env: { ...process.env } }).trim();
    log.info(`[git-sync] Sync complete (${hash}) — https://github.com/${repoPath}/commit/${hash}`);

    const result = { ok: true, hash, ts: new Date().toISOString() };
    _lastSyncResult = result;
    return result;
  } catch (e) {
    const details = String(e.stderr || e.stdout || e.message || '').trim().slice(0, 400);
    const sanitized = details.replace(/ghp_[^\s"]+/g, '***').replace(/github_pat_[^\s"]+/g, '***');
    log.error(`[git-sync] Sync failed: ${sanitized}`);
    const result = { ok: false, error: sanitized, ts: new Date().toISOString() };
    _lastSyncResult = result;
    return result;
  } finally {
    try { fs.rmSync(askPassPath, { force: true }); } catch {}
  }
}

export function getLastSyncResult() {
  return _lastSyncResult;
}

// ── Auto-sync ────────────────────────────────────────────────────

let _syncInterval = null;

const SYNC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export function startAutoSync() {
  if (_syncInterval) return;

  const run = () => {
    const token = String(process.env.GITHUB_TOKEN || '').trim();
    const repo = String(process.env.GITHUB_WORKSPACE_REPO || '').trim();
    if (!token || !repo) return;

    const ts = new Date().toISOString();
    gitSync(`chore: auto-sync ${ts}`).catch((e) => {
      log.error(`[git-sync] Auto-sync error: ${e.message}`);
    });
  };

  _syncInterval = setInterval(run, SYNC_INTERVAL_MS);
  // Don't block process exit
  if (_syncInterval.unref) _syncInterval.unref();

  log.info('[git-sync] Auto-sync scheduled (every 1 hour)');
}

export function stopAutoSync() {
  if (_syncInterval) {
    clearInterval(_syncInterval);
    _syncInterval = null;
  }
}

// ── Helpers ──────────────────────────────────────────────────────

// ── importFromGithub ─────────────────────────────────────────────

/**
 * Full restore of all tracked files from a GitHub repo into OPENCLAW_HOME.
 *
 * Strategy:
 *  1. Clone the remote into a temp dir (depth=1 for speed)
 *  2. Walk + copy every file in the clone (skipping .git/) into OPENCLAW_HOME
 *  3. Wire up / update the local git remote so future auto-syncs push back
 *  4. Clean up temp dir
 *
 * Emits progress via the optional `onProgress(msg)` callback.
 */
export async function importFromGithub({ githubToken, repoPath, onProgress = null }) {
  // Branch is intentionally locked to 'main' — the auto-sync service
  // always pulls from and pushes to origin/main. Supporting other branches
  // here would silently break future hourly syncs.
  const branch = 'main';
  const originUrl = `https://github.com/${repoPath}.git`;
  const tmpDir = path.join(os.tmpdir(), `ocimport-${process.pid}-${Date.now()}`);
  const askPassPath = path.join(os.tmpdir(), `ocimport-askpass-${process.pid}.sh`);

  const emit = (msg) => {
    log.info(`[git-import] ${msg}`);
    if (onProgress) onProgress(msg);
  };

  try {
    // Validate token + repo first
    emit('Verifying token and repository access…');
    const verify = await verifyGithubRepo({ githubToken, repoPath, mode: 'existing' });
    if (!verify.ok) return { ok: false, error: verify.error };
    if (verify.repoIsEmpty) return { ok: false, error: `Repository "${repoPath}" exists but has no data to restore.` };

    emit(`Cloning ${repoPath} (branch: ${branch})…`);
    writeAskPass(askPassPath, githubToken);
    const cloneEnv = { ...makeGitEnv(githubToken), GIT_ASKPASS: askPassPath };

    // Clone into temp dir
    try {
      execFileSync('git', ['clone', '--depth=1', '--branch', branch, originUrl, tmpDir], {
        stdio: 'pipe',
        env: cloneEnv,
      });
    } catch (e) {
      const msg = String(e.stderr || e.message || '').replace(/ghp_[^\s"]+/g, '***').replace(/github_pat_[^\s"]+/g, '***').trim().slice(0, 300);
      return { ok: false, error: `Clone failed: ${msg}` };
    }

    // Walk clone and copy all files (skip .git/)
    emit('Restoring files to data directory…');
    await fsp.mkdir(OPENCLAW_HOME, { recursive: true });
    const copied = [];
    await copyDir(tmpDir, OPENCLAW_HOME, '.git', copied, emit);

    // Validate that at least one expected OpenClaw payload was restored
    const hasConfig    = fs.existsSync(OPENCLAW_CONFIG_PATH);
    const hasWorkspace = fs.existsSync(path.join(OPENCLAW_HOME, 'workspace'));
    if (!hasConfig && !hasWorkspace) {
      return {
        ok: false,
        error: `Repository "${repoPath}" does not appear to contain OpenClaw data — no openclaw.json or workspace/ directory was found. Make sure this is a repo that was previously backed up by OpenClaw Railway.`,
      };
    }

    emit(`Restored ${copied.length} file(s): ${copied.slice(0, 8).join(', ')}${copied.length > 8 ? ' …' : ''}`);

    // Wire up git remote for future auto-syncs
    const gitDir = path.join(OPENCLAW_HOME, '.git');
    if (fs.existsSync(gitDir)) {
      emit('Updating git remote…');
      try {
        runGit(['remote', 'set-url', 'origin', originUrl]);
        runGit(['config', 'user.name', 'OpenClaw Railway']);
        runGit(['config', 'user.email', 'agent@openclaw.railway']);
        runGit(['fetch', '--quiet', '--depth=1', 'origin', branch], { askPassPath, githubToken });
        runGit(['branch', '--set-upstream-to', `origin/${branch}`, branch]);
      } catch (e) {
        emit(`Warning: could not update git remote: ${e.message?.slice(0, 120)}`);
      }
    } else {
      emit('Initializing git repo for future syncs…');
      try {
        runGit(['init', '-b', 'main'], { cwd: OPENCLAW_HOME });
        runGit(['remote', 'add', 'origin', originUrl]);
        runGit(['config', 'user.name', 'OpenClaw Railway']);
        runGit(['config', 'user.email', 'agent@openclaw.railway']);
        runGit(['fetch', '--quiet', '--depth=1', 'origin', branch], { askPassPath, githubToken });
        runGit(['branch', '--set-upstream-to', `origin/${branch}`, branch]);
      } catch (e) {
        emit(`Warning: git init skipped: ${e.message?.slice(0, 120)}`);
      }
    }

    emit('Import complete ✓');
    return { ok: true, files: copied };
  } catch (e) {
    const sanitized = String(e.message || '').replace(/ghp_[^\s"]+/g, '***').replace(/github_pat_[^\s"]+/g, '***');
    log.error(`[git-import] Failed: ${sanitized}`);
    return { ok: false, error: sanitized };
  } finally {
    try { fs.rmSync(askPassPath, { force: true }); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

/** Recursively copy srcDir → destDir, skipping `skip` name at the root level.
 *  Tracks relative paths (e.g. "workspace/memories/chat.md") in `collected`. */
async function copyDir(src, dest, skip, collected = [], emit = null, prefix = '') {
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === skip) continue;
    const srcPath  = path.join(src,  entry.name);
    const destPath = path.join(dest, entry.name);
    const relPath  = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await fsp.mkdir(destPath, { recursive: true });
      await copyDir(srcPath, destPath, null, collected, emit, relPath);
    } else {
      await fsp.copyFile(srcPath, destPath);
      collected.push(relPath);
    }
  }
}

export function resolveRepoPath(value) {
  return String(value || '')
    .trim()
    .replace(/^git@github\.com:/, '')
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '');
}

export function gitSyncStatus() {
  const token = String(process.env.GITHUB_TOKEN || '').trim();
  const repo = String(process.env.GITHUB_WORKSPACE_REPO || '').trim();
  const gitDir = path.join(OPENCLAW_HOME, '.git');

  return {
    configured: !!(token && repo),
    repoPath: repo ? resolveRepoPath(repo) : null,
    gitInitialized: fs.existsSync(gitDir),
    lastSync: _lastSyncResult,
    autoSyncActive: !!_syncInterval,
  };
}
