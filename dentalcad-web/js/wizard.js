/**
 * wizard.js — 7-step wizard: state machine + step indicator + nav buttons
 */

const Wizard = (() => {
  const STEPS = [
    'New Case',
    'Scan Import',
    'Tooth Selection',
    'Restoration Type',
    'Design Tools',
    'Library Selection',
    'Review & Export',
  ];

  let currentStep = 0;
  let onStepChange = null;
  let caseData = {};

  // ── Step Indicator ──────────────────────────────────────────
  function buildIndicator() {
    const bar = document.getElementById('step-indicator');
    bar.innerHTML = '';
    STEPS.forEach((name, i) => {
      if (i > 0) {
        const conn = document.createElement('div');
        conn.className = 'step-connector';
        conn.id = `conn-${i}`;
        bar.appendChild(conn);
      }
      const node = document.createElement('div');
      node.className = 'step-node';
      node.innerHTML = `
        <div class="step-circle" id="sc-${i}">${i + 1}</div>
        <div class="step-label"  id="sl-${i}">${name}</div>`;
      node.addEventListener('click', () => goTo(i));
      bar.appendChild(node);
    });
    updateIndicator();
  }

  function updateIndicator() {
    STEPS.forEach((_, i) => {
      const circle = document.getElementById(`sc-${i}`);
      const label  = document.getElementById(`sl-${i}`);
      const conn   = document.getElementById(`conn-${i}`);
      circle.className = 'step-circle';
      label.className  = 'step-label';
      if (conn) conn.className = 'step-connector';

      if (i < currentStep) {
        circle.classList.add('done');
        label.classList.add('done');
        circle.textContent = '✓';
        if (conn) conn.classList.add('done');
      } else if (i === currentStep) {
        circle.classList.add('active');
        label.classList.add('active');
        circle.textContent = i + 1;
      } else {
        circle.textContent = i + 1;
      }
    });

    // Nav buttons
    const backBtn = document.getElementById('btn-back');
    const nextBtn = document.getElementById('btn-next');
    backBtn.disabled = currentStep === 0;
    nextBtn.textContent = currentStep === STEPS.length - 1 ? 'Finish ✓' : 'Next ▶';
    document.getElementById('step-counter').textContent =
      `Step ${currentStep + 1} of ${STEPS.length}`;
  }

  // ── Step Switching ──────────────────────────────────────────
  function showStep(index) {
    document.querySelectorAll('.wizard-step').forEach((el, i) => {
      el.classList.toggle('active', i === index);
    });
  }

  function collectCurrentStepData() {
    const collectors = {
      0: collectNewCase,
      1: collectScanImport,
      2: collectToothSelection,
      3: collectRestorationType,
      4: () => ({}),
      5: collectLibrarySelection,
      6: () => ({}),
    };
    const fn = collectors[currentStep];
    if (fn) Object.assign(caseData, fn());
  }

  function goTo(index) {
    if (index < 0 || index >= STEPS.length) return;
    collectCurrentStepData();
    currentStep = index;
    showStep(currentStep);
    updateIndicator();
    if (currentStep === 6) populateReview();
    if (onStepChange) onStepChange(currentStep, STEPS[currentStep]);
  }

  function next() {
    if (currentStep < STEPS.length - 1) goTo(currentStep + 1);
  }
  function back() {
    if (currentStep > 0) goTo(currentStep - 1);
  }

  // ── Per-step data collectors ────────────────────────────────
  function collectNewCase() {
    return {
      patient:   document.getElementById('inp-patient')?.value  || '—',
      caseId:    document.getElementById('inp-caseid')?.value   || '—',
      date:      document.getElementById('inp-date')?.value     || '—',
      clinician: document.getElementById('inp-clinician')?.value|| '—',
      scanner:   document.getElementById('sel-scanner')?.value  || '—',
      lab:       document.getElementById('inp-lab')?.value      || '—',
      jaw: (() => {
        const active = document.querySelector('.jaw-btn.active');
        return active ? active.dataset.jaw : 'upper';
      })(),
    };
  }

  function collectScanImport() {
    return {
      scanFile:     window._scanFile || 'demo',
      scanFileName: window._lastScanFileName || window._scanFile || 'demo',
    };
  }

  function collectToothSelection() {
    return { selectedTeeth: DentalChart.getSelected() };
  }

  function collectRestorationType() {
    const sel = document.querySelector('.rest-card.selected');
    return { restoration: sel ? sel.dataset.rest : '—' };
  }

  function collectLibrarySelection() {
    const sel = document.querySelector('#lib-step-grid .lib-card.selected');
    return { libraryItem: sel ? sel.dataset.lib : '—' };
  }

  // ── Review population ───────────────────────────────────────
  function populateReview() {
    const set = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val || '—';
    };
    set('rv-patient',     caseData.patient);
    set('rv-caseid',      caseData.caseId);
    set('rv-date',        caseData.date);
    set('rv-clinician',   caseData.clinician);
    set('rv-scanner',     caseData.scanner);
    set('rv-jaw',         caseData.jaw);
    set('rv-teeth',       (caseData.selectedTeeth || []).join(', ') || '—');
    set('rv-restoration', caseData.restoration);
    set('rv-library',     caseData.libraryItem);

    // ── Real validation checks (no hardcoded true) ────────────
    // chk-margin:  did the user close the margin loop?
    const marginOk  = !!caseData.marginLineClosed;
    // chk-thick:   did WallThickness pass after the last compute?
    const thickOk   = caseData.thicknessCheck?.pass   ?? false;
    // chk-contact: did Validator.runAll produce contactOk?
    const contactOk = caseData.validationResults?.contactOk ?? false;

    const checks = [
      ['chk-scan',    !!caseData.scanFile,
                      'Scan data imported'],
      ['chk-teeth',   (caseData.selectedTeeth || []).length > 0,
                      'Teeth selected'],
      ['chk-rest',    !!(caseData.restoration && caseData.restoration !== '—'),
                      'Restoration type chosen'],
      ['chk-margin',  marginOk,
                      marginOk ? 'Margin line defined & closed'
                               : 'Margin line not closed yet'],
      ['chk-thick',   thickOk,
                      thickOk  ? 'Minimum thickness met'
                               : 'Thickness not yet verified — run heatmap first'],
      ['chk-contact', contactOk,
                      contactOk ? 'Proximal contacts verified'
                                : 'Contact check not run yet'],
    ];

    checks.forEach(([id, ok, label]) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.innerHTML =
        `<span class="check-icon ${ok ? 'check-ok' : 'check-warn'}">${ok ? '✅' : '⚠'}</span>` +
        `<span style="color:${ok ? 'var(--green)' : 'var(--yellow)'}">${label}</span>`;
    });

    // Show a summary warning if any required check failed
    const required = checks.slice(0, 3);            // scan, teeth, restoration
    const optional = checks.slice(3);               // margin, thick, contact
    const missingRequired = required.filter(([,ok]) => !ok);
    const missingOptional = optional.filter(([,ok]) => !ok);

    const summaryEl = document.getElementById('review-summary-msg');
    if (summaryEl) {
      if (missingRequired.length) {
        summaryEl.textContent =
          `⚠ ${missingRequired.length} required step(s) incomplete — complete them before exporting.`;
        summaryEl.style.color = 'var(--red)';
      } else if (missingOptional.length) {
        summaryEl.textContent =
          `ℹ ${missingOptional.length} optional check(s) pending — export is allowed but review recommended.`;
        summaryEl.style.color = 'var(--yellow)';
      } else {
        summaryEl.textContent = '✔ All checks passed — ready to export.';
        summaryEl.style.color = 'var(--green)';
      }
    }

    // Disable export button if required checks fail
    const exportBtn = document.getElementById('btn-export');
    if (exportBtn) {
      exportBtn.disabled = missingRequired.length > 0;
      exportBtn.title    = missingRequired.length
        ? 'Complete all required steps before exporting'
        : 'Export the design';
    }
  }

  // ── Init ────────────────────────────────────────────────────
  function init(onChangeFn) {
    onStepChange = onChangeFn;
    buildIndicator();
    showStep(0);

    document.getElementById('btn-back').addEventListener('click', back);
    document.getElementById('btn-next').addEventListener('click', next);
  }

  function getData() { return caseData; }
  function getStep() { return currentStep; }
  function getStepName() { return STEPS[currentStep]; }

  return { init, next, back, goTo, getData, getStep, getStepName };
})();