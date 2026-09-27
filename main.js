'use strict';

const { app, BrowserWindow, ipcMain, dialog, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const XLSX = require('xlsx');

const isSmoke = process.env.SMOKE_TEST === '1';

const isPackaged = app.isPackaged;

// 纯界面应用无需 GPU 硬件加速，禁用可避免部分驱动/远程环境的显示异常
app.disableHardwareAcceleration();

// 打包后沿用开发版 userData 目录（保持设置/待办/累计的连续性）
if (isPackaged) {
  app.setPath('userData', path.join(app.getPath('appData'), 'tomato-clock'));
}

// 学习记录文件位置：开发版在项目目录，便携版放在 exe 同目录（数据跟着 exe 走）
function recordFilePath() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return path.join(process.env.PORTABLE_EXECUTABLE_DIR, '学习记录.xlsx');
  }
  return path.join(__dirname, '学习记录.xlsx');
}

// 防止重复打开多个实例
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

/* ---------- 窗口状态持久化（位置/大小/置顶/锁定） ---------- */

const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch (e) {
    return null;
  }
}

// 校验保存的坐标是否仍在某个显示器范围内，避免显示器变化后窗口跑到屏幕外
function boundsVisible(b) {
  if (b == null || b.x == null || b.y == null) return true;
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y;
  });
}

