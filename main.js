'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, nativeTheme, shell, session } = require('electron');
const { spawn } = require('child_process');
const https  = require('https');
const http   = require('http');
const crypto2 = require('crypto');
const fs   = require('fs');
const zlib = require('zlib');
const path = require('path');
const os   = require('os');

const LOG_FILE = path.join(__dirname, 'gdos.log');
function log(lvl) {
  const args = Array.prototype.slice.call(arguments, 1);
  const ts   = new Date().toISOString();
  const msg  = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  const line = '[' + ts + '] [' + lvl + '] ' + msg + '\n';
  process.stdout.write(line);
  try { fs.appendFileSync(LOG_FILE, line); } catch (_) {}
}
const logger = {
  info:  (...a) => log('INFO ', ...a),
  warn:  (...a) => log('WARN ', ...a),
  error: (...a) => log('ERROR', ...a),
  debug: (...a) => log('DEBUG', ...a),
};

const MAGIC = Buffer.from('DOSI');
const VER   = 2;

function encodeDosi(payload, cols, rows) {
  const deflated = zlib.deflateSync(Buffer.from(JSON.stringify(payload), 'utf8'), { level: 9 });
  const hdr = Buffer.alloc(12);
  MAGIC.copy(hdr, 0);
  hdr.writeUInt16LE(VER,  4);
  hdr.writeUInt16LE(cols, 6);
  hdr.writeUInt16LE(rows, 8);
  hdr.writeUInt16LE(0,   10);
  return Buffer.concat([hdr, deflated]);
}

function decodeDosi(buf) {
  if (!buf.slice(0, 4).equals(MAGIC)) throw new Error('Not a valid .dosi file');
  const cols    = buf.readUInt16LE(6);
  const rows    = buf.readUInt16LE(8);
  const payload = JSON.parse(zlib.inflateSync(buf.slice(12)).toString('utf8'));
  logger.info('decodeDosi: cols=' + cols + ' rows=' + rows);
  return { cols, rows, payload };
}

function historyPath(fp) { return fp.replace(/\.dosi$/, '') + '.dosih'; }

function appendHistory(fp, snapshot) {
  const hp = historyPath(fp);
  const entry = JSON.stringify({ ts: Date.now(), snap: snapshot }) + '\n';
  try { fs.appendFileSync(hp, entry, 'utf8'); } catch (e) { logger.warn('history write fail: ' + e.message); }
}

