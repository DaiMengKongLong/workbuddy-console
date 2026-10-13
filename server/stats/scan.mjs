import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { workbuddyDir } from '../targets/workbuddy.mjs';
import { getVariant, dataRoot } from '../workbuddy/variant.mjs';

/**
 * WorkBuddy Token 统计：扫描 <数据目录>/projects 下所有 .jsonl 会话日志（递归，跳过 subagents）。
 *
 * 计数字段优先取 providerData.usage，其次 providerData.rawUsage，最后 message.usage；
 * 字段别名兼容 camel/snake（与 workbuddy-switch 的 token_stats 同源）。
 *
 * 口径说明（与 workbuddy-switch 的 token_stats 对齐，务必保留）：
 * - `input` **已包含**缓存命中部分（实测 inputTokens=36170 / cached=7533，input 就是总数）。
 *   因此展示总量 `total = input + output + cacheWrite`，**不再加 cacheRead**，
 *   否则缓存命中会被重复计入。
 * - `uncachedInput = input - cacheRead`，即真正新读进去的输入。
 * - 思考 token 是 `output` 的子集，用于拆分「思考 / 回复」；实测存在 thinking > output
 *   的异常记录，展示回复内容时必须做饱和减。
 *
 * 隐私：只读取计数字段。providerData.reasoning 是思考正文、message.content 是消息内容，
 * 任何情况下都不读、不返回。
 *
 * 本模块为纯计算逻辑，设计为在 worker 线程中运行（见 statsWorker.mjs），
 * 避免阻塞 Express / Electron 主进程——首次全量扫描可能耗时数分钟（数千个日志文件）。
 */

// 进程内文件级缓存：路径 -> { mtimeMs, size, records, meta }（worker 常驻，跨请求复用）
const fileCache = new Map();

function walkJsonl(dir, out = []) {
  let items;
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const it of items) {
    const p = path.join(dir, it.name);
    if (it.isDirectory()) {
      // 子代理日志会重放父会话上下文，计入会导致重复统计
      if (it.name === 'subagents') continue;
      walkJsonl(p, out);
    } else if (it.isFile() && it.name.endsWith('.jsonl')) {
      out.push(p);
    }
  }
  return out;
}

/** 从 JSON 数字或数字字符串里取非负数 */
function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : 0;
  if (typeof v === 'string') {
    const n = Number(v.trim());
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }
  return 0;
}

/** 取第一个 > 0 的候选值；全为 0/缺失时返回 0 */
function pickPositive(...vals) {
  for (const v of vals) {
    const n = toNumber(v);
    if (n > 0) return n;
  }
  return 0;
}

/**
 * 缓存命中 token。
 *
 * 各家 provider 字段位置不一致：既有平铺别名（`cache_read_input_tokens`），
 * 也有 OpenAI 兼容的嵌套结构（`prompt_tokens_details.cached_tokens`、
 * `inputTokensDetails[].cached_tokens`）。实测本机 WorkBuddy **只填嵌套结构**，
 * 平铺别名一律为 0——所以必须都查，且优先取正值，
 * 避免陈旧的 0 把真实值盖掉（这正是旧版统计缓存命中恒为 0 的原因）。
 */
function cachedTokens(rawUsage, usage) {
  const fromFlat = pickPositive(
    rawUsage?.cache_read_input_tokens,
    rawUsage?.cacheReadInputTokens,
    rawUsage?.prompt_cache_hit_tokens,
    rawUsage?.cached_tokens
  );
  if (fromFlat > 0) return fromFlat;

  const fromPromptDetails = pickPositive(rawUsage?.prompt_tokens_details?.cached_tokens);
  if (fromPromptDetails > 0) return fromPromptDetails;

  // inputTokensDetails 是数组，取其中第一个正的 cached_tokens
  for (const details of [usage?.inputTokensDetails, rawUsage?.inputTokensDetails]) {
    if (Array.isArray(details)) {
      for (const d of details) {
        const n = pickPositive(d?.cached_tokens);
        if (n > 0) return n;
      }
    }
  }
  return 0;
}

/** 缓存写入 token（本机 WorkBuddy 恒为 0，保留字段以兼容其他 provider） */
function cacheWriteTokens(rawUsage) {
  return pickPositive(
    rawUsage?.cache_creation_input_tokens,
    rawUsage?.cache_write_input_tokens,
    rawUsage?.prompt_cache_write_tokens
  );
}

/** 思考 token（output 的子集）。只取计数，绝不读 providerData.reasoning 正文。 */
function thinkingTokens(rawUsage, usage) {
  const fromRaw = pickPositive(
    rawUsage?.completion_thinking_tokens,
    rawUsage?.completion_tokens_details?.reasoning_tokens,
    rawUsage?.reasoning_tokens
  );
  if (fromRaw > 0) return fromRaw;
  const details = usage?.outputTokensDetails;
  if (Array.isArray(details)) {
    for (const d of details) {
      const n = pickPositive(d?.reasoning_tokens);
      if (n > 0) return n;
    }
  }
  return 0;
}

