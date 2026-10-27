## 1.8.12（清洗完整工具 schema 文本）

- 针对真实 DSH 33 个工具请求，递归清洗工具 schema 中所有说明、扩展字段和嵌套文本；保留工具名、类型、枚举、格式和引用字段。

## 1.8.11（修复 DSH 指纹清洗执行顺序）

- 修复首段身份句先被改写后，后续 DSH 固定指纹句未进入清洗快路径的问题；现在完整 19800 字符 system prompt 会继续执行句式改写。

## 1.8.10（清洗 DSH 工具指纹句）

- 针对真实 DSH 19800 字符 system prompt，改写 `Tokens prefixed with @`、`Use the read/glob/grep/workflow tool` 等固定指纹句，保留操作含义但避免 WorkBuddy 渠道校验误判。
- 继续保留 CLI 身份、历史消息清洗、状态字段清理和 11128 有界重试。

## 1.8.9（清理有状态字段与更多 DSH 变体）

- 清理 Chat Completions 转发中不属于 WorkBuddy chat 协议的 `store`、`previous_response_id`、`conversation_id` 字段，避免 Responses/Agent 状态字段触发渠道校验。
- 补齐 `DeepSeek-Harness`、换行和制表符变体的出站清洗；不改路径、URL、文件名和工具名称。

## 1.8.8 (11128 request-shape diagnostics)

- Keeps the 1.8.7 DSH identity/history sanitization and bounded retries; adds redacted request-shape diagnostics for remaining 11128 cases.
- Drops stateful Responses fields (`store`, `previous_response_id`, `conversation_id`) before WorkBuddy chat dispatch and handles hyphen/underscore DSH brand variants.

# 更新记录

## 1.8.7（修复真实 11‑128 线格式与 DSH 历史指纹）

- 兼容上游真实返回的 `11‑128`（U+2011 不换行连字符）和外层 `code=400` 信封，不再因 JSON 重复字段漏判。
- 11128/11‑128 改为最多 2 次有限重发，不再把模型封禁 60 秒或误判账号异常。
- 清洗后续历史消息、工具参数描述和换行/制表符变体中的 `DeepSeek Harness` 指纹，同时保留路径、URL、文件名和工具名。

## 1.8.6（模型封禁缩短并可手动解除）

- 11128 的模型封禁从 600 秒缩短到 60 秒：一次内容/渠道问题不再让模型停用 10 分钟。
- 新增 GET /model-blocks/clear[?model=xxx]，可立即解除全部或指定模型的封禁；升级后本机已清空一次，deepseek-v4.1-flash 连发 5 次全部 200。
- 说明：SLJ 提供方（tokenstation.top）的 deepseek-v4.1-flash-1017 不经过本网关，它返回的 11102 由上游决定，与网关无关。

## 1.8.5（11128 按模型快速封禁，DSH 恢复可用）

- 11128 的真实含义是 Illegal API invocation from an unapproved channel，与账号无关、与模型绑定：同一模型在每个账号上都会被拒。旧逻辑逐个账号换号重试，把一次拒绝放大成 15 次请求，最后仍失败。
- 现在第一次命中就按模型封禁 10 分钟（ModelBlockGate.block_model），后续请求直接快速失败，不再空转。
- 账号身分已统一回 workbuddy，并关闭 uto_switch_product（vscode / cli 会被上游判为未授权渠道）。
- 实测：deepseek-v4.1-flash、deepseek-v4-pro 均 200；DSH headless 连续两次成功返回，日志无 11128。

## 1.8.4（修复 11128 渠道校验与工具指纹）

- 证据确认：`11128` 的上游正文是 `Illegal API invocation from an unapproved channel`，不是余额不足，也不是单纯缺少会话 ID。
- 工具型请求在出站前清洗工具描述和嵌套参数描述中的 DSH 渠道指纹，保留工具名称、参数类型、枚举和调用协议不变。
- 确认的 HTTP 400 / `code=11128` 只对当前账号的当前模型做 60 秒冷却并自动换下一个账号；未知 400 继续原样一次性返回。
- 新增 11128 轮换、全部账号失败保留结构化错误、工具 schema 清洗的离线测试。

## 1.8.3（11128 换会话 id 重试）

- 上游返回 HTTP 400 / code 11128（渠道校验、会话 id 缺失或失效）时，同一账号先用新的会话 id 重试一次；仍失败才换号。以前这类错误直接透传，客户端只能看到「渠道校验被拒」。
- 实测：deepseek-v4.1-flash、kimi-k3.1-pro 均 200；DSH headless 走 WorkBuddy 提供方正常返回。
- 260 条单测通过。

## 1.8.2（修复账号列表 fmtTime 未定义）

- 1.8.1 在账号行调用 mtTime，但它定义在另一个 <script> 块里，渲染时抛 mtTime is not defined，导致账号列表加载失败。
- 改为 ccountRow 内部的 shortTime，不再跨块依赖；面板 5 个脚本块语法检查通过。

