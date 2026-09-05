/**
 * dental-chart.js — Interactive 32-tooth FDI chart
 * v3 ULTIMATE: Photorealistic anatomical SVG teeth with:
 *   - SVG gradients (ivory enamel, dentin shadow, pulp highlight)
 *   - Per-tooth morphology (crown shape + correct root number/form)
 *   - Glow + scale animations on hover/select
 *   - Upper vs Lower jaw orientation
 *   - Color-coded by tooth type
 */

const DentalChart = (() => {

  const UPPER_RIGHT = [18,17,16,15,14,13,12,11];
  const UPPER_LEFT  = [21,22,23,24,25,26,27,28];
  const LOWER_LEFT  = [31,32,33,34,35,36,37,38];
  const LOWER_RIGHT = [48,47,46,45,44,43,42,41];

  const TOOTH_TYPE = {};
  [11,12,21,22,31,32,41,42].forEach(n => TOOTH_TYPE[n] = 'I');
  [13,23,33,43]             .forEach(n => TOOTH_TYPE[n] = 'C');
  [14,15,24,25,34,35,44,45] .forEach(n => TOOTH_TYPE[n] = 'P');
  [16,17,18,26,27,28,36,37,38,46,47,48].forEach(n => TOOTH_TYPE[n] = 'M');

  // Tooth type accent colors
  const TC = {
    I: { h:'#60a5fa', glow:'rgba(96,165,250,0.8)',  sel:'#3b82f6', rs:'#1e40af' },
    C: { h:'#fb923c', glow:'rgba(251,146,60,0.8)',   sel:'#f97316', rs:'#9a3412' },
    P: { h:'#34d399', glow:'rgba(52,211,153,0.8)',   sel:'#10b981', rs:'#065f46' },
    M: { h:'#a78bfa', glow:'rgba(167,139,250,0.8)',  sel:'#8b5cf6', rs:'#4c1d95' },
  };

  let selected = new Set();
  let onChangeCb = null;

  const NS = 'http://www.w3.org/2000/svg';
  let _defCounter = 0;

  function _el(tag, a={}) {
    const e = document.createElementNS(NS, tag);
    for (const [k,v] of Object.entries(a)) e.setAttribute(k, String(v));
    return e;
  }

  // ── Gradient factory ────────────────────────────────────────
  function _makeGradients(svg, id, isSelected, col) {
    const defs = _el('defs');

    // Enamel gradient — ivory to warm shadow
    const eg = _el('linearGradient', {id:`eg${id}`, x1:'0', y1:'0', x2:'1', y2:'1'});
    if (isSelected) {
      const s1=_el('stop'); s1.setAttribute('offset','0%');   s1.setAttribute('stop-color',col.sel); s1.setAttribute('stop-opacity','0.85');
      const s2=_el('stop'); s2.setAttribute('offset','100%'); s2.setAttribute('stop-color',col.rs);  s2.setAttribute('stop-opacity','0.7');
      eg.appendChild(s1); eg.appendChild(s2);
    } else {
      const s1=_el('stop'); s1.setAttribute('offset','0%');   s1.setAttribute('stop-color','#f0e8d8'); s1.setAttribute('stop-opacity','1');
      const s2=_el('stop'); s2.setAttribute('offset','50%');  s2.setAttribute('stop-color','#d4c4a4'); s2.setAttribute('stop-opacity','1');
      const s3=_el('stop'); s3.setAttribute('offset','100%'); s3.setAttribute('stop-color','#b8a484'); s3.setAttribute('stop-opacity','1');
      eg.appendChild(s1); eg.appendChild(s2); eg.appendChild(s3);
    }
    defs.appendChild(eg);

    // Root gradient
    const rg = _el('linearGradient', {id:`rg${id}`, x1:'0', y1:'0', x2:'0', y2:'1'});
    const r1=_el('stop'); r1.setAttribute('offset','0%');   r1.setAttribute('stop-color', isSelected ? col.rs : '#c8b48a'); r1.setAttribute('stop-opacity','0.9');
    const r2=_el('stop'); r2.setAttribute('offset','100%'); r2.setAttribute('stop-color', isSelected ? col.rs : '#9a8464'); r2.setAttribute('stop-opacity','0.6');
    rg.appendChild(r1); rg.appendChild(r2);
    defs.appendChild(rg);

    // Highlight gradient (surface gloss)
    const hg = _el('radialGradient', {id:`hg${id}`, cx:'35%', cy:'25%', r:'55%'});
    const h1=_el('stop'); h1.setAttribute('offset','0%');   h1.setAttribute('stop-color','#ffffff'); h1.setAttribute('stop-opacity','0.5');
    const h2=_el('stop'); h2.setAttribute('offset','100%'); h2.setAttribute('stop-color','#ffffff'); h2.setAttribute('stop-opacity','0');
    hg.appendChild(h1); hg.appendChild(h2);
    defs.appendChild(hg);

    svg.appendChild(defs);
    return { eg:`url(#eg${id})`, rg:`url(#rg${id})`, hg:`url(#hg${id})` };
  }

  // ── INCISOR ─────────────────────────────────────────────────
  function _svgIncisor(col, isSelected, isLower) {
    const id = ++_defCounter;
    const svg = _el('svg', {viewBox:'0 0 40 72', xmlns:NS, style:'overflow:visible'});
    const g = _makeGradients(svg, id, isSelected, col);

    // Root — single, tapered, rounded tip
    svg.appendChild(_el('path', {
      d:`M15 40 C14 50 14.5 60 16 66 Q20 72 24 66 C25.5 60 26 50 25 40 Z`,
      fill: g.rg, stroke: isSelected ? col.h : '#c0a878', 'stroke-width':'1',
    }));
    // CEJ line
    svg.appendChild(_el('path', {
      d:'M11 40 Q20 43 29 40', fill:'none',
      stroke: isSelected ? col.h : 'rgba(180,150,100,0.5)', 'stroke-width':'0.8',
    }));
    // Crown — anatomical incisor (spade + lobes)
    svg.appendChild(_el('path', {
      d: isLower
        ? 'M10 40 C9 33 10 26 12 20 Q15 13 20 12 Q25 13 28 20 C30 26 31 33 30 40 Z'
        : 'M10 40 C9 32 10 24 12 18 Q16 11 20 10 Q24 11 28 18 C30 24 31 32 30 40 Z',
      fill: g.eg, stroke: isSelected ? col.h : '#b09a72', 'stroke-width':'1.2',
    }));
    // Mesial/distal line angles
    svg.appendChild(_el('path', {
      d: isLower ? 'M13 20 C15 14 17 12 20 12' : 'M13 19 C15 13 18 10.5 20 10',
      fill:'none', stroke:'rgba(255,255,255,0.35)', 'stroke-width':'0.9', 'stroke-linecap':'round',
    }));
    svg.appendChild(_el('path', {
      d: isLower ? 'M27 20 C25 14 23 12 20 12' : 'M27 19 C25 13 22 10.5 20 10',
      fill:'none', stroke:'rgba(255,255,255,0.25)', 'stroke-width':'0.7', 'stroke-linecap':'round',
    }));
    // Development grooves (perikymata)
    [24,28,32,36].forEach(y => {
      svg.appendChild(_el('path', {
        d:`M12 ${y} Q20 ${y+1} 28 ${y}`, fill:'none',
        stroke:'rgba(160,130,90,0.15)', 'stroke-width':'0.5',
      }));
    });
    // Surface highlight (gloss)
    svg.appendChild(_el('ellipse', {
      cx:'16', cy: isLower ? '22' : '20', rx:'3', ry:'5',
      fill: g.hg, transform:'rotate(-15,16,22)',
    }));
    return svg;
  }

  // ── CANINE ──────────────────────────────────────────────────
  function _svgCanine(col, isSelected, isLower) {
    const id = ++_defCounter;
    const svg = _el('svg', {viewBox:'0 0 40 76', xmlns:NS, style:'overflow:visible'});
    const g = _makeGradients(svg, id, isSelected, col);

    // Root — longest single root
    svg.appendChild(_el('path', {
      d:'M15 40 C14 52 14.5 63 16 69 Q20 76 24 69 C25.5 63 26 52 25 40 Z',
      fill: g.rg, stroke: isSelected ? col.h : '#c0a878', 'stroke-width':'1',
    }));
    svg.appendChild(_el('path', {
      d:'M11 40 Q20 43 29 40', fill:'none',
      stroke: isSelected ? col.h : 'rgba(180,150,100,0.5)', 'stroke-width':'0.8',
    }));
    // Crown — canine with prominent cusp
    svg.appendChild(_el('path', {
      d: isLower
        ? 'M10 40 C9 32 10 24 13 18 C15.5 13 18 9 20 8 C22 9 24.5 13 27 18 C30 24 31 32 30 40 Z'
        : 'M10 40 C9 31 10 23 13 17 C15.5 11 18 8 20 7 C22 8 24.5 11 27 17 C30 23 31 31 30 40 Z',
      fill: g.eg, stroke: isSelected ? col.h : '#b09a72', 'stroke-width':'1.2',
    }));
    // Cusp tip highlight
    const cy = isLower ? '8' : '7';
    svg.appendChild(_el('circle', {
      cx:'20', cy, r:'2.5',
      fill: isSelected ? col.h : '#e8d8b0', stroke: isSelected ? col.glow : 'rgba(255,240,200,0.5)', 'stroke-width':'1',
    }));
    // Mesial cusp ridge
    svg.appendChild(_el('path', {
      d: isLower ? `M13 18 L20 8` : `M13 17 L20 7`,
      fill:'none', stroke:'rgba(255,255,255,0.3)', 'stroke-width':'0.9', 'stroke-linecap':'round',
    }));
    // Distal cusp ridge
    svg.appendChild(_el('path', {
      d: isLower ? `M27 18 L20 8` : `M27 17 L20 7`,
      fill:'none', stroke:'rgba(255,255,255,0.2)', 'stroke-width':'0.8', 'stroke-linecap':'round',
    }));
    // Perikymata
    [24,28,32,36].forEach(y => {
      svg.appendChild(_el('path', {
        d:`M12 ${y} Q20 ${y+1.5} 28 ${y}`, fill:'none',
        stroke:'rgba(160,130,90,0.12)', 'stroke-width':'0.5',
      }));
    });
    svg.appendChild(_el('ellipse', {
      cx:'16', cy: isLower ? '19' : '18', rx:'2.5', ry:'5',
      fill: g.hg, transform:'rotate(-20,16,19)',
    }));
    return svg;
  }

  // ── PREMOLAR ────────────────────────────────────────────────
  function _svgPremolar(col, isSelected, isLower) {
    const id = ++_defCounter;
    const svg = _el('svg', {viewBox:'0 0 44 68', xmlns:NS, style:'overflow:visible'});
    const g = _makeGradients(svg, id, isSelected, col);

    const sc = isSelected ? col.h : '#c0a878';
    // Buccal root
    svg.appendChild(_el('path', {
      d:'M12 39 C11 47 11.5 57 13 62 Q16.5 68 20 62 C21.5 57 22 47 21 39 Z',
      fill: g.rg, stroke: sc, 'stroke-width':'1',
    }));
    // Lingual root
    svg.appendChild(_el('path', {
      d:'M23 39 C22 46 22.5 55 24 60 Q27 66 30 60 C31.5 55 32 46 31 39 Z',
      fill: g.rg, stroke: sc, 'stroke-width':'1', opacity:'0.8',
    }));
    // CEJ
    svg.appendChild(_el('path', {
      d:'M8 39 Q22 42 34 39', fill:'none',
      stroke: isSelected ? col.h : 'rgba(180,150,100,0.5)', 'stroke-width':'0.8',
    }));
    // Crown
    svg.appendChild(_el('path', {
      d:'M8 39 C7 31 8 23 11 17 Q15 10 22 10 Q29 10 33 17 C36 23 37 31 36 39 Z',
      fill: g.eg, stroke: isSelected ? col.h : '#b09a72', 'stroke-width':'1.3',
    }));
    // Buccal cusp
    svg.appendChild(_el('path', {
      d:'M11 18 Q15 10.5 22 10', fill:'none',
      stroke:'rgba(255,255,255,0.35)', 'stroke-width':'0.9', 'stroke-linecap':'round',
    }));
    // Lingual cusp (shorter)
    svg.appendChild(_el('path', {
      d:'M33 18 Q29 10.5 22 10', fill:'none',
      stroke:'rgba(255,255,255,0.25)', 'stroke-width':'0.8', 'stroke-linecap':'round',
    }));
    // Central groove
    svg.appendChild(_el('line', {
      x1:'22', y1:'10.5', x2:'22', y2:'35',
      stroke: isSelected ? col.h+'66' : 'rgba(160,130,90,0.3)', 'stroke-width':'0.8',
    }));
    // Transverse groove
    svg.appendChild(_el('path', {
      d:'M13 26 Q22 24 31 26', fill:'none',
      stroke: isSelected ? col.h+'44' : 'rgba(160,130,90,0.2)', 'stroke-width':'0.7',
    }));
    // Gloss
    svg.appendChild(_el('ellipse', {
      cx:'16', cy:'19', rx:'3', ry:'5.5',
      fill: g.hg, transform:'rotate(-10,16,19)',
    }));
    return svg;
  }

  // ── MOLAR ───────────────────────────────────────────────────
  function _svgMolar(col, isSelected, isLower) {
    const id = ++_defCounter;
    const svg = _el('svg', {viewBox:'0 0 52 66', xmlns:NS, style:'overflow:visible'});
    const g = _makeGradients(svg, id, isSelected, col);

    const sc = isSelected ? col.h : '#c0a878';

    if (isLower) {
      // Lower molar — 2 roots, flat crown
      svg.appendChild(_el('path', {
        d:'M10 38 C9 47 9.5 57 11 62 Q15 67 19 62 C20.5 57 21 47 20 38 Z',
        fill: g.rg, stroke: sc, 'stroke-width':'1',
      }));
      svg.appendChild(_el('path', {
        d:'M30 38 C29 47 29.5 57 31 62 Q35 67 39 62 C40.5 57 41 47 40 38 Z',
        fill: g.rg, stroke: sc, 'stroke-width':'1', opacity:'0.85',
      }));
    } else {
      // Upper molar — 3 roots
      svg.appendChild(_el('path', {
        d:'M8 38 C7 47 7.5 56 9 61 Q13 66 17 61 C18.5 56 19 47 18 38 Z',
        fill: g.rg, stroke: sc, 'stroke-width':'1',
      }));
      svg.appendChild(_el('path', {
        d:'M20 38 C19.5 46 20 55 21.5 60 Q25 65 28.5 60 C30 55 30.5 46 30 38 Z',
        fill: g.rg, stroke: sc, 'stroke-width':'1', opacity:'0.75',
      }));
      svg.appendChild(_el('path', {
        d:'M32 38 C31 47 31.5 56 33 61 Q37 66 41 61 C42.5 56 43 47 42 38 Z',
        fill: g.rg, stroke: sc, 'stroke-width':'1', opacity:'0.85',
      }));
    }

    // CEJ
    svg.appendChild(_el('path', {
      d:'M6 38 Q26 42 46 38', fill:'none',
      stroke: isSelected ? col.h : 'rgba(180,150,100,0.5)', 'stroke-width':'0.9',
    }));

    // Crown — wide box shape
    svg.appendChild(_el('path', {
      d: isLower
        ? 'M6 38 C5 30 6 22 9 16 Q14 9 26 9 Q38 9 43 16 C46 22 47 30 46 38 Z'
        : 'M6 38 C5 29 6 21 9 15 Q14 8 26 8 Q38 8 43 15 C46 21 47 29 46 38 Z',
      fill: g.eg, stroke: isSelected ? col.h : '#b09a72', 'stroke-width':'1.4',
    }));

    const fy = isLower ? 11 : 10;

    // Occlusal fissure pattern — the key feature of a molar
    // Mesio-buccal groove
    svg.appendChild(_el('path', {
      d:`M11 ${fy+8} Q18 ${fy+3} 26 ${fy+5} Q34 ${fy+3} 41 ${fy+8}`,
      fill:'none', stroke: isSelected ? col.h+'66' : 'rgba(140,110,70,0.4)', 'stroke-width':'0.9',
    }));
    // Central groove (mesio-distal)
    svg.appendChild(_el('line', {
      x1:'26', y1:`${fy}`, x2:'26', y2:`${fy+22}`,
      stroke: isSelected ? col.h+'55' : 'rgba(140,110,70,0.35)', 'stroke-width':'0.8',
    }));
    // Buccal groove
    svg.appendChild(_el('line', {
      x1:'9', y1:`${fy+12}`, x2:'43', y2:`${fy+12}`,
      stroke: isSelected ? col.h+'44' : 'rgba(140,110,70,0.25)', 'stroke-width':'0.7',
    }));
    // Secondary grooves
    svg.appendChild(_el('path', {
      d:`M11 ${fy+18} Q18 ${fy+16} 26 ${fy+18} Q34 ${fy+16} 41 ${fy+18}`,
      fill:'none', stroke: isSelected ? col.h+'33' : 'rgba(140,110,70,0.2)', 'stroke-width':'0.6',
    }));

    // Cusp tips (4 main cusps)
    const cusps = isLower
      ? [[13,fy+4],[20,fy+1],[32,fy+1],[39,fy+4]]
      : [[13,fy+3],[20,fy],[32,fy],[39,fy+3]];
    cusps.forEach(([cx,cy]) => {
      svg.appendChild(_el('circle', {
        cx, cy, r:'2',
        fill: isSelected ? col.sel+'88' : '#d4c090',
        stroke: isSelected ? col.h : 'rgba(180,150,90,0.5)', 'stroke-width':'0.7',
      }));
    });

    // Gloss
    svg.appendChild(_el('ellipse', {
      cx:'16', cy: isLower ? '19' : '18', rx:'4', ry:'6.5',
      fill: g.hg, transform:'rotate(-8,16,19)',
    }));

    return svg;
  }

  // ── Master builder ───────────────────────────────────────────
  function _buildSVG(type, isSelected, isLower, col) {
    switch(type) {
      case 'I': return _svgIncisor(col, isSelected, isLower);
      case 'C': return _svgCanine(col,  isSelected, isLower);
      case 'P': return _svgPremolar(col,isSelected, isLower);
      case 'M': return _svgMolar(col,   isSelected, isLower);
      default:  return _svgIncisor(col, isSelected, isLower);
    }
  }

  // ── Tooth button ─────────────────────────────────────────────
  function makeTooth(num, isLower) {
    const type = TOOTH_TYPE[num] || 'I';
    const col  = TC[type];

    const wrap = document.createElement('div');
    wrap.className = 'tooth-btn';
    wrap.dataset.tooth = num;
    wrap.dataset.type  = type;
    wrap.title = `#${num} — ${{I:'Incisor',C:'Canine',P:'Premolar',M:'Molar'}[type]}`;

    const svgWrap = document.createElement('div');
    svgWrap.className = 'tooth-svg-wrap';

    let svgEl = _buildSVG(type, false, isLower, col);
    svgEl.classList.add('tooth-svg');
    svgWrap.appendChild(svgEl);
    wrap.appendChild(svgWrap);

    const numEl = document.createElement('div');
    numEl.className = 'tooth-num';
    numEl.textContent = num;
    wrap.appendChild(numEl);

    wrap._toothCol = col;
    wrap._isLower  = isLower;

    wrap.addEventListener('click', () => {
      if (selected.has(num)) {
        selected.delete(num);
        wrap.classList.remove('selected');
      } else {
        selected.add(num);
        wrap.classList.add('selected');
      }
      // Rebuild SVG with new selected state
      svgWrap.innerHTML = '';
      svgEl = _buildSVG(type, selected.has(num), isLower, col);
      svgEl.classList.add('tooth-svg');
      svgWrap.appendChild(svgEl);

      if (onChangeCb) onChangeCb(getSelected());
    });

    return wrap;
  }

  // ── Arch ────────────────────────────────────────────────────
  function buildArch(leftArr, rightArr, labelText, isLower) {
    const frame = document.createElement('div');
    frame.className = 'arch-frame';

    const lbl = document.createElement('div');
    lbl.className = 'arch-label';
    lbl.innerHTML = isLower
      ? `<svg width="10" height="10" viewBox="0 0 12 12" style="margin-right:5px;vertical-align:middle"><path d="M1 3h10v6H1z" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>${labelText}`
      : `<svg width="10" height="10" viewBox="0 0 12 12" style="margin-right:5px;vertical-align:middle"><path d="M1 3h10v6H1z" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>${labelText}`;
    frame.appendChild(lbl);

    const row = document.createElement('div');
    row.className = 'arch-row';
    rightArr.forEach(n => row.appendChild(makeTooth(n, isLower)));

    const mid = document.createElement('div');
    mid.className = 'midline';
    row.appendChild(mid);

    leftArr.forEach(n => row.appendChild(makeTooth(n, isLower)));
    frame.appendChild(row);
    return frame;
  }

  // ── Legend ──────────────────────────────────────────────────
  function buildLegend() {
    const row = document.createElement('div');
    row.className = 'legend-row';
    [
      [TC.I.h, 'Incisor'],
      [TC.C.h, 'Canine'],
      [TC.P.h, 'Premolar'],
      [TC.M.h, 'Molar'],
    ].forEach(([color, label]) => {
      const item = document.createElement('div');
      item.className = 'legend-item';
      const dot = document.createElement('div');
      dot.className = 'legend-dot';
      dot.style.cssText = `background:${color};box-shadow:0 0 6px ${color}80`;
      const txt = document.createElement('span');
      txt.textContent = label;
      item.append(dot, txt);
      row.appendChild(item);
    });
    return row;
  }

  // ── Public API ───────────────────────────────────────────────
  function render(container, onChange) {
    onChangeCb = onChange;
    container.innerHTML = '';
    const chart = document.createElement('div');
    chart.className = 'dental-chart';
    chart.appendChild(buildArch(UPPER_LEFT, UPPER_RIGHT, 'UPPER JAW — Maxilla', false));
    chart.appendChild(buildArch(LOWER_LEFT, LOWER_RIGHT, 'LOWER JAW — Mandible', true));
    chart.appendChild(buildLegend());
    container.appendChild(chart);
  }

  function getSelected() { return Array.from(selected).sort((a,b)=>a-b); }

  function clearAll() {
    selected.clear();
    document.querySelectorAll('.tooth-btn').forEach(el => {
      if (el.classList.contains('selected')) {
        el.classList.remove('selected');
        const type = el.dataset.type || 'I';
        const col  = TC[type];
        const isLower = el._isLower || false;
        const wrap = el.querySelector('.tooth-svg-wrap');
        if (wrap) {
          wrap.innerHTML = '';
          const svg = _buildSVG(type, false, isLower, col);
          svg.classList.add('tooth-svg');
          wrap.appendChild(svg);
        }
      }
    });
    if (onChangeCb) onChangeCb([]);
  }

  function selectByNumbers(numbers) {
    numbers.forEach(n => {
      selected.add(n);
      const el = document.querySelector(`.tooth-btn[data-tooth="${n}"]`);
      if (!el) return;
      el.classList.add('selected');
      const type = el.dataset.type || 'I';
      const col  = TC[type];
      const isLower = el._isLower || false;
      const wrap = el.querySelector('.tooth-svg-wrap');
      if (wrap) {
        wrap.innerHTML = '';
        const svg = _buildSVG(type, true, isLower, col);
        svg.classList.add('tooth-svg');
        wrap.appendChild(svg);
      }
    });
    if (onChangeCb) onChangeCb(getSelected());
  }

  function selectAll(archFilter) {
    const upper = [...UPPER_RIGHT,...UPPER_LEFT];
    const lower = [...LOWER_LEFT,...LOWER_RIGHT];
    const targets = archFilter==='upper' ? upper : archFilter==='lower' ? lower : [...upper,...lower];
    selectByNumbers(targets);
  }

  return { render, getSelected, clearAll, selectAll, selectByNumbers };
})();