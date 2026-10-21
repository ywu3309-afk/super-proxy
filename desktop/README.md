# 超级反代桌面壳

`main.cjs` 启动 Python 网关并打开 Electron 窗口；网关仅绑定 `127.0.0.1`，版本号来自 `package.json`。

- 便携版状态在 EXE 同级 `data/`，窗口偏好在 `electron-user-data/`。
- 菜单和托盘的“检查桌面更新”只查询 `ywu3309-afk/super-proxy` 的稳定 Release。
- 私人附件访问使用当前进程的 `GH_TOKEN` / `GITHUB_TOKEN`，或本机 Git Credential Manager 已配置的 GitHub 授权；不把凭据打包、写日志或发送给页面。
- 下载请求只允许 GitHub API 及 GitHub 附件主机；跳转到附件主机时不会转发 Authorization。
- SHA-256、版本、平台、仓库和 ZIP 路径均检查后，再由复制到独立暂存目录的 Python 助手替换程序。
- 保留 `data/` 和 `electron-user-data/`，旧程序移到同级 `.previous-*` 目录。新程序启动健康检查失败时尝试回滚。
- 源码模式、自定义运行根目录与不带 Python 的包不支持就地安装；更新器不修改系统服务、注册表或全局 Git 配置。
- Windows 便携版在“设置 → 开机自启动”或“软件 → 开机自启动”开启后，使用 Electron 原生接口登记当前用户的 Windows 启动项（`SuperProxy`），路径取当前正在运行的 EXE，不包含开发机固定路径。新安装默认关闭；关闭开关会移除此启动项。
- 开机自启动在登录 Windows 后运行网关并收起到系统托盘；双击托盘图标打开界面，手动打开 EXE 始终显示窗口。此设置属于当前电脑的 Windows 用户，不随账号数据同步到朋友的电脑；移动便携目录后应在新目录里重新开启一次。
