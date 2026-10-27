# WorkBuddy Gateway / DSH 性能优化任务书

> 这里的 DSH 指 DeepSeek 智能体，不是 WorkBuddy 或 TRAE 客户端。
>
> 项目目录：`D:\Codex\workbuddy-credit-simulator`
>
> 当前基线版本：`v1.8.14`

## 0. 执行要求

请 DeepSeek 直接在现有项目中完成，不要新建平行网关，不要绕过账号池、DSH CLI 身份路由、TRAE 图片/工具桥接和 `11128` 处理逻辑。

执行顺序：先读代码和测试；先增加观测，再做上下文和调度优化；一次只改一个性能变量；先跑回归和本地基准，最后再打包发布。

## 1. 当前基线证据

基线日志：

```text
D:\Codex\workbuddy-credit-simulator\release\WorkBuddy Gateway-win32-x64\data\usage\usage.jsonl
```

最近 200 条真实请求：

| 指标 | P50 | P90 | P95 |
|---|---:|---:|---:|
| 首字延迟 TTFT | 2.15 s | 4.45 s | 5.53 s |
| 完整响应耗时 | 4.94 s | 10.06 s | 13.24 s |
| 生成速度 | 186 tok/s | 240 tok/s | 261 tok/s |
| 缓存命中率 | 99.5% | 99.9% | 99.9% |

部分 DeepSeek 请求已经达到 `150,000+` prompt tokens。缓存命中很高，但长上下文仍会影响首字时间和成本。

## 2. 已有优化，不要回退

当前代码已经包含：

- 上游 TCP/TLS keep-alive 连接池：`hub/wb_upstream_pool.py`
- 共享 TLS context
- SSE `read1()` 分块读取：`hub/wb_proxy.py::iter_sse_lines`
- 一个读取块内的响应批量写出
- `X-Accel-Buffering: no`
- 流式响应及时 `flush`
- 不同账号不共用认证连接

不要直接移除 `flush()`，也不要把主路径恢复成 `Connection: close`。每个优化都必须证明 TTFT 没有恶化。

## 3. P0：增加性能分段观测

为每个请求记录以下时间点：

```text
t_request_start       客户端请求进入网关
t_body_read_end       请求体读取完成
t_route_selected      账号/出口/模型路由完成
t_upstream_open       上游响应头收到
t_first_upstream_byte 上游首个有效 SSE 帧
t_first_client_write  网关首次向客户端写出
t_request_end         请求结束
```

至少计算：

```text
route_ms
upstream_open_ms
ttft_ms
proxy_first_write_ms
generation_ms
total_ms
tokens_per_sec
```

性能日志只能记录数值和脱敏标签，禁止记录 API Key、Token、Cookie、完整提示词、图片 Base64、工具参数原文和完整 UID。

推荐在现有 `usage.jsonl` 中增加可选字段：

```json
{
  "route_ms": 12,
  "upstream_open_ms": 184,
  "proxy_first_write_ms": 1912,
  "ttft_ms": 1981,
  "generation_ms": 2205,
  "total_ms": 4186,
  "tokens_per_sec": 164.63
}
```

数据看板新增“性能”区域，显示 TTFT P50/P90、完整耗时 P50/P90、生成速度、账号/出口延迟、流式/非流式分组，以及最近 20 条慢请求。样本不足时显示“样本不足”，不要伪造 0 ms。

## 4. P1：可控的 DeepSeek 快速上下文模式

增加一个**默认关闭**的快速模式，建议配置：

```text
WB_FAST_CONTEXT=0|1
WB_FAST_CONTEXT_TARGET=96000
```

只对 DeepSeek/兼容 Chat Completions 生效，默认行为不能改变。

必须保留：

1. system / developer 消息。
2. 当前用户消息。
3. 最近若干轮 user/assistant 消息。
4. `assistant.tool_calls` 与对应 `tool` 结果。
5. 当前轮图片消息。
6. 未闭合的工具调用和完整 JSON 工具参数。

推荐裁剪顺序：最早的普通 assistant 文本、已经闭合的旧 tool 结果、较早的重复辅助文本。工具调用进行中时禁止激进裁剪。

只记录脱敏统计：

```text
original_estimated_tokens
final_estimated_tokens
removed_message_count
compacted=true
```

## 5. P1：低延迟账号/出口排序

在现有额度、冷却、模型能力、会话粘性判断之后增加延迟排序：

```text
候选账号过滤
→ 现有可用性判断
→ 至少 3 个样本后计算 EWMA TTFT
→ 延迟相近时优先会话粘性和额度更高者
→ 单次异常不立即淘汰账号
```

建议维护：

```text
latency_ewma_ms
ttft_ewma_ms
recent_failure_rate
sample_count
last_sample_at
```

只在同一 realm、同一模型能力和同一出口条件内比较；不跨账号复用凭据连接；`11128`、`401`、`403`、`429` 仍走现有错误处理，不混入普通延迟分数。

## 6. P2：流式接收优化边界

只有客户端请求包含以下字段时，才能边生成边接收：

```json
{"stream": true}
```

对于 `stream=false`，网关聚合完整上游 SSE 后再返回，这是预期行为，不要伪造未完成的 JSON。

流式路径必须保持：

- `X-Accel-Buffering: no`
- 完整 SSE `data: ...\\n\\n` 帧
- `[DONE]`
- 工具调用帧顺序

允许小批量合并，但上限为 10 ms 或 8 KiB，不能明显推迟首帧。TRAE 原生桥接是缓冲式返回，不要把它误判为普通 DeepSeek 流式链路。

## 7. 必须保持不变

- DeepSeek 专用 CLI 身份路由
- `11128` 有界重试和 Conversation ID 更换
- WorkBuddy 与 TRAE 模型前缀区分
- TRAE 图片能力判断
- DeepSeek 工具协议桥接
- 国内版/国际版出口隔离
- 账号凭据加密和连接隔离
- 自动更新和运行数据保留
- `stream=true` / `stream=false` 两条协议路径

## 8. 验收命令

```powershell
Set-Location 'D:\Codex\workbuddy-credit-simulator'
python -m pytest -q
node --test test/*.mjs
git diff --check
```

至少新增回归测试：

1. 性能字段存在且是数值。
2. 性能日志不含 Key、Token、Cookie、完整提示词或图片 Base64。
3. 快速上下文默认关闭。
4. 未闭合工具调用不会被裁剪。
5. 图片消息不会被裁剪成文本。
6. `stream=true` 首帧能正常发出。
7. `stream=false` 仍返回完整 JSON。
8. `11128` 路由和连接池隔离测试仍通过。

## 9. 性能门槛

同一模型、同一账号、同一出口、同一提示词，优化前后各测试 10 次：

```text
TTFT P50 不得增加超过 5%
TTFT P90 不得增加超过 10%
stream=true 首帧不得延迟超过 100ms
生成速度 P50 不得下降超过 5%
11128 / 401 / 403 / 429 不得回归
```

只有在测试、性能对比、安装包真实验证都完成后，才能宣称优化完成。

## 10. 交付物

```text
1. 修改后的源码
2. 优化前后 TTFT / 总耗时 / 生成速度 / 失败率对比表
3. 新增测试及字面输出
4. 新版本安装包
5. SHA256SUMS
6. CHANGELOG.md
7. 可执行回滚方式
```

不要只报告“速度变快了”，必须给出前后数据。