## 1.8.1（账号面板显示续期状态）

- 账号行次要信息新增「续期:开 / 续期:关」：开启时显示上次续期时间，悬停可看说明；没有 refresh token 的账号明确标「续期:关」。
- 账号工具栏新增「立即续期」按钮，调用 POST /accounts/keepalive/run，成功后刷新列表。
- 面板 5 个脚本块语法检查全部通过。

## 1.8.0（账号凭据加密与自动续期）

- 凭据落盘改为 DPAPI 加密：ccessToken / 
efreshToken 以 dpapi: 信封写入，换机器或换 Windows 用户都解不开；旧明文文件继续可读，保存一次即自动迁移。
- 新建的凭据文件收紧 ACL，只授予当前用户完全控制（icacls /inheritance:r）。
- 新增 TokenKeeper 保活线程：每 30 分钟检查一次，access token 距到期不足 7 天时用 refresh token 主动换新，并轮换 refresh token，把 29 天的有效期持续续下去。
- 新增接口：GET /accounts/keepalive 查看每个账号的到期时间、上次续期时间、是否有 refresh token；POST /accounts/keepalive/run 手动触发一次续期。
- 账号面板字段新增 lastRefreshAt、utoRefresh。
- 本机 15 个账号已全部迁移为加密存储，网关仍显示 15/15 可用。
- 新增 6 条安全/保活单测，全套 260 条通过。

## 1.7.13（TRAE 拒绝请求时给出可执行提示）

- 上游在上下文超限或内部拒绝时会返回非 SSE 文本，原来的报错是“TRAE SSE 数据不是有效 JSON”，对使用者没有可操作性。
- 现在改为明确提示：换额度更大的 TRAE 模型（glm-5.3、Doubao-Seed-Code）或精简系统提示后重试。
- 配合 DSH 默认模型切到 glm-5.3-trae（约 60 万字符额度），避免 deepseek-v4.1-flash-trae（约 12.5 万）被 DSH 的 4 万 token 系统提示顶爆。

## 1.7.12（逐模型实测 TRAE 工具信封额度）

- 用真实账号把 31 个 TRAE 模型逐个量了一遍（每个模型按 6 万→60 万字符逐级加压，带工具请求），额度写进 TraeProvider._TOOL_BUDGETS，留 5 千字符余量；未列模型默认 100000。
- 结果分档：Doubao-Seed-Code / glm-5.3 / glm-5.3-flashx / qwen-3.5 / qwen-3.6-plus / qwen-3.7-plus 约 60 万；DeepSeek-V4-Flash / DeepSeek-V4-Pro-Official / Doubao-Seed-2.1-* 约 40 万；glm-5 / kimi-k2.5 / kimi-k2.6 / kimi-k3.1-pro 只有 2-3 万。
- -trae 后缀的重名模型查额度时自动剥后缀，和同名模型共用一档。
- 实测样本：Doubao-Seed-Code 55 万 → 200；deepseek-v4.1-flash-trae 12 万 → 200；glm-5 2 万边界不稳定（上游偶发 502）。
- 254 条单测全过。

## 1.7.11（工具信封额度按模型可配）

- 原生 	ools 字段经实测在所有模型 / 函数上都被上游 400 拒绝（chat_v3、solo_coder、裸 schema、Anthropic 形状都试过），确认只能走文本信封。
- 信封上限改为按模型配置：settings.json 的 	rae_tool_budget_chars，形如 {glm-5.3: 300000}；默认 100000。
- 实测：glm-5.3 带工具 25 万字符 → 200 且返回 	ool_calls；deepseek-v4.1-flash 默认 10 万，超出后按原有压缩阶梯收缩，仍放不下才 413。
- 254 条单测全过。

## 1.7.10（TRAE 带工具请求单独放开）

- 带工具的直连请求不再被 60000 字符信封卡住：直连模型使用按目录上下文计算的额度（本机实测上限 100000 字符），工具定义、对话和信封一起计入。
- 直连通道支持工具信封解析：模型输出的内容先缓冲，结束后统一解析成 content / 	ool_calls，不再返回 422「需要原生客户端模型」。
- 错误提示改为带实际额度（udget_chars），不再统一写 60000。
- 实测：带工具 3k/90k 字符 → 200 且正确返回 	ool_calls；150k → 413（额度 100000）。不带工具的 210k 仍为 200。
- 边界说明：120000 字符可用、130000 字符上游会返回无法解析的帧，因此封顶 100000 留余量。254 条单测全过。

## 1.7.9（TRAE 长上下文放开到直连额度）

- 直连 llm_raw_chat 的模型不再经过原生工具桥的 60000 字符信封预算：没有 tools/tool_choice/图片的普通长对话直接发上游，由上游的 prompt_max_tokens（__max 档约 936k）决定上限。
- TRAE 目录刷新改为**直连优先**：先用 get_detail_param 拿 config_name/model_name，成功就不再让原生客户端目录覆盖；失败才回落原生/本地缓存。
- 实测四探针 4/4：sys=210k 从 413 变为 200（1.6s），sys=3k/25k 均 200。
- 远端目录失败只尝试一次，避免重复请求与回退路径被判失败；254 条单测全过。

