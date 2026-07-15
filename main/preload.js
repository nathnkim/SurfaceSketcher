// preload.js — exposes a narrow, explicit API to the renderer via
// contextBridge. Renderer never gets direct Node/fs access.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (partial) => ipcRenderer.invoke('settings:set', partial),
  },
  workspace: {
    choose: () => ipcRenderer.invoke('workspace:choose'),
    tree: (root) => ipcRenderer.invoke('workspace:tree', root),
    createFile: (dirPath, name) => ipcRenderer.invoke('workspace:createFile', { dirPath, name }),
    createFolder: (dirPath, name) => ipcRenderer.invoke('workspace:createFolder', { dirPath, name }),
    rename: (oldPath, newName) => ipcRenderer.invoke('workspace:rename', { oldPath, newName }),
    delete: (targetPath) => ipcRenderer.invoke('workspace:delete', targetPath),
  },
  file: {
    read: (filePath) => ipcRenderer.invoke('file:read', filePath),
    write: (filePath, doc) => ipcRenderer.invoke('file:write', { filePath, doc }),
  },
  exportApi: {
    savePng: (defaultName, dataUrl) => ipcRenderer.invoke('export:savePng', { defaultName, dataUrl }),
    saveSvg: (defaultName, svgText) => ipcRenderer.invoke('export:saveSvg', { defaultName, svgText }),
    autoScreenshot: (root, dataUrl) => ipcRenderer.invoke('export:autoScreenshot', { root, dataUrl }),
  },
});
