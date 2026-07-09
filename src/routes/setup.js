/**
 * routes/setup.js
 *
 * GET  /setup       — serve the setup UI HTML
 * POST /setup/save  — write config + launch gateway
 */

import { Router } from 'express';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { config, DATA_DIR, OPENCLAW_HOME, OPENCLAW_GATEWAY_TOKEN, WRAPPER_ADMIN_PASSWORD, OLLAMA_BASE_URL, OPENCLAW_ENTRY, OPENCLAW_NODE } from '../config/index.js';
import { ensureGithubRepoExists, initGitRepo, startAutoSync, gitSync, resolveRepoPath } from '../services/gitSyncService.js';
import { gatewayManager } from '../services/gatewayManager.js';
import {
  buildOnboardArgs, runOpenclaw, runOpenclawPty,
  runConfigSet, runConfigSetJson, runModelsSet,
  isOauthRequest,
} from '../services/onboardBuilder.js';
import { validateSetupForm } from '../utils/validation.js';
import { log } from '../utils/log.js';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Persist GITHUB_TOKEN and GITHUB_WORKSPACE_REPO to the openclaw .env file
 * so they survive container restarts and are available to the auto-sync service.
 */
async function saveGithubEnvVars(githubToken, repoPath) {
  let lines = [];
  try {
    const raw = await fs.readFile(config.OPENCLAW_ENV_PATH, 'utf8');
    lines = raw.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
  } catch { /* file may not exist yet */ }

  const envMap = new Map(
    lines
      .map((l) => { const eq = l.indexOf('='); return eq > 0 ? [l.slice(0, eq), l.slice(eq + 1)] : null; })
      .filter(Boolean),
  );

  envMap.set('GITHUB_TOKEN', githubToken);
  envMap.set('GITHUB_WORKSPACE_REPO', repoPath);

  // Update process.env so the current process picks them up immediately
  process.env.GITHUB_TOKEN = githubToken;
  process.env.GITHUB_WORKSPACE_REPO = repoPath;

  const content = [...envMap.entries()].map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  await fs.mkdir(OPENCLAW_HOME, { recursive: true });
  await fs.writeFile(config.OPENCLAW_ENV_PATH, content, 'utf8');
  log.info('[git-sync] GitHub credentials saved to env file');
}

export const setupRoutes = Router();

// ── GET /setup — redirect to / if gateway already running ──────────

setupRoutes.get('/', async (req, res) => {
  if (gatewayManager.isRunning()) {
    return res.redirect('/');
  }
  // Serve the setup UI HTML (built separately, or served inline)
  const htmlPath = path.join(__dirname, '../../public/setup.html');
  try {
    await fs.access(htmlPath);
    res.sendFile(htmlPath);
  } catch {
    // Fallback: redirect to embedded inline setup
    res.redirect('/api/setup-ui');
  }
});

// ── POST /setup/save — write config and launch ─────────────────────

// ── GET /setup/api/ollama-config — return OLLAMA_BASE_URL env var ──
// Used by the setup page to pre-fill the Ollama URL field on load.

setupRoutes.get('/api/ollama-config', (req, res) => {
  res.json({ ollamaBaseUrl: OLLAMA_BASE_URL || null });
});

// ── GET /setup/api/ollama-models — fetch model list from Ollama ────
// Proxies to {url}/api/tags and returns the list of pulled model names.
// Query param: url (the Ollama base URL entered by the user).

setupRoutes.get('/api/ollama-models', async (req, res) => {
  const baseUrl = (req.query.url || OLLAMA_BASE_URL || '').trim().replace(/\/$/, '');
  if (!baseUrl) {
    return res.status(400).json({ error: 'No Ollama URL provided' });
  }
  if (!/^https?:\/\/.+/.test(baseUrl)) {
    return res.status(400).json({ error: 'URL must start with http:// or https://' });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const r = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!r.ok) {
      return res.status(502).json({ error: `Ollama returned HTTP ${r.status}` });
    }
    const json = await r.json();
    const models = (json.models || []).map((m) => m.name);
    res.json({ models });
  } catch (err) {
    const msg = err.name === 'AbortError'
      ? 'Request timed out — is the Ollama URL correct and reachable?'
      : `Could not reach Ollama: ${err.message}`;
    res.status(502).json({ error: msg });
  }
});

