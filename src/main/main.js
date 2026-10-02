'use strict';
const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { Backend, Checker, findPython, pythonVersion } = require('./pythonProcess');
const { decodeBuffer, encodeForSave } = require('./encoding');
const { buildMenu, examplesDir } = require('./menu');

const DEFAULT_SETTINGS = {
  pythonPath: '',
  fontSize: 16,
  theme: 'light',
  stringEncoding: 'cp1253',
  saveBeforeRun: true,
  minimap: true,
  wordWrap: false,
  showWhitespace: false,
  showVariables: true,
  showAssistant: true,
  liveCheck: true,
  openFiles: [],
  activeFile: null,
  recentFiles: [],
  layout: {},
  window: { width: 1300, height: 840, maximized: false },
};

let win = null;
function debugLog(...a) {
  const line = a.map(String).join(' ');
  if (process.env.EPAL_LOG) fs.appendFileSync(process.env.EPAL_LOG, line + String.fromCharCode(10));
  else console.log(line);
}
let settings = { ...DEFAULT_SETTINGS };
let forceClose = false;
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    const data = JSON.parse(fs.readFileSync(settingsFile(), 'utf-8'));
    settings = { ...DEFAULT_SETTINGS, ...data };
  } catch (_) {
    settings = { ...DEFAULT_SETTINGS };
  }
  settings.pythonPath = findPython(settings.pythonPath) || '';
}

let saveTimer = null;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
      fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), 'utf-8');
    } catch (_) { /* μη κρίσιμο */ }
  }, 300);
}

function workDir() {
  const dir = path.join(app.getPath('documents'), 'Python2');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* υπάρχει */ }
  return dir;
}

const getPython = () => settings.pythonPath;
const backend = new Backend(getPython);
const checker = new Checker(getPython);

backend.on('message', (msg) => {
  if (win && !win.isDestroyed()) win.webContents.send('backend', msg);
});

// --- Παραδείγματα ------------------------------------------------------------
function listExamples() {
  const dir = examplesDir.replace('app.asar', 'app.asar.unpacked');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.py')).sort(); } catch (_) { return []; }
  return files.map((file) => {
    let title = file.replace(/\.py$/, '');
    try {
      const { text } = decodeBuffer(fs.readFileSync(path.join(dir, file)));
      const m = /^#\s*Παράδειγμα:\s*(.+)$/m.exec(text);
      if (m) title = m[1].trim();
    } catch (_) { /* χρησιμοποιούμε το όνομα αρχείου */ }
    return { file: path.join(dir, file), title };
  });
}

/** Αντιγράφει το παράδειγμα στον φάκελο Έγγραφα\Python2\Παραδείγματα (για να μη χαλάσει το πρωτότυπο). */
function copyExample(src) {
  const dir = path.join(workDir(), 'Παραδείγματα');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, path.basename(src));
  if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
  return dest;
}

// --- Μενού -------------------------------------------------------------------
function sendMenu(id, arg) {
  if (win && !win.isDestroyed()) win.webContents.send('menu', id, arg);
}

function refreshMenu() {
  Menu.setApplicationMenu(buildMenu({
    send: sendMenu,
    settings,
    examples: listExamples(),
    recent: settings.recentFiles,
    openRecent: (p) => sendMenu('openPath', p),
  }));
}

function addRecent(p) {
  settings.recentFiles = [p, ...settings.recentFiles.filter((x) => x.toLowerCase() !== p.toLowerCase())].slice(0, 12);
  saveSettings();
  refreshMenu();
}

// --- Αρχεία ------------------------------------------------------------------
function readSource(p) {
  const buf = fs.readFileSync(p);
  const { text, encoding } = decodeBuffer(buf);
  return { path: p, content: text, encoding };
}

const PY_FILTERS = [
  { name: 'Προγράμματα Python', extensions: ['py', 'pyw'] },
  { name: 'Κείμενο', extensions: ['txt', 'csv', 'dat'] },
  { name: 'Όλα τα αρχεία', extensions: ['*'] },
];

