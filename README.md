# 超级反代 / WorkBuddy Gateway

把多个 WorkBuddy 账号汇成一个本地额度池，并通过 OpenAI 兼容的本地网关对外提供；桌面版用 Electron 便携壳包裹，开箱即用。

本项目基于开源项目 [workbuddy2api-hub](https://github.com/ardeyouxipianyi/workbuddy2api-hub) 的 Python 核心，用 Electron 便携壳做启动器与窗口，并集成 Cyber HUD 界面及旧账号导入能力。源码、桌面程序与账号数据分别管理；切换网关核心或升级时不要删除旧数据。

```
DSH 桌面版 / 任意 OpenAI 兼容客户端
    ↓  http://127.0.0.1:8787/v1（OpenAI Chat Completions / Anthropic Messages）
Electron 壳（desktop/main.cjs）
    ↓  spawn 子进程，健康检查通过后打开窗口
Python 网关（hub/wb_proxy.py，workbuddy2api-hub）
    ↓  按剩余额度选号、失败换号、429 冷却、任务/签到调度
WorkBuddy 多账号（各自独立凭据）
```

## 架构

| 目录                 | 角色                                              | 打包去向                               |
| ------------------ | ----------------------------------------------- | ---------------------------------- |
| `desktop/main.cjs` | Electron 壳：找 Python、起 `wb_proxy.py`、开窗口、托盘      | `app.asar`                         |
| `hub/`             | 网关主体：21 个 `wb_*.py` + `dashboard.html` + 定价表/目录 | `resources/hub/`（extraResource，磁盘） |
| `python/`          | 精简 CPython 3.12.15 运行时（便携，无需系统 Python）          | `resources/python/`（extraResource） |
| `data/`            | 账号、用量、密钥等全部状态                                   | 便携版 exe 同级 `data/`                 |

> 旧 Node 网关实现（`server.mjs`、`src/*.mjs`、`web/`、顶层 `pricing/`）已被 `hub/` 取代，仅保留在仓库备查，不再进入安装包。

## 快速开始

**便携版（推荐，Windows）**：解压后双击 `WorkBuddy Gateway.exe`。程序自带 CPython 运行时，自动起本地服务（默认 8787，被占用时自动 +1），不需要装 Python、Node.js 或 Docker。

从 v1.2.2 开始，运行中的 Python 网关意外退出后，桌面会按 1/2/4 秒退避自动恢复，每 5 分钟最多尝试 3 次。恢复固定原端口、确认旧子进程退出，并校验本次启动的健康实例标记；不会把其它进程的 HTTP 200 当成恢复成功。正常退出与桌面升级不会触发自动恢复。

**源码运行（开发）**：

```powershell
cd D:\Codex\workbuddy-credit-simulator
# 直接跑 Python 网关（需要系统 Python 3.9+）
python hub/wb_proxy.py --port 8787 --host 127.0.0.1
# 或起桌面壳（electron 会找 python/ 或系统 Python）
npm install
npm run desktop
```

## 功能总览

Python 网关的控制面板（`dashboard.html`）含 8 大页：

1. **网关**：OpenAI 兼容端点、API Key 管理、上游健康。
2. **账号**：账号池、扫码登录、手动粘贴凭据、额度扫描。
3. **任务福利**：自动签到、跑每日任务、领体验积分。
4. **用量看板**：token / 积分消耗、等价花费（按 OpenRouter 定价表折算）、逐账号/逐模型/逐小时统计。
5. **智能体**：代理/工具/模型路由等配置。
6. **设置**：限额、冷却、代理、安全（面板密码、API Key）。
7. **日志**：实时日志与历史检索。
8. **TRAE CN**：独立的本机账号同步、积分池、模型列表与 OpenAI 兼容路由。

打开面板后点「Login new account」即可扫码建号，账号自动落盘到 `data/accounts/`。

### TRAE CN（v1.2.3）

- TRAE 使用独立的 `data/trae/` 账号池，不与 WorkBuddy 账号、额度或路由混用。
- 「扫描本机 TRAE」只读取 TRAE 自己的登录存储，复制当前访问令牌、UID 和有效期到本项目的 Windows DPAPI 保护文件；不接管刷新令牌、设备私钥，也不修改 TRAE 安装目录。
- 额度接口保留小数并显示为账号积分池参考值；具体模型权益以 TRAE 返回结果为准。
- 模型以 `trae/<upstream-model-id>` 暴露，目录动态来自当前客户端原生 `model_list_by_function` 的 `chat_v3` 分组；不把固定模型别名冒充最新模型。旧五模型 HTTP 目录只用于兼容回退。
- **新模型需从桌面程序启动网关，并保持官方 TRAE CN 正在运行、打开一个工作窗口、登录与网关所选账号相同的账号。** 先“扫描本机 TRAE”，再“刷新额度 / 模型”。逐次校验 UID，不会把其它已导入账号的调用计费到当前登录账号。
- Chat Completions 支持普通响应与**缓冲 SSE**：完整对话序列化为带角色的文本交给原生客户端，确认实际模型和正常结束后输出；不是原生逐 token 透传。支持 `developer` 文本角色（映射为 system）及 `max_completion_tokens` 限额别名；图片、音频和 `response_format` 尚不支持，原生路由不接受 `temperature/top_p`，不会静默忽略采样参数。
- 原生新模型支持 **structured-text 工具协议桥**：接收 `tools`、`tool_choice`、`parallel_tool_calls`、`assistant.tool_calls` 和 `tool/tool_call_id` 历史，将模型的结构化文本和严格 JSON 参数转换为 OpenAI 工具调用及 `finish_reason=tool_calls`。工具只由 DSH 等调用方执行，绝不在 TRAE 中执行；这不是 TRAE 原生 function calling。旧 HTTP 模型不冒充支持工具。
- 工具桥逐次核对随机响应标记、工具名称、参数 JSON、调用策略和常见 JSON Schema 子集；无效输出显式失败，不重放或把工具调用降成普通文字。`strict=true` 遇到未支持的 schema 关键字（例如 `$ref/$defs`）返回 `unsupported_tool_schema`，不宣称完整 JSON Schema 支持。工具定义、历史和正文共同受原生上下文与本地输出限额约束。
- v1.2.3 对下表三个精确 TRAE DeepSeek 路由使用 `framed_json_v2`：`WB_TOOL_BRIDGE_V2` 首标记、`WB_CONTENT` JSON 字符串或 null、成对的 `WB_CALL/WB_ARGS`，以及带同一完整随机标记的 `WB_END`。每个 JSON 字段独占一行，字符串内换行须转义；普通聊天也使用完整帧，最终对外只返回正常正文或 OpenAI 工具调用。`WB_END` 完整后才允许固定字面 `WB_PAD 0000000000000000` 的完整或截短前缀，用来承接已观察到的原生 summary 末尾丢字符。不补齐任何语义帧、nonce 或参数，不接受残缺帧的普通文本回退，不重放；元数据标注 `framed_json_v2`。其它模型保留下面的 envelope 兼容行为。
- envelope 协议在完整工具与历史之后重申格式，优先要求完整 `json/JSON` 围栏内的字面 JSON；解析器也接受不带围栏的严格 envelope。`auto/none` 下普通文本可作为最终回答，并返回 `provider_metadata.response_format=plain_text_final`；代码、Windows 路径及描述性的 function/arguments 等词不等于工具调用。JSON 根对象、协议键或工具标签、错误响应标记或参数、以及 `required/forced` 均不能因此降级放行。不会为修正格式自动重新请求模型。
- 对已复现的“最终文本 envelope 只缺最后一个外层 `}`”，仅在 `auto/none` 且严格解析补齐后的对象为本次 nonce、非空完整文本、`tool_calls=[]`、恰好三个规定字段时归一化为文本，标注 `single_outer_close_final`。不修补任何工具调用 JSON、其他缺损或围栏内残缺内容，不猜参数、不重放。
- 原生客户端的手动审批配置不是硬禁用工具开关；桥接隔离工作区信息，收到非 `finish` 工具事件、超时或输出超限时发送 `stop_chat`。停止失败单独报告，不伪造成功、不重放请求。
- `max_tokens` 在原生桥接中用于计算本地字符上限（最大 65,536），不是上游精确 token 限额；超限返回 `output_limit`。旧 HTTP 路由仍保留原有有界输出保护。
- 原生 `custom_model` 同时保留官方所选预设目录的 `max_tokens/max_turn/prompt_max_tokens` 数值字段，避免丢失客户端默认配置；这些不是客户端传入 `max_tokens` 的精确转发。缺失字段不猜填，无效数字在创建会话前失败。`finish.params` 可为对象或最多四层 JSON 字符串，归一化不修补内层工具 JSON。
- 页面区分原生实时目录、客户端缓存和旧接口，显示目录年龄与上次连接结果；有名称不等于实时权益或已经逐个完成聊天验收。TRAE 关闭时保留上次新目录，不静默降级成旧模型。
- 桌面桥接仅在回环临时端口监听，随机 bearer 只驻留内存；临时运行时连接用后清理，不修改 TRAE 安装文件或全局权限。当前适配在 TRAE CN 3.4.4 上验证；其它客户端版本以明确报错处理，不猜接口或路由后缀。
- TRAE 本机登录过期后，请先在 TRAE 内刷新登录，再回到面板同步；本项目不自行轮换刷新令牌。纯 Python 启动没有桌面原生桥接，新模型会明确提示需桌面版。

#### DSH / 其它 OpenAI 客户端

接口使用 `openai-completions`（Chat Completions），Base URL 为 `http://127.0.0.1:8787/v1`，模型 ID 使用目录返回的完整 `trae/` 前缀，例如 `trae/deepseek-v4.1-flash`。API Key 使用网关中允许访问该模型、且未绑定 WorkBuddy 账号/realm 的 Key，不使用 TRAE Token。

当前 DeepSeek 接入优先。2026-10-20 实时原生目录提供以下三个精确 ID（大小写须保留）：

| TRAE 显示名 | OpenAI 兼容模型 ID |
| --- | --- |
| DeepSeek-V4.1-Flash | `trae/deepseek-v4.1-flash` |
| DeepSeek-V4-Flash | `trae/DeepSeek-V4-Flash-Official` |
| DeepSeek-V4-Pro | `trae/DeepSeek-V4-Pro-Official` |

目录可用不代表三个模型均已完成工具任务验收。后续目录以当前账号刷新结果为准，不通过改名或切换成其他模型伪装成功。

**DSH 图片识别使用 WorkBuddy 通道，不要与 TRAE 同名模型混淆。** WorkBuddy 分组中的 `deepseek-v4.1-flash`（没有 `trae/` 前缀）已于 2026-10-20 用随机四色四形、无文字图片完成真实视觉验证。网关保留 OpenAI `image_url` 图片块；DSH 自定义模型还必须显式声明 `input: [text, image]`，仅有 `supportsVision` 不会通过桌面图片准入检查。v1.2.3 的一键配置器已补齐明确声明的输入模态；缺失或相互冲突的能力声明保持纯文本。此配置修复不是给纯文本模型增加视觉能力；当前 TRAE 桥仍只接收文本，不应为它手工开启图片。

已有 DSH `wb-gateway` 配置中的目标模型应包含（保留既有 provider、凭据引用和其它规格）：

```yaml
- id: deepseek-v4.1-flash
  input: [text, image]
```

DSH 的自定义 provider 保留原有凭据引用，设置 `api: openai-completions`、上述 `baseURL` 及非空 `models`。推荐兼容参数为：

```yaml
compat:
  supportsStore: false
  supportsDeveloperRole: false
  supportsReasoningEffort: false
  supportsStrictMode: false
  maxTokensField: max_tokens
```

不要发送 `temperature/top_p`、图片或结构化响应模式；客户端超时应允许缓冲返回（如 180 秒）。工具描述和执行结果按 JSON 保留，由客户端自己的权限/审批和工作目录约束工具执行。调用链为：DSH 定义工具 → TRAE 生成工具协议文本 → 网关返回 `tool_calls` → DSH 执行 → 回传 `tool` 结果 → 模型继续回答。

## 账号与数据

- 账号凭据、用量、设置默认都在 `data/`（便携版在 exe 同级，可用 `ACCOUNTS_DIR` / `WB_PROXY_USAGE_DIR` 覆盖）。
- 账号凭据、密钥、用量、浏览器数据与恢复备份不提交到 GitHub，私人仓库也不例外。
- 旧版账号存储格式与新版账号池不同，切换核心时必须核验迁移结果，不能只以程序启动成功判断账号恢复成功。

## 私人仓库与版本

- 仓库：`ywu3309-afk/super-proxy`，中文名称“超级反代”。
- 桌面版本以 `package.json` 的 `version` 为准，Git 发布标签采用 `vX.Y.Z`。
- GitHub 仅保存源码、依赖锁文件、构建脚本和必要资源；`data/`、`release/`、`analysis/`、`vendor/` 等本机目录被排除。
- `vendor/WorkDaddy` 是本机参考 checkout，不是运行依赖；不会把它的嵌套 Git 历史或发布包上传到此仓库。
- `git push` 只更新源码，不会自动替换正在运行的桌面 EXE。桌面更新能力必须在打包、发布与客户端安装链路均验证后，才可称为可用。

### 桌面端更新

从 v1.1.0 开始，Windows x64 便携版的顶部菜单和托盘都有 **检查桌面更新**：

1. 当前电脑先通过 Git Credential Manager 登录有权访问本私人仓库的 GitHub 账号。
2. 在软件选择 **软件 → 检查桌面更新**。
3. 有较新稳定版时，用户确认“下载并重启更新”；客户端校验更新清单、平台、大小与 SHA-256。
4. 保留账号、密钥、设置、用量及窗口偏好，替换后重启；新版本启动检查失败时尝试回滚。旧程序目录保留。

没有更新功能的旧版不会凭空获得这个菜单，首次需切换到带更新器的新版。**不要把旧 `data/` 删除，也不要用空的发布目录覆盖账号数据。**

### 开发者发布下一版本（本机打包）

先提交并检查所有源码变更，再执行：

```powershell
npm run test:desktop-update
python test/desktop_update_helper_test.py
npm version patch
git push origin main --follow-tags
npm run release:prepare
npm run release:publish
```

`npm version patch` 同步更新清单和锁文件并创建版本提交及标签；例如 v1.1.0 → v1.1.1。`release:prepare` 只向独立 `release/publish-vX.Y.Z/` 构建，不触碰当前程序和账号。`release:publish` 在私人仓库上传 ZIP、更新清单和校验和，校验附件成功后才公开该 Release 给仓库授权用户。

只有 **稳定标签 + 带更新附件的 Release** 才会被客户端发现，普通源码推送不等于桌面更新。没有配置云端 Actions，也不会因本发布流程启动收费构建。下载包不携带 GitHub Token 或 WorkBuddy 账号。

### 回滚

更新器保留同级 `*.previous-*` 旧程序目录；账号目录移动到当前版本，不会用发布包里的空数据覆盖。手动回滚应先退出当前程序，将当前 `data/` 和 `electron-user-data/` 保留并迁回旧程序目录，切勿直接启动无数据的旧程序副本或删除当前账号目录。

## 上游说明

网关核心来源于 `ardeyouxipianyi/workbuddy2api-hub`；WorkDaddy 集成参考来自 `babygoton/WorkDaddy`。原上游许可与说明见 `licenses/`。这些文件保留各自原始许可，不为整个融合项目重新声明统一许可证。

## 打包便携版

```powershell
# 1.（一次性）下载并裁剪 CPython 运行时到 python/
#    见 build/portable_runtime.py —— 固定 python-build-standalone 3.12.15 + 校验和
python build/portable_runtime.py prepare --tarball cpython.tar.gz --dest python
# 2. 打包
npm run package:win
```

产物在 `release/WorkBuddy Gateway-win32-x64/`。`hub/` 与 `python/` 经 `extraResource` 物化到 `resources/` 磁盘目录（Python 需要直接读写 `dashboard.html`、`wb_*.py`、`pricing/pricing.json`，读不了 `app.asar`）。

## 运行时裁剪说明

`python/` 是严格裁剪的 CPython 3.12.15（来自 `astral-sh/python-build-standalone` 的 `install_only` 包），裁剪规则与 `workbuddy2api-hub` 发布包一致：去掉 `Scripts/include/libs/tcl`、`ensurepip/idlelib/lib2to3/multiprocessing/tkinter/venv` 及测试扩展，保留网关 `wb_*.py` 依赖的全部标准库与扩展模块（`_socket/_ssl/_hashlib/_ctypes/_sqlite3` 等）。裁剪后约 31MB，可直接运行 `wb_proxy.py`。