// ── POST /setup/save — write config + launch gateway ───────────────
//
// Two response modes:
//   • API-key flow → JSON response
//   • OAuth flow   → text/plain stream so the user can see the device-code URL
//                    that openclaw prints during interactive onboarding

async function applyPostOnboardConfig(data, stream) {
  const log_ = (msg) => stream ? stream(msg + '\n') : log.info(msg);

  log_('Patching gateway config...');
  await runConfigSet('gateway.controlUi.allowInsecureAuth', 'true');
  if (OPENCLAW_GATEWAY_TOKEN) {
    await runConfigSet('gateway.auth.token', OPENCLAW_GATEWAY_TOKEN);
  }
  await runConfigSetJson('gateway.trustedProxies', ['127.0.0.1', '::1']);
  await runConfigSetJson('gateway.controlUi.allowedOrigins', ['*']);

  if (data.model) {
    log_(`Setting model to ${data.model}...`);
    await runModelsSet(data.model);
  }

  if (data.telegramBotToken) {
    log_('Configuring Telegram channel...');
    await runConfigSetJson('channels.telegram', {
      enabled: true,
      botToken: data.telegramBotToken,
      dmPolicy: data.telegramDmPolicy || 'pairing',
      groupPolicy: 'open',
      streaming: { mode: 'partial' },
      ...(data.telegramAllowFrom
        ? { allowFrom: data.telegramAllowFrom.split(/[,\n]/).map(s => s.trim()).filter(Boolean) }
        : {}),
      ...(data.telegramWebhookUrl ? { webhookUrl: data.telegramWebhookUrl } : {}),
    });
  }

  if (data.discordBotToken) {
    log_('Configuring Discord channel...');
    await runConfigSetJson('channels.discord', {
      enabled: true,
      token: data.discordBotToken,
      groupPolicy: 'open',
      dm: { policy: data.discordDmPolicy || 'pairing' },
      ...(data.discordAllowFrom
        ? { allowFrom: data.discordAllowFrom.split(/[,\n]/).map(s => s.trim()).filter(Boolean) }
        : {}),
    });
  }

  if (data.slackBotToken && data.slackAppToken) {
    log_('Configuring Slack channel...');
    await runConfigSetJson('channels.slack', {
      enabled: true,
      botToken: data.slackBotToken,
      appToken: data.slackAppToken,
    });
  }

  if (data.googleChatServiceAccount) {
    await runConfigSetJson('channels.googlechat', {
      serviceAccount: data.googleChatServiceAccount,
    });
  }

  if (data.mattermostUrl && data.mattermostToken) {
    await runConfigSetJson('channels.mattermost', {
      url: data.mattermostUrl,
      token: data.mattermostToken,
      ...(data.mattermostTeam ? { team: data.mattermostTeam } : {}),
    });
  }

  if (data.sessionScope) {
    const session = { dmScope: data.sessionScope };
    if (data.sessionResetMode && data.sessionResetMode !== 'off') {
      session.reset = {
        mode: data.sessionResetMode,
        ...(data.sessionResetHour ? { atHour: parseInt(data.sessionResetHour, 10) } : {}),
      };
    }
    await runConfigSetJson('session', session);
  }
}