function writeSource(p, content) {
  const enc = encodeForSave(content);
  if (enc.error) {
    return {
      ok: false,
      error: `Ο χαρακτήρας «${enc.char}» (γραμμή ${enc.line}) δεν υπάρχει στην κωδικοποίηση ${enc.encoding} ` +
        'που δηλώνει το αρχείο στην πρώτη γραμμή (coding). Άλλαξε τη δήλωση σε utf-8 ή αφαίρεσε τον χαρακτήρα.',
    };
  }
  try {
    fs.writeFileSync(p, enc.buffer);
  } catch (e) {
    return { ok: false, error: `Δεν ήταν δυνατή η αποθήκευση: ${e.message}` };
  }
  addRecent(p);
  return { ok: true, path: p, encoding: enc.encoding };
}

ipcMain.handle('file:open', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Άνοιγμα προγράμματος',
    defaultPath: workDir(),
    filters: PY_FILTERS,
    properties: ['openFile', 'multiSelections'],
  });
  if (r.canceled) return [];
  return r.filePaths.map((p) => { const s = readSource(p); addRecent(p); return s; });
});

ipcMain.handle('file:read', (_e, p) => {
  try { return readSource(p); } catch (e) { return { error: e.message }; }
});

ipcMain.handle('file:save', (_e, p, content) => writeSource(p, content));

ipcMain.handle('file:saveAs', async (_e, content, suggested) => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Αποθήκευση προγράμματος',
    defaultPath: suggested && path.isAbsolute(suggested) ? suggested : path.join(workDir(), suggested || 'πρόγραμμα.py'),
    filters: PY_FILTERS,
  });
  if (r.canceled || !r.filePath) return null;
  let p = r.filePath;
  if (!path.extname(p)) p += '.py';
  return writeSource(p, content);
});

