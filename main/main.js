// main.js — Electron main process.
// Responsible for: window creation, filesystem access (workspace file tree,
// save/open .skx files), export dialogs, and persisted app settings.
// Kept deliberately small/dependency-free to keep the app lightweight.

const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

let mainWindow;

const SETTINGS_PATH = () => path.join(app.getPath('userData'), 'settings.json');

const DEFAULT_SETTINGS = {
  exportMarginPx: 40,
  dotGridEnabled: false,
  lastWorkspace: null,
  strokeBaseWidth: 4,
  strokeMinWidth: 1,
  strokeMaxWidth: 24,
  pressureSensitivity: 1,
};

function readSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH(), 'utf-8');
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch (e) {
    return { ...DEFAULT_SETTINGS };
  }
}

function writeSettings(settings) {
  const merged = { ...readSettings(), ...settings };
  fs.mkdirSync(path.dirname(SETTINGS_PATH()), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH(), JSON.stringify(merged, null, 2), 'utf-8');
  return merged;
}

const ICON_PATH = path.join(__dirname, '..', 'build', 'icon.ico');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#f5f5f5',
    autoHideMenuBar: true,
    ...(fs.existsSync(ICON_PATH) ? { icon: ICON_PATH } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Pointer events (pressure, tilt, pen/touch discrimination) work fine
      // in the renderer without extra flags in modern Electron/Chromium.
    },
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------- Settings ----------

ipcMain.handle('settings:get', () => readSettings());
ipcMain.handle('settings:set', (_evt, partial) => writeSettings(partial));

// ---------- Workspace / file tree ----------

async function buildTree(dirPath) {
  const entries = await fsp.readdir(dirPath, { withFileTypes: true });
  const children = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      children.push({
        name: entry.name,
        path: fullPath,
        type: 'folder',
        children: await buildTree(fullPath),
      });
    } else if (entry.isFile() && entry.name.endsWith('.skx')) {
      children.push({ name: entry.name, path: fullPath, type: 'file' });
    }
  }
  // Folders first, then files, alphabetically.
  children.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return children;
}

ipcMain.handle('workspace:choose', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Choose or create a workspace folder',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const root = result.filePaths[0];
  writeSettings({ lastWorkspace: root });
  return root;
});

ipcMain.handle('workspace:tree', async (_evt, root) => {
  if (!root) return [];
  try {
    return await buildTree(root);
  } catch (e) {
    return [];
  }
});

ipcMain.handle('workspace:createFile', async (_evt, { dirPath, name }) => {
  const safeName = name.endsWith('.skx') ? name : `${name}.skx`;
  const filePath = path.join(dirPath, safeName);
  if (fs.existsSync(filePath)) throw new Error('A file with that name already exists.');
  const emptyDoc = {
    version: 1,
    strokes: [],
    createdAt: new Date().toISOString(),
  };
  await fsp.writeFile(filePath, JSON.stringify(emptyDoc, null, 2), 'utf-8');
  return filePath;
});

ipcMain.handle('workspace:createFolder', async (_evt, { dirPath, name }) => {
  const folderPath = path.join(dirPath, name);
  await fsp.mkdir(folderPath, { recursive: false });
  return folderPath;
});

ipcMain.handle('workspace:rename', async (_evt, { oldPath, newName }) => {
  const dir = path.dirname(oldPath);
  const isFile = fs.statSync(oldPath).isFile();
  const finalName = isFile && !newName.endsWith('.skx') ? `${newName}.skx` : newName;
  const newPath = path.join(dir, finalName);
  await fsp.rename(oldPath, newPath);
  return newPath;
});

ipcMain.handle('workspace:delete', async (_evt, targetPath) => {
  // Soft-delete: move into a top-level ".trash" folder inside the workspace
  // rather than permanently removing, so accidental deletes are recoverable.
  const settings = readSettings();
  const root = settings.lastWorkspace;
  if (!root) throw new Error('No workspace open.');
  const trashDir = path.join(root, '.trash');
  await fsp.mkdir(trashDir, { recursive: true });
  const dest = path.join(trashDir, `${Date.now()}_${path.basename(targetPath)}`);
  await fsp.rename(targetPath, dest);
  return dest;
});

ipcMain.handle('file:read', async (_evt, filePath) => {
  const raw = await fsp.readFile(filePath, 'utf-8');
  return JSON.parse(raw);
});

ipcMain.handle('file:write', async (_evt, { filePath, doc }) => {
  await fsp.writeFile(filePath, JSON.stringify(doc, null, 2), 'utf-8');
  return true;
});

// ---------- Export ----------

ipcMain.handle('export:savePng', async (_evt, { defaultName, dataUrl }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName || 'sketch.png',
    filters: [{ name: 'PNG Image', extensions: ['png'] }],
  });
  if (result.canceled || !result.filePath) return null;
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  await fsp.writeFile(result.filePath, Buffer.from(base64, 'base64'));
  return result.filePath;
});

ipcMain.handle('export:saveSvg', async (_evt, { defaultName, svgText }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName || 'sketch.svg',
    filters: [{ name: 'SVG Image', extensions: ['svg'] }],
  });
  if (result.canceled || !result.filePath) return null;
  await fsp.writeFile(result.filePath, svgText, 'utf-8');
  return result.filePath;
});

// Auto-screenshot (pen barrel-button trigger): saves silently into a
// Screenshots subfolder of the current workspace, no dialog interruption.
ipcMain.handle('export:autoScreenshot', async (_evt, { root, dataUrl }) => {
  if (!root) throw new Error('No workspace open.');
  const dir = path.join(root, 'Screenshots');
  await fsp.mkdir(dir, { recursive: true });
  const fileName = `screenshot_${Date.now()}.png`;
  const filePath = path.join(dir, fileName);
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  await fsp.writeFile(filePath, Buffer.from(base64, 'base64'));
  return filePath;
});
