import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { installErrorCapture, pushError } from './lib/errlog';
import './index.css';

// 先装全局错误捕获再挂载应用：启动阶段的异常也能被记录（设置页「界面错误日志」可查看）
installErrorCapture();

/**
 * 渲染兜底：某个页面的渲染异常不应让整个应用白屏。
 * React 没有默认的错误边界——一旦渲染抛错整棵树卸载，用户只会看到一片空白；
 * 这里兜住后给出「重试 / 刷新」，并把堆栈记入设置页的错误日志。
 */
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    pushError({
      kind: 'error',
      message: `渲染异常：${error.message}`,
      detail: info.componentStack ? String(info.componentStack).slice(0, 2000) : undefined,
    });
    // 自动恢复：渲染异常多半来自旧版 JS 缓存/瞬时状态，自动刷新一次即可恢复；
    // 10 秒内只自动刷新一次，避免错误循环时反复刷屏（仍保留手动「重试/刷新」按钮）。
    try {
      const last = Number(sessionStorage.getItem('render-reload-at') || 0);
      if (Date.now() - last > 10000) {
        sessionStorage.setItem('render-reload-at', String(Date.now()));
        setTimeout(() => location.reload(), 600);
      }
    } catch {
      /* 隐私模式下 sessionStorage 不可用：跳过自动刷新 */
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="h-full flex items-center justify-center p-8">
          <div className="max-w-md w-full rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm text-center">
            <div className="text-sm font-medium text-zinc-800">界面渲染出错了</div>
            <div className="mt-1.5 text-xs text-zinc-400 leading-relaxed break-words">{this.state.error.message}</div>
            <div className="mt-4 flex justify-center gap-2">
              <button
                onClick={() => this.setState({ error: null })}
                className="h-8 px-3 rounded-xl text-xs font-medium text-zinc-700 border border-zinc-200 bg-white hover:bg-zinc-50"
              >
                重试
              </button>
              <button
                onClick={() => location.reload()}
                className="h-8 px-3 rounded-xl text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-700"
              >
                刷新页面
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
