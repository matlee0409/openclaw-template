/**
 * routes/github.js
 *
 * GitHub backup API endpoints.
 *
 * POST /api/github/verify        — verify token + repo (no auth, pre-setup)
 * GET  /api/github/status        — sync status (admin auth)
 * POST /api/github/sync          — manual sync trigger (admin auth)
 */

import { Router } from 'express';
import { requireAdminAuth } from '../middleware/auth.js';
import {
  verifyGithubRepo,
  gitSync,
  gitSyncStatus,
  resolveRepoPath,
  importFromGithub,
} from '../services/gitSyncService.js';
import { log } from '../utils/log.js';

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
      send('done', { ok: true, files: result.files });
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
