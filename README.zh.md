# dsh-balance

[![npm 包](https://img.shields.io/badge/npm-%40andrecgoncalves%2Fdsh--balance-cb3837?logo=npm&logoColor=white)](https://www.npmjs.com/package/@andrecgoncalves/dsh-balance)
[![GitHub 发布](https://img.shields.io/github/v/release/andregoncalves/dsh-balance?sort=semver&color=4D6BFE)](https://github.com/andregoncalves/dsh-balance/releases)
[![CI](https://github.com/andregoncalves/dsh-balance/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/andregoncalves/dsh-balance/actions/workflows/ci.yml)
[![许可证：MIT](https://img.shields.io/badge/license-MIT-3da639.svg)](LICENSE)
[![node >= 22.18](https://img.shields.io/badge/node-%E2%89%A5%2022.18-43853d?logo=node.js&logoColor=white)](https://nodejs.org)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)

[English](README.md) | **中文**

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：在输入框下方状态条的最右端（上下文百分比指示器之后），显示**当前活跃模型所属服务商的账户余额**，并保持实时刷新。

这个余额胶囊是**感知服务商的**：它会读取当前会话所选的模型，显示对应服务商的余额，并在你切换模型时自动跟着切换。

在 DeepSeek 上，胶囊还会跟踪**高峰 / 空闲计费时段**——状态圆点在 DeepSeek 高峰时段内变红，空闲时段变绿（此时请求按半价计费）。详见 [DeepSeek 高峰 / 空闲时段](#deepseek-高峰--空闲时段)。

<p align="center">
  <img src="assets/providers.png" alt="余额胶囊在 DeepSeek、OpenRouter、Moonshot/Kimi、Zhipu/GLM 和 MiniMax 下的渲染效果" width="720">
</p>

## 目录

- [为什么选择 dsh-balance？](#为什么选择-dsh-balance)
- [轻量设计](#轻量设计)
- [亮点](#亮点)
- [截图](#截图)
- [支持的服务商](#支持的服务商)
  - [DeepSeek 高峰 / 空闲时段](#deepseek-高峰--空闲时段)
- [安装](#安装)
- [配置](#配置)
- [无需账号预览（mock 模式）](#无需账号预览mock-模式)
- [实现原理](#实现原理)
- [开发](#开发)
- [故障排查](#故障排查)
- [常见问答](#常见问答)
- [更新日志](#更新日志)
- [许可证](#许可证)

## 为什么选择 dsh-balance？

- **感知服务商，不止 DeepSeek。** 它会跟随**当前活跃模型所属的服务商**，覆盖 DeepSeek、OpenRouter、Moonshot/Kimi、Zhipu/GLM 与 MiniMax——切换模型时胶囊立即切换。
- **只做一件事的最小实现。** 没有设置面板、没有费用估算、没有额外服务。一条路由，一个胶囊，gzip 后约 11 kB。
- **对核心零侵入。** 一个树外包，注册到已声明的插槽，不会修改或 fork Harness 源码中的任何文件。

## 轻量设计

`dsh-balance` 刻意保持极简，不给 Harness 增加任何机制：

| | |
|---|---|
| **运行时依赖** | **零** —— `dependencies: {}`；唯一的 import 是 `@deepseek-ai/*` 平台模块与 React，均由运行中的 Harness 以可选 peer 提供 |
| **产物体积** | 宿主端 **约 8 kB**（gzip 3.1 kB）+ 浏览器端 **约 23 kB**（gzip 8.1 kB）→ **gzip 合计约 11 kB** |
| **Harness 接触面** | **一条**精确路由（`GET /plugins/balance`）与已声明 `conversation.composer.dock` 插槽中的**一个**组件 |
| **核心补丁** | **无** —— 不 fork 文件、不修补核心 CSS；插件只从自己的 DOM 锚点设置自己那一行底栏的样式 |
| **后台任务** | 无 —— 没有数据库、没有 worker、没有遥测、没有全局状态；每个胶囊只有一个 `setInterval`，卸载时清除 |
| **生命周期** | 路由通过 `ctx.effect` 注册，卸载时自动回收；模型目录订阅会取消订阅；卸载插件后不会留下任何残留 |
| **故障隔离** | 缺少密钥或上游出错时降级为灰色胶囊，绝不会阻塞会话或界面 |

> **无需配置，也无需清理。** 安装后唯一的变化是输入框下方状态条多了一枚胶囊；卸载后 Harness 与原来完全一致。

## 亮点

- **一个胶囊，五家服务商。** DeepSeek、OpenRouter、Moonshot/Kimi、Zhipu/GLM（Z.ai）与 MiniMax——各自带有品牌图标、货币单位与悬停明细。
- **首页也显示。** 空会话时胶囊位于输入框工具行（模型选择器旁）；发送第一条消息时它会动画飞入下方状态条。
- **感知服务商。** 切换活跃模型，胶囊立即切换到对应服务商的余额。
- **在 DeepSeek 上感知高峰/空闲。** 状态圆点在 DeepSeek 高峰计费时段（周一至周五，北京时间 09:00–12:00 与 14:00–18:00）变红，空闲时段变绿（此时请求按半价计费）。悬停面板会把这些时段换算为您的系统时区（带 AM/PM 标签），并显示实时倒计时——高峰时显示 `off-peak in 1h 20m`，空闲时段最后一小时内显示 `peak in 45m`。详见 [DeepSeek 高峰 / 空闲时段](#deepseek-高峰--空闲时段)。
- **密钥永不进入浏览器。** 由宿主端解析凭证并请求服务商，浏览器只会看到归一化后的余额数据。
- **实时更新。** 每 60 秒自动刷新，点击刷新，会话变化时刷新，模型所属服务商变化时立即刷新。
- **优雅降级。** 缺少密钥或上游出错时，显示灰色的 `Balance —` 胶囊，原因写在悬停提示里，不会破坏布局。
- **无需账号即可预览。** 内置 mock 模式，可为任意服务商渲染出逼真的余额。

## 截图

> 下图为 0.5.0 之前的侧边栏布局；自 0.5.0 起，胶囊位于输入框下方状态条的最右端。

<table>
  <tr>
    <td align="center"><img src="assets/sidebar-light.png" alt="浅色主题侧边栏，底部显示余额胶囊" width="260"></td>
    <td align="center"><img src="assets/sidebar-dark.png" alt="深色主题侧边栏，底部显示余额胶囊" width="260"></td>
  </tr>
  <tr>
    <td align="center"><sub>浅色主题</sub></td>
    <td align="center"><sub>深色主题</sub></td>
  </tr>
</table>

<p align="center">
  <img src="assets/footer.png" alt="侧边栏底部：左侧是设置按钮，右侧是余额胶囊" width="420">
</p>

## 支持的服务商

| 活跃模型路由 | 显示的余额 | 数据来源 |
|---|---|---|
| `deepseek`、`deepseek-official` | DeepSeek 账户余额（原币种） | `api.deepseek.com/user/balance` |
| `openrouter` | 剩余额度（`total_credits − total_usage`，美元） | `openrouter.ai/api/v1/credits` |
| `moonshotai`、`moonshotai-cn` | 可用余额（美元，现金 + 代金券） | `api.moonshot.ai` / `api.moonshot.cn` 的 `/v1/users/me/balance` |
| `zai`、`zai-coding-cn`、`zhipu` | 账户余额（默认人民币） | `open.bigmodel.cn` / `api.z.ai` 账户报表 |
| `minimax`、`minimax-cn` | Token 套餐剩余额度（次数或百分比） | `minimax.io` / `api.minimaxi.com` 的 `/v1/token_plan/remains` |
| 其他任意路由 | DeepSeek 余额 | 与 `deepseek` 行相同 |

映射刻意保持克制：插件不认识的路由（包括自定义服务商 id）会回退到 DeepSeek 余额，而不是让胶囊报错。

### 胶囊显示什么

- **`[品牌图标] $9.74 ●`** —— 服务商图标、金额，然后是状态圆点。
- **状态圆点** —— DeepSeek 标记高峰/空闲计费时段（绿色 = 空闲，红色 = 高峰；详见 [DeepSeek 高峰 / 空闲时段](#deepseek-高峰--空闲时段)）。OpenRouter、Moonshot、Zhipu 和 MiniMax 标记剩余余额或额度是否为正（绿色 = 有余额，红色 = 已耗尽）。
- **悬停提示** —— 与 DSH 风格一致的浮层：完整明细（例如 `Total $42.50 · Granted $5.00 · Topped up $37.50`）、以您的系统时区显示的峰谷时段（AM/PM 标签），以及到下一个计费边界的倒计时。
- **点击** —— 立即刷新。
- **错误** —— 灰色 `Balance —` 胶囊；悬停查看原因，点击重试。
- **紧凑设计** —— 胶囊与活动、用量、上下文指示器处于同一行高，只占用自身内容所需的宽度，且从不隐藏金额。
- 状态条只在会话的输入框视图中渲染；首页上胶囊位于输入框工具行，首次发送时会动画飞入状态条。

### DeepSeek 高峰 / 空闲时段

DeepSeek 的**空闲时段价格为高峰时段的一半**。胶囊通过状态圆点反映当前时段；判断基于 UTC 时间，因此与你的本地时区无关：

| 时段 | 时间 |
|---|---|
| **高峰** —— 红点 | **周一至周五**，北京时间（UTC+8）**09:00–12:00** 与 **14:00–18:00**，即 **01:00–04:00** 与 **06:00–10:00 UTC** |
| **空闲** —— 绿点 | 其余所有时间，**包括整个周末**，按高峰价的 5 折计费 |

来源：[DeepSeek API —— 模型 & 价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing) 脚注 (1)：「空闲时段价格为高峰时段价格的一半。高峰时段为北京时间周一至周五 9:00 - 12:00、14:00 - 18:00（其余为空闲时段）。」

**在这五家服务商中，只有 DeepSeek 有固定的高峰 / 空闲时段。** 其他服务商没有按时段定价，因此它们的圆点表示余额 / 额度，而不是计费时段：

| 服务商 | 按时段定价？ | 实际采用的计费方式 |
|---|---|---|
| DeepSeek | **有** —— 周一至周五为高峰，空闲时段半价 | —— |
| OpenRouter | 无 | 透传上游价格，另加平台手续费 |
| Moonshot / Kimi | 无 | 固定 token 单价，含缓存折扣 |
| Zhipu / GLM（Z.ai） | 无 | 目录价，偶有限时促销 |
| MiniMax | 无 | 固定 token 单价（M3 永久 5 折），另有可选的 1.5× 优先档 |

## 安装

前置条件：带有 web profile 的 DeepSeek Harness（`dsh web`）以及 Node.js ≥ 22.18。

> 插件是自包含的：不需要额外服务、不需要配置文件、不需要核心补丁。安装只会新增一个依赖和状态条中的一枚胶囊。

### 从 npm 安装

```sh
pnpm dsh plugin --profile web add @andrecgoncalves/dsh-balance
```

### 从 GitHub 安装

```sh
pnpm dsh plugin --profile web add github:andregoncalves/dsh-balance
```

该包会在安装时自行构建（`prepare` → `pnpm run build`），因此无需把 `lib/` 提交到仓库。

### 从本地克隆安装（开发用）

```sh
git clone https://github.com/andregoncalves/dsh-balance.git
cd dsh-balance
pnpm install
pnpm run build
pnpm dsh plugin --profile web add link:"$PWD"
```

请使用 `link:` 而不是 `file:`：普通 `file:` 依赖使用硬链接，在原子化重建时会失效。

### 这一行是如何接入的

本包声明了 **`dsh.bundle`**，因此 `dsh plugin add` 会自动把它追加到 profile 的 `dsh.profile.bundles`，并由包内自带的 `cordis.patch.yml` 插入插件那一行——**无需手动修改补丁文件**。首次安装后刷新一次浏览器，让启动清单（`window.__DSH_BOOT__`）识别新增的行；之后源码改动会重建并热替换。

<details>
<summary>手动管理 profile（或使用忽略 <code>dsh.bundle</code> 的旧版 <code>dsh</code>）</summary>

把该 bundle 加入 `~/.dsh/profiles/web/package.json`：

```json
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@andrecgoncalves/dsh-balance"] } }
```

bundle 的补丁随后会插入该行。如果你更希望把它当作普通依赖，可以不走 `dsh.bundle`，而是自己在 `~/.dsh/profiles/web/cordis.patch.yml` 中加入：

```yaml
- insert:
    - id: dsh-balance
      name: "@andrecgoncalves/dsh-balance"
```

两种方式中，`id` 都是插件内部的 Cordis 名称，保持 `dsh-balance` 不变；`name` 是已安装的包名。

</details>

### 验证

```sh
curl http://127.0.0.1:3080/plugins/balance                    # DeepSeek
curl "http://127.0.0.1:3080/plugins/balance?kind=openrouter"  # OpenRouter
curl "http://127.0.0.1:3080/plugins/balance?kind=moonshot"    # Moonshot / Kimi
curl "http://127.0.0.1:3080/plugins/balance?kind=zhipu"       # Zhipu / GLM
curl "http://127.0.0.1:3080/plugins/balance?kind=minimax"     # MiniMax
```

每个接口返回 `{"ok":true,"provider":"…","balance":{…}}`；当凭证缺失时返回 `{"ok":false,"error":"no-key","message":"…"}`。

## 配置

DeepSeek 通过 Harness 的**凭证接缝**解析 `DEEPSEEK_API_KEY`（例如 `~/.dsh/.credentials.yaml`）。其他服务商优先走凭证接缝，然后回退到启动环境（进程环境、调用项目目录下的 `.env`，最后是 Harness 主目录的 `.env`）。

| 服务商 | 依次尝试的凭证名 |
|---|---|
| DeepSeek | `DEEPSEEK_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Moonshot / Kimi | `MOONSHOT_API_KEY` |
| Zhipu / GLM | `ZAI_API_KEY`、`GLM_API_KEY`、`ZHIPU_API_KEY` |
| MiniMax | `MINIMAX_API_KEY`、`MINIMAX_CN_API_KEY`、`MINIMAX_API_TOKEN` |

若要与模型适配器共用同一套凭证，请把密钥写入 `~/.dsh/.credentials.yaml`，并为该路由添加 `apiKeyEnv`。Zhipu 的账户接口要求密钥原样传递（不加 `Bearer` 前缀），宿主会自动选择正确的认证方式。Moonshot 与 Zhipu 在两个区域主机之间互为镜像，只对其中一个站点有效的密钥会先尝试另一个站点，之后才报告失败。

## 无需账号预览（mock 模式）

mock 模式由宿主端返回预设余额，跳过凭证解析与上游请求。它默认关闭，可通过 `DSH_BALANCE_MOCK=1` 或 `?mock=1` 查询参数开启。

```sh
curl "http://127.0.0.1:3080/plugins/balance?kind=moonshot&mock=1"
curl "http://127.0.0.1:3080/plugins/balance?kind=zhipu&mock=1"
curl "http://127.0.0.1:3080/plugins/balance?kind=minimax&mock=1"
```

想在界面中查看，请带上环境变量启动服务：

```sh
DSH_BALANCE_MOCK=1 dsh web
```

然后在 **Settings → Models** 中为想预览的服务商（`moonshotai`、`zai`、`minimax` 等）添加路由，添加一个模型并选中它。胶囊会跟随活跃模型，在没有任何真实密钥的情况下显示预设余额。mock 模式不会读取凭证，也不会请求服务商——其中的数字仅用于预览布局。

## 实现原理

`dsh-balance` 是一个**双面包（dual-face Cordis package）**：同一个 npm 包，包含宿主端与浏览器端两个部分。

| 部分 | 文件 | 职责 |
|---|---|---|
| Bundle 层 | `cordis.patch.yml` | 由 `dsh.bundle` 声明；当 profile 列出本包时插入 `dsh-balance` 行，因此 `dsh plugin add` 无需手动修改补丁文件。 |
| 宿主端（Node） | `src/index.ts` | 在宿主 Web 服务器上注册 `GET /plugins/balance?kind=…`。通过凭证接缝（以及新增服务商的启动环境）解析密钥，请求服务商，并转发归一化后的余额。**密钥不会经过网络传到浏览器。** |
| 浏览器端 | `src/client/index.tsx` | 将 `BalanceChip` 组件注册到 `conversation.composer.dock` 插槽（固定在状态条最右端）与 `conversation.input.right` 插槽（会话为空时的输入框工具行）。两个位置通过记忆位置交接，首次发送时胶囊会从工具行飞入状态条。从模型目录存储（`ctx.modelDirectories`）读取当前会话的模型服务商，映射为 `kind`，并每 60 秒、点击时、会话切换时、模型切换时轮询宿主路由。每种服务的返回数据由各自的渲染器整形。 |

浏览器端产物由宿主的 client-module 流水线以 Web 外壳所需的 `window.__ModuleLoader__.load({ id, factory })` 闭包格式提供；`react` 与 `@deepseek-ai/*` 平台模块保持外部依赖，从浏览器冻结的模块表中解析。

> **Fork 提示。** client-module 的条目 id 就是 **npm 包名**。构建时会从 `package.json` 读取（见 `tsdown.config.ts`），`scripts/verify-client.mjs` 也会校验同一个值。若你重命名该包，还需同步 `cordis.patch.yml` 中的 `name` 以及 profile `dsh.profile.bundles` 中的条目；插件内部的 Cordis `name` 导出始终是 `dsh-balance`。

## 开发

```sh
pnpm install
pnpm run build     # tsdown：lib/index.js（宿主端）+ lib/client.js（浏览器端）
pnpm run verify    # 在桩模块表上执行客户端产物并校验契约
```

使用 `link:` 安装时，重建 `lib/` 会立即更新正在运行的应用，包括在已打开的浏览器标签页中热替换胶囊。宿主端改动可能需要按你的 DSH 工作流重载或重启。

`@deepseek-ai/*` 平台包是**可选的 peer 依赖**，由正在运行的 Harness 提供，因此 `pnpm install` 永远不会去下载它们（见 `pnpm-workspace.yaml`）。因此 TypeScript 类型检查需要本机的 Harness 检出并配置 `tsconfig` 路径；构建本身没有这个要求。

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| 显示 `Balance —` 且提示 `Set DEEPSEEK_API_KEY …` | 凭证无法解析。请写入 `~/.dsh/.credentials.yaml` 或启动环境。 |
| 其他服务商却显示 DeepSeek 余额 | 该路由 id 不在上面的映射表中——请带上路由 id 提交 issue。 |
| 重命名包之后胶囊消失 | client-module 的 id 就是包名；请确认 `cordis.patch.yml` 中的行与 `dsh.profile.bundles` 中的条目都与 `package.json` 一致，然后重启 `dsh web`。 |
| 首页看不到胶囊 | 首页上胶囊位于输入框工具行（模型选择器旁），而不是下方状态条；发送第一条消息后它会飞入状态条。 |
| Moonshot 或 Zhipu 返回上游 `401`/`403` | 密钥属于另一个区域主机；插件已尝试镜像站点，若仍报错说明该密钥在两个站点都无效。 |

## 常见问答

**浏览器会看到我的 API 密钥吗？** 不会。宿主端通过 Harness 的凭证接缝解析密钥并请求服务商，浏览器只会收到归一化后的余额。

**卸载后会影响 Harness 吗？** 不会。它只注册了一条路由和一个插槽组件，两者都归插件所有。卸载后 Harness 与原来完全一致——核心没有任何改动。

**运行成本如何？** 每个打开的标签页每分钟一次很小的本地 HTTP 请求，且只在打开会话视图时发生。mock 模式完全不请求服务商。

**为什么自定义服务商显示 DeepSeek 余额？** 未知路由会刻意回退到 DeepSeek，而不是让胶囊报错。请带上路由 id 提交 issue，即可补充映射。

**headless/CLI 会话能用吗？** 胶囊是 Web UI 功能；只要 profile 挂载了 Web 服务器，宿主路由在任何 profile 下都可用，但没有 Web UI 就没有胶囊可渲染。

## 更新日志

完整历史见 [CHANGELOG.md](CHANGELOG.md)。每次发布同时发布在 [GitHub Releases](https://github.com/andregoncalves/dsh-balance/releases) 与 [npm](https://www.npmjs.com/package/@andrecgoncalves/dsh-balance)。

## 许可证

[MIT](LICENSE) © 2026 Andre Goncalves
