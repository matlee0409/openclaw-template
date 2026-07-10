/**
 * routes/github.js
 *
 * GitHub backup API endpoints.
 *
 * POST /api/github/verify        — verify token + repo (no auth, pre-setup)
 * GET  /api/github/status        — sync status (admin auth)
 * POST /api/github/sync          — manual sync trigger (admin auth)
 */

import fsp from 'fs/promises';
import { Router } from 'express';
import { requireAdminAuth } from '../middleware/auth.js';
import {
  verifyGithubRepo,
  gitSync,
  gitSyncStatus,
  resolveRepoPath,
  importFromGithub,
  ensureGithubRepoExists,
  initGitRepo,
  startAutoSync,
} from '../services/gitSyncService.js';
import { OPENCLAW_HOME, config } from '../config/index.js';
import { log } from '../utils/log.js';

/**
 * Write GITHUB_TOKEN + GITHUB_WORKSPACE_REPO into the openclaw .env file
 * and update process.env immediately so the running process picks them up.
 */
async function persistGithubEnv(githubToken, repoPath) {
  let lines = [];
  try {
    const raw = await fsp.readFile(config.OPENCLAW_ENV_PATH, 'utf8');
    lines = raw.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
  } catch { /* file may not exist yet */ }

  const envMap = new Map(
    lines.map(l => { const eq = l.indexOf('='); return eq > 0 ? [l.slice(0, eq), l.slice(eq + 1)] : null; }).filter(Boolean)
  );
  envMap.set('GITHUB_TOKEN', githubToken);
  envMap.set('GITHUB_WORKSPACE_REPO', repoPath);
  process.env.GITHUB_TOKEN = githubToken;
  process.env.GITHUB_WORKSPACE_REPO = repoPath;

  await fsp.mkdir(OPENCLAW_HOME, { recursive: true });
  await fsp.writeFile(config.OPENCLAW_ENV_PATH, [...envMap.entries()].map(([k, v]) => `${k}=${v}`).join('\n') + '\n', 'utf8');
}

export const githubRoutes = Router();

// ── POST /api/github/verify ───────────────────────────────────────
// Called by the setup wizard to validate token + repo before launch.
// No admin auth required (may be called before any config exists).

