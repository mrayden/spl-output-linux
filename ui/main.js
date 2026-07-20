const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, session } = require('electron');
const { spawn, execFile } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Talk to the installed dbmon via python3, independent of PATH.
const DBMON = path.join(os.homedir(), '.local', 'share', 'dbmon', 'dbmon.py');
const SETTINGS_FILE = path.join(app.getPath('userData'), 'ui-settings.json');

function loadSettings() {
  try { return Object.assign({ tray: false, allDefault: false }, JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))); }
  catch (e) { return { tray: false, allDefault: false }; }
}
function saveSettings(s) {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s));
  } catch (e) {}
}
let settings = loadSettings();

function runJSON(args) {
  return new Promise((resolve, reject) => {
    execFile('python3', [DBMON, ...args], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(stdout)); }
      catch (e) { reject(new Error('bad JSON from dbmon: ' + e.message)); }
    });
  });
}
function runCmd(args) {
  return new Promise((resolve, reject) => {
    execFile('python3', [DBMON, ...args], (err, stdout) => err ? reject(err) : resolve(stdout.trim()));
  });
}

let win = null, liveProc = null, tray = null, isQuitting = false;

function startLive() {
  stopLive();
  liveProc = spawn('python3', [DBMON, 'live', '--json']);
  let buf = '';
  liveProc.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try { const obj = JSON.parse(line); if (win) win.webContents.send('live', obj); }
      catch (e) { /* ignore */ }
    }
  });
  liveProc.on('error', () => {});
}
function stopLive() {
  if (liveProc) { try { liveProc.kill('SIGTERM'); } catch (e) {} liveProc = null; }
}

function createTray(image) {
  if (tray) return;
  tray = new Tray(image);
  tray.setToolTip('SPL Output Monitor');
  const menu = Menu.buildFromTemplate([
    { label: 'Show window', click: showWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
  tray.on('click', showWindow);
}
function destroyTray() { if (tray) { try { tray.destroy(); } catch (e) {} tray = null; } }

function showWindow() {
  if (!win) return createWindow();
  win.show(); win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1120, height: 860, minWidth: 820, minHeight: 640,
    backgroundColor: '#0f1115', title: 'SPL Output Monitor',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.on('did-finish-load', startLive);
  win.on('close', (e) => {
    if (settings.tray && !isQuitting) { e.preventDefault(); win.hide(); }
  });
  win.on('closed', () => { win = null; });
}

ipcMain.handle('report', (e, { days, all, device }) =>
  runJSON(['report', '--json', '--days', String(days), ...(all ? ['--all'] : []), ...(device ? ['--device', device] : [])]));
ipcMain.handle('devices', () => runJSON(['devices', '--json']));
ipcMain.handle('setCap', (e, v) => runCmd(['cap', String(v)]));
ipcMain.handle('whitelist', (e, { match, on }) => runCmd(['whitelist', on ? 'add' : 'rm', match]));
ipcMain.handle('playtone', (e, { freq, level }) => runJSON(['playtone', '--freq', String(freq), '--level', String(level), '--seconds', '2']));
ipcMain.handle('addCalib', (e, { device, volume, freq, slope, offset }) => runCmd(['addcalib', '--device', device, '--volume', String(volume), '--freq', String(freq), '--slope', String(slope), '--offset', String(offset)]));
ipcMain.handle('calibList', () => runJSON(['showcalib', '--json']));
ipcMain.handle('delCalib', (e, { device, volume, freq }) => runCmd(['delcalib', '--device', device, '--volume', String(volume), '--freq', String(freq)]));
ipcMain.handle('getUiSettings', () => settings);
ipcMain.handle('setUiSetting', (e, { key, value }) => {
  settings[key] = value; saveSettings(settings);
  if (key === 'tray' && !value) destroyTray();
  return settings;
});
ipcMain.on('tray-update', (e, { image, tip }) => {
  if (!settings.tray) return;
  try {
    const img = nativeImage.createFromDataURL(image);
    if (!tray) createTray(img); else tray.setImage(img);
    if (tip) tray.setToolTip(tip);
  } catch (err) {}
});

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(true));
  session.defaultSession.setPermissionCheckHandler(() => true);
  createWindow();
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('window-all-closed', () => { if (!settings.tray) { stopLive(); app.quit(); } });
app.on('before-quit', () => { isQuitting = true; stopLive(); });
