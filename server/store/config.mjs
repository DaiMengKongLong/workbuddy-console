import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

/** 配置目录：默认 ~/.free-token，可用 FREE_TOKEN_CONFIG_DIR 重定向（隔离测试用） */
export const CONFIG_DIR = process.env.FREE_TOKEN_CONFIG_DIR
  ? path.resolve(process.env.FREE_TOKEN_CONFIG_DIR)
  : path.join(os.homedir(), '.free-token');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
export const CACHE_DIR = path.join(CONFIG_DIR, 'cache');

const DEFAULT_SETTINGS = {
  workbuddyDir: '', // 覆盖默认 ~/.workbuddy
  proxyUrl: '', // 出站代理（如 http://127.0.0.1:7890）；留空自动探测环境变量 / Windows 系统代理
  autoCheckin: true, // 自动签到（仅国内版账号，服务端每小时巡检一次）；默认开启，可在设置里关闭
  // 凭据自动刷新（服务端每 6 小时巡检一次，只在 access/refresh 临期时才动手）；默认开启。
  // 关掉后：既没被切换、也没走过反向代理的账号会一直静默过期，直到需要重新扫码。
  autoRefreshToken: true,
  // 启动时检查有没有新版本（只读 GitHub Release 元数据，是唯一一处访问非官方服务的出站请求）
  autoCheckUpdate: true,
  /**
   * 免费模型页是否列出**全部平台**（含默认收起的地区受限 / 平台禁止外部接入的那几个）。
   * 默认关闭：这些平台的 key 在外部环境调用大概率被拒，列出来只会让人白折腾。
   * 打开后照常可选，但界面上会常驻风险提示——是否接入由用户自己承担。
   */
  unlockAllPlatforms: false,
};

/**
 * 反向代理（让其他 agent 用 OpenAI 协议调用 WorkBuddy 的积分与模型）。
 * 放在 settings 里，随 config.json 一起落盘；apiKey 首次使用时自动生成。
 */
export const DEFAULT_PROXY = {
  enabled: false, // 默认关闭：暴露本地端口属于"对外能力"，要用户明确打开
  apiKey: '', // 调用方鉴权用；为空视为未初始化，首次启用时生成
  /**
   * 参与轮换的账号 id。
   * 语义上必须区分「没配过」与「一个都不选」：
   *   null/非数组 = 全部可用账号；[]（空数组）= 一个都不用（池为空）。
   * 早期版本用 [] 表示"全部"，导致用户在界面上取消最后一个勾选后又被解释成全部。
   */
  accountIds: null,
  /** 非流式请求的整段超时；流式响应只受 60s 首字节超时约束，不会被硬掐 */
  timeoutMs: 120_000,
};

const DEFAULT_CONFIG = {
  version: 1,
  activeKeyId: null, // 兼容字段：openrouter 的活跃 key
  activeKeys: {}, // platform -> 活跃 keyId（如 { openrouter: 'key-xxx', zen: 'key-yyy' }）
  keys: [], // { id, platform, label, key, addedAt, lastStatus }
  settings: { ...DEFAULT_SETTINGS },
  proxy: { ...DEFAULT_PROXY },
};

export function ensureDirs() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

/**
 * 覆盖式 rename + 降级：rename 被环境拦截时（genie-safe-delete shim 等，间歇性），
 * 降级为「复制内容到目标 + 删临时」。copyFileSync 覆盖已有文件实测不受拦截。
 * rename 是原子操作，失败即未发生，因此降级不会产生半写状态。
 */
export function safeRenameOverwrite(tmp, file) {
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.copyFileSync(tmp, file);
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * 原子写 JSON：先写临时文件再 rename 覆盖。
 *
 * 本机环境注意：全局 NODE_OPTIONS 注入了 WorkBuddy CLI 的 genie-safe-delete shim，
 * 它会把「~/.wb-switch 内覆盖已有文件」的 renameSync 路由到自己的回收站后端；该后端
 * 一旦失败（2026-10-22 实测 'Error during a trash operation: Unknown'）所有落盘全挂。
 * 所以 rename 失败时**降级为直接写目标文件**（实测不受 shim 拦截）——牺牲一次原子性
 * 换取功能可用；写入内容完全相同，崩溃窗口极小。
 */
export function atomicWriteJson(file, obj) {
  const text = JSON.stringify(obj, null, 2);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch {
    // rename 被拒（文件锁 / 安全软件 / genie-safe-delete 回收站后端失败）→ 直接写目标
    try {
      fs.writeFileSync(file, text, 'utf8');
    } finally {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* 残留 tmp 可后续清理，不影响数据 */
      }
    }
  }
}

export function loadConfig() {
  ensureDirs();
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const cfg = {
      ...structuredClone(DEFAULT_CONFIG),
      ...raw,
      settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) },
      activeKeys: { ...(raw.activeKeys || {}) },
      proxy: { ...DEFAULT_PROXY, ...(raw.proxy || {}) },
    };
    // 迁移：旧版 key 不分平台，全部归入 openrouter；activeKeyId 迁移为 activeKeys.openrouter
    let migrated = false;
    for (const k of cfg.keys) {
      if (!k.platform) {
        k.platform = 'openrouter';
        migrated = true;
      }
    }
    if (!cfg.activeKeys.openrouter && cfg.activeKeyId && cfg.keys.some((k) => k.id === cfg.activeKeyId)) {
      cfg.activeKeys.openrouter = cfg.activeKeyId;
      migrated = true;
    }
    // 迁移：accountIds 的语义从"空数组=全部"改为"null=全部、空数组=一个都不选"。
    // 旧配置里留下的 [] 必须翻成 null，否则老用户升级后会发现"账号池突然空了"。
    if (Array.isArray(cfg.proxy?.accountIds) && cfg.proxy.accountIds.length === 0 && cfg.proxy.migratedPool !== true) {
      cfg.proxy.accountIds = null;
      cfg.proxy.migratedPool = true;
      migrated = true;
    }
    if (migrated) saveConfig(cfg);
    return cfg;
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

/** 某平台当前活跃的 key 记录（找不到时回退到该平台第一个 key） */
export function activeKeyFor(cfg, platform) {
  const keys = cfg.keys.filter((k) => k.platform === platform);
  const activeId = cfg.activeKeys?.[platform] || (platform === 'openrouter' ? cfg.activeKeyId : null);
  return keys.find((k) => k.id === activeId) || keys[0] || null;
}

export function saveConfig(cfg) {
  ensureDirs();
  atomicWriteJson(CONFIG_FILE, cfg);
}

export function newId(prefix) {
  return `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
}

/** key 只保留末 4 位用于界面区分，完整值永不返回给前端 */
export function maskKey(key) {
  if (!key || typeof key !== 'string') return '';
  return `••••${key.slice(-4)}`;
}

export function cachePath(name) {
  ensureDirs();
  return path.join(CACHE_DIR, name);
}
