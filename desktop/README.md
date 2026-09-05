# DentalCAD Desktop

This folder is the Electron desktop shell for the DentalCAD renderer. The application opens `dentalcad-web/index.html` in a native window, with Node integration disabled and navigation restricted to local files. The preload exposes only native project open/save dialogs through IPC; it does not expose filesystem or Node APIs to the renderer.

From this folder:

```powershell
npm install
npm start
```

Run `build-dentalcad.ps1` from the repository root before packaging a release. The renderer currently loads Three.js from its configured CDN script, so first launch requires network access unless that dependency is vendored locally.

Python-style entry point from the repository root:

```powershell
python main.py
```

On Windows, `DentalCAD.bat` can be double-clicked after Python and the desktop dependencies are installed.
