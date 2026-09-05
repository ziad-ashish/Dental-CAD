const { app, BrowserWindow, shell, session, dialog, ipcMain } = require('electron');
const fs = require('fs/promises');
const path = require('path');

let mainWindow;

function _projectFilters() {
  return [{ name: 'DentalCAD project', extensions: ['dcad'] }, { name: 'JSON', extensions: ['json'] }];
}

ipcMain.handle('project-save-dialog', async (_event, payload = {}) => {
  const contents = typeof payload.contents === 'string' ? payload.contents : '';
  if (!contents || contents.length > 512 * 1024 * 1024) throw new Error('Invalid or oversized project payload');
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save DentalCAD Case',
    defaultPath: typeof payload.defaultPath === 'string' && payload.defaultPath ? payload.defaultPath : 'DentalCAD_Case.dcad',
    filters: _projectFilters(),
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  await fs.writeFile(result.filePath, contents, 'utf8');
  return { canceled: false, filePath: result.filePath };
});

ipcMain.handle('project-open-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { title: 'Open DentalCAD Case', properties: ['openFile'], filters: _projectFilters() });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const filePath = result.filePaths[0];
  return { canceled: false, filePath, contents: await fs.readFile(filePath, 'utf8') };
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#080b12',
    title: 'DentalCAD',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.removeMenu();
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'dentalcad-web', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
