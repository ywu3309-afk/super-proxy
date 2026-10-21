// Electron owns the per-user Windows Run entry; no startup scripts or services.
const LOGIN_ITEM_NAME = 'SuperProxy';
const LOGIN_ARGS = ['--autostart'];
const STATUS_CHANNEL = 'super-proxy:autostart:status';
const SET_CHANNEL = 'super-proxy:autostart:set';

function createAutostart({ app, platform = process.platform, executablePath = process.execPath }) {
  const supported = platform === 'win32' && app.isPackaged;
  const options = () => ({ path: executablePath, args: [...LOGIN_ARGS] });

  function getStatus() {
    if (!supported) {
      return {
        supported: false, enabled: false,
        reason: platform !== 'win32' ? '仅支持 Windows 桌面软件' : '请在打包后的桌面软件中设置'
      };
    }
    // Electron parses this lookup as a command line, so quote paths with spaces.
    const settings = app.getLoginItemSettings({ ...options(), path: `"${executablePath}"` });
    // openAtLogin only checks Electron's default AppUserModelID, not our custom
    // registry name. launchItems is authoritative for the named per-user entry.
    // launchItems.args omits Chromium switches such as --autostart. Match the
    // exact EXE (filtered by Electron), our entry name and the current user.
    const item = settings.launchItems?.find(value => value.name === LOGIN_ITEM_NAME && value.scope === 'user');
    const registered = !!item;
    const approved = item?.enabled === true;
    return {
      supported: true, enabled: registered && approved, blocked: registered && !approved,
      registered, executablePath
    };
  }

  function setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('开机自启动参数必须为布尔值');
    if (!supported) throw new Error(getStatus().reason);
    app.setLoginItemSettings({ ...options(), name: LOGIN_ITEM_NAME, openAtLogin: enabled, enabled });
    const status = getStatus();
    if (status.enabled !== enabled || (!enabled && status.registered)) {
      throw new Error('Windows 未保存开机自启动设置，请检查系统的启动应用设置后重试');
    }
    return status;
  }

  return { getStatus, setEnabled };
}

function installAutostartIPC({ ipcMain, autostart, getWindow, getOrigin, onChange = () => {} }) {
  function assertPanel(event) {
    const contents = getWindow()?.webContents;
    if (!contents || event.sender !== contents || event.senderFrame !== contents.mainFrame) {
      throw new Error('仅允许桌面主窗口修改开机自启动');
    }
    let url;
    try { url = new URL(event.senderFrame.url); } catch { /* rejected below */ }
    if (!url || url.origin !== getOrigin() || url.pathname !== '/') {
      throw new Error('仅允许本机网关控制面板修改开机自启动');
    }
  }
  ipcMain.handle(STATUS_CHANNEL, event => {
    assertPanel(event);
    return autostart.getStatus();
  });
  ipcMain.handle(SET_CHANNEL, (event, enabled) => {
    assertPanel(event);
    try { return autostart.setEnabled(enabled); }
    finally { onChange(); }
  });
}

module.exports = { createAutostart, installAutostartIPC, LOGIN_ITEM_NAME, LOGIN_ARGS, STATUS_CHANNEL, SET_CHANNEL };