## 1.7.8（TRAE 直连 llm_raw_chat，去掉 trae/ 前缀）

- TRAE 通道改为直连官方 POST /api/ide/v2/llm_raw_chat：用目录里的 config_name + model_name（优先 __max，其次 __dev）直发，不再依赖 Electron 原生桥；原 llm_utils_chat 保留兜底。
- 关键修复：model_name 必须带 __dev/__max 后缀，直接拿 config_name 当模型名会得到上游 4023 model is unknown。
- 模型命名：不再使用 	rae/ 前缀。与 WorkBuddy 不重名的 TRAE 模型直接用裸名（如 Doubao-Seed-Code、kimi-k3）；重名的 13 个加 -trae 后缀（如 deepseek-v4.1-flash-trae），裸名仍归 WorkBuddy，两条通道互不抢名。
- 模型清单去掉 TRAE 池的重复条目（原先同名模型被列两遍，133 → 102 条）。
- 实测：Doubao-Seed-Code / kimi-k3 / glm-5.3-flashx → 200（TRAE）；deepseek-v4.1-flash → 200（WorkBuddy）；deepseek-v4.1-flash-trae → 200（TRAE）；TRAE 四探针 4/4。
- 已知限制：超过 6 万字符的请求仍按原生信封预算回 413（直连 raw 的 1M 上下文尚未放开）。

## 1.7.7（移除免费车道旧前缀与裸名）

- 免费模型只接受统一前缀 hang/：zen/、kilo/ 与裸模型名全部停用，调用会收到一句明确提示（例如“免费模型的旧前缀已停用，请改用 hang/<模型名>”），不会再落到 WorkBuddy 通道报 11102。
- 实测：hang/kilo-auto/free → 200；kilo-auto/free → 400 并提示加前缀；zen/deepseek-v4.1-flash-free → 400 并提示新前缀；deepseek-v4.1-flash 不受影响。
- 全套 254 条单测通过。

## 1.7.6（免费车道前缀改为 hang/）

