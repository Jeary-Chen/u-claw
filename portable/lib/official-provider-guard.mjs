#!/usr/bin/env node
// official-provider-guard.mjs — 避开 OpenClaw 官方 provider 插件的自动安装路径 + 启动侧
// gateway 自愈。
//
// OpenClaw 2026.8.1 在 models.providers 的 key 命中官方 catalog 时，会尝试安装相应
// 官方插件。exFAT 无法创建插件验证需要的 node_modules/openclaw 链接，gateway 因而永不
// ready；NTFS 上也可能等待交互式 capability consent。守卫分两步：
//   1) 若该 provider 的官方插件已预装在 app/core（v2.1.28+ 发版包，npm install --prefix），
//      保留用户原名——gateway 直接识别本地插件，用户还能吃到原生插件体验；
//   2) 插件缺失（存量老 U 盘 / 手动 npm 装法）时，把 provider key 改为不命中 catalog 的
//      <id>-api，并同步默认模型引用，走通用 OpenAI 兼容通道，启动不再被插件安装卡死。
//      仅当条目自带 baseUrl+api（Config.html 写出的形态）才改名——裸条目改名后模型也调不通，
//      改了只是把「起不来」换成「连不上」，没有价值。
//
// gateway 自愈（2026-09-01，与 merge-config.mjs 同一契约）：启动时配置若缺 gateway 段
// 或 auth 子对象（旧版页面/上游/第三方工具写盘都可能造成），就地补回本地 token 配置，
// 否则 OpenClaw 每次重启生成随机 runtime token，固定 #token=uclaw 的 Dashboard 永远 401。
//
// 官方 id 来源 = 运行时 catalog ∪ 2026.8.1 快照（取并集：catalog 部分解析成功时快照
// 兜住剩余；catalog 完全不可用时退化为纯快照）。两者都空 → fail-open，绝不妨碍启动。
//
// 零依赖、静默失败、退出码恒为 0（缺少配置路径的用法错误除外）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// [officialId, npmSpec] — 2026.8.1 catalog 快照（official-external-provider-catalog.json，
// entries[].openclaw.providers[].id + entries[].openclaw.install.npmSpec），2026-09-01 提取。
const OFFICIAL_PROVIDER_SNAPSHOT = Object.freeze([
  ['amazon-bedrock', '@openclaw/amazon-bedrock-provider'],
  ['amazon-bedrock-mantle', '@openclaw/amazon-bedrock-mantle-provider'],
  ['anthropic-vertex', '@openclaw/anthropic-vertex-provider'],
  ['arcee', '@openclaw/arcee-provider'],
  ['cerebras', '@openclaw/cerebras-provider'],
  ['chutes', '@openclaw/chutes-provider'],
  ['cloudflare-ai-gateway', '@openclaw/cloudflare-ai-gateway-provider'],
  ['codex', '@openclaw/codex'],
  ['cohere', '@openclaw/cohere-provider'],
  ['deepinfra', '@openclaw/deepinfra-provider'],
  ['deepseek', '@openclaw/deepseek-provider'],
  ['featherless', '@openclaw/featherless-provider'],
  ['fireworks', '@openclaw/fireworks-provider'],
  ['gmi', '@openclaw/gmi-provider'],
  ['groq', '@openclaw/groq-provider'],
  ['kilocode', '@openclaw/kilocode-provider'],
  ['kimi', '@openclaw/kimi-provider'],
  ['longcat', '@openclaw/longcat-provider'],
  ['meta', '@openclaw/meta-provider'],
  ['moonshot', '@openclaw/moonshot-provider'],
  ['pixverse', '@openclaw/pixverse-provider'],
  ['qianfan', '@openclaw/qianfan-provider'],
  ['qwen', '@openclaw/qwen-provider'],
  ['qwen-oauth', '@openclaw/qwen-provider'],
  ['stepfun', '@openclaw/stepfun-provider'],
  ['stepfun-plan', '@openclaw/stepfun-provider'],
  ['tencent-tokenhub', '@openclaw/tencent-provider'],
  ['tencent-tokenplan', '@openclaw/tencent-provider'],
  ['venice', '@openclaw/venice-provider'],
  ['vercel-ai-gateway', '@openclaw/vercel-ai-gateway-provider'],
  ['zai', '@openclaw/zai-provider'],
]);

