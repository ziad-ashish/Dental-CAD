// Keep the renderer isolated. DentalCAD uses browser APIs only; no Node APIs
// are exposed to the design surface.
window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.dataset.desktop = 'electron';
});
