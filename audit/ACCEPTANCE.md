# DentalCAD acceptance audit

Run the acceptance suite from the repository root:

```powershell
node .\audit\test.cjs
```

Run all local gates (build, tests, diff check, and HTTP smoke) with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\audit\run-all.ps1
```

The suite currently verifies 91 cases across:

- STL, OBJ, and ASCII PLY import; malformed input rejection; STL/OBJ/PLY/3MF package export
- project persistence, autosave recovery, version checks, and margin validation
- implant plan persistence and malformed-plan rejection
- undo/redo, tooth library geometry, crown cement shell transforms, and support generation
- wall thickness, manifold checks, contact detection, occlusion adaptation, and world transforms
- implant catalog validation, fixture geometry, surgical guide sleeves, and plan serialization
- nesting fit, overflow reporting, manufacturing job manifests, and toolpath safety checks
- G-code machine profiles, machine-specific output, and UI/export wiring
- index HTML uniqueness and local script reference integrity

The suite is a deterministic acceptance check for the source and geometry pipeline. A clinical release still requires browser interaction testing and machine-specific post-processor validation on the target CAM hardware.

The local HTTP smoke check also returned `200` for `dentalcad-web/index.html`, the bundled `DentalCAD.html`, and the manufacturing module script.
