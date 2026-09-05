# DentalCAD readiness boundary

The current repository is an engineering prototype with a tested geometry and manufacturing pipeline. The 94/94 acceptance result measures deterministic software behavior only; it is not a claim of clinical validation, regulatory clearance, commercial parity, or readiness for sale.

The path to a serious Exocad competitor has four independent workstreams:

1. **Engineering** — complete the design modules, robust geometry kernel, integrations, performance work, and sustained browser/desktop testing with a multidisciplinary team.
2. **Data and clinical validation** — collect real scans and treatment outcomes through dentists and laboratories, define labeled evaluation sets, and measure accuracy over time. This cannot be fabricated in code.
3. **Business and partnerships** — establish laboratory, scanner, milling, distribution, support, and commercial relationships.
4. **Regulatory and quality** — determine the applicable device classification and jurisdiction, establish a quality system, risk management, cybersecurity, clinical evidence, and the required submissions before commercial sale.

The repository can provide evidence for the engineering workstream. The other three require external people, data, funding, and elapsed time. The current software status should therefore be described as **tested prototype / pre-commercial**, until those external workstreams produce their own evidence.

## Evidence boundary

- Automated source and geometry acceptance: `audit/results.json` (currently 94 passing cases).
- Build and static/HTTP gates: `audit/run-all.ps1` and `audit/http-smoke.ps1`.
- Desktop shell: `desktop/` and the Python-style launcher at the repository root.
- Browser interaction, CAM-machine validation, clinical validation, partnerships, and regulatory clearance remain external evidence requirements.
