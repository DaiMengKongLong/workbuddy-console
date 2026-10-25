# WorkBuddy 控制台 · 飞牛 fnOS 版

基于上游 [walter-io/workbuddy-console](https://github.com/walter-io/workbuddy-console) v0.2.16 **完整源码**做减法而来，
不是重写：接口契约、协议转换、平台适配、前端页面全部沿用官方实现。

## 做了哪些减法

| 删除的文件 / 目录 | 原功能 | 删除原因 |
| --- | --- | --- |
| `server/targets/` | 退出 / 重启本机 WorkBuddy 进程、exe 探测 | fnOS 无桌面客户端 |
| `server/stats/` | Token 统计（扫本机会话日志） | 无 `~/.workbuddy` 日志 |
| `server/workbuddy/sessions.mjs` | 会话复制 / 同步 / 去重 | 依赖本机 `workbuddy.db` |
| `server/workbuddy/diagnostics.mjs` | 登录态与目录权限自检 | 无本机登录态 |
| `server/workbuddy/backups.mjs` | 登录态备份与恢复 | 无本机登录态 |
| `server/workbuddy/modelLimits.mjs` | 超限探测（依赖 sessions） | 连带删除 |
| `electron/`、`build/`、`deploy-windows/`、`*.cmd` | 桌面壳与 Windows 部署脚本 | fnOS 不需要 |
| `src/pages/StatsPage.tsx` | Token 统计页 | 同上 |

路由层面（`tools/slim.mjs` 自动执行，可重复运行）：
- 整块删除 19 个顶层路由：`/api/workbuddy/*`（status/loaded/load/remove/restart/stop/detect/permissions/backups）、`/api/stats`、`/api/sessions*`、`/api/diag/tail`
- 大块内部子路径（`/api/accounts/switch`、`/api/accounts/import`）改为直接返回 410
- `auth.mjs` 降级为 stub：`detectCurrentAccount()` 恒空、`syncTokensToAuthFile()` 跳过
- 前端 `App.tsx` 移除 Token 统计入口、「WorkBuddy 运行状态」、「当前登录态」展示

## 保留的能力（全部为官方实现）

账号管理 · 扫码登录（OAuth state/token/account）· 凭据维护 · 积分统计 · 每日签到与成长中心 ·
免费模型广场（OpenRouter / 硅基流动 / 魔搭 / Groq / Agnes / ZenMux / Cerebras / NVIDIA / Mistral / 智谱 / GitHub / Google AI …）·
反向代理四协议（OpenAI Chat / Anthropic Messages / Responses / Gemini 原生，含 11128 风控净化）· 网络代理 · 通知与日志

## fnOS 适配

- 端口 **57891**（被占用时 cmd/main 自动顺延，CGI 桥接读 `var/run/port` 跟随）
- `cmd/main` 设置 `HOME=$TRIM_PKGVAR/home`、`FREE_TOKEN_CONFIG_DIR`，数据不依赖系统 home
- 桌面入口：`type: iframe` + `/cgi/ThirdParty/wbconsole/index.cgi/`；`ui/index.cgi` → `server/cgi-bridge.mjs` 桥接到本机服务
- 运行时：应用中心 Node.js v22（`install_dep_apps = nodejs_v22`）
- 自动打开浏览器默认关闭（服务器环境无浏览器）

## 构建

```bash
npm install            # 完整依赖
npm run build          # 前端 vite 构建 → dist/
npm run fpk            # 打包 → dist-fpk/wbconsole-<version>-x86.fpk
```

本机 npm 若被环境拖慢，可在 NAS 上构建前端后拉回 `dist/` 再打包：
```bash
SKIP_BUILD=1 npm run fpk      # 跳过前端构建，直接用现有 dist/
SKIP_DEPS=1 npm run fpk       # 复用 fpk/app/node_modules，不重装
CLEAN_DEPS=1 npm run fpk      # 强制清理并重装生产依赖
```

## 安装

飞牛桌面 → 应用中心 → 右上角「设置」→「手动安装应用」→ 选择 `.fpk`。
数据目录：`/var/apps/wbconsole/var/`（配置在 `data/config`，账号库在 `home/.wb-switch`）。
