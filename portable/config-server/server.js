#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const { deflateSync } = require('zlib');
const crypto = require('crypto');

const PORT_RANGE_START = 18788;
const PORT_RANGE_END = 18798;
const CONFIG_PATH = path.join(__dirname, '../data/.openclaw/openclaw.json');
const RUNTIME_PATH = path.join(__dirname, '../data/.openclaw/runtime.json');

// ── WeChat Login State ──────────────────────────────────────────────────────
// ⚠️ 微信接入降级开关（2026-08-27 专家会审定）：OpenClaw 微信插件存在上游 ESM 模块
// 加载竞态兼容 bug（2026.7.1-2 内核及同系 2026.7.2-beta 仍存在），插件无人维护，
// 四路 AI 全票判定：等上游明确修复，不为它赌内核升级。
// 降级期：控制台入口明示「暂不可用」，start 接口直接 503（防浏览器缓存旧页/绕过前端）。
// 上游修复后：把此处与 index.html 的 WECHAT_ENABLED 同改回 true 即恢复，其余代码不动。
const WECHAT_ENABLED = false;
const DEFAULT_WECHAT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const DEFAULT_ILINK_BOT_TYPE = '3';
const ACTIVE_LOGIN_TTL_MS = 5 * 60000;
const QR_POLL_TIMEOUT_MS = 35000;
const MAX_QR_REFRESH_COUNT = 3;

// Resolve ~/.openclaw/ directory
const OPENCLAW_DIR = process.env.OPENCLAW_STATE_DIR ||
  path.join(process.env.USERPROFILE || process.env.HOME || require('os').homedir(), '.openclaw');
const WECHAT_STATE_DIR = path.join(OPENCLAW_DIR, 'openclaw-weixin');
const WECHAT_ACCOUNTS_DIR = path.join(WECHAT_STATE_DIR, 'accounts');
const WECHAT_ACCOUNT_INDEX_FILE = path.join(WECHAT_STATE_DIR, 'accounts.json');

// Plugin source on USB
const USB_PLUGIN_DIR = path.join(__dirname, '../app/extensions/openclaw-weixin');
const INSTALLED_PLUGIN_DIR = path.join(OPENCLAW_DIR, 'extensions', 'openclaw-weixin');

const activeLogins = new Map();

// ── QR Code PNG Renderer (pure Node.js, no external deps) ───────────────────

function getQrRenderDeps() {
  // Try to load QR lib from openclaw's bundled qrcode-terminal
  const corePath = path.join(__dirname, '../app/core/node_modules');
  const candidates = [
    path.join(corePath, 'qrcode-terminal/vendor/QRCode/index.js'),
    path.join(corePath, 'openclaw/node_modules/qrcode-terminal/vendor/QRCode/index.js'),
  ];
  const errCandidates = [
    path.join(corePath, 'qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js'),
    path.join(corePath, 'openclaw/node_modules/qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js'),
  ];
  for (let i = 0; i < candidates.length; i++) {
    if (fs.existsSync(candidates[i])) {
      return { QRCode: require(candidates[i]), QRErrorCorrectLevel: require(errCandidates[i]) };
    }
  }
  // Fallback: try WeChat plugin's own node_modules
  const pluginQr = path.join(USB_PLUGIN_DIR, 'node_modules/qrcode-terminal/vendor/QRCode/index.js');
  const pluginQrErr = path.join(USB_PLUGIN_DIR, 'node_modules/qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js');
  if (fs.existsSync(pluginQr)) {
    return { QRCode: require(pluginQr), QRErrorCorrectLevel: require(pluginQrErr) };
  }
  throw new Error('QR code library not found');
}

function createQrMatrix(input) {
  const { QRCode, QRErrorCorrectLevel } = getQrRenderDeps();
  const qr = new QRCode(-1, QRErrorCorrectLevel.L);
  qr.addData(input);
  qr.make();
  return qr;
}

function fillPixel(buf, x, y, width, r, g, b, a) {
  const idx = (y * width + x) * 4;
  buf[idx] = r; buf[idx + 1] = g; buf[idx + 2] = b; buf[idx + 3] = (a === undefined ? 255 : a);
}