function createWindow() {
  const saved = loadWindowState() || {};

  const win = new BrowserWindow({
    width: saved.width || 560,
    height: saved.height || 600,
    minWidth: 380,
    minHeight: 300,
    x: boundsVisible(saved) ? saved.x : undefined,
    y: boundsVisible(saved) ? saved.y : undefined,
    title: '番茄钟',
    frame: false,                            // 无边框
    backgroundColor: '#f6f4ef',
    autoHideMenuBar: true,
    resizable: true,
    alwaysOnTop: saved.alwaysOnTop !== false, // 默认置顶
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.setMovable(saved.locked !== true);     // 锁定位置时禁止拖动

  win.loadFile('index.html');

  /* 窗口状态变化时保存 */
  const saveState = () => {
    try {
      const b = win.getBounds();
      fs.writeFileSync(stateFile(), JSON.stringify({
        x: b.x, y: b.y, width: b.width, height: b.height,
        alwaysOnTop: win.isAlwaysOnTop(),
        locked: !win.isMovable()
      }));
    } catch (e) {}
  };
  win.on('moved', saveState);
  win.on('resized', saveState);
  win.on('close', saveState);

  /* 关闭前：把未记录的「本次学习」时间自动写入 Excel（>=1 分钟才记），避免数据丢失 */
  let allowClose = false;
  win.on('close', (e) => {
    if (allowClose) return;
    e.preventDefault();
    win.webContents.executeJavaScript('window.__getPendingMs ? window.__getPendingMs() : 0')
      .then((ms) => {
        const mins = Math.round(Number(ms || 0) / 60000);
        if (mins >= 1) appendRecord(todayDateStr(), mins);
      })
      .catch(() => {})
      .finally(() => {
        allowClose = true;
        win.close();
      });
  });

  /* 把当前置顶/锁定状态同步给渲染进程（用于按钮高亮） */
  const sendState = () => {
    win.webContents.send('win-state', {
      alwaysOnTop: win.isAlwaysOnTop(),
      locked: !win.isMovable()
    });
  };
  win.webContents.on('did-finish-load', sendState);

  /* 冒烟测试支持：SMOKE_TEST=1 时加载完成后写结果文件并退出 */
  if (isSmoke) {
    const resultFile = path.join(__dirname, 'smoke-result.txt');
    const writeResult = (txt) => { try { fs.writeFileSync(resultFile, txt); } catch (e) {} };
    writeResult('STARTED');
    win.webContents.on('render-process-gone', (e, details) => {
      writeResult('RENDERER GONE: ' + (details && details.reason));
    });
    const timer = setTimeout(() => { writeResult('TIMEOUT'); app.exit(2); }, 8000);
    win.webContents.once('did-finish-load', () => {
      clearTimeout(timer);
      writeResult('OK');
      app.exit(0);
    });
    win.webContents.once('did-fail-load', (e, code, desc) => {
      writeResult('LOAD FAIL: ' + code + ' ' + desc);
    });
  }
}

app.whenReady().then(() => {
  cleanupLegacyRunEntries();  // 清理旧版自启动残留
  validateAutoLaunchEntry();  // 清理指向已不存在文件的失效条目
  normalizeRecordsFile();     // 合并 Excel 里已有的重复日期（每天一行）
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ---------- 窗口控制（渲染进程调用） ---------- */

function winOf(event) {
  return BrowserWindow.fromWebContents(event.sender);
}

function stateOf(win) {
  return { alwaysOnTop: win.isAlwaysOnTop(), locked: !win.isMovable() };
}

ipcMain.on('win-minimize', (e) => { const w = winOf(e); if (w) w.minimize(); });

ipcMain.on('win-close', (e) => { const w = winOf(e); if (w) w.close(); });

ipcMain.on('win-toggle-top', (e) => {
  const w = winOf(e);
  if (!w) return;
  w.setAlwaysOnTop(!w.isAlwaysOnTop());
  w.webContents.send('win-state', stateOf(w));
});

ipcMain.on('win-toggle-lock', (e) => {
  const w = winOf(e);
  if (!w) return;
  w.setMovable(!w.isMovable());
  w.webContents.send('win-state', stateOf(w));
});

// 渲染进程按内容高度自适应窗口（展开/收起区块时调用）
ipcMain.on('win-resize', (e, w, h) => {
  const win = winOf(e);
  if (!win) return;
  const W = Math.max(380, Math.min(760, Math.round(w)));
  const H = Math.max(300, Math.min(1200, Math.round(h)));
  win.setSize(W, H);
});

/* ---------- 开机自启动（直接管理注册表 Run 键，读写完全可控） ---------- */
// 说明：不用 app.setLoginItemSettings，因为它的"写入-回读检测"不可靠（写入成功但
// getLoginItemSettings 仍返回 false），导致开关点了没反应。这里用 reg.exe 自己读写。

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_NAME = 'TomatoClock';                                   // 本次使用的值名
const LEGACY_RUN_NAMES = ['electron.app.tomato-clock', 'tomato-clock']; // 旧版接口残留

function regExec(args) {
  return new Promise((resolve) => {
    execFile('reg', args, { windowsHide: true }, (err) => resolve(!err));
  });
}

function readAutoLaunch() {
  return new Promise((resolve) => {
    execFile('reg', ['query', RUN_KEY], { windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve(false);
      const s = stdout;
      resolve(s.includes(RUN_NAME) || LEGACY_RUN_NAMES.some((n) => s.includes(n)));
    });
  });
}

// 启动时校验自启动条目：若指向的文件已不存在（如旧版便携把路径写进了临时目录），自动清理
function validateAutoLaunchEntry() {
  return new Promise((resolve) => {
    execFile('reg', ['query', RUN_KEY, '/v', RUN_NAME], { windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve();
      const m = String(stdout).match(/"([^"]+)"/);
      const p = m ? m[1] : null;
      if (p && !fs.existsSync(p)) {
        regExec(['delete', RUN_KEY, '/v', RUN_NAME, '/f']);
      }
      resolve();
    });
  });
}

async function writeAutoLaunch(enabled) {
  // 先清掉自身与旧版残留，避免重复/损坏条目
  for (const n of [RUN_NAME, ...LEGACY_RUN_NAMES]) {
    await regExec(['delete', RUN_KEY, '/v', n, '/f']);
  }
  if (enabled) {
    let cmd;
    if (process.env.PORTABLE_EXECUTABLE_FILE) {
      // 便携版：注册表必须指向"真实"的便携 exe（$EXEPATH）。
      // 注意：便携版运行时 process.execPath 是临时解压目录里的程序，关掉就被清理，
      // 写成它会导致开机启动失败。
      cmd = `"${process.env.PORTABLE_EXECUTABLE_FILE}"`;
    } else if (isPackaged) {
      cmd = `"${process.execPath}"`;
    } else {
      // 开发版：electron.exe + 应用目录
      cmd = `"${process.execPath}" "${__dirname}"`;
    }
    await regExec(['add', RUN_KEY, '/v', RUN_NAME, '/t', 'REG_SZ', '/d', cmd, '/f']);
  }
  return readAutoLaunch();
}

// 每次启动顺手清掉旧版接口写入的残留条目
function cleanupLegacyRunEntries() {
  for (const n of LEGACY_RUN_NAMES) {
    regExec(['delete', RUN_KEY, '/v', n, '/f']);
  }
}

ipcMain.handle('get-auto-launch', () => readAutoLaunch());

ipcMain.handle('set-auto-launch', (e, enabled) => writeAutoLaunch(!!enabled));

/* ---------- 学习记录（本地 Excel） ---------- */

// 打包前用 const；运行时根据 PORTABLE_EXECUTABLE_DIR 决定（开发版 = 项目目录，便携版 = exe 同目录）
let RECORD_FILE = recordFilePath();

function todayDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 今日学习程度：按当天累计分钟数判定
function levelFor(totalMin) {
  if (totalMin < 120) return '不足';   // < 2 小时
  if (totalMin < 240) return '适宜';   // 2 ~ 4 小时
  if (totalMin < 360) return '努力';   // 4 ~ 6 小时
  return '过度';                        // >= 6 小时
}

// 读取全部记录 [{date, minutes, level}]；兼容旧版两列文件（level 为空字符串）
function readRecords() {
  try {
    if (!fs.existsSync(RECORD_FILE)) return [];
    const wb = XLSX.readFile(RECORD_FILE);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
    const out = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || r.length < 2) continue;
      const date = String(r[0]).trim();
      const minutes = Math.round(Number(r[1]));
      if (/^\d{4}-\d{2}-\d{2}$/.test(date) && minutes > 0) {
        out.push({ date, minutes, level: r[2] != null ? String(r[2]).trim() : '' });
      }
    }
    return out;
  } catch (e) {
    return null; // 读取失败（如文件被占用）
  }
}

// 按日期合并：每天只保留一行，学习时间累加，按日期升序
function mergeRecords(records, addDate, addMinutes) {
  const byDate = {};
  records.forEach((r) => {
    byDate[r.date] = (byDate[r.date] || 0) + r.minutes;
  });
  if (addDate) byDate[addDate] = (byDate[addDate] || 0) + addMinutes;
  return Object.keys(byDate)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort()
    .map((d) => ({ date: d, minutes: byDate[d], level: levelFor(byDate[d]) }));
}

function writeRecords(list) {
  const aoa = [['日期', '学习时间(分钟)', '今日学习程度']];
  list.forEach((r) => aoa.push([r.date, r.minutes, r.level]));
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 12 }, { wch: 16 }, { wch: 12 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '学习记录');
  XLSX.writeFile(wb, RECORD_FILE);
}