/** 从一行日志解析用量；无任何用量数据时返回 null */
function usageFromLine(line) {
  const pd = line.providerData ?? {};
  const u = pd.usage ?? {};
  const ru = pd.rawUsage ?? {};
  const mu = line.message?.usage ?? {};

  const input = pickPositive(u.inputTokens, ru.input_tokens, ru.prompt_tokens, mu.input_tokens, mu.prompt_tokens);
  const output = pickPositive(u.outputTokens, ru.output_tokens, ru.completion_tokens, mu.output_tokens, mu.completion_tokens);
  const cacheRead = cachedTokens(ru, u);
  const cacheWrite = cacheWriteTokens(ru);
  const thinking = thinkingTokens(ru, u);
  const requests = toNumber(u.requests);

  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0 && requests === 0) return null;

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    thinking,
    requests: requests || 1, // 有 token 而无 requests 计数时按 1 次请求计
    model: pd.model || pd.requestModelId || 'unknown',
  };
}

/** 便宜的行级预过滤：任何用量数据都出现在 usage/rawUsage（含 "sage" 子串）里，不含则无需 JSON.parse */
function lineMayHaveUsage(line) {
  return line.includes('sage');
}

/** 流式逐行解析（readline），避免对大文件一次性 split 造成内存尖峰 */
async function parseFile(file) {
  const records = [];
  const meta = { sessionId: null, title: '', project: '' };
  const stream = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line || line.length > 4_000_000) continue; // 超长行跳过，防坏档
    const metaDone = meta.sessionId && meta.title && meta.project;
    if (metaDone && !lineMayHaveUsage(line)) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;
    if (!meta.sessionId && obj.sessionId) meta.sessionId = obj.sessionId;
    if (!meta.title) {
      const t = obj.aiTitle || obj.summary || obj.title;
      if (typeof t === 'string' && t.trim()) meta.title = t.trim().slice(0, 200);
    }
    if (!meta.project && typeof obj.cwd === 'string' && obj.cwd) {
      meta.project = obj.cwd.split(/[\\/]/).filter(Boolean).pop() || obj.cwd;
    }
    const u = usageFromLine(obj);
    if (u) {
      const ts = Number(obj.timestamp ?? obj.ts) || null;
      records.push({ ts, sid: obj.sessionId || meta.sessionId || path.basename(file, '.jsonl'), ...u });
    }
  }
  if (!meta.sessionId) meta.sessionId = path.basename(file, '.jsonl');
  // 项目名兜底：projects/<dirname>/
  if (!meta.project) {
    const dir = path.basename(path.dirname(file));
    meta.project = dir === 'projects' ? '未命名' : dir;
  }
  return { records, meta };
}

