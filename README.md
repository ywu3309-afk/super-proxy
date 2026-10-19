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

### TRAE CN（首版）

- TRAE 使用独立的 `data/trae/` 账号池，不与 WorkBuddy 账号、额度或路由混用。
- 「扫描本机 TRAE」只读取 TRAE 自己的登录存储，复制当前访问令牌、UID 和有效期到本项目的 Windows DPAPI 保护文件；不接管刷新令牌、设备私钥，也不修改 TRAE 安装目录。
- 额度接口保留小数并显示为账号积分池参考值；具体模型权益以 TRAE 返回结果为准。
- 模型以 `trae/<upstream-model-id>` 暴露，文本 Chat Completions 支持普通与 SSE；工具调用、图片、音频暂不接入。
- 上游请求使用已核实的 TRAE CN 官方主机和 `chat_v3` 路由；若上游忽略 `max_tokens`，本地会在有界输出上限处中止并返回 `output_limit`，不伪造成功、不重放请求。
- TRAE 的本机登录过期后，请先在 TRAE 内刷新登录，再回到面板执行同步；本项目首版不自行轮换刷新令牌。

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