const CRC_TABLE = (function() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crc = crc32(Buffer.concat([typeBuf, data]));
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePngRgba(buffer, width, height) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row++) {
    const offset = row * (stride + 1);
    raw[offset] = 0;
    buffer.copy(raw, offset + 1, row * stride, row * stride + stride);
  }
  const compressed = deflateSync(raw);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([signature, pngChunk('IHDR', ihdr), pngChunk('IDAT', compressed), pngChunk('IEND', Buffer.alloc(0))]);
}

function renderQrPngDataUrl(input) {
  const scale = 6, margin = 4;
  const qr = createQrMatrix(input);
  const modules = qr.getModuleCount();
  const size = (modules + margin * 2) * scale;
  const buf = Buffer.alloc(size * size * 4, 255);
  for (let row = 0; row < modules; row++) {
    for (let col = 0; col < modules; col++) {
      if (!qr.isDark(row, col)) continue;
      const sx = (col + margin) * scale, sy = (row + margin) * scale;
      for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++)
        fillPixel(buf, sx + x, sy + y, size, 0, 0, 0, 255);
    }
  }
  return 'data:image/png;base64,' + encodePngRgba(buf, size, size).toString('base64');
}

// ── WeChat API helpers ──────────────────────────────────────────────────────

async function fetchWeChatQrCode(apiBaseUrl) {
  const base = apiBaseUrl.endsWith('/') ? apiBaseUrl : apiBaseUrl + '/';
  const url = base + 'ilink/bot/get_bot_qrcode?bot_type=' + encodeURIComponent(DEFAULT_ILINK_BOT_TYPE);
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error('Failed to fetch QR: ' + response.status + ' ' + body);
  }
  return await response.json();
}

async function pollWeChatQrStatus(apiBaseUrl, qrcode) {
  const base = apiBaseUrl.endsWith('/') ? apiBaseUrl : apiBaseUrl + '/';
  const url = base + 'ilink/bot/get_qrcode_status?qrcode=' + encodeURIComponent(qrcode);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QR_POLL_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { 'iLink-App-ClientVersion': '1' },
      signal: controller.signal
    });
    clearTimeout(timer);
    const text = await response.text();
    if (!response.ok) throw new Error('Poll failed: ' + response.status + ' ' + text);
    return JSON.parse(text);
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') return { status: 'wait' };
    throw err;
  }
}

function normalizeAccountId(raw) {
  return String(raw).toLowerCase().replace(/[^a-z0-9._-]/g, '-');
}

async function saveWeChatAccount(rawAccountId, payload) {
  const accountId = normalizeAccountId(rawAccountId);
  fs.mkdirSync(WECHAT_ACCOUNTS_DIR, { recursive: true });
  const filePath = path.join(WECHAT_ACCOUNTS_DIR, accountId + '.json');
  const data = {
    token: payload.token.trim(),
    savedAt: new Date().toISOString(),
  };
  if (payload.baseUrl) data.baseUrl = payload.baseUrl.trim();
  if (payload.userId) data.userId = payload.userId.trim();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

  // Update account index
  let accounts = [];
  try { accounts = JSON.parse(fs.readFileSync(WECHAT_ACCOUNT_INDEX_FILE, 'utf-8')); } catch {}
  if (!Array.isArray(accounts)) accounts = [];
  if (!accounts.includes(accountId)) {
    accounts.push(accountId);
    fs.mkdirSync(WECHAT_STATE_DIR, { recursive: true });
    fs.writeFileSync(WECHAT_ACCOUNT_INDEX_FILE, JSON.stringify(accounts, null, 2));
  }
  return accountId;
}

