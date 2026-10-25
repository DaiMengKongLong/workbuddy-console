<p align="center">
  <img src="fpk/assets/icon-source.png" alt="WorkBuddy 控制台 · 飞牛 fnOS 版" width="128" />
</p>

# WorkBuddy 控制台 · 飞牛 fnOS 版

> 把 **WorkBuddy 账号管理**、**多平台免费模型广场**、**积分统计**、**每日签到与成长中心**、**反向代理** 收进飞牛 fnOS 的一个应用里。

**当前版本：v0.2.42**

本仓库的 `fnos` 分支是**飞牛 fnOS（fnOS 应用中心）专用版本**，与上游
[walter-io/workbuddy-console](https://github.com/walter-io/workbuddy-console) 的 Windows / macOS
桌面版**不是同一个东西**：上游发的是 `.exe` / `.dmg`，这里发的是飞牛安装包 `.fpk`。

- 上游桌面版源码与 Release 镜像：`main` 分支
- 飞牛 fnOS 版源码：`fnos` 分支（本文件）
- 飞牛版安装包 Release：`[fnos-v0.2.42](https://github.com/DaiMengKongLong/workbuddy-console/releases/tag/fnos-v0.2.42)`

---

## 一、安装

1. 到 [fnos-v0.2.42 Release](https://github.com/DaiMengKongLong/workbuddy-console/releases/tag/fnos-v0.2.42)
   下载 `wbconsole-0.2.42-x86.fpk`；
2. 飞牛桌面 → **应用中心** → 右上角「设置」→「**手动安装应用**」→ 选择该 `.fpk`；
3. 装完点「启用」，再从桌面打开即可。

- 服务端口：**57891**（被占用时自动顺延 57892）
- 桌面入口：`/cgi/ThirdParty/wbconsole/index.cgi/`
- 运行时：安装包**内置 Node.js v22**，不依赖应用中心的 nodejs 组件，也不需要预装任何东西
- 数据目录：`/var/apps/wbconsole/var/`（配置在 `data/config`，账号库在 `home/.wb-switch`）

> ⚠️ 飞牛应用中心不支持第三方应用原地覆盖升级。**升版本请先卸载再安装**（数据不会丢）。
> 小版本迭代也可以直接在应用界面里点「一键更新并重启」，见下节。

## 二、一键热更新（v0.2.33 起）

设置页出现新版本时，点 **「一键更新并重启」** 即可完成升级：

1. 服务端自动从 GitHub Release 下载热更新包（`-hotupdate.tar.gz`，约 0.6 MB）；
2. sha256 校验（比对 GitHub 资产自带的 digest）；
3. 旧版本自动备份到数据盘 `var/backup/`（保留最近 3 份）；
4. 就地替换 `server/` `dist/` `package.json` `ui/` 并重启服务。

**不需要下载 .fpk，也不需要到应用中心卸载重装。** 任一步失败会自动回滚到备份版本。

> 下载走的是 `api.github.com` 的资产端点：实测飞牛 NAS 常常连不上 `github.com`，
> 但 `api.github.com` 可达，绕开这一步更新必然失败。

## 三、功能（全部沿用上游官方实现）

- **账号管理**：扫码登录 / 手动添加、凭据维护、账号展示
- **免费模型广场**：OpenRouter、硅基流动、魔搭、Groq、Agnes、ZenMux、Cerebras、NVIDIA、Mistral、智谱、GitHub、Google AI …
- **反向代理**：OpenAI Chat / Anthropic Messages / Responses / Gemini 原生四种协议
- **积分统计**、**每日签到与成长中心**、**通知与错误日志**、**网络代理**

### 相对上游桌面版删除的部分

fnOS 上没有桌面客户端，以下功能整块移除：本机 WorkBuddy 进程管理（启动/停止/重启）、
Token 统计（依赖本机会话日志）、会话复制与去重、登录态与目录权限自检、登录态备份恢复、
「当前登录态 / 导入登录态 / 检测 WorkBuddy 运行」相关 UI。

## 四、构建

```bash
npm install            # 完整依赖
npm run build          # 前端 vite 构建 → dist/
npm run fpk            # 打包 → dist-fpk/wbconsole-<version>-x86.fpk
npm run hotupdate      # 生成热更新包 → dist-fpk/wbconsole-fnos-<version>-hotupdate.tar.gz
```

打包时需要官方的 `fnpack`（已放在 `tools/fnpack`）。常用开关：

| 环境变量 | 作用 |
| --- | --- |
| `SKIP_BUILD=1` | 跳过前端构建，直接用现有 `dist/` |
| `SKIP_DEPS=1` | 复用 `fpk/app/node_modules`，不重装 |
| `CLEAN_DEPS=1` | 强制清理并重装生产依赖 |
| `BUNDLE_NODE=1` | 把 Node 运行时打进包（默认行为，装完零依赖） |
| `INCLUDE_DEPS=1` | 热更新包里也带上 `node_modules` |

### 图标与飞牛的缓存坑

飞牛客户端会**缓存图标**，重装同名应用不会自动刷新。因此 `fpk/make-icons.mjs` 每次发版都会：

- 生成 `ICON.PNG`（1024×1024）、`ICON_256.PNG`（256×256）—— 应用中心读这两个；
- 生成带版本后缀的副本 `ui/images/icon_{64,256}_<版本号去点>.png`，并把
  `ui/config` 的 `icon` 指向它 —— 缓存键变了，客户端才会重新拉图。

改版本号时这两步会自动跟着变，不用手动处理。

## 五、常见问题

**应用中心「启用」提示端口被占用**
`cmd/main` 在启动前会先 `fuser -k` 清掉占着 57891 的残留进程（应用中心以 root 运行，必杀得掉），
失败才降级到 57892。若仍报错，可在 NAS 上执行 `sudo fuser -k 57891/tcp` 后再启用。

**桌面图标打开是白屏**
飞牛网关是**文件型 CGI**，必须有 `<应用目录>/target/ui/index.cgi`。热更新包已包含 `ui/`，
若手动替换过文件请确认 `ui/index.cgi` 与 `ui/config` 都在。

## 六、许可

MIT。上游项目同样为 MIT，版权归原作者所有；飞牛 fnOS 适配部分见提交历史。
