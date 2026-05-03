/**
 * services/onboardBuilder.js
 *
 * Delegates openclaw configuration to `openclaw onboard --non-interactive`
 * instead of building openclaw.json by hand. This keeps us compatible with
 * config schema changes across openclaw versions.
 *
 * Exports:
 *  - buildOnboardArgs(data)   — returns the CLI args array for onboard
 *  - runOpenclaw(args)        — spawns `openclaw <args>` and returns { code, output }
 *  - runConfigSet(key, value) — shorthand for `openclaw config set key value`
 *  - runConfigSetJson(key, v) — shorthand for `openclaw config set --json key <json>`
 *  - runModelsSet(model)      — shorthand for `openclaw models set <model>`
 */

import { spawn } from 'child_process';
import pty from 'node-pty';
import {
  DATA_DIR,
  OPENCLAW_HOME,
  OPENCLAW_GATEWAY_TOKEN,
  GATEWAY_PORT,
  OPENCLAW_ENTRY,
  OPENCLAW_NODE,
} from '../config/index.js';
import { log } from '../utils/log.js';

// ─── Auth mode → openclaw authChoice mapping ────────────────────────
//
// Some providers support OAuth/device-pairing instead of API keys. These
// require running `openclaw onboard` interactively (via PTY) so the user
// can see the device-code URL and complete login in a browser.

const OAUTH_AUTH_CHOICE = {
  // provider:authMode → openclaw --auth-choice value
  'openai:oauth': 'openai-codex-device-code',
};

export function isOauthRequest(data) {
  if (!data?.authMode || data.authMode === 'apiKey') return false;
  const key = `${data.provider}:${data.authMode}`;
  return Boolean(OAUTH_AUTH_CHOICE[key]);
}

// ─── Provider → authChoice + CLI flag mapping ───────────────────────
//
// Each entry maps our setup form's `provider` value to:
//   authChoice  — the value passed to `--auth-choice`
//   keyFlag     — the CLI flag for the API key (null if no key needed)
//   extra       — additional static flags (e.g. for Groq's custom endpoint)

const PROVIDER_MAP = {
  // ── Major AI Labs ────────────────────────────────────────────────
  anthropic:   { authChoice: 'apiKey',                keyFlag: '--anthropic-api-key' },
  openai:      { authChoice: 'openai-api-key',        keyFlag: '--openai-api-key' },
  google:      { authChoice: 'gemini-api-key',        keyFlag: '--gemini-api-key' },
  deepseek:    { authChoice: 'deepseek-api-key',      keyFlag: '--deepseek-api-key' },
  xai:         { authChoice: 'xai-api-key',           keyFlag: '--xai-api-key' },
  mistral:     { authChoice: 'mistral-api-key',       keyFlag: '--mistral-api-key' },

  // ── Multi-Model Gateways ─────────────────────────────────────────
  openrouter:  { authChoice: 'openrouter-api-key',   keyFlag: '--openrouter-api-key' },
  together:    { authChoice: 'together-api-key',     keyFlag: '--together-api-key' },
  litellm:     { authChoice: 'litellm-api-key',      keyFlag: '--litellm-api-key' },
  aigateway:   { authChoice: 'ai-gateway-api-key',   keyFlag: '--ai-gateway-api-key' },
  synthetic:   { authChoice: 'synthetic-api-key',    keyFlag: '--synthetic-api-key' },
  cloudflare:  { authChoice: 'cloudflare-ai-gateway-api-key', keyFlag: '--cloudflare-ai-gateway-api-key' },

  // ── Specialized / Other ──────────────────────────────────────────
  groq: {
    // Groq has no native authChoice — use custom endpoint (OpenAI-compatible)
    authChoice: 'custom-api-key',
    keyFlag: '--custom-api-key',
    extra: ['--custom-base-url', 'https://api.groq.com/openai/v1', '--custom-compatibility', 'openai'],
  },
  huggingface: { authChoice: 'huggingface-api-key',  keyFlag: '--huggingface-api-key' },
  venice:      { authChoice: 'venice-api-key',       keyFlag: '--venice-api-key' },
  chutes:      { authChoice: 'chutes-api-key',       keyFlag: '--chutes-api-key' },
  kilocode:    { authChoice: 'kilocode-api-key',     keyFlag: '--kilocode-api-key' },
  opencode:    { authChoice: 'opencode-zen',         keyFlag: '--opencode-zen-api-key' },

  // ── Asia / Regional ──────────────────────────────────────────────
  moonshot:    { authChoice: 'moonshot-api-key',     keyFlag: '--moonshot-api-key' },
  zai:         { authChoice: 'zai-api-key',          keyFlag: '--zai-api-key' },
  minimax:     { authChoice: 'minimax-global-api',   keyFlag: '--minimax-api-key' },
  modelstudio: { authChoice: 'modelstudio-api-key',  keyFlag: '--modelstudio-api-key' },
  volcengine:  { authChoice: 'volcengine-api-key',   keyFlag: '--volcengine-api-key' },
  qianfan:     { authChoice: 'qianfan-api-key',      keyFlag: '--qianfan-api-key' },
  xiaomi:      { authChoice: 'xiaomi-api-key',       keyFlag: '--xiaomi-api-key' },
  byteplus:    { authChoice: 'byteplus-api-key',     keyFlag: '--byteplus-api-key' },

  // ── Self-Hosted / Local ──────────────────────────────────────────
  ollama:  { authChoice: 'ollama',         keyFlag: null },
  vllm:    { authChoice: 'vllm',           keyFlag: null },
  sglang:  { authChoice: 'sglang',         keyFlag: null },
  custom:  { authChoice: 'custom-api-key', keyFlag: '--custom-api-key' },
};