function ensureWeChatPluginInstalled() {
  if (!fs.existsSync(USB_PLUGIN_DIR) || !fs.existsSync(path.join(USB_PLUGIN_DIR, 'openclaw.plugin.json'))) {
    return { installed: false, warning: 'WeChat plugin not found on USB' };
  }
  if (fs.existsSync(path.join(INSTALLED_PLUGIN_DIR, 'openclaw.plugin.json'))) {
    return { installed: true };
  }
  // Copy from USB to ~/.openclaw/extensions/
  // 容错：copy 失败不抛错中断整个 confirmed 流程（账号保存 + openclaw.json 已/将写好）。
  try {
    const extDir = path.join(OPENCLAW_DIR, 'extensions');
    fs.mkdirSync(extDir, { recursive: true });
    copyDirSync(USB_PLUGIN_DIR, INSTALLED_PLUGIN_DIR);
  } catch (e) {
    console.error('WeChat plugin copy failed:', e.message);
    return { installed: false, warning: e.message };
  }
  return { installed: fs.existsSync(path.join(INSTALLED_PLUGIN_DIR, 'openclaw.plugin.json')) };
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

// ── WeChat login session management ─────────────────────────────────────────

async function handleWeChatStart() {
  const sessionKey = crypto.randomUUID();
  const apiBaseUrl = DEFAULT_WECHAT_BASE_URL;
  const qrResponse = await fetchWeChatQrCode(apiBaseUrl);
  const qrDataUrl = renderQrPngDataUrl(qrResponse.qrcode_img_content);

  activeLogins.set(sessionKey, {
    sessionKey,
    qrcode: qrResponse.qrcode,
    qrcodeUrl: qrDataUrl,
    startedAt: Date.now(),
    apiBaseUrl,
  });

  return { sessionKey, qrcodeUrl: qrDataUrl };
}

async function handleWeChatStatus(sessionKey) {
  const login = activeLogins.get(sessionKey);
  if (!login) return { status: 'expired', message: 'No active session' };
  if (Date.now() - login.startedAt > ACTIVE_LOGIN_TTL_MS) {
    activeLogins.delete(sessionKey);
    return { status: 'expired', message: 'Session expired' };
  }

  // 状态轮询用 pollBaseUrl（IDC 重定向后会指向新主机）；二维码获取/刷新始终用原始
  // apiBaseUrl（与官方插件一致：refresh 回到固定主机，只有 status 轮询跟随重定向）。
  const result = await pollWeChatQrStatus(login.pollBaseUrl || login.apiBaseUrl, login.qrcode);
  // 微信登录状态流转日志（跳过高频的 wait，便于排查"扫码卡死"类问题）。
  if (result.status && result.status !== 'wait') {
    console.log(`[wechat] status=${result.status}` + (result.redirect_host ? ` redirect_host=${result.redirect_host}` : ''));
  }

  if (result.status === 'expired') {
    // Try to refresh QR code
    if (!login.refreshCount) login.refreshCount = 1;
    login.refreshCount++;
    if (login.refreshCount > MAX_QR_REFRESH_COUNT) {
      activeLogins.delete(sessionKey);
      return { status: 'expired', message: 'QR expired too many times' };
    }
    const refreshed = await fetchWeChatQrCode(login.apiBaseUrl);
    const newQr = renderQrPngDataUrl(refreshed.qrcode_img_content);
    login.qrcode = refreshed.qrcode;
    login.qrcodeUrl = newQr;
    login.startedAt = Date.now();
    // 新二维码来自原始主机，重置轮询主机，避免拿新码去轮询旧的重定向主机。
    login.pollBaseUrl = null;
    return { status: 'refreshed', qrcodeUrl: newQr };
  }

  if (result.status === 'confirmed') {
    activeLogins.delete(sessionKey);
    if (!result.ilink_bot_id || !result.bot_token) {
      return { status: 'error', message: 'Server did not return credentials' };
    }

    // 1. Install plugin
    const pluginResult = ensureWeChatPluginInstalled();

    // 2. Save account
    const accountId = await saveWeChatAccount(result.ilink_bot_id, {
      token: result.bot_token,
      baseUrl: result.baseurl,
      userId: result.ilink_user_id,
    });

    // 3. Update openclaw.json to enable the plugin
    // 用同一套 lib/merge-config.mjs 原子写（读现有文件 + rename 落盘），跟 /api/config 保持
    // 一致的"不半截写坏、不静默丢字段"保证。
    try {
      const { readConfigSafe, writeConfigAtomic } = await import('../lib/merge-config.mjs');
      const config = readConfigSafe(CONFIG_PATH);
      if (!config.plugins) config.plugins = {};
      if (!config.plugins.entries) config.plugins.entries = {};
      config.plugins.entries['openclaw-weixin'] = { enabled: true };
      writeConfigAtomic(CONFIG_PATH, config);
    } catch (e) {
      console.error('Failed to update config:', e.message);
    }

    return {
      status: 'confirmed',
      accountId,
      pluginInstalled: pluginResult.installed,
      message: 'WeChat connected! Restart Gateway to activate.',
    };
  }

  // IDC 重定向：用户扫码后，ilink 服务端可能要求把后续轮询切换到另一个数据中心主机
  // (status=scaned_but_redirect + redirect_host)。必须跟着切，否则一直轮询旧主机，
  // 扫码后永远等不到 confirmed——表现为「扫了码却卡死不前进」。
  // 同款逻辑见官方插件 openclaw-weixin/src/auth/login-qr.ts 的 scaned_but_redirect 分支。
  if (result.status === 'scaned_but_redirect') {
    if (result.redirect_host) {
      login.pollBaseUrl = 'https://' + result.redirect_host;
    }
    // 对前端按「已扫码」处理：显示提示并继续轮询，下一轮已指向新主机。
    return { status: 'scaned' };
  }

  return { status: result.status };
}

function handleWeChatCancel(sessionKey) {
  if (sessionKey) activeLogins.delete(sessionKey);
  else activeLogins.clear();
}

const server = http.createServer((req, res) => {
  // CORS：只允许同源访问（本服务只服务 127.0.0.1 上的配置中心页面）。
  // 旧版 `*` 让任意网页都能跨域读 /api/config（明文 Key）并调用敏感接口——已收紧。
  // loading.html 等 file:// 页面不发带凭据的跨域请求，无需放行 Origin。
  const origin = req.headers.origin || '';
  if (origin.startsWith('http://127.0.0.1') || origin.startsWith('http://localhost')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Vary', 'Origin');
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // API: WeChat start login
  if (req.url === '/api/wechat/start' && req.method === 'POST') {
    if (!WECHAT_ENABLED) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '微信插件存在上游兼容问题，暂时无法接入，修复后会随更新自动恢复。' }));
      return;
    }
    handleWeChatStart()
      .then(result => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      })
      .catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
    return;
  }

  // API: WeChat poll status
  if (req.url && req.url.startsWith('/api/wechat/status') && req.method === 'GET') {
    const urlObj = new URL(req.url, 'http://localhost');
    const session = urlObj.searchParams.get('session');
    if (!session) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing session parameter' }));
      return;
    }
    handleWeChatStatus(session)
      .then(result => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      })
      .catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
    return;
  }

  // API: WeChat cancel
  if (req.url === '/api/wechat/cancel' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = body ? JSON.parse(body) : {};
        handleWeChatCancel(data.session);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // API: WeChat plugin status
  if (req.url === '/api/wechat/plugin-status' && req.method === 'GET') {
    const hasPlugin = fs.existsSync(path.join(USB_PLUGIN_DIR, 'openclaw.plugin.json'));
    const installed = fs.existsSync(path.join(INSTALLED_PLUGIN_DIR, 'openclaw.plugin.json'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ hasPlugin, installed }));
    return;
  }

  // API: Get config
  if (req.url === '/api/config' && req.method === 'GET') {
    try {
      const config = fs.existsSync(CONFIG_PATH)
        ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
        : {};
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(config));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: Update status — read update-available.json written by check-update.mjs
  // Returns { available: false } if no info or stale; otherwise the manifest payload.
  if (req.url === '/api/update-status' && req.method === 'GET') {
    try {
      const stateDir = process.env.OPENCLAW_STATE_DIR
        || path.join(__dirname, '../data/.openclaw');
      const updateFile = path.join(stateDir, 'update-available.json');
      if (!fs.existsSync(updateFile)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ available: false, reason: 'no-check-yet' }));
        return;
      }
      const payload = JSON.parse(fs.readFileSync(updateFile, 'utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ available: false, reason: 'read-failed', error: err.message }));
    }
    return;
  }

  // API: Trigger update check on demand (so users can press a "Check now" button)
  if (req.url === '/api/update-check' && req.method === 'POST') {
    (async () => {
      try {
        const mod = await import('../lib/check-update.mjs');
        const portableRoot = path.join(__dirname, '..');
        const versionFilePath = fs.existsSync(path.join(portableRoot, 'OPENCLAW_VERSION'))
          ? path.join(portableRoot, 'OPENCLAW_VERSION')
          : path.join(portableRoot, '..', 'OPENCLAW_VERSION');
        const stateDir = process.env.OPENCLAW_STATE_DIR
          || path.join(portableRoot, 'data/.openclaw');
        const result = await mod.checkUpdate({ versionFilePath, stateDir });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    })();
    return;
  }

  // API: Discover local models (Ollama / LM Studio)
  // 借鉴 RealShocky/openclaw-windows：自动探测本机已装的本地模型，
  // 用户无需手填 baseUrl/模型名，直接点选即可（便携版纯离线推理卖点）。
  // 静默失败：探测不到就返回空数组，不影响 Config 页面。
  if (req.url === '/api/local-models' && req.method === 'GET') {
    (async () => {
      const probes = [
        { provider: 'ollama',   label: 'Ollama',    base: 'http://127.0.0.1:11434/v1', api: 'http://127.0.0.1:11434/api/tags' },
        { provider: 'lmstudio', label: 'LM Studio', base: 'http://127.0.0.1:1234/v1',  api: 'http://127.0.0.1:1234/v1/models' },
      ];
      const found = [];
      await Promise.all(probes.map(async (p) => {
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 1200);
          const r = await fetch(p.api, { signal: ctrl.signal });
          clearTimeout(t);
          if (!r.ok) return;
          const data = await r.json();
          // Ollama: { models:[{name}] } | LM Studio (OpenAI-style): { data:[{id}] }
          const models = Array.isArray(data.models)
            ? data.models.map(m => m.name).filter(Boolean)
            : Array.isArray(data.data)
              ? data.data.map(m => m.id).filter(Boolean)
              : [];
          if (models.length) found.push({ provider: p.provider, label: p.label, base: p.base, models });
        } catch { /* 探测失败：该 provider 未运行，跳过 */ }
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ providers: found }));
    })();
    return;
  }

  // API: Save config
  // 合并写入而非整体覆盖（issue #58）：磁盘上可能有 UI 不认识的字段（最典型是微信登录写入的
  // config.plugins.entries），整体覆盖会把它们静默冲掉。合并 + 原子写逻辑见 lib/merge-config.mjs。
  if (req.url === '/api/provider-models' && req.method === 'POST') {
    // 动态模型发现：带上用户的 Key 去问该平台的 /v1/models，返回实时模型 id 列表。
    // Key 只在本次请求内使用，不落盘、不打日志。
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      try {
        const { provider, base, apiKey } = JSON.parse(body || '{}');
        if (!apiKey) throw new Error('请先填写 API Key 再拉取');
        let target = (base || '').trim();
        if (!target && provider === 'zai') target = 'https://open.bigmodel.cn/api/paas/v4';
        if (!target) throw new Error('该提供商不支持在线拉取，可直接手填模型名');
        // 只放行标准 http(s) 绝对地址；拒绝带凭据/fragment 的怪 URL，防 Key 被导向意外目标
        let u;
        try { u = new URL(target); } catch { throw new Error('API 地址格式不正确'); }
        if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('仅支持 http(s) 地址');
        if (u.username || u.password || u.hash) throw new Error('API 地址含不支持的部分');
        const url = u.origin + u.pathname.replace(/\/+$/, '') + '/models';
        const headers = { Authorization: 'Bearer ' + apiKey };
        if (/anthropic\.com/.test(u.hostname)) {
          headers['x-api-key'] = apiKey;
          headers['anthropic-version'] = '2023-06-01';
          delete headers.Authorization;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        let json;
        try {
          // redirect:'error'：Key 不跟随重定向，防止被 30x 导到第三方
          const r = await fetch(url, { headers, signal: controller.signal, redirect: 'error' });
          if (!r.ok) throw new Error(r.status === 401 ? 'Key 校验失败(401)，检查是否填对' : '平台返回 HTTP ' + r.status);
          json = await r.json();
        } finally { clearTimeout(timer); }
        const seen = new Set();
        const ids = ((json && json.data) || [])
          .map(m => String(m && m.id || ''))
          .filter(id => id && id.length <= 128 && !seen.has(id) && seen.add(id))
          .sort();
        if (!ids.length) throw new Error('平台返回了空列表');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, models: ids.slice(0, 500) }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.name === 'AbortError' ? '平台响应超时' : String(err.message || err) }));
      }
    });
    return;
  }

  if (req.url === '/api/config' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      (async () => {
        try {
          const incoming = JSON.parse(body);
          const { saveConfigMerged } = await import('../lib/merge-config.mjs');
          saveConfigMerged(CONFIG_PATH, incoming);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      })();
    });
    return;
  }

  // ── 虾盘云 · 设备钱包 ───────────────────────────────────────────────────
  // 六个接口全部只在被调用时才碰网络（claim/rotate/adopt 内部才发 fetch）——绝不能挂在
  // 服务器启动或任何计时器上，否则等于变相恢复本仓 CLAUDE.md 删掉的自动开户
  // （bootstrap-xiapan.mjs，2026-06-17 已移除）。真正联网只发生在用户点了配置页按钮之后，
  // 这条路由本身只是把浏览器的点击转发给 lib/wallet-client.mjs。

  // API: 本地钱包状态（不联网，配置页首屏用）
  if (req.url === '/api/wallet/status' && req.method === 'GET') {
    (async () => {
      try {
        const { getStatus, payBaseUrl } = await import('../lib/wallet-client.mjs');
        const result = await getStatus();
        if (result.hasWallet && result.apiKey) {
          result.rechargeUrl = payBaseUrl() + '/recharge?key=' + encodeURIComponent(result.apiKey);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message, hasWallet: false }));
      }
    })();
    return;
  }

  // API: 一键领取额度
  if (req.url === '/api/wallet/claim' && req.method === 'POST') {
    (async () => {
      try {
        const { claimWallet } = await import('../lib/wallet-client.mjs');
        const result = await claimWallet();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    })();
    return;
  }

  // API: 查询余额
  if (req.url === '/api/wallet/balance' && req.method === 'GET') {
    (async () => {
      try {
        const { getBalance } = await import('../lib/wallet-client.mjs');
        const result = await getBalance();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    })();
    return;
  }

  // API: 换一把（两阶段提交：mint → 只读验证 → commit）
  if (req.url === '/api/wallet/rotate' && req.method === 'POST') {
    (async () => {
      try {
        const { rotateWallet } = await import('../lib/wallet-client.mjs');
        const result = await rotateWallet();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    })();
    return;
  }

  // API: 填入已有密钥
  if (req.url === '/api/wallet/adopt' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      (async () => {
        try {
          const data = body ? JSON.parse(body) : {};
          const { adoptWallet } = await import('../lib/wallet-client.mjs');
          const result = await adoptWallet(data.key);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      })();
    });
    return;
  }

  // API: 移除本机钱包（危险区；只清本地 + 清实际消费者，绝不调服务端删钱包/清余额）
  if (req.url === '/api/wallet/reset-local' && req.method === 'POST') {
    (async () => {
      try {
        const { resetLocalWallet } = await import('../lib/wallet-client.mjs');
        const result = await resetLocalWallet();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    })();
    return;
  }

  // Serve static files
  const filePath = req.url === '/'
    ? path.join(__dirname, 'public/index.html')
    : path.join(__dirname, 'public', req.url);

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    const contentType = {
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json'
    }[ext] || 'text/plain';

    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

function listenWithFallback(port) {
  server.once('error', (err) => {
    if (err && err.code === 'EADDRINUSE' && port < PORT_RANGE_END) {
      console.log(`   Port ${port} busy, trying ${port + 1}…`);
      setImmediate(() => listenWithFallback(port + 1));
      return;
    }
    console.error(`Config server failed to bind: ${err && err.message ? err.message : err}`);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`\n🦞 U-Claw Config Center`);
    console.log(`   http://127.0.0.1:${port}`);
    console.log(`\n   Config file: ${CONFIG_PATH}\n`);
    // Persist the live port so Config.html / launchers can discover it after restarts.
    try {
      fs.mkdirSync(path.dirname(RUNTIME_PATH), { recursive: true });
      const existing = fs.existsSync(RUNTIME_PATH) ? JSON.parse(fs.readFileSync(RUNTIME_PATH, 'utf8')) : {};
      existing.configServerPort = port;
      existing.configServerUpdatedAt = new Date().toISOString();
      fs.writeFileSync(RUNTIME_PATH, JSON.stringify(existing, null, 2));
    } catch (err) {
      console.warn(`   Warning: could not write ${RUNTIME_PATH}: ${err.message}`);
    }
  });
}

listenWithFallback(PORT_RANGE_START);