// 追加一条记录（同日期自动累计进同一行）；失败返回 null
function appendRecord(date, minutes) {
  try {
    const records = readRecords() || [];
    writeRecords(mergeRecords(records, date, minutes));
    return readRecords();
  } catch (e) {
    return null;
  }
}

// 启动时把旧文件里的重复日期合并掉（每天只留一行）；无重复则不重写
function normalizeRecordsFile() {
  try {
    if (!fs.existsSync(RECORD_FILE)) return;
    const records = readRecords();
    if (records == null || records.length === 0) return;
    const merged = mergeRecords(records, null, 0);
    if (merged.length === records.length) return; // 没有重复
    writeRecords(merged);
  } catch (e) {}
}

ipcMain.handle('read-records', () => readRecords());
ipcMain.handle('record-study', (e, date, minutes) => appendRecord(date, minutes));
ipcMain.handle('get-record-file', () => RECORD_FILE);

/* ---------- 音频选择与读取 ---------- */

const MIME_MAP = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  aac: 'audio/aac',
  wma: 'audio/x-ms-wma'
};

function readAudioPayload(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase().replace('.', '') || 'bin';
    const mime = MIME_MAP[ext] || 'application/octet-stream';
    return {
      path: filePath,
      name: path.basename(filePath),
      dataUrl: `data:${mime};base64,${buf.toString('base64')}`
    };
  } catch (err) {
    return { path: filePath, name: path.basename(filePath), dataUrl: null, error: String(err) };
  }
}

ipcMain.handle('select-audio', async () => {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  const res = await dialog.showOpenDialog(win, {
    title: '选择音频文件',
    properties: ['openFile'],
    filters: [
      { name: '音频文件', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'wma'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
  if (res.canceled || !res.filePaths.length) return null;
  return readAudioPayload(res.filePaths[0]);
});

ipcMain.handle('load-audio', (event, filePath) => {
  if (!filePath) return null;
  return readAudioPayload(filePath);
});
