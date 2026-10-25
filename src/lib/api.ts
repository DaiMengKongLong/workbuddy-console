/**
 * API 层。当前走 HTTP（本地 Express 服务）。
 * 未来桌面化（Tauri）时在此切换为 invoke 通道，页面代码无需改动。
 */

/** 默认超时：避免服务假死/代理挂起时请求永不返回，界面一直转圈 */
export const TIMEOUT = {
  default: 25_000,
  /** 模型列表：平台返回可能较大 */
  models: 60_000,
  /** 额度：需要并发查询多个平台 */
  quota: 90_000,
  /** 统计：首次冷扫描需要遍历全部会话日志，可能超过 1 分钟 */
  stats: 300_000,
  /** 积分统计：需要逐账号分页扫官方用量接口，30 天窗口较慢 */
  credits: 240_000,
  /**
   * 扫码登录（start / status）：服务端在这条链路上要落盘账号，而本机写盘可能被
   * 外部进程拦几十秒（写盘重试最坏 36 秒）。沿用 25 秒默认值会把「仍在正常等待」
   * 误报成「超时失败」（2026-10-25 反馈），故单独放宽到 60 秒。
   */
  oauth: 60_000,
  /**
   * 写配置类操作（重新生成 Key、切代理开关、保存设置）：服务端要落盘 config.json，
   * 本机写盘重试最坏 36 秒。服务端已改异步落盘（不再冻结其它请求），但本次请求本身
   * 仍要等写完，所以前端也必须给足时间，否则「已经保存成功」会被报成超时。
   */
  write: 60_000,
  /**
   * 切换账号/复制会话：单会话体积可达几十 MB，且要先优雅退出 WorkBuddy 再重启，
   * 大批量复制 + 进程启停全程可能超过 1 分钟。此前沿用 25 秒默认值，
   * 实测（0.2.2）复制几十个会话必然超时中断，但服务端其实还在继续干活。
   */
  switch: 600_000,
} as const;

export type ApiFailure = Error & { offline?: boolean; status?: number };

/** 是否为「连不上本地服务」类错误（区别于服务端返回的业务错误） */
export const isOffline = (e: unknown): boolean => !!(e as ApiFailure)?.offline;

const fail = (message: string, offline: boolean, status?: number): ApiFailure => {
  const err = new Error(message) as ApiFailure;
  err.offline = offline;
  err.status = status;
  return err;
};

export async function api<T = unknown>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const { timeoutMs = TIMEOUT.default, ...rest } = init || {};
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let res: Response;
  try {
    // fnOS 版：相对路径（走网关前缀时不会去打 /api/* 的绝对路径）
    res = await fetch(path.replace(/^\//, ''), {
      headers: { 'Content-Type': 'application/json' },
      ...rest,
      signal: ctrl.signal,
    });
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      throw fail(`本地服务响应超时（${Math.round(timeoutMs / 1000)} 秒未返回），已中断请求`, true);
    }
    throw fail('无法连接本地服务，请确认 workbuddy控制台的服务正在运行', true);
  } finally {
    clearTimeout(timer);
  }

  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* 非 JSON 响应 */
  }
  if (!res.ok) {
    // 502/503/504 通常意味着本地服务进程已退出（被代理兜住），按「离线」处理
    const offline = res.status === 502 || res.status === 503 || res.status === 504;
    throw fail(body?.error || `请求失败（HTTP ${res.status}）`, offline, res.status);
  }
  return body as T;
}

export const get = <T = unknown>(path: string, init?: RequestInit & { timeoutMs?: number }) => api<T>(path, init);
export const post = <T = unknown>(path: string, body?: unknown, init?: RequestInit & { timeoutMs?: number }) =>
  api<T>(path, { method: 'POST', body: body != null ? JSON.stringify(body) : undefined, ...init });
export const put = <T = unknown>(path: string, body?: unknown, init?: RequestInit & { timeoutMs?: number }) =>
  api<T>(path, { method: 'PUT', body: body != null ? JSON.stringify(body) : undefined, ...init });
export const patch = <T = unknown>(path: string, body?: unknown, init?: RequestInit & { timeoutMs?: number }) =>
  api<T>(path, { method: 'PATCH', body: body != null ? JSON.stringify(body) : undefined, ...init });
export const del = <T = unknown>(path: string, init?: RequestInit & { timeoutMs?: number }) => api<T>(path, { method: 'DELETE', ...init });