function localDate(ts) {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function cutoffFor(range, now) {
  const DAY = 24 * 3600 * 1000;
  switch (range) {
    case 'today': {
      const d = new Date(now);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    }
    case '7d':
      return now - 7 * DAY;
    case '30d':
      return now - 30 * DAY;
    default:
      return null; // all
  }
}

function emptyBucket() {
  return { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0, total: 0 };
}

/**
 * 累加一条记录的用量。
 *
 * total = input + output + cacheWrite：input 已含 cacheRead，不再重复加，
 * 否则缓存命中的 token 会被计两遍（本口径最容易出错的地方）。
 */
function addUsage(bucket, r) {
  bucket.requests += r.requests;
  bucket.input += r.input;
  bucket.output += r.output;
  bucket.cacheRead += r.cacheRead;
  bucket.cacheWrite += r.cacheWrite;
  bucket.thinking += r.thinking;
  bucket.total += r.input + r.output + r.cacheWrite;
}

/** 给聚合桶补上派生字段：未命中输入、缓存命中率、纯回复量 */
function decorate(bucket) {
  return {
    ...bucket,
    uncachedInput: Math.max(0, bucket.input - bucket.cacheRead),
    cacheHitRate: bucket.input > 0 ? bucket.cacheRead / bucket.input : null,
    // 回复内容 = max(0, output - thinking)，思考是 output 的子集
    reply: Math.max(0, bucket.output - bucket.thinking),
  };
}

/**
 * 档位 → 扫描根。
 *
 * 国内版沿用可被用户在设置里覆盖的数据目录（历史行为不变），国际版用它自己的
 * 数据根 `~/.workbuddy-ai`——两个档位的会话日志本来就分别存放，混在一个目录里统计
 * 既不准也没法"归类看"。
 */
function rootsFor(variants) {
  const ids = Array.isArray(variants) && variants.length ? variants : ['cn'];
  return ids.map((id) => ({
    id,
    label: getVariant(id).label,
    dir: id === 'ai' ? dataRoot('ai') : workbuddyDir(),
  }));
}

export async function runStats({ range = '30d', model = '', variants = ['cn'] } = {}) {
  const roots = rootsFor(variants);
  const multi = roots.length > 1;
  const now = Date.now();
  const cutoff = cutoffFor(range, now);
  const modelFilter = String(model || '').trim().toLowerCase();

  const summary = emptyBucket();
  const byModel = new Map();
  const byProject = new Map();
  const sessions = new Map(); // `${variant}/${sid}`（多档位时）或 sid -> bucket + meta
  const daily = new Map(); // date -> bucket + byModel
  const hours = new Map(); // '周一-9' -> requests
  const variantBuckets = new Map(); // 档位 -> bucket + 该档位的文件计数
  let filesScanned = 0;
  let filesSkipped = 0;
  let parseErrors = 0;
  let coverageStartAt = null;
  let coverageEndAt = null;

  for (const root of roots) {
    const vb = { variant: root.id, label: root.label, dir: root.dir, filesScanned: 0, filesSkipped: 0, ...emptyBucket() };
    variantBuckets.set(root.id, vb);
    const projectsDir = path.join(root.dir, 'projects');

    const files = walkJsonl(projectsDir);
    for (const file of files) {
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      filesScanned++;
      vb.filesScanned++;
      // 会话日志为追加写：mtime 一定 >= 文件内最后一条记录的时间。
      // 因此 mtime 早于 cutoff 的文件不可能包含范围内的记录，直接跳过（对 30 天视图是巨大的首扫提速）。
      if (cutoff != null && st.mtimeMs < cutoff) {
        filesSkipped++;
        vb.filesSkipped++;
        continue;
      }
      let entry = fileCache.get(file);
      if (!entry || entry.mtimeMs !== st.mtimeMs || entry.size !== st.size) {
        try {
          entry = { mtimeMs: st.mtimeMs, size: st.size, ...(await parseFile(file)) };
        } catch {
          parseErrors++;
          continue;
        }
        fileCache.set(file, entry);
      }
      const { records, meta } = entry;

      for (const r of records) {
        if (cutoff != null && (r.ts == null || r.ts < cutoff || r.ts > now)) continue;
        const modelLower = String(r.model).toLowerCase();
        if (modelFilter && !modelLower.includes(modelFilter)) continue;

        addUsage(summary, r);
        addUsage(vb, r);
        if (r.ts) {
          if (coverageStartAt == null || r.ts < coverageStartAt) coverageStartAt = r.ts;
          if (coverageEndAt == null || r.ts > coverageEndAt) coverageEndAt = r.ts;
        }

        const mb = byModel.get(r.model) || emptyBucket();
        addUsage(mb, r);
        byModel.set(r.model, mb);

        const projectName = meta.project || '未命名';
        const pb = byProject.get(projectName) || emptyBucket();
        addUsage(pb, r);
        byProject.set(projectName, pb);

        // 多档位时按「档位/会话」建档，避免两个档位的会话 id 撞车
        const skey = multi ? `${root.id}/${r.sid}` : r.sid;
        const sb =
          sessions.get(skey) || { ...emptyBucket(), meta, models: new Map(), lastActive: 0, variant: root.id, sid: r.sid };
        addUsage(sb, r);
        sb.models.set(r.model, (sb.models.get(r.model) || 0) + (r.input + r.output + r.cacheWrite));
        if (r.ts && r.ts > sb.lastActive) sb.lastActive = r.ts;
        sessions.set(skey, sb);

        if (r.ts) {
          const date = localDate(r.ts);
          const db = daily.get(date) || { ...emptyBucket(), byModel: new Map() };
          addUsage(db, r);
          db.byModel.set(r.model, (db.byModel.get(r.model) || 0) + (r.input + r.output + r.cacheWrite));
          daily.set(date, db);

          const d = new Date(r.ts);
          const hk = `${WEEKDAYS[d.getDay()]}-${d.getHours()}`;
          hours.set(hk, (hours.get(hk) || 0) + r.requests);
        }
      }
    }
  }

  const sortBuckets = (m) =>
    [...m.entries()]
      .map(([name, b]) => decorate({ name, ...b }))
      .sort((a, b) => b.total - a.total);

  const models = sortBuckets(byModel);
  const projects = sortBuckets(byProject);
  const sessionList = [...sessions.entries()]
    .map(([sid, s]) => ({
      sessionId: s.sid || sid,
      variant: s.variant || roots[0].id,
      variantLabel: getVariant(s.variant || roots[0].id).label,
      title: s.meta?.title || '',
      project: s.meta?.project || '',
      ...decorate(s),
      lastActive: s.lastActive || null,
      topModels: [...s.models.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([m, t]) => ({ model: m, tokens: t })),
    }))
    .sort((a, b) => b.total - a.total);
  const dailyList = [...daily.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, b]) => ({
      date,
      ...decorate(b),
      byModel: Object.fromEntries([...b.byModel.entries()].sort((x, y) => y[1] - x[1])),
    }));

  return {
    range,
    modelFilter: model || null,
    generatedAt: now,
    variantFilter: multi ? 'all' : roots[0].id,
    dir: roots[0].dir,
    dirs: roots.map((r) => ({ variant: r.id, label: r.label, dir: r.dir })),
    variants: [...variantBuckets.values()].map((v) => ({ ...v, ...decorate(v) })),
    filesScanned,
    filesSkipped,
    parseErrors,
    coverageStartAt,
    coverageEndAt,
    summary: decorate(summary),
    models,
    projects,
    sessions: sessionList,
    daily: dailyList,
    hours: Object.fromEntries([...hours.entries()].sort((a, b) => b[1] - a[1])),
  };
}