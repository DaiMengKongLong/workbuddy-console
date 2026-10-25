/**
 * 模型额度限制探测：**按账号真实发一次最小请求**，看上游是不是回 429。
 *
 * 为什么不用日志：会话会被「搬家」到别的账号，老会话里残留的 429 跟错账号；
 * 而且助手正文里出现「超出频率限制」几个字也会被误判。只有当场问一次才准。
 *
 * 成本控制：每个账号只探它最近用过的 ≤2 个模型，max_tokens=1、stream 一有响应就断开，
 * 结果缓存 10 分钟；页面打开时并发 3 路，约 1-2 秒出结果。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadAccounts } from './accounts.mjs';
import { authHeaders } from './credits.mjs';
import { variantOf } from './variant.mjs';
import { sessionDataRoot } from './sessions.mjs';

const CHAT_BASE = {
  cn: 'https://copilot.tencent.com',
  ai: 'https://www.workbuddy.ai',
};
const TTL = 10 * 60 * 1000;
let cache = { at: 0, data: null };

/** 该账号最近用过的模型（去重，最多 limit 个） */
function recentModelsOf(uid, variantId, limit = 2) {
  const root = sessionDataRoot(variantId);
  const projects = path.join(root, 'projects');
  const index = new Map();
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let es = [];
    try {
      es = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of es) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) index.set(e.name.slice(0, -6), p);
    }
  };
  walk(projects, 1);

  let rows = [];
  try {
    const db = new DatabaseSync(path.join(root, 'workbuddy.db'), { readOnly: true, timeout: 5000 });
    try {
      rows = db
        .prepare('SELECT id FROM sessions WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 6')
        .all(uid);
    } finally {
      db.close();
    }
  } catch {
    return [];
  }

  const out = [];
  for (const r of rows) {
    const p = index.get(String(r.id));
    if (!p) continue;
    try {
      const st = fs.statSync(p);
      const len = Math.min(st.size, 128 * 1024);
      const fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      fs.closeSync(fd);
      const ms = buf.toString('utf8').match(/"model"\s*:\s*"([^"]+)"/g);
      if (!ms) continue;
      const model = ms[ms.length - 1].replace(/^.*"model"\s*:\s*"/, '').replace(/"$/, '');
      if (model && model !== 'auto' && !out.includes(model)) out.push(model);
      if (out.length >= limit) break;
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** 发一个最小请求，判断该模型是否超限 */
async function probeOne(account, variantId, model) {
  const base = CHAT_BASE[variantId] || CHAT_BASE.cn;
  const url = base + '/v2/chat/completions';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: authHeaders(account, url),
      body: JSON.stringify({ model, messages: [{ role: 'user', content: '1' }], max_tokens: 1, stream: true }),
      signal: ctl.signal,
    });
    if (res.status === 200) {
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      return { limited: false };
    }
    const txt = await res.text();
    let j = null;
    try {
      j = JSON.parse(txt);
    } catch {
      j = null;
    }
    const msg = String(j?.msg || j?.message || txt).slice(0, 200);
    const m = /将在\s*(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})/.exec(msg);
    const resetAt = m ? new Date(m[1].replace(' ', 'T') + '+08:00').getTime() : 0;

    // 判定不能只认 429：上游换成 400/403 或改文案时，真实限流会被漏掉
    const limitWord = /限流|频率|额度|配额|超出|用尽|超额|too many requests|rate.?limit|quota|insufficient|11128/i.test(msg);
    const hardLimit = res.status === 429;
    const softLimit = !hardLimit && (res.status === 400 || res.status === 403) && limitWord;
    if (hardLimit || softLimit) {
      return {
        limited: true,
        // 解析不到恢复时间也给一个占位（10 分钟后复探），否则前端会把它当作“已过期”丢掉
        resetAt: resetAt > Date.now() ? resetAt : Date.now() + 10 * 60 * 1000,
        resetKnown: resetAt > Date.now(),
        status: res.status,
        model,
      };
    }
    return { limited: false, note: `${res.status} ${model}: ${msg.slice(0, 60)}` };
  } catch (e) {
    return { limited: false, note: `${model}: ${e?.name === 'AbortError' ? '超时' : e?.message}` };
  } finally {
    clearTimeout(timer);
  }
}

/** 缓存里可能残留「恢复时间已过」的条目，返回前统一剔掉 */
function dropExpired(data) {
  const now = Date.now();
  const accs = {};
  for (const [uid, list] of Object.entries(data?.accounts || {})) {
    const keep = (Array.isArray(list) ? list : []).filter((x) => x && x.resetAt > now);
    if (keep.length) accs[uid] = keep;
  }
  return { ...data, accounts: accs };
}

export async function probeAllModelLimits({ refresh = false } = {}) {
  if (!refresh && cache.data && Date.now() - cache.at < TTL) return { ...dropExpired(cache.data), cached: true };

  const accs = loadAccounts().filter((a) => a?.uid);
  const out = {};
  for (const a of accs) out[String(a.id || a.uid)] = [];

  const tasks = [];
  for (const a of accs) {
    const v = variantOf(a).id;
    // 固定探一次最常用的模型（账号可能已经把会话搬走了，没有「最近模型」可依），
    // 再补最近用过的 2 个：只探 1 个时，被限的往往是没探到的那个型号。
    const cand = ['deepseek-v4.1-flash'];
    for (const m of recentModelsOf(String(a.uid), v, 2)) if (!cand.includes(m)) cand.push(m);
    for (const model of cand.slice(0, 3)) tasks.push({ a, v, model });
  }

  const notes = [];
  const accountNotes = {};
  let idx = 0;
  const worker = async () => {
    while (idx < tasks.length) {
      const t = tasks[idx++];
      const r = await probeOne(t.a, t.v, t.model);
      const id = String(t.a.id || t.a.uid);
      if (r.limited) {
        if (!out[id].some((x) => x.model === t.model)) {
          out[id].push({
            model: t.model,
            resetAt: r.resetAt,
            resetKnown: !!r.resetKnown,
            status: r.status || 0,
          });
        }
        accountNotes[id] = `${t.model} 已被上游限流（HTTP ${r.status || 429}）`;
      } else if (r.note) {
        notes.push(r.note);
        // 探测失败但没被判定为限流：把原因一并带回前端，避免"什么都没显示"的黑盒
        if (!accountNotes[id]) accountNotes[id] = r.note;
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, () => worker()));

  const data = {
    accounts: out,
    accountNotes,
    at: Date.now(),
    probed: tasks.length,
    notes: notes.slice(0, 6),
    source: 'live-probe',
  };
  cache = { at: Date.now(), data };
  return data;
}

export function clearLimitCache() {
  cache = { at: 0, data: null };
}
