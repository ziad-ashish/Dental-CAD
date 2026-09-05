// Keep the renderer isolated. Only the small, validated file-dialog API below
// crosses the context boundary; no Node APIs are exposed to the design surface.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dentalcadDesktop', Object.freeze({
  isElectron: true,
  saveProject: (payload) => ipcRenderer.invoke('project-save-dialog', payload),
  openProject: () => ipcRenderer.invoke('project-open-dialog'),
}));
window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.dataset.desktop = 'electron';
});