setupRoutes.post('/save', async (req, res) => {
  if (gatewayManager.isRunning() || gatewayManager.getState() === 'starting') {
    return res.status(409).json({
      ok: false,
      error: 'Gateway is already running or starting. Use /api/config to update config.',
    });
  }

  const { errors, data } = validateSetupForm(req.body);
  if (errors.length > 0) {
    return res.status(400).json({ ok: false, errors });
  }

  const interactive = isOauthRequest(data);
  const onboardArgs = buildOnboardArgs(data);
  log.info(`Running: openclaw ${onboardArgs.join(' ').replace(/--\S+-api-key\s+\S+/g, '--***-api-key ***')}`);

  // ─── OAuth flow: stream PTY output to the browser ─────────────────
  if (interactive) {
    res.set({
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no', // disable nginx buffering if any
    });
    const stream = (chunk) => { if (chunk) res.write(chunk); };

    try {
      stream('Starting OAuth onboarding. A device-code URL will appear below — open it in your browser to sign in.\n\n');

      const onboard = await runOpenclawPty(onboardArgs, {
        onOutput: stream,
        autoInputs: [{ pattern: /Enable hooks\?/, input: ' \r' }],
      });

      stream(`\n[onboard] exit=${onboard.code} configured=${await config.isAlreadyConfigured()}\n`);

      if (onboard.code !== 0 || !(await config.isAlreadyConfigured())) {
        stream('\n[setup] Onboarding failed. Review the output above.\n');
        return res.end();
      }

      await applyPostOnboardConfig(data, stream);

      stream('\nLaunching gateway...\n');
      gatewayManager.start().catch((err) => {
        log.error('Gateway failed to start after setup:', err.message);
        stream(`[gateway] start error: ${err.message}\n`);
      });

      // ── GitHub backup setup (optional, OAuth flow) ───────────────
      const ghToken = String(data.githubToken || '').trim();
      const ghRepoInput = String(data.githubRepo || '').trim();
      if (ghToken && ghRepoInput) {
        const ghRepoPath = resolveRepoPath(ghRepoInput);
        const ghRepoExists = data.githubRepoExists === '1';
        const ghRepoIsEmpty = data.githubRepoIsEmpty !== '0' && data.githubRepoIsEmpty !== 'false';
        const ghMode = ghRepoExists && !ghRepoIsEmpty ? 'existing' : 'new';
        stream(`\n[git-sync] Setting up GitHub backup for ${ghRepoPath} (mode=${ghMode})...\n`);
        try {
          await saveGithubEnvVars(ghToken, ghRepoPath);
          const repoResult = await ensureGithubRepoExists({ githubToken: ghToken, repoPath: ghRepoPath, mode: ghMode });
          if (repoResult.ok) {
            await initGitRepo({ githubToken: ghToken, repoPath: ghRepoPath, repoIsEmpty: repoResult.repoIsEmpty ?? ghRepoIsEmpty });
            startAutoSync();
            stream('[git-sync] GitHub backup configured.\n');
          } else {
            stream(`[git-sync] Warning: ${repoResult.error}\n`);
          }
        } catch (e) {
          stream(`[git-sync] Warning: GitHub setup failed: ${e.message}\n`);
        }
      }

      stream('\n[setup] Complete. You can close this page and visit /admin to manage your gateway.\n');
      return res.end();
    } catch (err) {
      log.error('OAuth setup failed:', err);
      stream(`\n[setup] Internal error: ${err.message}\n`);
      return res.end();
    }
  }

  // ─── API-key flow: regular JSON response ──────────────────────────
  try {
    const onboard = await runOpenclaw(onboardArgs);
    log.info(`Onboard exit=${onboard.code} configured=${await config.isAlreadyConfigured()}`);

    if (onboard.code !== 0 || !(await config.isAlreadyConfigured())) {
      log.error('Onboard failed:', onboard.output);
      return res.status(500).json({
        ok: false,
        error: `Onboard failed (exit ${onboard.code}). Check logs for details.`,
        output: onboard.output,
      });
    }

    log.info('Onboard succeeded. Patching gateway config...');
    await applyPostOnboardConfig(data, null);

    log.info('Config complete. Launching OpenClaw gateway...');
    gatewayManager.start().catch((err) => {
      log.error('Gateway failed to start after setup:', err.message);
    });

    // ── GitHub backup setup (optional) ────────────────────────────
    const githubToken = String(data.githubToken || '').trim();
    const githubRepoInput = String(data.githubRepo || '').trim();
    if (githubToken && githubRepoInput) {
      const repoPath = resolveRepoPath(githubRepoInput);
      // repoExists/repoIsEmpty come from the verify step (hidden form fields)
      const repoExists = data.githubRepoExists === '1';
      const repoIsEmpty = data.githubRepoIsEmpty !== '0' && data.githubRepoIsEmpty !== 'false';
      const repoMode = repoExists && !repoIsEmpty ? 'existing' : 'new';
      log.info(`[git-sync] Setting up GitHub backup for ${repoPath} (mode=${repoMode})...`);
      setImmediate(async () => {
        try {
          // Persist to env file so it survives container restarts
          await saveGithubEnvVars(githubToken, repoPath);
          // Ensure the remote repo exists (or verify we can access it)
          const repoResult = await ensureGithubRepoExists({ githubToken, repoPath, mode: repoMode });
          if (!repoResult.ok) {
            log.error(`[git-sync] Repo setup failed: ${repoResult.error}`);
            return;
          }
          // Init local git repo and push initial state (or fetch existing)
          await initGitRepo({ githubToken, repoPath, repoIsEmpty: repoResult.repoIsEmpty ?? repoIsEmpty });
          // Start hourly auto-sync
          startAutoSync();
          log.info('[git-sync] GitHub backup configured and active');
        } catch (e) {
          log.error('[git-sync] GitHub setup error:', e.message);
        }
      });
    }

    res.json({ ok: true, message: 'Config saved. Gateway launching...' });
  } catch (err) {
    log.error('Setup failed:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /setup/pairing/approve — approve a channel pairing code ────

setupRoutes.post('/pairing/approve', async (req, res) => {
  const { channel, code } = req.body || {};
  if (!channel || !code) {
    return res.status(400).json({ ok: false, error: 'Missing channel or code' });
  }

  try {
    const env = { ...process.env, HOME: DATA_DIR, OPENCLAW_STATE_DIR: OPENCLAW_HOME };
    // `pairing approve` mutates local state; it does NOT make a gateway RPC,
    // so passing --token is unnecessary and triggers the WS scope check bug.
    const args = [OPENCLAW_ENTRY, 'pairing', 'approve', String(channel), String(code)];

    const { stdout } = await execFileAsync(OPENCLAW_NODE, args, { env, timeout: 30_000 });
    log.info(`Pairing approve result: ${stdout}`);
    res.json({ ok: true, output: stdout });
  } catch (err) {
    const output = err.stdout || err.stderr || err.message;
    log.error(`Pairing approve failed: ${output}`);
    res.status(500).json({ ok: false, error: output });
  }
});

// ── POST /setup/reset — wipe config or full factory reset ─────────

setupRoutes.post('/reset', async (req, res) => {
  const { mode } = req.body || {};

  try {
    await gatewayManager.stop();

    if (mode === 'full') {
      // Full factory reset — wipe the entire .openclaw directory
      try {
        await fs.rm(OPENCLAW_HOME, { recursive: true, force: true });
      } catch { /* already gone */ }
      // Re-create the base directories so the next setup works
      await fs.mkdir(path.join(OPENCLAW_HOME, 'nodes'), { recursive: true });
      await fs.mkdir(path.join(OPENCLAW_HOME, 'workspace'), { recursive: true });
      log.info('Full factory reset complete. All data wiped.');
      res.json({ ok: true, message: 'Full reset complete. All data wiped. Redirecting to setup...' });
    } else {
      // Config-only reset — remove config + env so setup wizard reappears
      try { await fs.unlink(config.OPENCLAW_CONFIG_PATH); } catch { /* already gone */ }
      try { await fs.unlink(config.OPENCLAW_ENV_PATH); } catch { /* already gone */ }
      log.info('Config reset. Gateway stopped.');
      res.json({ ok: true, message: 'Config reset complete. Redirecting to setup...' });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /setup/export — download a zip backup of .openclaw data ───

setupRoutes.get('/export', async (req, res) => {
  try {
    // Check that the data directory exists
    try {
      await fs.access(OPENCLAW_HOME);
    } catch {
      return res.status(404).json({ ok: false, error: 'No data directory found to export.' });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const zipName = `openclaw-export-${timestamp}.zip`;
    const tmpZip = path.join(os.tmpdir(), zipName);

    const zipArgs = ['-r'];
    // Password-protect with admin password if set
    if (WRAPPER_ADMIN_PASSWORD) {
      zipArgs.push('-P', WRAPPER_ADMIN_PASSWORD);
    }
    zipArgs.push(tmpZip, OPENCLAW_HOME);

    const { stdout } = await execFileAsync('zip', zipArgs, { timeout: 60_000 });
    log.info(`Export zip created: ${zipName}`);

    // Verify the zip was created
    let stat;
    try {
      stat = await fs.stat(tmpZip);
    } catch {
      return res.status(500).json({ ok: false, error: 'Failed to create export archive.' });
    }

    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${zipName}"`,
      'Content-Length': String(stat.size),
    });

    const stream = createReadStream(tmpZip);
    stream.pipe(res);
    stream.on('end', () => {
      fs.unlink(tmpZip).catch(() => {});
    });
    stream.on('error', (err) => {
      log.error('Export stream error:', err.message);
      fs.unlink(tmpZip).catch(() => {});
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: 'Stream error during export.' });
      }
    });
  } catch (err) {
    log.error('Export failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});
