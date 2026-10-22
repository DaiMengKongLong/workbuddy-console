// 合并内核.mjs —— 同一会话多副本 → 合并成一份（按消息 id 并集 + 时间排序）
// 规则：
//   1) 跨副本按「行 key」去重（消息 id / 快照 messageId+时间 / 行首哈希兜底）
//   2) 同一个 key 内容长度不同 → 取更长的那份（更完整）
//   3) 排序按 timestamp 升序；缺 timestamp 的行沿用同文件前一行时间（避免排到最前）
//   4) 合并后校验：每个副本的每一行都在结果里、行数 == 去重后行数；不通过不落盘
import fs from 'node:fs';
import crypto from 'node:crypto';

const CH = 8 * 1024 * 1024;

export function scanLineRanges(file) {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  const ranges = [];
  const buf = Buffer.alloc(CH);
  let pos = 0;
  let lineStart = 0;
  let carry = 0;
  while (pos < size) {
    const n = fs.readSync(fd, buf, 0, Math.min(CH, size - pos), pos);
    if (n <= 0) break;
    let from = 0;
    for (;;) {
      const k = buf.indexOf(0x0a, from);
      if (k === -1 || k >= n) break;
      const len = carry + (k - from);
      if (len > 0) ranges.push([lineStart, len]);
      lineStart = pos + k + 1;
      carry = 0;
      from = k + 1;
    }
    carry += n - from;
    pos += n;
  }
  if (lineStart < size) ranges.push([lineStart, size - lineStart]);
  fs.closeSync(fd);
  return { size, ranges };
}

export function readLineHead(fd, off, len) {
  const n = Math.min(600, len);
  const b = Buffer.alloc(n);
  fs.readSync(fd, b, 0, n, off);
  const s = b.toString('latin1');
  const id = (s.match(/"id"\s*:\s*"([^"]{1,64})"/) || [])[1] || '';
  const mid = (s.match(/"messageId"\s*:\s*"([^"]{1,64})"/) || [])[1] || '';
  const type = (s.match(/"type"\s*:\s*"([^"]{1,40})"/) || [])[1] || '';
  const ts = Number((s.match(/"timestamp"\s*:\s*(\d{10,16})/) || [])[1] || 0);
  const sid = (s.match(/"sessionId"\s*:\s*"([^"]{1,64})"/) || [])[1] || '';
  return { id, mid, type, ts, sid };
}

export function lineKey(head, fd, off, len) {
  if (head.id) return 'i:' + head.id;
  if (head.mid) return 'm:' + head.type + ':' + head.mid + ':' + head.ts;
  const n = Math.min(256, len);
  const b = Buffer.alloc(n);
  fs.readSync(fd, b, 0, n, off);
  return 'h:' + crypto.createHash('sha1').update(b).digest('hex').slice(0, 16) + ':' + len;
}

/** 复制一行并把「组内任一旧 sessionId」全部等长替换成 keeperId */
function copyLine(inFd, outFd, off, len, fromIds, toId) {
  const cands = (fromIds || []).filter((x) => x && x !== toId).map((x) => Buffer.from(x));
  const toB = Buffer.from(toId || '');
  const usable = cands.filter((c) => c.length === toB.length);
  let done = 0;
  let carry = Buffer.alloc(0);
  const buf = Buffer.alloc(CH);
  const overlap = usable.length ? Math.max(...usable.map((c) => c.length)) - 1 : 0;
  while (done < len) {
    const n = fs.readSync(inFd, buf, 0, Math.min(CH, len - done), off + done);
    if (n <= 0) break;
    const chunk = Buffer.from(buf.subarray(0, n));
    if (!usable.length) {
      fs.writeSync(outFd, chunk, 0, chunk.length);
    } else {
      const joined = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      for (const c of usable) {
        let i = 0;
        while (i + c.length <= joined.length) {
          const k = joined.indexOf(c, i);
          if (k === -1) break;
          toB.copy(joined, k);
          i = k + c.length;
        }
      }
      const cut = Math.max(0, joined.length - overlap);
      fs.writeSync(outFd, joined, 0, cut);
      carry = Buffer.from(joined.subarray(cut));
    }
    done += n;
  }
  if (usable.length && carry.length) fs.writeSync(outFd, carry, 0, carry.length);
  fs.writeSync(outFd, Buffer.from([0x0a]));
}

export function mergeUnion(parts, keeperId, outFile, opts = {}) {
  const keeper = parts.find((p) => p.id === keeperId);
  if (!keeper) return { ok: false, error: 'keeper 不在副本列表内' };

  const infos = parts.map((p) => ({ ...p, ...scanLineRanges(p.file) }));
  const fds = new Map();
  const getFd = (f) => {
    if (!fds.has(f)) fds.set(f, fs.openSync(f, 'r'));
    return fds.get(f);
  };

  const picked = new Map(); // key -> {file, off, len, ts, src, idx}
  const perFile = new Map();
  let dup = 0;

  for (let s = 0; s < infos.length; s++) {
    const it = infos[s];
    const fd = getFd(it.file);
    const keys = [];
    let lastTs = 0;
    for (let i = 0; i < it.ranges.length; i++) {
      const [off, len] = it.ranges[i];
      const h = readLineHead(fd, off, len);
      const ts = h.ts || lastTs;
      lastTs = ts;
      const key = lineKey(h, fd, off, len);
      keys.push(key);
      const prev = picked.get(key);
      if (prev) {
        dup++;
        if (len > prev.len) picked.set(key, { file: it.file, off, len, ts, src: s, idx: i });
        continue;
      }
      picked.set(key, { file: it.file, off, len, ts, src: s, idx: i });
    }
    perFile.set(it.id, keys);
  }

  const items = [...picked.entries()].map(([k, v]) => ({ key: k, ...v }));
  items.sort((a, b) => a.ts - b.ts || a.src - b.src || a.idx - b.idx);

  const allIds = parts.map((p) => p.id);
  const tmp = outFile + '.merging';
  const outFd = fs.openSync(tmp, 'w');
  try {
    for (const it of items) {
      const fd = getFd(it.file);
      const h = readLineHead(fd, it.off, it.len);
      const ids = h.sid && !allIds.includes(h.sid) ? [...allIds, h.sid] : allIds;
      copyLine(fd, outFd, it.off, it.len, ids, keeperId);
    }
  } finally {
    fs.closeSync(outFd);
  }

  const check = scanLineRanges(tmp);
  if (check.ranges.length !== items.length) {
    fs.rmSync(tmp, { force: true });
    for (const fd of fds.values()) fs.closeSync(fd);
    return { ok: false, error: `写出 ${items.length} 行，实际 ${check.ranges.length} 行` };
  }
  const outKeys = new Set();
  {
    const fd = fs.openSync(tmp, 'r');
    for (const [off, len] of check.ranges) outKeys.add(lineKey(readLineHead(fd, off, len), fd, off, len));
    fs.closeSync(fd);
  }
  for (const [fid, keys] of perFile) {
    const miss = keys.filter((k) => !outKeys.has(k)).length;
    if (miss) {
      fs.rmSync(tmp, { force: true });
      for (const fd of fds.values()) fs.closeSync(fd);
      return { ok: false, error: `副本 ${String(fid).slice(0, 8)} 有 ${miss} 行未进入结果` };
    }
  }
  for (const fd of fds.values()) fs.closeSync(fd);

  const lastTs = items.length ? items[items.length - 1].ts : 0;
  fs.renameSync(tmp, outFile);
  return { ok: true, lines: check.ranges.length, dup, bytes: fs.statSync(outFile).size, lastTs };
}