ipcMain.handle('file:exists', (_e, p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } });
ipcMain.handle('file:showInFolder', (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('example:open', (_e, src) => {
  try { const dest = copyExample(src); addRecent(dest); return readSource(dest); } catch (e) { return { error: e.message }; }
});

ipcMain.handle('dialog:unsaved', async (_e, names) => {
  const r = await dialog.showMessageBox(win, {
    type: 'warning',
    title: 'Μη αποθηκευμένες αλλαγές',
    message: names.length === 1
      ? `Το «${names[0]}» έχει αλλαγές που δεν αποθηκεύτηκαν.`
      : `Υπάρχουν αλλαγές που δεν αποθηκεύτηκαν σε ${names.length} αρχεία:\n${names.join('\n')}`,
    detail: 'Θέλεις να τις αποθηκεύσεις;',
    buttons: ['Αποθήκευση', 'Χωρίς αποθήκευση', 'Άκυρο'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  return ['save', 'discard', 'cancel'][r.response];
});

ipcMain.handle('dialog:message', (_e, opts) => dialog.showMessageBox(win, { noLink: true, ...opts }));

ipcMain.handle('dialog:choosePython', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Επιλογή python.exe (Python 2.7)',
    defaultPath: settings.pythonPath || 'C:\\',
    filters: [{ name: 'python.exe', extensions: ['exe'] }],
    properties: ['openFile'],
  });
  return r.canceled ? null : r.filePaths[0];
});

// --- Ρυθμίσεις / Python ---------------------------------------------------------
ipcMain.handle('settings:get', () => ({ ...settings, workDir: workDir() }));
ipcMain.handle('settings:set', (_e, patch) => {
  const pythonChanged = patch.pythonPath !== undefined && patch.pythonPath !== settings.pythonPath;
  settings = { ...settings, ...patch };
  saveSettings();
  if (['theme', 'minimap', 'wordWrap', 'showWhitespace', 'showVariables', 'showAssistant', 'stringEncoding']
    .some((k) => k in patch)) refreshMenu();
  if (pythonChanged) checker.reset();
  return settings;
});
ipcMain.handle('python:info', () => pythonVersion(settings.pythonPath).then((v) => ({ ...v, path: settings.pythonPath })));
ipcMain.handle('python:test', (_e, p) => pythonVersion(p));

// --- Εκτέλεση -------------------------------------------------------------------
ipcMain.on('backend:run', (_e, { path: p, source }) => {
  backend.run({ path: p, source, encoding: settings.stringEncoding });
});
ipcMain.on('backend:shell', () => backend.shell({ cwd: workDir(), encoding: settings.stringEncoding }));
ipcMain.on('backend:stop', () => backend.stop());
ipcMain.on('backend:input', (_e, text) => backend.input(text));
ipcMain.on('backend:repl', (_e, line) => backend.repl(line));
ipcMain.handle('check', (_e, source) => checker.check(source, settings.stringEncoding));

ipcMain.on('app:closeNow', () => { forceClose = true; if (win) win.close(); });

// --- Παράθυρο -------------------------------------------------------------------
function createWindow() {
  const w = settings.window || {};
  win = new BrowserWindow({
    width: w.width || 1300,
    height: w.height || 840,
    x: w.x,
    y: w.y,
    minWidth: 760,
    minHeight: 480,
    title: 'Python 2.7 ΕΠΑΛ',
    backgroundColor: settings.theme === 'dark' ? '#1e1f22' : '#ffffff',
    icon: path.join(__dirname, '..', 'renderer', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  if (w.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // σύνδεσμοι προς εξωτερικές σελίδες ανοίγουν στον browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  const rememberBounds = () => {
    if (!win || win.isDestroyed()) return;
    const maximized = win.isMaximized();
    settings.window = maximized ? { ...settings.window, maximized } : { ...win.getBounds(), maximized };
    saveSettings();
  };
  win.on('resize', rememberBounds);
  win.on('move', rememberBounds);

  win.on('close', (e) => {
    if (!forceClose) {
      e.preventDefault();
      win.webContents.send('menu', 'requestClose');
    }
  });
  win.on('closed', () => { win = null; });

  if (process.env.EPAL_DEBUG) {
    win.webContents.on('console-message', (e, level, message) => {
      debugLog('[renderer]', (e && e.message) || message);
    });
  }
  // Εργαλείο ανάπτυξης: EPAL_SCREENSHOT=αρχείο.png [EPAL_SCRIPT=αρχείο.js] [EPAL_WAIT=ms]
  if (process.env.EPAL_SCREENSHOT) {
    win.webContents.once('did-finish-load', async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      await wait(Number(process.env.EPAL_WAIT) || 2500);
      if (process.env.EPAL_SCRIPT) {
        try {
          const result = await win.webContents.executeJavaScript(fs.readFileSync(process.env.EPAL_SCRIPT, 'utf-8'));
          if (result !== undefined) debugLog('[script]', typeof result === 'string' ? result : JSON.stringify(result));
        } catch (e) { debugLog('[script error]', e.message); }
        await wait(Number(process.env.EPAL_WAIT2) || 2000);
      }
      const img = await win.webContents.capturePage();
      fs.writeFileSync(process.env.EPAL_SCREENSHOT, img.toPNG());
      forceClose = true;
      app.quit();
    });
  }
}

if (process.env.EPAL_USERDATA) app.setPath('userData', process.env.EPAL_USERDATA);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    const file = argv.slice(1).find((a) => /\.pyw?$/i.test(a));
    if (file) sendMenu('openPath', path.resolve(file));
  });

  app.whenReady().then(() => {
    loadSettings();
    refreshMenu();
    createWindow();
    const file = process.argv.slice(1).find((a) => /\.pyw?$/i.test(a) && fs.existsSync(a));
    if (file) win.webContents.once('did-finish-load', () => sendMenu('openPath', path.resolve(file)));
  });

  app.on('window-all-closed', () => {
    backend.stop();
    checker.dispose();
    clearTimeout(saveTimer);
    try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), 'utf-8'); } catch (_) { /* */ }
    app.quit();
  });
}