// ─── Build onboard args ─────────────────────────────────────────────

export function buildOnboardArgs(data) {
  const workspaceDir = `${DATA_DIR}/.openclaw/workspace`;
  const interactive = isOauthRequest(data);

  const args = [
    'onboard',
    '--accept-risk',
    '--no-install-daemon',
    '--skip-health',
    '--workspace', workspaceDir,
    '--gateway-bind', 'loopback',
    '--gateway-port', String(GATEWAY_PORT),
    '--gateway-auth', 'token',
    '--gateway-token', OPENCLAW_GATEWAY_TOKEN,
    '--flow', 'quickstart',
  ];

  if (interactive) {
    // OAuth/device-code flows — onboard prompts the user via stdout, so we
    // run it under a PTY and stream output to the browser. Skip channel,
    // skill, search, UI prompts so the only interaction is the OAuth login.
    args.push('--mode', 'local', '--skip-channels', '--skip-skills', '--skip-search', '--skip-ui');
  } else {
    args.push('--non-interactive', '--json');
  }

  // ── Auth choice ──────────────────────────────────────────────────
  // OAuth providers override the standard authChoice with a device-code variant.

  let authChoice;
  if (interactive) {
    authChoice = OAUTH_AUTH_CHOICE[`${data.provider}:${data.authMode}`];
  } else {
    const mapping = PROVIDER_MAP[data.provider];
    if (!mapping) throw new Error(`Unknown provider: ${data.provider}`);
    authChoice = mapping.authChoice;

    if (mapping.keyFlag && data.apiKey) {
      args.push(mapping.keyFlag, data.apiKey);
    }
    if (mapping.extra) {
      args.push(...mapping.extra);
    }
  }

  args.push('--auth-choice', authChoice);

  // ── Provider-specific extra args ──────────────────────────────────

  // Ollama: URL via ollamaUrl field, bare model ID (strip "ollama/" prefix)
  if (data.provider === 'ollama') {
    if (data.ollamaUrl) {
      args.push('--custom-base-url', data.ollamaUrl);
    }
    if (data.model) {
      const bareModel = data.model.startsWith('ollama/') ? data.model.slice(7) : data.model;
      args.push('--custom-model-id', bareModel);
    }
  }

  // vLLM / SGLang: URL + model ID via customUrl / model fields
  if (data.provider === 'vllm' || data.provider === 'sglang') {
    if (data.customUrl) args.push('--custom-base-url', data.customUrl);
    if (data.model)     args.push('--custom-model-id', data.model);
  }

  // Custom endpoint: URL + model ID + optional compatibility
  if (data.provider === 'custom') {
    if (data.customUrl)           args.push('--custom-base-url', data.customUrl);
    if (data.model)               args.push('--custom-model-id', data.model);
    if (data.customCompatibility) args.push('--custom-compatibility', data.customCompatibility);
  }

  // Cloudflare AI Gateway: account ID + gateway ID
  if (data.provider === 'cloudflare') {
    if (data.cloudflareAccountId) args.push('--cloudflare-ai-gateway-account-id', data.cloudflareAccountId);
    if (data.cloudflareGatewayId) args.push('--cloudflare-ai-gateway-gateway-id', data.cloudflareGatewayId);
  }

  return args;
}

// ─── CLI runner ─────────────────────────────────────────────────────

