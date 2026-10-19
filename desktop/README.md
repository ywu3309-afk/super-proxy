# 超级反代桌面壳

`main.cjs` 启动 Python 网关并打开 Electron 窗口；网关仅绑定 `127.0.0.1`，版本号来自 `package.json`。

- 便携版状态在 EXE 同级 `data/`，窗口偏好在 `electron-user-data/`。
- 菜单和托盘的“检查桌面更新”只查询 `ywu3309-afk/super-proxy` 的稳定 Release。
- 私人附件访问使用当前进程的 `GH_TOKEN` / `GITHUB_TOKEN`，或本机 Git Credential Manager 已配置的 GitHub 授权；不把凭据打包、写日志或发送给页面。
- 下载请求只允许 GitHub API 及 GitHub 附件主机；跳转到附件主机时不会转发 Authorization。
- SHA-256、版本、平台、仓库和 ZIP 路径均检查后，再由复制到独立暂存目录的 Python 助手替换程序。
- 保留 `data/` 和 `electron-user-data/`，旧程序移到同级 `.previous-*` 目录。新程序启动健康检查失败时尝试回滚。
- 源码模式、自定义运行根目录与不带 Python 的包不支持就地安装；不会修改系统服务、注册表或全局 Git 配置。
