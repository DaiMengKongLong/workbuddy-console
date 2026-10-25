// 飞牛统一网关 CGI 桥接：/cgi/ThirdParty/wbconsole/index.cgi/*  →  127.0.0.1:<service_port>/*
// 由 app/ui/index.cgi 调用（标准 CGI 环境变量 + stdin/stdout）
import http from 'node:http';

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    };
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    // GET 没有 body 时某些 CGI 容器不关闭 stdin，兜底超时
    setTimeout(finish, 1500).unref?.();
  });
}

import fs from 'node:fs';

const env = process.env;
// 端口优先级：环境变量 → cmd/main 落地的实际端口文件 → service_port → 57891
function resolvePort() {
  if (env.WBCONSOLE_PORT) return env.WBCONSOLE_PORT;
  const candidates = [
    `${env.TRIM_PKGVAR || ''}/run/port`,
    '/var/apps/wbconsole/var/run/port',
  ].filter(Boolean);
  for (const f of candidates) {
    try {
      const v = fs.readFileSync(f, 'utf8').trim();
      if (v) return v;
    } catch {}
  }
  return env.TRIM_SERVICE_PORT || '57891';
}
const port = resolvePort();
const method = env.REQUEST_METHOD || 'GET';
/**
 * 解析目标路径。
 * 关键点：飞牛的 CGI 实现不一定设置 PATH_INFO。若只认 PATH_INFO，
 * 子路径（/assets/*.js、/api/*）会全部被当成 `/`，返回首页 HTML → 浏览器拿到
 * 「内容是 HTML 的 JS」→ 白屏。因此按下列顺序兜底：
 *   1) PATH_INFO（标准 CGI）
 *   2) REQUEST_URI / DOCUMENT_URI / HTTP_X_ORIGINAL_URI（nginx fastcgi 常见）
 *      —— 从完整 URI 里截掉 `.../index.cgi` 之后的部分
 *   3) 都没有 → '/'
 */
const CGI_NAME = '/index.cgi';
function resolveTarget() {
  if (env.PATH_INFO) {
    const p = env.PATH_INFO;
    return p.startsWith('/') ? p : `/${p}`;
  }
  const uri = env.REQUEST_URI || env.DOCUMENT_URI || env.HTTP_X_ORIGINAL_URI || env.REDIRECT_URL || '';
  if (uri) {
    const clean = uri.split('?')[0];
    const i = clean.indexOf(CGI_NAME);
    const rest = i >= 0 ? clean.slice(i + CGI_NAME.length) : clean;
    if (rest && rest !== '/') return rest;
    return '/';
  }
  return '/';
}
const target = resolveTarget();
// query：优先 REQUEST_URI 自带的，其次 QUERY_STRING
let query = '';
const uriForQuery = env.REQUEST_URI || env.DOCUMENT_URI || '';
if (uriForQuery.includes('?')) query = `?${uriForQuery.split('?').slice(1).join('?')}`;
else if (env.QUERY_STRING) query = `?${env.QUERY_STRING}`;

// 收集请求头（HTTP_* → 真实头名）
const headers = {};
if (env.CONTENT_TYPE) headers['content-type'] = env.CONTENT_TYPE;
const skip = new Set(['host', 'connection', 'content-length', 'content-type', 'expect']);
for (const [k, v] of Object.entries(env)) {
  if (!k.startsWith('HTTP_')) continue;
  const name = k.slice(5).toLowerCase().replace(/_/g, '-');
  if (skip.has(name)) continue;
  headers[name] = v;
}

const body = ['GET', 'HEAD'].includes(method) ? Buffer.alloc(0) : await readStdin();
if (body.length) headers['content-length'] = String(body.length);
else delete headers['content-length'];

await new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port: Number(port), path: target + query, method, headers }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      const buf = Buffer.concat(chunks);
      const out = [`Status: ${res.statusCode} ${res.statusMessage || ''}`];
      for (const [k, v] of Object.entries(res.headers)) {
        if (['connection', 'transfer-encoding', 'content-length'].includes(k)) continue;
        const val = Array.isArray(v) ? v.join(', ') : v;
        out.push(`${k}: ${val}`);
      }
      out.push('Content-Length: ' + buf.length, '');
      process.stdout.write(Buffer.from(out.join('\r\n') + '\r\n'));
      process.stdout.write(buf);
      resolve();
    });
  });
  req.on('error', (e) => {
    const msg = `WorkBuddy 控制台未运行或端口 ${port} 不可达：${e.message}`;
    const buf = Buffer.from(`<html><body><h3>502</h3><p>${msg}</p></body></html>`);
    process.stdout.write(Buffer.from(`Status: 502 Bad Gateway\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${buf.length}\r\n\r\n`));
    process.stdout.write(buf);
    resolve();
  });
  if (body.length) req.write(body);
  req.end();
});