const OPENCLAW_ENV = {
  ...process.env,
  HOME: DATA_DIR,
  OPENCLAW_STATE_DIR: OPENCLAW_HOME,
};

/**
 * Spawns `node $OPENCLAW_ENTRY <args>` and returns { code, output }.
 * Invoking entry.js directly (rather than the bin wrapper) is more reliable
 * in containers and matches the reference Railway template's approach.
 */
export function runOpenclaw(args, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    const proc = spawn(OPENCLAW_NODE, [OPENCLAW_ENTRY, ...args], {
      env: OPENCLAW_ENV,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    proc.stdout?.on('data', (d) => { out += d.toString('utf8'); });
    proc.stderr?.on('data', (d) => { out += d.toString('utf8'); });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      out += '\n[timeout] openclaw command timed out\n';
    }, timeoutMs);

    proc.on('error', (err) => {
      clearTimeout(timer);
      out += `\n[spawn error] ${String(err)}\n`;
      resolve({ code: 127, output: out });
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 0, output: out });
    });
  });
}

/**
 * Strip ANSI escape sequences and OSC hyperlinks from PTY output so the
 * streamed text reads cleanly in the browser without needing a terminal
 * emulator on the client side.
 */
export function stripAnsi(value) {
  return String(value)
    .replace(/\x1b\]8;;.*?\x1b\\|\x1b\]8;;\x1b\\/g, '')
    .replace(/\x1b\[[\x20-\x3f]*[\x40-\x7e]/g, '');
}

/**
 * Spawn `node $OPENCLAW_ENTRY <args>` under a pseudo-terminal so openclaw
 * thinks it's running interactively. Used for OAuth/device-code onboarding
 * where openclaw prints a login URL + code and waits for the user to
 * complete browser authentication.
 *
 * Calls onOutput(chunk) for every output chunk (ANSI-stripped) and resolves
 * with { code, output } when the process exits.
 *
 * autoInputs: array of { pattern: RegExp, input: string } — when accumulated
 *   output matches `pattern`, we send `input` to the PTY (used to auto-answer
 *   non-OAuth prompts like "Enable hooks?").
 */
export function runOpenclawPty(args, opts = {}) {
  return new Promise((resolve) => {
    const { onOutput, autoInputs = [] } = opts;
    const sentAutoInputs = new Set();
    let out = '';
    let proc;

    try {
      proc = pty.spawn(OPENCLAW_NODE, [OPENCLAW_ENTRY, ...args], {
        name: 'xterm-color',
        cols: 100,
        rows: 30,
        cwd: process.cwd(),
        env: {
          ...OPENCLAW_ENV,
          // Force openclaw's *local* device-code branch so the short code
          // is printed in stdout instead of being hidden behind a remote-only
          // OAuth redirect (matches reference template).
          DISPLAY: process.env.DISPLAY || ':0',
          WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || 'wayland-0',
          SSH_CLIENT: '',
          SSH_TTY: '',
          SSH_CONNECTION: '',
          FORCE_COLOR: '0',
          NO_COLOR: '1',
        },
      });
    } catch (err) {
      const msg = `\n[spawn error] ${String(err)}\n`;
      onOutput?.(msg);
      return resolve({ code: 127, output: msg });
    }

    proc.onData((data) => {
      const chunk = stripAnsi(data);
      if (!chunk) return;
      out += chunk;

      for (const { input, pattern } of autoInputs) {
        const key = String(pattern);
        if (sentAutoInputs.has(key) || !pattern.test(out)) continue;
        sentAutoInputs.add(key);
        proc.write(input);
      }

      onOutput?.(chunk);
    });

    proc.onExit(({ exitCode }) => {
      resolve({ code: exitCode ?? 0, output: out });
    });
  });
}

// ─── Convenience wrappers ───────────────────────────────────────────

export async function runConfigSet(key, value) {
  const result = await runOpenclaw(['config', 'set', key, value]);
  if (result.code !== 0) {
    log.warn(`config set ${key} failed (exit=${result.code}): ${result.output}`);
  }
  return result;
}

export async function runConfigSetJson(key, value) {
  const result = await runOpenclaw([
    'config', 'set', '--json', key, JSON.stringify(value),
  ]);
  if (result.code !== 0) {
    log.warn(`config set --json ${key} failed (exit=${result.code}): ${result.output}`);
  }
  return result;
}

export async function runModelsSet(model) {
  const result = await runOpenclaw(['models', 'set', model]);
  if (result.code !== 0) {
    log.warn(`models set ${model} failed (exit=${result.code}): ${result.output}`);
  }
  return result;
}
