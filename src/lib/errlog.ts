/**
 * 界面错误日志。
 *
 * 捕获未处理的 JS 异常与 Promise 拒绝，落盘到 localStorage（最多 200 条），
 * 设置页可直接查看、复制、清空——反馈问题时能贴出真实堆栈，而不是"点了没反应"。
 * 与提示存档一样，仅存本机，且对 localStorage 不可用的情况静默降级。
 */

export interface ErrorItem {
  at: number;
  kind: 'error' | 'rejection';
  message: string;
  detail?: string;
  source?: string;
}

const KEY = 'wbhub.errorlog';
const MAX = 200;

function safeRead(): ErrorItem[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x) => x && typeof x.message === 'string') : [];
  } catch {
    return [];
  }
}

function safeWrite(items: ErrorItem[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    /* 存档不可用时不阻塞主流程 */
  }
}

export function pushError(item: Omit<ErrorItem, 'at'>) {
  const items = safeRead();
  const last = items[0];
  // 同一错误连续触发（如渲染循环）只记一条，避免把日志冲爆
  if (last && last.message === item.message && last.detail === item.detail && Date.now() - last.at < 3000) return;
  items.unshift({ ...item, at: Date.now() });
  safeWrite(items.slice(0, MAX));
}

export function readErrors(): ErrorItem[] {
  return safeRead();
}

export function clearErrors() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* 忽略 */
  }
}

export const ERROR_MAX = MAX;

/** 安装全局捕获；重复调用无副作用（返回卸载函数） */
export function installErrorCapture() {
  const onError = (e: ErrorEvent) => {
    pushError({
      kind: 'error',
      message: e.message || '未知错误',
      detail: e.error?.stack ? String(e.error.stack).slice(0, 2000) : undefined,
      source: `${e.filename || ''}:${e.lineno || 0}:${e.colno || 0}`,
    });
  };
  const onRejection = (e: PromiseRejectionEvent) => {
    const r = e.reason;
    pushError({
      kind: 'rejection',
      message: r?.message || String(r ?? '未处理的 Promise 拒绝'),
      detail: r?.stack ? String(r.stack).slice(0, 2000) : undefined,
    });
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