function loadHistory(fp) {
  const hp = historyPath(fp);
  if (!fs.existsSync(hp)) return [];
  try {
    return fs.readFileSync(hp, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch (e) { logger.warn('history load fail: ' + e.message); return []; }
}

function clearHistory(fp) {
  const hp = historyPath(fp);
  try { fs.writeFileSync(hp, '', 'utf8'); } catch (_) {}
}


const PUBKEY_B64 = (() => {
  const candidates = [
    path.join(path.dirname(process.execPath), 'gdos.pubkey'),
    path.join(__dirname, 'gdos.pubkey'),
  ];
  for (const p of candidates) {
    try { const k = fs.readFileSync(p,'utf8').trim(); if (k.length>20) return k; } catch(_){}
  }
  return 'MCowBQYDK2VwAyEA/HpdO6U1Hh+2jvGzvP7m+eJ9bNdD5n3+GQ+EEMV9i94=';
})();

const APP_VERSION = app.getVersion();
const UPDATE_HOST = 'update.nezili.uk';
const UPDATE_PATH = '/latest.json';
const IS_PACKAGED = app.isPackaged;

let splashWin = null;
let mainWin   = null;

function splashSend(state, data) {
  if (splashWin && !splashWin.isDestroyed())
    splashWin.webContents.send('splash-state', state, data || {});
}

function httpsGet(host, path_) {
  return new Promise((resolve, reject) => {
    const req = https.get({ host, path: path_, headers: { 'User-Agent': 'G-Dos/' + APP_VERSION } }, res => {
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Connection timed out')); });
    req.on('error', reject);
  });
}

function httpsDownload(url, onProgress) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const get = parsed.protocol === 'https:' ? https.get : http.get;
    get(url, { headers: { 'User-Agent': 'G-Dos/' + APP_VERSION } }, res => {
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      const total = parseInt(res.headers['content-length'] || '0');
      let loaded = 0;
      const chunks = [];
      res.on('data', c => {
        chunks.push(c); loaded += c.length;
        onProgress(loaded, total);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function verifyManifest(manifest) {
  try {
    const { signature, ...payload } = manifest;
    if (!signature) return false;
    const raw = Buffer.from(PUBKEY_B64, 'base64');
    const pubPem = '-----BEGIN PUBLIC KEY-----\n' +
      raw.toString('base64').match(/.{1,64}/g).join('\n') +
      '\n-----END PUBLIC KEY-----';
    return crypto2.verify(null,
      Buffer.from(JSON.stringify(payload)),
      { key: pubPem, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64')
    );
  } catch(e) { logger.error('verifyManifest:', e.message); return false; }
}

function semverNewer(latest, current) {
  const l = latest.split('.').map(Number);
  const c = current.split('.').map(Number);
  return l.reduce((a,n,i) => a !== 0 ? a : n > (c[i]||0) ? 1 : n < (c[i]||0) ? -1 : 0, 0) > 0;
}

async function checkForUpdates() {
  splashSend('checking', { msg: 'Connecting to update server…' });
  try {
    const raw = await httpsGet(UPDATE_HOST, UPDATE_PATH);
    const manifest = JSON.parse(raw);
    if (!manifest.version || !manifest.signature)
      throw new Error('Invalid manifest from server');
    if (manifest.timestamp && Date.now() - manifest.timestamp > 90 * 86400000)
      throw new Error('Manifest too old — possible replay attack');
    if (!verifyManifest(manifest))
      throw new Error('Signature invalid — possible MITM attack');
    return manifest;
  } catch(e) {
    logger.warn('Update check failed: ' + e.message);
    return null;
  }
}

// ── Update marker: written before quit, read on next launch ──────────────────
const UPDATE_MARKER_FILE = path.join(app.getPath('userData'), 'pending-update.json');

function writeUpdateMarker(version) {
  try { fs.writeFileSync(UPDATE_MARKER_FILE, JSON.stringify({ version, ts: Date.now() })); }
  catch(e) { logger.warn('Could not write update marker: ' + e.message); }
}

function checkAndClearUpdateMarker() {
  try {
    if (!fs.existsSync(UPDATE_MARKER_FILE)) return null;
    const m = JSON.parse(fs.readFileSync(UPDATE_MARKER_FILE, 'utf8'));
    fs.unlinkSync(UPDATE_MARKER_FILE);
    if (Date.now() - (m.ts || 0) < 10 * 60 * 1000) return m.version;
  } catch(_) {}
  return null;
}

// ── Reliable installer launch: spawn detached so it outlives this process ────
function launchInstallerAndQuit(installerPath) {
  return new Promise(resolve => {
    try {
      let child;
      if (process.platform === 'win32') {
        child = spawn(installerPath, [], {
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        });
      } else if (process.platform === 'darwin') {
        child = spawn('open', [installerPath], { detached: true, stdio: 'ignore' });
      } else {
        child = spawn('xdg-open', [installerPath], { detached: true, stdio: 'ignore' });
      }
      child.unref();
    } catch(e) {
      logger.error('Failed to launch installer: ' + e.message);
    }
    // Give OS 1.5s to pick up the process before we exit
    setTimeout(() => { app.quit(); }, 1500);
  });
}

async function downloadUpdate(manifest) {
  const url = manifest.url;
  if (!url) throw new Error('No download URL in manifest');

  splashSend('downloading', { pct: 0, mbDl: '0.0', mbTot: '?' });

  const data = await httpsDownload(url, (loaded, total) => {
    const pct   = total ? Math.min(Math.round(loaded/total*100), 99) : 0;
    const mbDl  = (loaded/1048576).toFixed(1);
    const mbTot = total ? (total/1048576).toFixed(1) : '?';
    splashSend('downloading', { pct, mbDl, mbTot });
  });

  splashSend('downloading', { pct: 99, mbDl: (data.length/1048576).toFixed(1), mbTot: (data.length/1048576).toFixed(1) });

  if (manifest.sha256) {
    const actual = crypto2.createHash('sha256').update(data).digest('hex');
    if (actual !== manifest.sha256)
      throw new Error('SHA-256 mismatch — download may be corrupted');
  }

  const ext = url.split('.').pop().toLowerCase().replace(/[^a-z]/g, '') || 'exe';
  const tmp = path.join(app.getPath('temp'), 'gdos-update-' + manifest.version + '.' + ext);
  fs.writeFileSync(tmp, data);
  logger.info('Update downloaded to: ' + tmp);
  return tmp;
}

function createSplash() {
  splashWin = new BrowserWindow({
    width: 420, height: 360,
    frame: false, resizable: false, center: true,
    backgroundColor: '#0f1624',
    show: false,
    skipTaskbar: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  const splashHtml = path.join(__dirname, 'splash.html');
  splashWin.loadFile(splashHtml);
  splashWin.once('ready-to-show', () => {
    splashWin.show();
    splashWin.webContents.send('splash-version', APP_VERSION);
    runSplashFlow();
  });
  if (!IS_PACKAGED) {
    splashWin.webContents.on('console-message', (_, lvl, msg) => {
      if (lvl >= 2) logger.warn('[SPLASH] ' + msg);
    });
  }
}

async function runSplashFlow() {
  // If we just ran an installer, skip straight to launch — don't re-check
  const justUpdated = checkAndClearUpdateMarker();
  if (justUpdated) {
    logger.info('Post-install launch detected (v' + justUpdated + '), skipping update check');
    splashSend('launching', {});
    await new Promise(r => setTimeout(r, 500));
    launchMainWindow();
    return;
  }

  let manifest = null;
  try { manifest = await checkForUpdates(); } catch(_) {}

  if (!manifest) {
    splashSend('error', { msg: 'Could not reach the update server. Check your connection.' });
    const errChoice = await waitForSplashChoice(['skip', 'retry']);
    if (errChoice === 'retry') {
      try { manifest = await checkForUpdates(); } catch(_) {}
      if (!manifest) {
        splashSend('error', { msg: 'Still cannot reach update server. Launching anyway.' });
        await new Promise(r => setTimeout(r, 1500));
        launchMainWindow();
        return;
      }
    } else {
      splashSend('launching', {});
      await new Promise(r => setTimeout(r, 400));
      launchMainWindow();
      return;
    }
  }

  if (manifest && semverNewer(manifest.version, APP_VERSION)) {
    splashSend('available', {
      version: manifest.version,
      current: APP_VERSION,
      notes:   manifest.notes || '',
    });
    const choice = await waitForSplashChoice(['update', 'skip']);
    if (choice === 'update') {
      try {
        const installerPath = await downloadUpdate(manifest);
        writeUpdateMarker(manifest.version);
        splashSend('launching', {});
        await new Promise(r => setTimeout(r, 600));
        await launchInstallerAndQuit(installerPath);
        return;
      } catch(e) {
        logger.error('Download failed: ' + e.message);
        splashSend('error', { msg: 'Download failed: ' + e.message });
        await waitForSplashChoice(['skip']);
      }
    }
  } else if (manifest) {
    splashSend('up-to-date', {});
  }

  splashSend('launching', {});
  await new Promise(r => setTimeout(r, 500));
  launchMainWindow();
}

function waitForSplashChoice(expected) {
  return new Promise(resolve => {
    ipcMain.once('splash-choice', (_, choice) => {
      if (!expected || expected.includes(choice)) resolve(choice);
    });
  });
}

function launchMainWindow() {
  const isDark = nativeTheme.shouldUseDarkColors;
  mainWin = new BrowserWindow({
    width: 1440, height: 920, minWidth: 900, minHeight: 600,
    title: 'G-Dos',
    frame: false,
    show: false,
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: isDark ? '#1e1e1e' : '#f0f0f0',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });

  buildAndLoadUI(mainWin, isDark);

  mainWin.webContents.on('console-message', (_, level, message) => {
    if (level >= 2) {
      const lvls = ['DBG','INFO','WARN','ERR'];
      logger.warn('[UI] ' + message);
    }
  });

  mainWin.webContents.on('did-finish-load', () => {
    logger.info('Main window loaded');
    mainWin.webContents.send('theme-init', isDark ? 'dark' : 'light');
    mainWin.show();
    if (splashWin && !splashWin.isDestroyed()) splashWin.destroy();
    splashWin = null;
  });

  mainWin.on('close', e => {
    e.preventDefault();
    mainWin.webContents.send('window-close-request');
  });
  mainWin.on('closed', () => { mainWin = null; });

  nativeTheme.on('updated', () => {
    if (mainWin) mainWin.webContents.send('theme-changed', nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
  });

  mainWin.on('maximize',   () => { if (mainWin) mainWin.webContents.send('win-state', 'maximized'); });
  mainWin.on('unmaximize', () => { if (mainWin) mainWin.webContents.send('win-state', 'normal'); });
  mainWin.on('focus',      () => { if (mainWin) mainWin.webContents.send('win-state', mainWin.isMaximized() ? 'maximized' : 'normal'); });

  buildMenu();
}

function buildAndLoadUI(win, isDark) {
  const b64     = require('./ui-b64');
  const version = APP_VERSION;
  const pubkey  = PUBKEY_B64;
  const html = Buffer.from(b64, 'base64').toString('utf8')
                 .replace('__THEME__',      isDark ? 'dark' : 'light')
                 .replace('__APPDIR__',     __dirname.replace(/\\/g, '/'))
                 .replace('__APP_VERSION__', version)
                 .replace('__PUBKEY_B64__', pubkey);
  const tmp = path.join(os.tmpdir(), 'gdos-ui.html');
  fs.writeFileSync(tmp, html, 'utf8');
  win.loadFile(tmp);
}

function buildMenu() {
  function s(cmd) { return () => { if (mainWin) mainWin.webContents.send('menu', cmd); }; }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [
      { label: 'New',               accelerator: 'CmdOrCtrl+N',       click: s('new')        },
      { label: 'Open\u2026',        accelerator: 'CmdOrCtrl+O',       click: s('open')       },
      { label: 'Save',              accelerator: 'CmdOrCtrl+S',       click: s('save')       },
      { label: 'Save As\u2026',     accelerator: 'CmdOrCtrl+Shift+S', click: s('saveAs')     },
      { type: 'separator' },
      { label: 'Import Excel\u2026',                                    click: s('importXlsx') },
      { label: 'Import CSV\u2026',                                      click: s('importCsv')  },
      { type: 'separator' },
      { label: 'Export CSV',        accelerator: 'CmdOrCtrl+E',       click: s('csv')        },
      { label: 'Export Excel\u2026',                                    click: s('exportXlsx') },
      { label: 'Export PDF\u2026',                                      click: s('exportPdf')  },
      { label: 'Export SQL\u2026',                                      click: s('exportSql')  },
      { type: 'separator' },
      { role: 'quit' },
    ]},
    { label: 'Edit', submenu: [
      { label: 'Undo',              accelerator: 'CmdOrCtrl+Z',       click: s('undo')      },
      { label: 'Redo',              accelerator: 'CmdOrCtrl+Y',       click: s('redo')      },
      { type: 'separator' },
      { label: 'Clear Cells',                                           click: s('clear')     },
      { label: 'Smart Fill Down',   accelerator: 'CmdOrCtrl+D',       click: s('fillDown')  },
    ]},
    { label: 'Insert', submenu: [
      { label: 'Chart\u2026',                                           click: s('chart')       },
      { label: 'Auto-Sum Row',      accelerator: 'CmdOrCtrl+Shift+R', click: s('autoSumRow')  },
      { label: 'Auto-Sum Col',      accelerator: 'CmdOrCtrl+Shift+C', click: s('autoSumCol')  },
    ]},
    { label: 'Format', submenu: [
      { label: 'Cell Borders\u2026',           click: s('borders')  },
      { label: 'Conditional Formatting\u2026', click: s('condFmt')  },
    ]},
    { label: 'Data', submenu: [
      { label: 'Connect Database\u2026', click: s('dbConnect') },
      { label: 'Query Database\u2026',   click: s('dbQuery')   },
      { label: 'Push to Database\u2026', click: s('dbPush')    },
    ]},
    { label: 'View', submenu: [
      { label: 'Toggle Theme',      accelerator: 'CmdOrCtrl+Shift+T', click: s('toggleTheme')  },
      { label: 'Variables',         accelerator: 'CmdOrCtrl+Shift+V', click: s('vars')         },
      { label: 'History Panel',                                         click: s('historyPanel') },
    ]},
    { label: 'Help', submenu: [
      { label: 'Check for Updates\u2026', click: () => {
          if (mainWin) mainWin.webContents.send('menu', 'checkForUpdates');
        }
      },
      { type: 'separator' },
      { label: 'About G-Dos', click: () => {
          dialog.showMessageBox(mainWin || null, {
            type: 'info', title: 'About G-Dos',
            message: 'G-Dos',
            detail: 'Version ' + APP_VERSION + '\nG-Dos — a modern spreadsheet application.',
            buttons: ['OK']
          });
        }
      },
    ]},
  ]));
}


function applyCSP() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' file:; " +
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com; " +
          "style-src 'self' 'unsafe-inline'; " +
          "img-src 'self' file: data:; " +
          "font-src 'self' data:; " +
          "connect-src https://update.nezili.uk;"
        ]
      }
    });
  });
}

app.whenReady().then(() => { applyCSP(); createSplash(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!mainWin && !splashWin) createSplash(); });



ipcMain.handle('showSaveDialog',  (_, opts)       => dialog.showSaveDialog(mainWin, opts));
ipcMain.handle('showOpenDialog',  (_, opts)       => dialog.showOpenDialog(mainWin, opts));
ipcMain.handle('setTitle',        (_, t)          => { if (mainWin) mainWin.setTitle(t); });

ipcMain.handle('triggerUpdateCheck', async () => {
  const manifest = await checkForUpdates();
  if (!manifest) {
    dialog.showMessageBox(mainWin, { type:'error', title:'Update Check', message:'Could not reach update server.', detail:'Check your connection and try again.', buttons:['OK'] });
    return;
  }
  if (semverNewer(manifest.version, APP_VERSION)) {
    const notes = manifest.notes || '';
    const detail = (notes ? notes + '\n\n' : '') + 'Current: v' + APP_VERSION + '  \u2192  New: v' + manifest.version + '\n\nDownload and install now?';

    const { response } = await dialog.showMessageBox(mainWin, {
      type:'info', title:'Update Available',
      message:'Version ' + manifest.version + ' is available',
      detail: detail,
      buttons:['Update & Restart','Later'], defaultId:0
    });
    if (response === 0) {
      try {
        splashWin = new BrowserWindow({ width:420, height:360, frame:false, resizable:false, center:true, backgroundColor:'#0f1624', parent:mainWin, modal:true, show:false, webPreferences:{ nodeIntegration:true, contextIsolation:false } });
        splashWin.loadFile(path.join(__dirname,'splash.html'));
        splashWin.once('ready-to-show', async () => {
          splashWin.show();
          splashWin.webContents.send('splash-version', APP_VERSION);
          splashSend('downloading', { pct:0, mbDl:'0.0', mbTot:'?' });
          const installerPath = await downloadUpdate(manifest);
          writeUpdateMarker(manifest.version);
          splashSend('launching', {});
          await new Promise(r => setTimeout(r, 400));
          await launchInstallerAndQuit(installerPath);
        });
      } catch(e) {
        if (splashWin && !splashWin.isDestroyed()) splashWin.destroy();
        dialog.showMessageBox(mainWin, { type:'error', title:'Download Failed', message:e.message, buttons:['OK'] });
      }
    }
  } else {
    dialog.showMessageBox(mainWin, { type:'info', title:'Up to Date', message:'G-Dos v' + APP_VERSION + ' is the latest version.', buttons:['OK'] });
  }
});

ipcMain.handle('writeDosi', (_, fp, cols, rows, payload) => {
  const buf = encodeDosi(payload, cols, rows);
  fs.writeFileSync(fp, buf);
  appendHistory(fp, payload);
  return { size: buf.length };
});

ipcMain.handle('readDosi', (_, fp) => decodeDosi(fs.readFileSync(fp)));

ipcMain.handle('writeText', (_, fp, data) => { fs.writeFileSync(fp, data, 'utf8'); return true; });

ipcMain.handle('readText', (_, fp, enc) => {
  const buf = fs.readFileSync(fp);

  try { return buf.toString(enc || 'utf8'); }
  catch(_) { return buf.toString('latin1'); }
});

ipcMain.handle('loadHistory', (_, fp) => loadHistory(fp));
ipcMain.handle('clearHistory', (_, fp) => { clearHistory(fp); return true; });

ipcMain.handle('saveHistorySnapshot', (_, fp, snapshot) => {
  appendHistory(fp, snapshot);
  return true;
});

ipcMain.on('win-minimize',   () => { mainWin?.minimize(); });
ipcMain.on('win-maximize',   () => { mainWin?.isMaximized() ? mainWin.unmaximize() : mainWin.maximize(); });
ipcMain.on('win-close',      () => { mainWin?.destroy(); });

ipcMain.on('win-close-force',() => { mainWin?.destroy(); });

ipcMain.handle('readBinary', (_, fp) => {
  const buf = fs.readFileSync(fp);
  return buf.toString('base64');
});

ipcMain.handle('writeBinary', (_, fp, b64) => {
  fs.writeFileSync(fp, Buffer.from(b64, 'base64'));
  return true;
});

ipcMain.handle('xlsxRead', async (_, fp) => {
  try {
    const ExcelJS = require('exceljs');
    const ext = fp.split('.').pop().toLowerCase();

    if (ext === 'csv') {
      const txt = fs.readFileSync(fp, 'utf8');
      const rows = txt.split('\n').map(line => {
        const cells = []; let cur = '', inQ = false;
        for (let i = 0; i < line.length; i++) {
          const ch = line[i];
          if (ch === '"') { inQ = !inQ; }
          else if (ch === ',' && !inQ) { cells.push(cur.trim()); cur = ''; }
          else cur += ch;
        }
        cells.push(cur.trim());
        return cells;
      });
      return { ok: true, sheetNames: ['Sheet1'], sheets: { Sheet1: rows } };
    }

    const wb = new ExcelJS.Workbook();
    if (ext === 'xlsx' || ext === 'xlsm') {
      await wb.xlsx.readFile(fp);
    } else if (ext === 'xls') {

      return { ok: false, error: '.xls (Excel 97-2003) is not supported. Please save as .xlsx first.' };
    } else if (ext === 'ods') {

      return { ok: false, error: '.ods is not supported. Please save as .xlsx first.' };
    } else {
      await wb.xlsx.readFile(fp);
    }

    const sheetNames = [];
    const sheets = {};
    wb.eachSheet((worksheet, sheetId) => {
      const name = worksheet.name;
      sheetNames.push(name);
      const rows = [];
      worksheet.eachRow({ includeEmpty: false }, (row) => {
        const cells = [];
        row.eachCell({ includeEmpty: true }, (cell) => {

          let v = '';
          if (cell.type === ExcelJS.ValueType.Formula) {
            v = cell.result !== undefined ? String(cell.result) : '';
          } else if (cell.type === ExcelJS.ValueType.Date) {
            v = cell.value instanceof Date ? cell.value.toISOString().slice(0, 10) : String(cell.value);
          } else if (cell.type === ExcelJS.ValueType.RichText) {
            v = (cell.value.richText || []).map(r => r.text || '').join('');
          } else if (cell.type === ExcelJS.ValueType.SharedString) {
            v = String(cell.value);
          } else if (cell.value !== null && cell.value !== undefined) {
            v = String(cell.value);
          }
          cells.push(v);
        });

        rows.push(cells);
      });

      const maxC = rows.reduce((m, r) => Math.max(m, r.length), 0);
      rows.forEach(r => { while (r.length < maxC) r.push(''); });
      sheets[name] = rows;
    });

    return { ok: true, sheetNames, sheets };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('xlsxWrite', async (_, fp, rows) => {
  try {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'GridApp';
    wb.created = new Date();
    const ws = wb.addWorksheet('Sheet1');

    rows.forEach((row, ri) => {
      const wsRow = ws.getRow(ri + 1);
      row.forEach((val, ci) => {
        const cell = wsRow.getCell(ci + 1);
        const n = parseFloat(val);
        cell.value = (val === '' || val === null || val === undefined) ? null
                   : !isNaN(n) && val.toString().trim() !== '' ? n
                   : val;
      });
      wsRow.commit();
    });

    await wb.xlsx.writeFile(fp);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('exportDocumentPDF', async (_, htmlContent, filePath) => {
  const { BrowserWindow } = require('electron');
  const os = require('os');
  const tmp = path.join(os.tmpdir(), 'gridapp-pdf-' + Date.now() + '.html');
  try {
    fs.writeFileSync(tmp, htmlContent, 'utf8');
    const win = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    });
    await new Promise((res, rej) => {
      win.loadFile(tmp);
      win.webContents.once('did-finish-load', res);
      win.webContents.once('did-fail-load', rej);
    });

    await new Promise(r => setTimeout(r, 400));
    const data = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      landscape: true,
      margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4, marginType: 'custom' }
    });
    win.destroy();
    fs.writeFileSync(filePath, data);
    fs.unlinkSync(tmp);
    return { ok: true };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch(_) {}
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('printToPDF', async (_, opts) => {
  try {
    const data = await mainWin.webContents.printToPDF(opts || {});
    return { ok: true, data: data.toString('base64') };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

const dbConns = {};

ipcMain.handle('dbList', () => Object.keys(dbConns).map(k => ({ id: k, info: dbConns[k].info })));

ipcMain.handle('dbConnect', async (_, cfg) => {
  const id = cfg.id || ('conn_' + Date.now());
  try {
    if (cfg.type === 'sqlite') {

      const initSqlJs = require('sql.js');
      const SQL = await initSqlJs();
      let db;
      if (cfg.file && fs.existsSync(cfg.file)) {
        const fileBuffer = fs.readFileSync(cfg.file);
        db = new SQL.Database(fileBuffer);
      } else {
        db = new SQL.Database();
      }
      dbConns[id] = { type: 'sqlite', db, info: cfg, SQL };
      return { ok: true, id };
    }
    if (cfg.type === 'mysql' || cfg.type === 'mariadb') {
      const mysql = require('mysql2/promise');
      const conn  = await mysql.createConnection({ host: cfg.host, port: cfg.port || 3306, user: cfg.user, password: cfg.password, database: cfg.database });
      dbConns[id] = { type: 'mysql', conn, info: cfg };
      return { ok: true, id };
    }
    if (cfg.type === 'postgres') {
      const { Client } = require('pg');
      const client = new Client({ host: cfg.host, port: cfg.port || 5432, user: cfg.user, password: cfg.password, database: cfg.database });
      await client.connect();
      dbConns[id] = { type: 'postgres', client, info: cfg };
      return { ok: true, id };
    }
    if (cfg.type === 'mongodb') {
      const { MongoClient } = require('mongodb');
      const client = await MongoClient.connect(cfg.uri || `mongodb://${cfg.host}:${cfg.port || 27017}`);
      dbConns[id] = { type: 'mongodb', client, info: cfg };
      return { ok: true, id };
    }
    if (cfg.type === 'mssql') {
      const mssql = require('mssql');
      const pool  = await mssql.connect({ server: cfg.host, port: cfg.port || 1433, user: cfg.user, password: cfg.password, database: cfg.database, options: { trustServerCertificate: true } });
      dbConns[id] = { type: 'mssql', pool, info: cfg };
      return { ok: true, id };
    }
    if (cfg.type === 'redis') {
      const { createClient } = require('redis');
      const client = createClient({ socket: { host: cfg.host || 'localhost', port: parseInt(cfg.port) || 6379 }, password: cfg.password || undefined });
      await client.connect();
      dbConns[id] = { type: 'redis', client, info: cfg };
      return { ok: true, id };
    }
    return { ok: false, error: 'Unknown DB type: ' + cfg.type };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('dbQuery', async (_, id, sql, params) => {
  const c = dbConns[id];
  if (!c) return { ok: false, error: 'No connection: ' + id };
  try {
    if (c.type === 'sqlite') {

      const results = c.db.exec(sql);
      if (!results.length) return { ok: true, rows: [] };
      const { columns, values } = results[0];
      const rows = values.map(row => {
        const obj = {};
        columns.forEach((col, i) => { obj[col] = row[i]; });
        return obj;
      });

      if (c.info.file && /^\s*(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)/i.test(sql)) {
        const data = c.db.export();
        fs.writeFileSync(c.info.file, Buffer.from(data));
      }
      return { ok: true, rows: normalisedRows };
    }
    if (c.type === 'mysql') {
      const [rows] = await c.conn.execute(sql, params || []);
      return { ok: true, rows: normalisedRows };
    }
    if (c.type === 'postgres') {
      const res = await c.client.query(sql, params || []);
      return { ok: true, rows: res.rows };
    }
    if (c.type === 'mongodb') {

      let collName, dbName, filter = {}, limit = 1000;
      logger.info('[MongoDB] raw sql param: ' + JSON.stringify(sql));
      logger.info('[MongoDB] stored info: ' + JSON.stringify(c.info));
      try {
        const q = typeof sql === 'string' && sql.trim().startsWith('{')
          ? JSON.parse(sql) : { collection: sql.trim() };
        collName = q.collection;
        filter   = q.filter || {};
        limit    = q.limit  || 1000;
        dbName   = q.database || c.info.database || null;
        logger.info('[MongoDB] parsed -> collection=' + collName + ' dbName=' + dbName + ' filter=' + JSON.stringify(filter));
      } catch(e) {
        collName = sql.trim();
        logger.warn('[MongoDB] JSON parse failed, using raw as collection name: ' + e.message);
      }

      if (!dbName) {
        try {
          const uriPath = new URL(c.info.uri || '').pathname;
          const fromUri = uriPath.replace(/^\//, '') || null;
          logger.info('[MongoDB] dbName from URI: ' + fromUri);
          dbName = fromUri;
        } catch(e) {
          logger.warn('[MongoDB] URI parse failed: ' + e.message);
        }
      }
      logger.info('[MongoDB] final dbName=' + dbName + '  collection=' + collName);
      const mongoDb   = dbName ? c.client.db(dbName) : c.client.db();
      logger.info('[MongoDB] using db.databaseName=' + mongoDb.databaseName);
      const coll = mongoDb.collection(collName);
      logger.info('[MongoDB] running find() on collection: ' + coll.collectionName);
      const rawRows = await coll.find(filter).limit(limit).toArray();
      logger.info('[MongoDB] rawRows.length=' + rawRows.length);
      if (rawRows.length > 0) {
        logger.info('[MongoDB] first doc keys: ' + Object.keys(rawRows[0]).join(', '));
        logger.info('[MongoDB] first doc sample: ' + JSON.stringify(rawRows[0]).slice(0, 500));
      } else {
        logger.warn('[MongoDB] *** ZERO ROWS - diagnosing...');
        try {
          const allColls = await mongoDb.listCollections().toArray();
          logger.info('[MongoDB] collections in db "' + mongoDb.databaseName + '": ' + allColls.map(x => x.name).join(', '));
        } catch(e2) { logger.warn('[MongoDB] listCollections failed: ' + e2.message); }
        try {
          const count = await coll.countDocuments({});
          logger.info('[MongoDB] countDocuments({}) for "' + collName + '" = ' + count);
        } catch(e2) { logger.warn('[MongoDB] countDocuments failed: ' + e2.message); }
      }

      function unwrapExtJson(v) {
        if (v === null || v === undefined) return '';
        if (v instanceof Date) return v.toISOString();
        if (typeof v !== 'object') return v;
        if (Array.isArray(v)) return v;

        if ('$oid'        in v) return String(v.$oid);
        if ('$date'       in v) { const d = v.$date; return typeof d === 'string' ? d : (typeof d === 'object' && '$numberLong' in d ? new Date(parseInt(d.$numberLong)).toISOString() : String(d)); }
        if ('$numberLong' in v) return String(v.$numberLong);
        if ('$numberInt'  in v) return String(v.$numberInt);
        if ('$numberDouble' in v) return String(v.$numberDouble);
        if ('$numberDecimal' in v) return String(v.$numberDecimal);
        if ('$binary'     in v) return '[binary]';
        if ('$regex'      in v) return v.$regex;
        return v;

      }

      function flattenDoc(doc, prefix, out) {
        for (const [k, v] of Object.entries(doc)) {
          const key = prefix ? prefix + '.' + k : k;
          const uw = unwrapExtJson(v);

          if (Array.isArray(uw)) {

            const hasObjects = uw.some(item => item !== null && typeof item === 'object' && !Array.isArray(item));
            if (hasObjects) {

              uw.forEach((item, idx) => {
                if (item !== null && typeof item === 'object') {
                  const uwItem = unwrapExtJson(item);
                  if (typeof uwItem === 'object' && !Array.isArray(uwItem)) {
                    flattenDoc(uwItem, key + '.' + idx, out);
                  } else {
                    out[key + '.' + idx] = String(uwItem);
                  }
                } else {
                  out[key + '.' + idx] = item == null ? '' : String(item);
                }
              });

              out[key + '.__count'] = String(uw.length);
            } else {

              out[key] = uw.map(x => x == null ? '' : String(x));
            }
          } else if (uw !== null && typeof uw === 'object') {

            flattenDoc(uw, key, out);
          } else {
            out[key] = uw === null || uw === undefined ? '' : String(uw);
          }
        }
        return out;
      }
      const rows = rawRows.map(doc => flattenDoc(doc, '', {}));

      const allKeysSet = new Set();
      rows.forEach(row => Object.keys(row).forEach(k => allKeysSet.add(k)));

      const firstDocKeys = rows.length ? Object.keys(rows[0]) : [];
      const extraKeys = [...allKeysSet].filter(k => !firstDocKeys.includes(k));
      const allKeys = [...firstDocKeys, ...extraKeys];

      const normalisedRows = rows.map(row => {
        const out = {};
        allKeys.forEach(k => { out[k] = row[k] !== undefined ? row[k] : ''; });
        return out;
      });
      logger.info('[MongoDB] union keys across all docs: ' + allKeys.join(', '));
      logger.info('[MongoDB] final flattened rows: ' + rows.length);
      if (rows.length > 0) logger.info('[MongoDB] flattened first row keys: ' + Object.keys(rows[0]).join(', '));
      return { ok: true, rows: normalisedRows };
    }
    if (c.type === 'mssql') {
      const result = await c.pool.request().query(sql);
      return { ok: true, rows: result.recordset };
    }
    if (c.type === 'redis') {

      const parts = sql.trim().split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const args = parts.slice(1);
      const result = await c.client.sendCommand([parts[0].toUpperCase(), ...args]);
      const rows = Array.isArray(result) ? result.map((v,i)=>({index:i,value:v})) : [{result: String(result)}];
      return { ok: true, rows };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('dbBrowse', async (_, id) => {

  const c = dbConns[id];
  if (!c) return { ok: false, error: 'No connection: ' + id };
  try {
    if (c.type === 'sqlite') {
      const res = c.db.exec("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY name");
      const items = res.length ? res[0].values.map(([name, type]) => ({ name, type })) : [];
      return { ok: true, type: 'sqlite', tables: items };
    }
    if (c.type === 'mysql') {
      const [dbs] = await c.conn.execute('SHOW DATABASES');
      const [tbls] = await c.conn.execute('SHOW TABLES');
      return { ok: true, type: 'mysql', databases: dbs.map(r => Object.values(r)[0]), tables: tbls.map(r => Object.values(r)[0]) };
    }
    if (c.type === 'postgres') {
      const dbRes = await c.client.query("SELECT datname FROM pg_database WHERE datistemplate=false ORDER BY datname");
      const tblRes = await c.client.query("SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_schema, table_name");
      return { ok: true, type: 'postgres', databases: dbRes.rows.map(r => r.datname), tables: tblRes.rows.map(r => r.table_schema + '.' + r.table_name) };
    }
    if (c.type === 'mongodb') {
      const admin = c.client.db().admin();
      const { databases } = await admin.listDatabases();
      const dbNames = databases.map(d => d.name);
      logger.info('[MongoDB browse] databases found: ' + dbNames.join(', '));
      const collections = {};
      for (const dbName of dbNames) {
        const colls = await c.client.db(dbName).listCollections().toArray();
        const names = colls.map(cl => cl.name);
        collections[dbName] = names;
        logger.info('[MongoDB browse] ' + dbName + ' -> collections: ' + names.join(', '));
      }
      return { ok: true, type: 'mongodb', databases: dbNames, collections };
    }
    if (c.type === 'mssql') {
      const dbRes = await c.pool.request().query('SELECT name FROM sys.databases ORDER BY name');
      const tblRes = await c.pool.request().query("SELECT TABLE_SCHEMA+'.'+TABLE_NAME as tbl FROM INFORMATION_SCHEMA.TABLES ORDER BY tbl");
      return { ok: true, type: 'mssql', databases: dbRes.recordset.map(r => r.name), tables: tblRes.recordset.map(r => r.tbl) };
    }
    if (c.type === 'redis') {
      const keys = await c.client.keys('*');
      return { ok: true, type: 'redis', keys: keys.slice(0, 500) };
    }
    return { ok: false, error: 'Browse not supported for ' + c.type };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('dbDisconnect', async (_, id) => {
  const c = dbConns[id];
  if (!c) return false;
  try {
    if (c.type === 'sqlite')   c.db.close();

    if (c.type === 'mysql')    await c.conn.end();
    if (c.type === 'postgres') await c.client.end();
    if (c.type === 'mongodb')  await c.client.close();
    if (c.type === 'mssql')    await c.pool.close();
    if (c.type === 'redis')    await c.client.quit();
  } catch (_) {}
  delete dbConns[id];
  return true;
});

ipcMain.on('log', (_, lvl, msg) => log(lvl, '[UI] ' + msg));