- 免费车道的公开前缀从 zen/（部分 kilo/）统一为 **hang/**，由 settings 的 ree_lane_prefix 控制，默认 hang；zen/、kilo/ 与裸模型名继续兼容。
- 修：免费模型在 /v1/models 里被重复列了两遍、且 id 带「· 鸡蛋」后缀（hang/xxx · 鸡蛋）导致无法调用；现在统一成裸 hang/<id> 并按 id 去重，27 条免费模型恢复正常。
- 实测：hang/kilo-auto/free、kilo-auto/free 均 200；deepseek-v4.1-flash 仍走 WorkBuddy 账号池。
- 全套 254 条单测通过。

## 1.7.5（免费模型可省略 zen//kilo/ 前缀、设置页显示桌面更新进度）

- 免费车道的 zen/ 与 kilo/ 只是来源标签，不再是调用约定：裸模型名（如 deepseek-v4.1-flash-free、kilo-auto/free）只要 wb_zen.resolve() 认得，就会进入同一条免费车道。实测：裸名 kilo-auto/free 返回 200（落到 dots-studio/dots-3-note-preview:free）；裸名 deepseek-v4.1-flash-free 也路由到 Zen（当前上游配额用尽，回 429）。
- 设置页「桌面软件更新」新增“桌面更新”一行：下载/校验/重启时显示与顶栏一致的进度条和已下载大小，页面刷新后能接回进行中的更新。
- 全套 254 条单测与 17 条桌面更新测试通过。

## 1.7.4（桌面更新下载进度条）

- 顶栏「检查桌面更新」现在会在下载时显示浮动进度卡：状态、百分比、已下载/总大小（例如 88.1 MB / 142.3 MB），以及校验、重启阶段的状态文字。
- 进度数据来自桌面进程的真实下载回调（
eceivedBytes / 	otalBytes / progress），不是前端估算；每 500ms 轮询一次，页面刷新后会自动接回仍在进行的下载。
- 失败时进度卡变红并显示原因，不再只弹一个原生对话框。
- 说明：进度条本身跑在**当前已安装版本**里，所以从 1.5.1 / 1.7.2 升到 1.7.4 这一步仍然只有旧界面；从 1.7.4 起的后续更新才会看到新进度条。

## 1.7.3（请求体上限可在设置里热改，默认 16MB → 64MB）

- 长会话客户端的请求体会随历史线性增长：实测 DSH 一次 16.8MB，正好顶穿旧的 16MB 上限，客户端重试 3 次全部 413，会话直接断在那里。
- 默认上限 16MB → **64MB**；同时支持在 settings.json 里写 payload_max_mb（例如 128）**免重启生效**，WB_MAX_PAYLOAD_BYTES 环境变量仍是最先读的值。413 文案里的数字现在跟实际上限一致，不会再出现“说 16MB、其实已经改了”的误导。
- 实测：20MB 请求体正常进入业务逻辑（不再 413，返回的是上游对假模型的 400）；130MB 仍在毫秒级回 413 Request Entity Too Large。
- 全套 254 条单测通过。

## 1.7.2（同请求内换候选重试、第三方通道面板接口接活）

- 路由池：同一次请求内换候选重试。上游回 11133（参数被模型供应商拒绝）时，把当前成员拉黑 600 秒，再用客户端点的 `route/*` 重新选路重试，最多 2 次；全部候选都失败才把错误回给调用方。
  实测（真账号）：清空黑名单后单发 `route/usage`，第一次撞上 `glm-5.1` 被拒，同请求内自动换人，最终 HTTP 200（落到 `step-5-preview`），黑名单里留下 `glm-5.1`。
- 面板「第三方通道」页接活：后端新增 `GET/POST /api/third-party-channels` 与 `/{id}/probe`、`/{id}/toggle`、`/{id}/models`，内部复用原有的 external 存储，两套命名共用一份数据。此前页面调的是这组路径，而后端只有 `/providers/external`，所以页面永远停在“正在读取第三方通道…”。
- 通道 `kind` 归一：面板下拉给的是 `openai` / `anthropic`，存储层只认 `openai-compatible`；现在 `openai` 自动归一，选 `anthropic` 会直接回一句看得懂的话，而不是 `unsupported_kind`。
- 实测通道 CRUD：新建 → 启用 → 列模型 → 探活（假密钥，上游 401 如实回）→ 删除 → 列表归空，全部 200。
- 修：keep-alive 连接复用同一个 handler 实例，路由重试状态会在请求之间串味；现在每个非重试请求开头都重置。
- 全套 254 条单测通过。

## 1.7.1（路由成员健康冷却与 token saver 默认关闭）

- 路由池成员健康冷却：上游返回 400 且 detail 里含 `11133`（provider 拒绝参数）时，把该成员拉黑 600 秒，选路自动绕开；全池都被拉黑时退回全量候选，不让池子变空。根因是 `route/usage` 按“24 小时用得最少”排序，把已经对所有请求都报 11133 的 `glm-5.1` 排在第一位，于是每个请求都撞同一个坏成员。
- 实测（真账号、同一 body）：`route/usage` 连发 10 次，第 1 次撞上 `glm-5.1` 得到 400 并触发拉黑，后 9 次全部 200、全部落到 `glm-5v-turbo`；黑名单落盘在 settings 的 `routing_unhealthy`。**首个撞上坏成员的请求仍会失败**（同请求内换候选重试尚未实现）。
- `/routing` 的 `candidates` 现在带 `unhealthy_for`（剩余冷却秒数）与 `filtered` 标记。
- `token_saver` 默认改为关闭：实测它对 7 条不同的 ERROR 只保留 3 条（同前缀抽样，“还有 N 条”），会丢证据；需要时在设置里显式开启。
- 全套 254 条单测通过。

## 1.7.0（免费车道收尾、路由总池与选号加固）

- 免费车道收尾：`kilo-auto/*` 与 `*:free` 统一走 `kilo/` 前缀分发（`zen/` 保持兼容）；上游 429/400 时模型进入 60s 冷却，重复请求本地直接回 429 并带剩余秒数，不再每个请求都去撞必然失败的源；`/v1/models` 的免费条目按来源标注前缀与 `egg_cooldown_left`。
- 免费目录自愈：网关启动后异步刷新目录，面板新增 `GET /zen/status` 与 `POST /zen/refresh` 手动刷新入口；免费车道失败一律原样回给调用方，不静默降级到付费池。
- 路由总池子：新增 `route/auto` 与 `route/{smart,order,rotate,usage,pace}` 五种策略的公共路由入口，三通道候选（WorkBuddy 账号池、TRAE 原生、Kilo/OpenCode Zen 免费车道）统一进 `/routing` 与 `/v1/models`；会话粘性 1800s（轮换策略例外），决策记录面板可见。
- 三因子加权选号（仅在本机 127.0.0.1 故障注入 mock 上对照验证，未触碰任何真实账号）：余额、临期积分、闲置时间三因子打分，前 5 名加权抽签；100ms 内重复接单的号让位，无人可用时按单调接单序号 LRU 兜底。mock 对照（40 请求剧本）：改前纯轮询 14/13/13 均分，改后 25/12/3 按余额倾斜；临期剧本改前单号垄断 40/40，改后 23/12/5 分摊。
- 跨账号 fail-fast 闸门（同上，仅 mock 验证）：上游 WAF 403（无业务信封）60s 内 2 个不同账号命中即合闸，合闸后所有请求本地 429、不再发任何上游请求——mock 对照：改前 3 个请求打出 6 次上游命中（同号双打），改后 2 次命中即止损。`11102 模型不存在` 同构处理：改前 3 请求 3 次上游命中，改后 2 次命中后合闸 fail-fast。已有 11140 风控连坐保护不受影响（对照结果与改前完全一致）。
- 测试：全套 254 条通过；C1 实验驱动器与对比报告见 `D:\artex-app\data\tasks\23\c1\`（mock 剧本下改前/改后同一并发对照）。

- TRAE 原生通道的 413 不再只说"超过限制"：响应体现在带 `context_chars`（本次实际字符数）、`budget_chars`（60000）、`suggest`（可操作建议），流式与非流式两条路径都带。
- TRAE 原生通道补降级阶梯：先丢旧轮次，再把系统提示压成"头 + 省略标记 + 尾"（provider_metadata 里记 `context_trim`）；只有单条消息本身就超过整额度时才 413，不再把 20 万字符的系统提示悄悄切碎。
- 修复 `max_tokens` 过小必现 502 `output_limit` 的问题：字符预算下限从 256 提到 8192，reasoning 与正文各算各的预算，思维链不再吃正文额度。
- TRAE 模型在 `/v1/models` 里新增 `context_limit_chars: 60000`，客户端可据此自行避免超长上下文。
- 出站清洗 DeepSeek Harness 的两个渠道指纹词组（上游 400 / code 11-128）：只把词组内的空格换成零宽空格，其余字节不动，并把词组纳入 `has_fingerprint` 快路径。
- 请求体被截断（实际收到的字节少于 `Content-Length`）改回 **408**，并写一条取证日志（peer / 收到字节 / 声明字节 / path / UA）；此前回 400，而所有 OpenAI 与 Anthropic SDK 都不对 400 重试，本该自愈的故障变成人工重发。
- 三处 `text/event-stream` 响应补 `X-Accel-Buffering: no`，避免前置代理或隧道攒帧导致"流式看起来像非流式、首字很慢"。
- 新增 `POST /v1` 别名：把 base_url 当成完整端点、直接 POST 到 /v1 的客户端不再吃 404。
- 测试：新增 DSH 渠道指纹清洗契约测试（含"规则源码不许出现零宽字符"守卫）与请求体截断 408 用例，全套 254 条通过。

## 1.5.1（桌面更新失败重试与醒目更新入口）

- 修复公开 GitHub Release 大附件下载中途断开后直接失败的问题：更新包支持从已下载位置断点续传，网络抖动时自动重连并继续校验 SHA-256。
- 更新下载同时支持 GitHub Release 直链回退，减少 API 重定向链路在部分网络环境下卡住导致的更新失败。
- 桌面更新失败会把可读原因写入 `desktop-startup.log` 并显示在错误对话框，不再只显示“没有替换当前程序”。
- 顶栏新增高亮“检查桌面更新”按钮；“软件”菜单同步改为“立即检查桌面更新…”，支持 `Ctrl+U` 快捷键；设置页恢复并突出显示完整更新卡片。

## 1.5.0（TRAE 浏览器扫码授权与工具上下文修复）

- TRAE 新增“扫码 / 浏览器授权”主入口，不要求本机安装 TRAE，也不再强制读取本机 TRAE 登录态；授权完成后自动回调并加入 TRAE 国内版账号池。
- 新增 TRAE OAuth/PKCE 授权、AuthCode 换发、凭据自动刷新和 DPAPI 加密保存；Token、RefreshToken、设备私钥不会返回到前端或写入普通日志。
- 保留“扫描本机 TRAE”作为兼容入口，并明确区分浏览器授权、远程文本调用和本机原生视觉/工具能力。
- 修复 DSH 完全权限模式下大量工具定义触发 TRAE 原生上下文超限的问题；模型侧按预算渐进压缩工具描述，网关本地仍使用完整 schema 严格校验。
- 新增 OAuth、授权回调、HTTP 管理路由和工具上下文回归测试。

## 1.4.0（融合 wb-proxy 的 TRAE 动态目录与远程 SSE）

- 接入 `cty1735/wb-proxy` 当前使用的 `get_detail_param` 动态模型目录，按 `chat_v3`、`solo_agent`、`solo_coder` 合并模型，不再只依赖旧的五项 `model_list`。
- TRAE 网关默认优先读取上游动态目录；动态接口临时不可用时保留旧接口作为最后兼容回退，并在看板明确显示目录来源。
- 补齐现代 TRAE SSE 的 `metadata`、`timing_cost`、`extra_info`、`output`、`token_usage` 和 `done` 事件解析，兼容嵌套 usage 字段与 `content/text/reasoning` 输出。
- 远程动态模型支持普通文本请求直连 `llm_utils_chat`；原生 TRAE CN 路径继续保留 `deepseek-v4.1-flash` 图片与工具桥接，不把不支持的远程图片/工具请求静默降级。
- 更新 TRAE 请求头与版本标识，避免旧客户端标识导致模型目录过期或触发渠道校验；新增动态目录和远程 DeepSeek 文本回归测试。

## 1.3.5（DSH 首局提示兼容）

- 只在请求开头连续的 system/developer 初始指令块中，将会触发 WorkBuddy 渠道校验的 `DeepSeek Harness` 品牌句改写为 `DeepSeek`；不修改用户正文、工具参数、图片 URL、文件路径、历史消息或其它字段。
- 增加 URL、路径、文件名、大小写、文本块、developer 入口和对象不变性的回归测试。
- 本项针对 DSH 首局提示的已复现触发形状，不代表所有 `400 / 11128` 场景都已解决。

## 1.3.4（WorkBuddy 上游错误诊断）

- Chat Completions 和 Responses 对已确认的 `400 / 11128` 返回简明渠道校验提示，并单独保留 provider、模型和上游请求编号，不再把整段上游 JSON 嵌进错误消息。
- 修复直接抛出的上游 HTTP 错误缺少实际账号归因的问题；错误记录保留白名单诊断字段，避免随简短显示文案一起截断。
- 本项只改善诊断与错误展示，不改变请求内容、身份、账号、出口或重试策略，不代表已恢复被上游拒绝的原会话。

## 1.3.3（开机自启动）

- 设置页和“软件”菜单增加开机自启动开关，使用当前 EXE 路径登记当前 Windows 用户的启动项，支持随时关闭；新安装默认关闭。
- 随 Windows 登录时自动运行网关并收起到系统托盘，手动启动正常显示主窗口；托盘不可用时自动显示窗口。
- 开关读取 Windows 的实际状态，并识别在任务管理器中被禁用的启动项；保留账号、配置和现有更新机制。

## 1.3.2（TRAE 用量回退估算与来源标记）

- 修复 TRAE 原生客户端未返回 `token_usage` 时，DSH 显示“用量 0 tok”的问题。
- 原生上游提供真实用量时继续优先使用真实字段；缺失或全为零时按实际发送的原生提示词、回答和推理文本做本地估算，并在响应元数据与 TRAE 看板中明确标记“估算”。
- 估算值只用于 OpenAI-compatible 客户端展示和本地统计，不冒充 TRAE 官方积分账单；账号积分仍以 TRAE 官方额度接口为准。
- TRAE 看板最近请求增加用量来源标记，方便区分上游真实值与本地估算值。

## 1.3.1（看板缩放与 TRAE 工具上下文修复）

- 数据看板增加 80%–120% 缩放控制，记住本机上次选择；最近请求和模型清单在缩放后仍可横向查看。
- 网关主页只保留账号、出口和调度概览；最近请求与模型能力明细集中到数据看板，减少主页信息堆叠。
- “任务与福利”统一改为“自动化任务”，中英文界面同步更新文案。
- DSH 完全权限模式发送大量工具定义时，自动压缩模型侧工具描述与 schema，保留本地完整 schema 做严格结果校验，避免触发 TRAE 原生上下文上限。
- 通过 `trae/deepseek-v4.1-flash` 实测工具调用、写入、读取和最终结束流程。

## 1.3.0（默认国内出口与设置页简化）

- 新安装实例默认使用国内版出口；已有实例继续尊重已保存的出口选择与 `WB_PROXY_DEFAULT_REALM` 覆盖值。
- 国内版与国际版账户卡片分区展示，默认出口控制改为独立的全宽醒目控制栏，明确说明未绑定专属出口的请求会走哪里。
- 设置页默认只显示密码、语言、页签、API Key、代理槽和账号限额等常用项；价格、探针、日志、网络工具等高级设置统一收起，可一键展开且不改变任何后端配置。

## 1.2.9（TRAE 长历史自动压缩）

- 修复 DSH/工具调用历史过长时触发 TRAE 原生 65,536 UTF-16 字符上限的问题。
- 保留完整工具定义、全部 system/developer 指令和最新用户请求；只删除最早的完整普通历史消息，不截断工具 JSON 或图片数据。
- 原生桥接使用 60,000 UTF-16 工作预算；单条工具定义或当前消息本身超限时返回明确 `request_too_large`，不重放请求。
- 增加长历史压缩、Unicode UTF-16 计数和超大消息拒绝测试。
- 主题菜单收敛为唯一的 Cyber HUD，移除 Claude、Material、MiuiX 三个不再使用的主题入口。
- API Key 行内操作按钮提高对比度、尺寸和焦点反馈，补充明确的悬浮提示与无障碍标签。

## 1.2.8（公开仓库免登录自动更新）

- 公开 GitHub 仓库的桌面更新不再强制读取 GitHub 凭据，可直接读取 Release、更新清单和公开附件。
- 只有发布新版本时才要求 GitHub 写权限；更新下载仍校验 Release 资产大小和 SHA-256。
- 更新提示改为公开 GitHub Release，不再显示“私人仓库需要授权”。
- TRAE 原生桥接增加 `product.json` 产品标识兜底，可识别用户自定义安装目录中的官方 TRAE CN。

## 1.2.7（TRAE CN 安装路径兼容）

- TRAE 原生桥接同时识别用户安装目录和系统安装目录，不再只检查单一的 `%LOCALAPPDATA%\\Programs\\Trae CN` 路径。
- TRAE 状态页会在检测到系统级安装时正常显示客户端版本；启动官方 TRAE CN 并登录同一账号后即可刷新原生模型目录。

## 1.2.6（移除私人仓库菜单入口）

- 移除桌面应用菜单中的“查看私人仓库发布页”入口。
- 保留桌面自动更新能力，更新仍通过已配置的公开 GitHub Release 清单执行。

## 1.2.5（TRAE 配置向导与调用看板）

- TRAE 页面新增 API 接入配置向导：Base URL、Bearer API Key、模型 ID、curl 示例及 DSH/兼容客户端配置步骤。
- 新增 TRAE 原生连接诊断，明确区分原生目录、本机缓存目录和旧接口回退目录，并给出恢复最新模型目录的操作步骤。
- 新增 TRAE 脱敏调用看板：请求数、成功率、Token、平均延迟、按模型/账号统计和最近请求；不保存提示词、图片、Token 或登录凭据。
- 继续保留 TRAE/WorkBuddy 账号、凭据、额度和模型数据隔离。

## 1.2.4（TRAE DeepSeek 图片传输）

- 精确 `trae/deepseek-v4.1-flash` 接通内联 PNG/JPEG/WebP 图片输入。图片经独立私有字段传递，工具协议文本只保留按历史顺序生成的 `image_ref`，不把 Base64 塞入提示词，不丢失历史图片。
- 采用官方 native signed 上传链：`get_resource_upload_url` → 返回的官方 TOS 主机 PUT 原始字节与 CRC32 → `commit_resource_upload_result`；同一资源同时绑定 `message_content` 和 `multi_media`。不使用当前 Rust 不支持的 `upload_image`，不猜上传端点；签名只发往严格校验的官方上传主机，禁止重定向，上传失败不会降级为纯文本生成。
- 每次实际请求重新核对精确模型与原生目录 `multimodal === true`；目录能力显式传递至网关和 DSH 配置器。未实现、离线缓存、未知或不支持图片的模型仍声明纯文本，不按模型名猜能力。
- 仅接受 user 消息中的 PNG/JPEG/WebP dataURI；每次最多 4 张，单张解码不超过 4 MiB、总计不超过 8 MiB，校验规范 Base64、容器头及尺寸。外部 URL、不支持角色及伪造内部引用会明确失败。无新增生产依赖。
- 修复官方 TRAE 同 EXE 后代进程没有 `--type=` 时误判“未运行”的问题：验证完整官方路径并按祖先关系选唯一根进程；多根、循环及 Inspector 所有权冲突仍拒绝。
- 保留 structured-text 工具桥的完整帧、随机标记、schema、输出预算及外部客户端执行边界，不修补模型数据，不重放失败请求。

## 1.2.3（DeepSeek 工具格式与 DSH 图片配置修复）

- 修复 DSH 一键配置只写 `supportsVision`、未写实际生效的 `input` 而拦截图片的问题。Python/JS 配置器从网关明确声明的能力生成 `input: [text, image]`，纯文本、未知或冲突能力显式保留 `[text]`；不根据模型名称猜视觉能力，不将未实现图片通路的 TRAE 伪标为支持图片。WorkBuddy `deepseek-v4.1-flash` 已用无文字随机四色四形图验证图片识别。
- 三个精确 TRAE DeepSeek 路由改用浅层分行协议 `framed_json_v2`，普通文本和工具循环均要求完整首尾随机标记、完整 JSON 内容及参数。固定非语义尾垫仅在结束标记完整后允许截短，用于隔离已观察到的上游尾字符丢失；不补齐响应标记、JSON、工具名或参数，不降级残缺响应，不重放请求。其它模型维持原 envelope 协议。
- 原生请求保留所选官方预设目录的 `max_tokens/max_turn/prompt_max_tokens`，与客户端 `custom_model` 构建语义对齐；仅传递经过校验的数值，不猜填预算、不泄露原始模型配置。调用方输出限制继续独立生效。
- 原生 `finish.params` 支持有界解析 JSON 字符串形式（最多四层），允许后续完整参数替换先前快照；不修补 `summary` 内的 JSON，也不拼接不同事件中的参数。
- 在完整工具定义与对话之后追加同一请求标记的格式提醒，优先要求将完整 envelope 作为单一 JSON 代码围栏内的字面文本返回，明确外层闭合要求；提醒仍计入原生上下文限额。
- 兼容整个响应仅包含一个 `json/JSON` 代码围栏的情况；剥离围栏后仍严格检查响应标记、重复 JSON 键、工具名、参数及调用策略，不从说明文字中提取或修复工具 JSON。
- `tool_choice=auto/none` 允许普通文本最终回答，以 `plain_text_final` 元数据标识；普通代码、Windows 路径及 function/arguments 等描述性词语不误判为工具协议。JSON 根对象、协议键或工具标签、错误响应标记及 `required/forced` 不走该兼容路径，无效工具输出仍失败且不重放。
- 兼容已复现的最终文本 envelope 仅缺最后一个外层 `}`：只在 `auto/none`、本次标记匹配、三个字段严格有效、文本完整且 `tool_calls=[]` 时补齐终止符并标注 `single_outer_close_final`；任何实际工具调用、其他 JSON 缺损、重复键及 `required/forced` 均不修补。
- 修复桌面正常退出时对子进程重复发送终止信号而产生清理失败误报的竞争条件。
- 保留账号、凭据、模型隔离、输出上限与客户端工具执行边界，无新增生产依赖。

## 1.2.2（TRAE 工具协议与网关自动恢复）

- 修复 Python 网关退出后桌面仍显示但端口离线的问题：运行期异常退出采用固定端口、有限退避自动恢复，并验证启动实例标记；正常退出或更新不重启子进程。
- TRAE 原生模型新增 structured-text 工具桥，支持 OpenAI `tools/tool_choice/parallel_tool_calls`、工具调用结果回传及多轮循环。工具由 DSH 等外部客户端执行，不开放 TRAE 内置文件或命令工具，不冒称原生 function calling。
- 支持普通响应和缓冲 SSE 的工具调用，正确返回独立调用 ID、函数参数和 `finish_reason=tool_calls`；工具名称/参数/策略、响应 nonce、JSON 格式、历史关联和上下文大小均校验，无效输出不重放。
- 兼容 developer 文本角色、空工具字段和 `max_completion_tokens` 别名；旧 HTTP 模型仍显式拒绝工具，采样参数不被静默忽略。增加工具协议、健康握手和生命周期回归测试。
- 保持 WorkBuddy/TRAE 账号、凭据、设置和用量隔离，无新增生产依赖。

## 1.2.1（TRAE 原生新模型目录与文本桥接）

- 修复旧 `model_list?type=chat` 只返回 5 个历史模型的问题；桌面版优先调用当前 TRAE 的原生 `model_list_by_function` 动态发现目录，不硬编码“最新”模型名。
- 新增仅限本机回环、每次启动随机鉴权的原生桥接；使用官方客户端当前登录状态，核对账号 UID、精确配置名和实际返回的模型身份，不复制设备密钥。
- 新模型走原生文本链路，不再错误发送给旧的 `llm_utils_chat`。兼容普通 Chat Completions 与缓冲 SSE：完整对话按角色序列化为文本，原生完成后返回，并非逐 token 流式透传。
- 原生模型需要官方 TRAE CN 运行、打开工作窗口并登录相同账号。缓存仅作为目录回退，不表示已连接或模型调用已通过；临时离线不以旧五模型覆盖新目录。
- 增加工具事件、超时、输出上限、模型错配和不完整流的错误处理；异常时调用真正的 `stop_chat`，停止未确认会明确返回错误，不重放对话。
- TRAE 页面增加目录来源、刷新时间、桥接配置/上次连接状态、缓存与缓冲返回说明。原 WorkBuddy 账号、额度和路由维持隔离。
- 修复更新附件正常下载超过三分钟仍被总超时中断的问题，改为独立响应头期限与无进度期限，保留大小和 SHA-256 校验。

## 1.2.0（TRAE CN 二次融合）

- 新增独立 TRAE CN 账号池、Windows DPAPI 凭据存储、本机登录同步、积分池与模型发现。
- 新增 `/providers/trae` 管理 API，以及 `trae/<model-id>` 的 OpenAI 兼容 Chat Completions / SSE 路由。
- TRAE 与 WorkBuddy 保持独立的账号、模型、并发和错误边界；不复制刷新令牌或设备私钥。
- 新增 TRAE 页面、积分小数显示、登录/积分期限、partial/quota/model 错误状态及移动布局回归。
- 上游聊天不自动重放；增加本地输出上限，防止上游忽略 `max_tokens` 时无限消费。
- TRAE CN 账号、积分和模型管理已实测；对话适配仍为实验性。部分真实请求输出异常或上游忽略输出上限时，会返回 `output_limit` 并中止，不代表正常聊天已通过验收。

## 1.1.0

- 建立“超级反代”私人源码仓库及统一桌面版本号。
- Windows 便携桌面端增加自有 GitHub Release 更新入口。
- 私人仓库授权留在本机，不随源码或发布包上传。
- 更新清单绑定仓库、版本和 Windows x64 平台；下载校验大小及 SHA-256。
- 更新时保留账号、密钥、设置、用量与窗口偏好；保留旧程序并检查新版本启动。
- 发布打包使用源码白名单，排除账号、运行日志、调试截图及上游参考 checkout。
- 保留上游许可及归属说明。

