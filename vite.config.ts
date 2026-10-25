import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // fnOS 版：飞牛桌面入口走 /cgi/ThirdParty/wbconsole/index.cgi/ 前缀，
  // 资源必须用相对路径，否则浏览器会去请求 /assets/*（404 → 白屏）
  base: './',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,
    /**
     * 必须显式写 IPv4 回环。不写时 Vite 用 `localhost`，而 Node 在启用 IPv6 的机器上
     * 会把它解析成 `::1` 并且**只绑那一个** —— 于是 `http://127.0.0.1:5174` 直接连接被拒，
     * 只有 `http://localhost:5174` 能打开（实测踩过）。
     * 绑定范围仍是回环，与"绝不暴露到局域网"的约定一致（别改成 `true`，那会绑 0.0.0.0）。
     */
    host: '127.0.0.1',
    proxy: {
      '/api': 'http://127.0.0.1:57891',
    },
  },
});