githubRoutes.post('/verify', async (req, res) => {
  const githubToken = String(req.body?.githubToken || '').trim();
  const repoInput = String(req.body?.githubRepo || '').trim();
  const mode = String(req.body?.mode || 'new').trim();

  if (!githubToken || !repoInput) {
    return res.status(400).json({ ok: false, error: 'GitHub token and repo are required' });
  }

  const repoPath = resolveRepoPath(repoInput);
  if (!repoPath.includes('/')) {
    return res.status(400).json({ ok: false, error: 'Repo must be in "owner/name" format' });
  }

  try {
    const result = await verifyGithubRepo({ githubToken, repoPath, mode });
    if (!result.ok) {
      return res.status(result.status || 400).json({ ok: false, error: result.error });
    }
    return res.json({
      ok: true,
      repoExists: result.repoExists || false,
      repoIsEmpty: result.repoIsEmpty !== false,
      repoPath,
    });
  } catch (err) {
    log.error('[github] verify error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/github/setup ────────────────────────────────────────
// Called by the setup wizard (and optionally admin) to wire up GitHub backup.
// Saves credentials, creates/verifies the remote repo, inits local git, starts auto-sync.
// No admin auth — may be called right after first launch before a session cookie exists.

githubRoutes.post('/setup', async (req, res) => {
  const githubToken  = String(req.body?.githubToken  || '').trim();
  const repoInput    = String(req.body?.githubRepo   || '').trim();
  const repoExists   = req.body?.repoExists  === true || req.body?.repoExists  === '1';
  const repoIsEmpty  = req.body?.repoIsEmpty !== false && req.body?.repoIsEmpty !== '0' && req.body?.repoIsEmpty !== 'false';

  if (!githubToken || !repoInput) {
    return res.status(400).json({ ok: false, error: 'githubToken and githubRepo are required' });
  }

  const repoPath = resolveRepoPath(repoInput);
  if (!repoPath.includes('/')) {
    return res.status(400).json({ ok: false, error: 'Repo must be in owner/name format' });
  }

  const repoMode = repoExists && !repoIsEmpty ? 'existing' : 'new';
  log.info(`[git-sync] /api/github/setup — repo=${repoPath} mode=${repoMode}`);

  try {
    // 1. Persist credentials to .env file immediately
    await persistGithubEnv(githubToken, repoPath);
    log.info('[git-sync] Credentials saved');

    // 2. Create / verify remote repo
    const repoResult = await ensureGithubRepoExists({ githubToken, repoPath, mode: repoMode });
    if (!repoResult.ok) {
      return res.status(400).json({ ok: false, error: repoResult.error });
    }

    // 3. Init local git repo and push initial snapshot
    const initResult = await initGitRepo({
      githubToken,
      repoPath,
      repoIsEmpty: repoResult.repoIsEmpty ?? repoIsEmpty,
    });
    if (!initResult.ok) {
      return res.status(500).json({ ok: false, error: initResult.error || 'git init failed' });
    }

    // 4. Start hourly auto-sync
    startAutoSync();

    // 5. Run an initial sync right now so the repo has current data immediately
    gitSync(`chore: initial backup from openclaw-railway ${new Date().toISOString()}`)
      .catch(e => log.error('[git-sync] Initial sync error:', e.message));

    log.info('[git-sync] GitHub backup fully configured');
    return res.json({ ok: true, repoPath });
  } catch (err) {
    log.error('[git-sync] /api/github/setup error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Protected routes ──────────────────────────────────────────────
githubRoutes.use(requireAdminAuth);

// ── GET /api/github/status ────────────────────────────────────────

githubRoutes.get('/status', (req, res) => {
  res.json({ ok: true, ...gitSyncStatus() });
});

// ── POST /api/github/sync ─────────────────────────────────────────

githubRoutes.post('/sync', async (req, res) => {
  const message = String(req.body?.message || `chore: manual sync ${new Date().toISOString()}`).trim();
  try {
    const result = await gitSync(message);
    res.json(result);
  } catch (err) {
    log.error('[github] manual sync error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/github/import ───────────────────────────────────────
// Restore all data from a GitHub repo into OPENCLAW_HOME.
// Streams Server-Sent Events so the UI can show live progress.

githubRoutes.post('/import', async (req, res) => {
  const githubToken = String(req.body?.githubToken || '').trim();
  const repoInput   = String(req.body?.githubRepo  || '').trim();

  if (!githubToken || !repoInput) {
    return res.status(400).json({ ok: false, error: 'githubToken and githubRepo are required' });
  }

  const repoPath = resolveRepoPath(repoInput);
  if (!repoPath.includes('/')) {
    return res.status(400).json({ ok: false, error: 'Repo must be in owner/name format' });
  }

  // Stream progress via SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (type, payload) => {
    res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
  };

  const onProgress = (msg) => send('progress', { message: msg });

  try {
    const result = await importFromGithub({ githubToken, repoPath, onProgress });
    if (result.ok) {
      // Save credentials so they survive restarts and future syncs work
      try {
        await persistGithubEnv(githubToken, repoPath);
        startAutoSync();
        log.info('[git-import] Credentials saved, auto-sync started');
      } catch (e) {
        log.error('[git-import] Could not persist credentials:', e.message);
      }
      send('done', { ok: true, files: result.files, repoPath });
    } else {
      send('done', { ok: false, error: result.error });
    }
  } catch (err) {
    log.error('[github] import error:', err.message);
    send('done', { ok: false, error: err.message });
  } finally {
    res.end();
  }
});
