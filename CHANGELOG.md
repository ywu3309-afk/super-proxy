# 更新记录

## 1.2.0（TRAE CN 二次融合）

- 新增独立 TRAE CN 账号池、Windows DPAPI 凭据存储、本机登录同步、积分池与模型发现。
- 新增 `/providers/trae` 管理 API，以及 `trae/<model-id>` 的 OpenAI 兼容 Chat Completions / SSE 路由。
- TRAE 与 WorkBuddy 保持独立的账号、模型、并发和错误边界；不复制刷新令牌或设备私钥。
- 新增 TRAE 页面、积分小数显示、登录/积分期限、partial/quota/model 错误状态及移动布局回归。
- 上游聊天不自动重放；增加本地输出上限，防止上游忽略 `max_tokens` 时无限消费。

## 1.1.0

- 建立“超级反代”私人源码仓库及统一桌面版本号。
- Windows 便携桌面端增加自有 GitHub Release 更新入口。
- 私人仓库授权留在本机，不随源码或发布包上传。
- 更新清单绑定仓库、版本和 Windows x64 平台；下载校验大小及 SHA-256。
- 更新时保留账号、密钥、设置、用量与窗口偏好；保留旧程序并检查新版本启动。
- 发布打包使用源码白名单，排除账号、运行日志、调试截图及上游参考 checkout。
- 保留上游许可及归属说明。

