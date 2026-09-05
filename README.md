# DentalCAD

DentalCAD is a desktop-first dental CAD prototype. The renderer lives in `dentalcad-web/`, and the Electron shell in `desktop/` opens it as a native application. The repository also contains deterministic geometry/manufacturing acceptance tests.

## Prerequisites

- Windows 10/11 for the documented desktop workflow.
- Node.js 20+ and npm 10+.
- Python 3.10+ only if you want to use the `python main.py` launcher.

## Install and run

From the repository root:

```powershell
npm install
npm start
```

The first command installs the Electron dependency. The second opens DentalCAD in a native window. In the desktop shell, `Open Case` and `Save As` use native Windows file dialogs; the browser renderer keeps its file-picker/download fallback. The equivalent Python-style entry point is:

```powershell
python main.py
```

On Windows, `DentalCAD.bat` can be double-clicked after the dependencies are installed. `npm start` and the Python launcher both use the same `desktop/main.cjs` shell and `dentalcad-web/index.html` renderer.

## Build the distributable HTML bundle

The modular source files are authoritative. Rebuild the self-contained `DentalCAD.html` bundle with:

```powershell
npm run build
```

Run this after changing `dentalcad-web/index.html`, CSS, or JavaScript modules.

## Run the acceptance audit

Run the deterministic geometry, persistence, manufacturing, desktop-shell, and integration tests with:

```powershell
npm run audit
```

Run all local gates, including the build and whitespace checks:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\audit\run-all.ps1
```

The HTTP smoke portion needs a local static server on port `8765`; use `-SkipHttp` when that server is not running. See [audit/ACCEPTANCE.md](audit/ACCEPTANCE.md) for coverage and [audit/READINESS.md](audit/READINESS.md) for the boundary between tested prototype behavior and external clinical, commercial, and regulatory evidence.

## Source layout

- `dentalcad-web/index.html` — renderer markup.
- `dentalcad-web/js/` — parser, mesh repair, analysis, tools, manufacturing, persistence, and UI modules.
- `desktop/` — isolated Electron shell and its package metadata.
- `dentalcad/main.py` and `main.py` — Python-style launcher.
- `audit/` — acceptance tests, gates, and readiness notes.

## Current engineering backlog

The next code priorities are input hardening and large-scan performance, then multi-user accounts/permissions if the pilot needs them, continuous integration, a stronger geometry kernel, production CAM simulation/post-processors, and end-to-end Electron UI tests. Arabic localization and accessibility are tracked as later backlog work. Clinical data collection, partnerships, and regulatory work require external teams and evidence; they cannot be completed by writing code alone.