const CORE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app', 'core');
const DEFAULT_CATALOG_PATH = path.join(
  CORE_DIR, 'node_modules', 'openclaw', 'scripts', 'lib',
  'official-external-provider-catalog.json',
);

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// catalog → Map(officialId → npmSpec)；npmSpec 缺失用 entry name 兜底，再缺视为未安装。
function readCatalogProviders(catalogPath) {
  try {
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    const providers = new Map();
    for (const entry of catalog.entries || []) {
      if (entry?.kind && entry.kind !== 'provider') continue;
      const oc = entry?.openclaw || {};
      const npmSpec = oc?.install?.npmSpec || entry?.name || '';
      for (const provider of oc?.providers || []) {
        if (provider?.kind && provider.kind !== 'provider') continue;
        if (typeof provider?.id === 'string' && provider.id && !providers.has(provider.id)) {
          providers.set(provider.id, npmSpec);
        }
      }
    }
    return providers;
  } catch {
    return new Map();
  }
}

function timestampForBackup(date = new Date()) {
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value) => String(value).padStart(2, '0'))
    .join('');
}

function writeAtomic(configPath, content) {
  const dir = path.dirname(configPath);
  const tempPath = path.join(dir, `.${path.basename(configPath)}.provider-guard-${process.pid}-${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tempPath, content);
    fs.renameSync(tempPath, configPath);
  } catch (err) {
    // 失败时清掉残留的半截临时文件（2026-09-01 独立测试抓到的残留问题）。
    try { fs.unlinkSync(tempPath); } catch { /* 本就不存在或删不掉，随它 */ }
    throw err;
  }
}

function appendLog(configPath, message) {
  const logPath = path.resolve(path.dirname(configPath), '..', 'logs', 'provider-guard.log');
  if (!fs.existsSync(path.dirname(logPath))) return;
  fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
}

function pluginInstalled(npmSpec, coreDir) {
  if (!npmSpec) return false;
  // npmSpec 可能带版本（@scope/pkg@1.2.3）；包目录只取 @scope/pkg 部分。
  // 注意：npm 对 @scope/pkg 形态，版本分隔符是「第二个 @」；无 scope 包是「第一个 @」。
  const isScoped = npmSpec.startsWith('@');
  const at = npmSpec.lastIndexOf('@');
  const pkgDir = at > (isScoped ? 0 : -1) && at > 0 ? npmSpec.slice(0, at) : npmSpec;
  if (!pkgDir) return false;
  try {
    return fs.existsSync(path.join(coreDir, 'node_modules', pkgDir, 'package.json'));
  } catch {
    return false;
  }
}

/**
 * gateway 自愈（与 merge-config.mjs 的保底契约一致，就地修改并返回是否发生变化）。
 * 缺失/非对象 → 补默认；缺 auth → 补 auth；token 模式下 token 缺失/空 → 补 uclaw。
 */
export function ensureGatewayOnConfig(config) {
  const DEFAULT_GATEWAY = { mode: 'local', auth: { mode: 'token', token: 'uclaw' } };
  if (!isPlainObject(config.gateway)) {
    config.gateway = { mode: DEFAULT_GATEWAY.mode, auth: { ...DEFAULT_GATEWAY.auth } };
    return true;
  }
  let changed = false;
  if (!isPlainObject(config.gateway.auth)) {
    config.gateway.auth = { ...DEFAULT_GATEWAY.auth };
    changed = true;
  } else {
    const auth = config.gateway.auth;
    const tokenMode = !auth.mode || auth.mode === 'token';
    if (tokenMode && (typeof auth.token !== 'string' || auth.token === '')) {
      auth.token = DEFAULT_GATEWAY.auth.token;
      changed = true;
    }
  }
  return changed;
}

/**
 * @param {string} configPath openclaw.json 绝对路径
 * @param {string} [catalogPath] 运行时 catalog 路径（默认指向 app/core 内那份）
 * @param {{coreDir?: string, snapshot?: ReadonlyArray<[string, string]>}} [options]
 *        coreDir 供测试注入；snapshot 传 [] 可禁用快照兜底（测试 fail-open 用）。
 * @returns {string[]} 动作记录（改名/跳过/gateway 自愈），无动作返回 []
 */
export function guardOfficialProviders(configPath, catalogPath = DEFAULT_CATALOG_PATH, options = {}) {
  try {
    const snapshot = options.snapshot !== undefined ? options.snapshot : OFFICIAL_PROVIDER_SNAPSHOT;
    const catalogProviders = readCatalogProviders(catalogPath);
    // 并集：catalog 实时覆盖同名快照项，快照兜住 catalog 缺失/残缺的部分。
    const official = new Map(
      (Array.isArray(snapshot) ? snapshot : []).map(([id, spec]) => [id, spec || '']),
    );
    for (const [id, spec] of catalogProviders) official.set(id, spec);
    if (!official.size) return [];

    const raw = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(raw);
    if (!isPlainObject(config) || !isPlainObject(config.models) || !isPlainObject(config.models.providers)) {
      return [];
    }

    const actions = [];
    const coreDir = options.coreDir || CORE_DIR;

    for (const [id, npmSpec] of official) {
      if (!Object.prototype.hasOwnProperty.call(config.models.providers, id)) continue;
      // 官方插件已预装在本地 → gateway 能直接识别，保留原名不动（原生插件体验）。
      if (pluginInstalled(npmSpec, coreDir)) continue;
      const target = `${id}-api`;
      if (Object.prototype.hasOwnProperty.call(config.models.providers, target)) {
        // 同名共存（deepseek + deepseek-api）：改名会把用户手建的条目覆盖掉，跳过并记日志。
        actions.push(`skip ${id}: ${target} 已存在`);
        continue;
      }
      const entry = config.models.providers[id];
      const renamable = isPlainObject(entry)
        && typeof entry.baseUrl === 'string' && entry.baseUrl
        && typeof entry.api === 'string' && entry.api;
      if (!renamable) {
        // 裸条目（无 baseUrl/api）改名后模型也调不通，不动它、留线索。
        actions.push(`skip ${id}: 缺 baseUrl/api，无法安全改名`);
        continue;
      }

      config.models.providers[target] = config.models.providers[id];
      delete config.models.providers[id];
      actions.push(`renamed ${id}→${target}`);

      const primary = config.agents?.defaults?.model?.primary;
      if (typeof primary === 'string' && primary.startsWith(`${id}/`)) {
        config.agents.defaults.model.primary = `${target}/${primary.slice(id.length + 1)}`;
        actions.push(`primary ${id}/→${target}/`);
      }
    }

    const gatewayHealed = ensureGatewayOnConfig(config);
    if (gatewayHealed) actions.push('gateway 自愈（补回缺失的 gateway/auth 段）');

    if (!actions.length) return [];

    try {
      fs.copyFileSync(configPath, `${configPath}.provider-guard-bak-${timestampForBackup()}`);
    } catch {
      // 备份失败不阻断：配置原子写成功更重要。
    }

    writeAtomic(configPath, JSON.stringify(config, null, 2));
    try {
      appendLog(configPath, actions.join('; '));
    } catch {
      // 日志仅供诊断，不能影响启动。
    }
    return actions;
  } catch {
    return [];
  }
}

export function main(argv) {
  if (!argv[2]) return 2;
  guardOfficialProviders(argv[2], argv[3]);
  return 0;
}

const isMain = path.basename(process.argv[1] || '') === 'official-provider-guard.mjs';

if (isMain) process.exitCode = main(process.argv);
