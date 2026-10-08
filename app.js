/**
 * ============================================================
 * BLOODREPORT AI - CORE APPLICATION CONTROLLER & GEMINI API
 * Dynamic report analysis, Gemini AI extraction & summaries,
 * longitudinal comparison engine, and Chart.js visualizations.
 * ============================================================
 */

// Global State
let currentView = 'viewLanding';
let comparisonChartInstance = null;
let modalChartInstance = null;
let latestGeminiSummary = null;
// NOTE: Patient profile removed for now — will be re-added via Firebase.
// Doctor summary name/age fields render "—" placeholders (see renderDoctorSummaryView).

// Report store starts empty. Upload a report (Upload page) or paste lab text
// to create the first entry, then confirm it in the verification table.
// (Previous demo/seed reports were removed; no testing data ships with the app.)
const REPORTS_STORE = [];

// Report views (analysis, detail modal) follow this when set from History;
// null means "latest report". Dashboard always shows the latest.
let activeReportId = null;

function getActiveReport() {
  if (activeReportId !== null && activeReportId !== undefined) {
    const found = REPORTS_STORE.find(r => r.id === activeReportId);
    if (found) return found;
    activeReportId = null; // stale (e.g. deleted) -> fall back to latest
  }
  return REPORTS_STORE.length > 0 ? REPORTS_STORE[REPORTS_STORE.length - 1] : null;
}

function predecessorOf(report) {
  const idx = REPORTS_STORE.findIndex(r => r.id === report.id);
  return idx > 0 ? REPORTS_STORE[idx - 1] : null;
}

// Empty-state helpers: every view must handle zero uploaded reports
// gracefully instead of crashing on REPORTS_STORE[REPORTS_STORE.length - 1].
function hasReports() {
  return REPORTS_STORE.length > 0;
}
function emptyTableRow(colspan, msg) {
  return `<tr><td colspan="${colspan}" style="text-align:center; padding: 22px; color: var(--text-muted);">${msg}</td></tr>`;
}
const NO_REPORTS_MSG = 'No reports uploaded yet. Go to <strong>Upload Report</strong> to add your first blood report.';
// Extracted Tests Working Buffer for user verification before confirming
let ocrWorkingTests = [];

// ============================================================
// GEMINI API SERVICE (POWERED SECURELY VIA BACKEND & .ENV)
// ============================================================
const geminiService = {
  async extractBiomarkers(reportText) {
    try {
      const res = await fetch('/api/gemini/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw_text: reportText })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.tests && data.tests.length > 0) {
          return data;
        }
      }
    } catch (err) {
      console.warn('Backend /api/gemini/extract unavailable or offline, running local fallback parser:', err);
    }
    return fallbackParseReportText(reportText);
  },

  async generateSummary(currentTests, previousTests = []) {
    // Abort after 20s so a hanging AI call can never leave the UI spinning;
    // the local synthesis below always guarantees a visible summary.
    const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 20000) : null;
    try {
      const res = await fetch('/api/gemini/summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          current_tests: currentTests,
          previous_tests: previousTests
        }),
        signal: controller ? controller.signal : undefined
      });
      if (res.ok) {
        const data = await res.json();
        // Validate shape: a malformed AI payload must never blank the page.
        if (data && typeof data.narrative === 'string' && data.narrative.trim()) {
          return data;
        }
        console.warn('Summary response missing narrative, using local synthesis.');
      }
    } catch (err) {
      console.warn('Backend /api/gemini/summary unavailable, running local dynamic synthesis:', err);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return generateLocalDynamicSummary(currentTests, previousTests);
  },

  async explainBiomarker(testName, value, unit, low, high) {
    try {
      const res = await fetch('/api/gemini/explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          test_name: testName,
          value: value,
          unit: unit,
          low: low,
          high: high
        })
      });
      if (res.ok) {
        return await res.json();
      }
    } catch (err) {
      console.warn('Backend /api/gemini/explain unavailable, using local explanation:', err);
    }
    return {
      explanation: `${testName} is a routine diagnostic biomarker measured in clinical blood panels.`,
      factors: 'Hydration status, recent meals, exercise, and collection time.',
      guidance: 'Review any deviations with your physician to establish personalized target goals.'
    };
  }
};

const BIOMARKER_LIBRARY = [
  { canonical: 'Fasting Glucose', aliases: ['fasting glucose', 'blood glucose', 'blood sugar', 'glucose fasting', 'glucose', 'fbs', 'fasting blood sugar'], unit: 'mg/dL', low: 70, high: 99 },
  { canonical: 'HbA1c', aliases: ['hba1c', 'hb a1c', 'glycated hemoglobin', 'glycated haemoglobin', 'glycosylated hemoglobin', 'glycohemoglobin', 'a1c'], unit: '%', low: 4.0, high: 5.6 },
  { canonical: 'Total Cholesterol', aliases: ['total cholesterol', 'cholesterol total', 'serum cholesterol'], unit: 'mg/dL', low: 120, high: 200 },
  { canonical: 'Triglycerides', aliases: ['triglycerides', 'triglyceride', 'trig'], unit: 'mg/dL', low: 40, high: 150 },
  { canonical: 'HDL Cholesterol', aliases: ['hdl cholesterol', 'hdl-c', 'hdl'], unit: 'mg/dL', low: 40, high: 80 },
  { canonical: 'LDL Cholesterol', aliases: ['ldl cholesterol', 'ldl-c', 'ldl'], unit: 'mg/dL', low: 50, high: 100 },
  { canonical: 'ALT (SGPT)', aliases: ['alt (sgpt)', 'alt', 'sgpt', 'alanine aminotransferase'], unit: 'U/L', low: 7, high: 40 },
  { canonical: 'AST (SGOT)', aliases: ['ast (sgot)', 'ast', 'sgot', 'aspartate aminotransferase'], unit: 'U/L', low: 10, high: 40 },
  { canonical: 'Vitamin D (25-OH)', aliases: ['vitamin d (25-oh)', 'vitamin d 25-oh', 'vitamin d', 'vit d', '25-oh vitamin d', '25-hydroxy vitamin d'], unit: 'ng/mL', low: 30, high: 100 },
  { canonical: 'Vitamin B12', aliases: ['vitamin b12', 'vit b12', 'b12', 'cobalamin'], unit: 'pg/mL', low: 200, high: 900 },
  { canonical: 'Hemoglobin', aliases: ['hemoglobin', 'haemoglobin', 'hb', 'hgb', 'hb level'], unit: 'g/dL', low: 13.5, high: 17.5 },
  { canonical: 'Hematocrit', aliases: ['hematocrit', 'haematocrit', 'hct', 'packed cell volume', 'pcv'], unit: '%', low: 41, high: 50 },
  { canonical: 'RBC Count', aliases: ['rbc count', 'rbc', 'red blood cell', 'red blood corpuscle', 'erythrocyte'], unit: 'million/uL', low: 4.0, high: 5.5 },
  { canonical: 'MCV', aliases: ['mcv', 'mean corpuscular volume'], unit: 'fL', low: 80, high: 100 },
  { canonical: 'MCH', aliases: ['mch', 'mean corpuscular hemoglobin'], unit: 'pg', low: 27, high: 33 },
  { canonical: 'MCHC', aliases: ['mchc', 'mean corpuscular hemoglobin concentration'], unit: 'g/dL', low: 32, high: 36 },
  { canonical: 'RDW-CV', aliases: ['rdw-cv', 'rdw cv', 'rdw', 'red cell distribution width'], unit: '%', low: 11.5, high: 14.5 },
  { canonical: 'ESR', aliases: ['esr', 'erythrocyte sedimentation rate', 'westergren'], unit: 'mm/hr', low: 0, high: 20 },
  { canonical: 'Neutrophils', aliases: ['neutrophils', 'neutrophil', 'neut', 'polymorphs', 'polymorph'], unit: '%', low: 40, high: 70 },
  { canonical: 'Lymphocytes', aliases: ['lymphocytes', 'lymphocyte', 'lymph'], unit: '%', low: 20, high: 40 },
  { canonical: 'Monocytes', aliases: ['monocytes', 'monocyte', 'mono'], unit: '%', low: 2, high: 8 },
  { canonical: 'Eosinophils', aliases: ['eosinophils', 'eosinophil', 'eosino', 'eos'], unit: '%', low: 1, high: 4 },
  { canonical: 'Basophils', aliases: ['basophils', 'basophil', 'baso'], unit: '%', low: 0, high: 1 },
  { canonical: 'MPV', aliases: ['mpv', 'mean platelet volume'], unit: 'fL', low: 7.5, high: 11.5 },
  { canonical: 'WBC Count', aliases: ['wbc count', 'wbc', 'white blood cell', 'leukocyte', 'tlc', 'total leukocyte'], unit: '10^3/uL', low: 4.5, high: 11.0 },
  { canonical: 'Platelets', aliases: ['platelets', 'platelet', 'platelet count', 'thrombocyte', 'plt'], unit: '10^3/uL', low: 150, high: 450 },
  { canonical: 'eGFR', aliases: ['egfr', 'estimated gfr', 'glomerular filtration'], unit: 'mL/min', low: 60, high: 120 },
  { canonical: 'Serum Creatinine', aliases: ['serum creatinine', 'creatinine'], unit: 'mg/dL', low: 0.70, high: 1.30 },
  { canonical: 'Serum Urea', aliases: ['serum urea', 'urea'], unit: 'mg/dL', low: 15, high: 40 },
  { canonical: 'BUN', aliases: ['bun', 'blood urea nitrogen'], unit: 'mg/dL', low: 7, high: 20 },
  { canonical: 'TSH', aliases: ['tsh', 'thyroid stimulating hormone', 'thyrotropin'], unit: 'mIU/L', low: 0.4, high: 4.0 },
  { canonical: 'T3 Total', aliases: ['t3 total', 't3', 'triiodothyronine'], unit: 'ng/dL', low: 80, high: 200 },
  { canonical: 'T4 Total', aliases: ['t4 total', 't4', 'thyroxine'], unit: 'ug/dL', low: 5.0, high: 12.0 },
  { canonical: 'Ferritin', aliases: ['ferritin', 'serum ferritin'], unit: 'ng/mL', low: 30, high: 400 },
  { canonical: 'hs-CRP', aliases: ['hs-crp', 'hs crp', 'high sensitivity crp', 'c-reactive protein', 'crp'], unit: 'mg/L', low: 0.1, high: 1.0 }
];
// Word-boundary matching is critical: short aliases like "ast", "alt", "hb"
// must NOT match inside other words ("fasting" contains "ast", "health"
// contains "alt"). Each alias becomes a (?<!\w)...(?!\w) regex.
function escapeForRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
}
const BIOMARKER_PATTERNS = [];
BIOMARKER_LIBRARY.forEach(b => {
  b.aliases.forEach(a => {
    BIOMARKER_PATTERNS.push({
      canonical: b.canonical,
      alias: a,
      regex: new RegExp(`(?<!\\w)${escapeForRegex(a)}(?!\\w)`, 'i'),
      aliasLen: a.length,
      biomarker: b
    });
  });
});
// Longest alias first so "HDL Cholesterol" wins over "HDL",
// "Vitamin D (25-OH)" wins over "Vitamin D", etc.
BIOMARKER_PATTERNS.sort((x, y) => y.aliasLen - x.aliasLen);

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1), cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ai === b.charCodeAt(j - 1) ? 0 : 1));
    }
    const tmp = prev; prev = cur; cur = tmp;
  }
  return prev[n];
}

function fuzzyThreshold(alias) {
  const len = alias.length;
  if (len >= 7) return 2;
  if (len >= 4) return 1;
  return 0; // short tokens (hb, ast, t3) stay exact to avoid false hits
}

function sameDigits(a, b) {
  const da = (a.match(/\d/g) || []).join('');
  const db = (b.match(/\d/g) || []).join('');
  return da === db;
}

function findFuzzyBiomarkerInLine(line) {
  // Second pass for scanned-photo OCR typos ("HemogIobin" for Hemoglobin).
  // Runs only when exact matching found nothing. Single-token aliases only,
  // pure numbers skipped, digit sequences must agree exactly.
  const words = [];
  const wordRe = /[A-Za-z0-9]+(?:[\/\-][A-Za-z0-9]+)*/g;
  let m;
  while ((m = wordRe.exec(line)) !== null) {
    if (/^[0-9.]+$/.test(m[0])) continue;
    words.push({ text: m[0], index: m.index });
  }
  if (words.length === 0) return null;
  let best = null;
  for (const p of BIOMARKER_PATTERNS) {
    if (/\s/.test(p.alias)) continue;
    const th = fuzzyThreshold(p.alias);
    if (th === 0) continue;
    const al = p.alias.toLowerCase();
    for (const w of words) {
      const wl = w.text.toLowerCase();
      if (Math.abs(wl.length - al.length) > th) continue;
      if (!sameDigits(w.text, p.alias)) continue;
      const d = levenshtein(wl, al);
      if (d > 0 && d <= th && (!best || d < best.dist ||
          (d === best.dist && (w.index < best.index ||
            (w.index === best.index && p.aliasLen > best.pattern.aliasLen))))) {
        best = { pattern: p, biomarker: p.biomarker, index: w.index, matchLen: w.text.length, dist: d };
      }
    }
  }
  return best;
}

function findBiomarkerInLine(line) {
  // Earliest occurrence in the string wins; longest alias breaks ties at the
  // same position (so "HDL Cholesterol" beats "HDL"). Position-first ordering
  // is what makes multi-test lines and flattened PDF text extract in order.
  let best = null;
  for (const p of BIOMARKER_PATTERNS) {
    const m = p.regex.exec(line);
    if (m && (!best || m.index < best.index ||
        (m.index === best.index && p.aliasLen > best.pattern.aliasLen))) {
      best = { pattern: p, biomarker: p.biomarker, index: m.index, matchLen: m[0].length };
    }
  }
  return best;
}

function matchReportNumber(s) {
  // Numeric result with optional thousands separators ("2,50,000" -> 250000).
  const m = s.match(/[-+]?[\d,]+(?:\.\d+)?/);
  if (!m) return null;
  const val = parseFloat(m[0].replace(/,/g, ''));
  if (isNaN(val)) return null;
  return { text: m[0], index: m.index, length: m[0].length, value: val };
}

function lastNumberBefore(s) {
  // For layouts printing the result before the test name
  // ("13.8 g/dL Hemoglobin"). Rejects trailing dates ("2026-10-04 Hb").
  const trimmed = s.replace(/\s+$/, '');
  if (/(19|20)\d{2}-\d{1,2}-\d{1,2}$/.test(trimmed)) return null;
  const all = [...trimmed.matchAll(/[-+]?[\d,]+(?:\.\d+)?/g)];
  if (all.length === 0) return null;
  const last = all[all.length - 1];
  const val = parseFloat(last[0].replace(/,/g, ''));
  if (isNaN(val)) return null;
  return { text: last[0], index: last.index, length: last[0].length, value: val };
}

function parsePrintedRangeFromLine(lineAfterValue, defaultLow, defaultHigh) {
  // Prefer content inside parentheses/brackets: "(70 - 99)", "(< 200)", "(> 40)"
  const parenChunks = [];
  const parenRe = /[\(\[]([^\)\]]+)[\)\]]/g;
  let m;
  while ((m = parenRe.exec(lineAfterValue)) !== null) parenChunks.push(m[1]);
  const searchZones = parenChunks.length > 0 ? parenChunks : [lineAfterValue];

  for (const zone of searchZones) {
    // "< 200" style -> only an upper bound is printed
    let lt = zone.match(/<\s*(\d+\.?\d*)/);
    if (lt) return { low: defaultLow, high: parseFloat(lt[1]), printed: true };
    // "> 40" style -> only a lower bound is printed
    let gt = zone.match(/>\s*(\d+\.?\d*)/);
    if (gt) return { low: parseFloat(gt[1]), high: defaultHigh, printed: true };
    // "70 - 99", "70 to 99", "70–99" style
    let range = zone.match(/(\d+\.?\d*)\s*(?:-|–|—|to)\s*(\d+\.?\d*)/i);
    if (range) {
      const lo = parseFloat(range[1]);
      const hi = parseFloat(range[2]);
      if (!isNaN(lo) && !isNaN(hi) && hi > lo && hi < 100000) {
        return { low: lo, high: hi, printed: true };
      }
    }
  }
  return { low: defaultLow, high: defaultHigh, printed: false };
}

function extractUnitFromLine(lineAfterValue, defaultUnit) {
  const um = lineAfterValue.match(/(mg\s*\/\s*dL|g\s*\/\s*dL|ng\s*\/\s*dL|ng\s*\/\s*mL|pg\s*\/\s*mL|10\^3\s*\/\s*uL|x10\^6\s*\/\s*uL|million\s*\/\s*uL|U\s*\/\s*L|mL\s*\/\s*min|mmol\s*\/\s*L|mg\s*\/\s*L|mm\s*\/\s*hr|mIU\s*\/\s*L|uIU\s*\/\s*mL|ug\s*\/\s*dL|(?<!\w)fL(?!\w)|(?<!\w)pg(?!\w)|%)/i);
  if (um) {
    const u = um[1].replace(/\s+/g, '');
    if (/%/.test(u)) return '%';
    if (/mg\/dL/i.test(u)) return 'mg/dL';
    if (/g\/dL/i.test(u)) return 'g/dL';
    if (/ng\/mL/i.test(u)) return 'ng/mL';
    if (/ng\/dL/i.test(u)) return 'ng/dL';
    if (/pg\/mL/i.test(u)) return 'pg/mL';
    if (/^pg$/i.test(u)) return 'pg';
    if (/^fL$/i.test(u)) return 'fL';
    if (/U\/L/i.test(u)) return 'U/L';
    if (/mL\/min/i.test(u)) return 'mL/min';
    if (/mg\/L/i.test(u)) return 'mg/L';
    if (/mm\/hr/i.test(u)) return 'mm/hr';
    if (/(mIU\/L|uIU\/mL)/i.test(u)) return 'mIU/L';
    if (/ug\/dL/i.test(u)) return 'ug/dL';
    if (/(10\^3\/uL|x10\^6\/uL|million\/uL)/i.test(u)) return um[1].includes('10^3') ? '10^3/uL' : 'million/uL';
    return um[1].trim();
  }
  return defaultUnit;
}

function normalizeReportLine(line) {
  // "Glucose, Fasting" -> "Glucose Fasting" so it matches the
  // "glucose fasting" alias. Only commas/semicolons between letters are
  // joined — "/" is left alone because units (mg/dL, U/L, ng/mL) need it,
  // and numeric ranges like "70 - 99" are untouched.
  return line
    .replace(/([A-Za-z])\s*[,\;]\s*([A-Za-z])/g, '$1 $2')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function fallbackParseReportText(reportText) {
  const tests = [];
  if (!reportText || !reportText.trim()) {
    return { lab_name: 'Clinical Laboratory', report_date: new Date().toISOString().split('T')[0], tests };
  }
  const lines = reportText.replace(/\f/g, '\n').split(/\r?\n/);

  lines.forEach(rawLine => {
    let line = normalizeReportLine(rawLine.trim());
    if (line.length < 3) return;

    // Scan the whole line for biomarkers (not just the first hit) so that
    // flattened PDF text or multi-column rows holding several tests on one
    // line still populate the full Verify Extracted Laboratory Values table.
    let remaining = line;
    let guard = 0;
    while (remaining && guard < 10) {
      guard++;
      // Exact match first; OCR-typo-tolerant fuzzy match as fallback so a
      // misread word like "HemogIobin" still resolves to Hemoglobin.
      const hit = findBiomarkerInLine(remaining) || findFuzzyBiomarkerInLine(remaining);
      if (!hit) break;
      const biomarker = hit.biomarker;

      // Take the substring AFTER the matched alias so leading dates/ages
      // (e.g. "Date: 2026-10-04 Fasting Glucose: 114") are not picked as the value.
      const afterAlias = remaining.slice(hit.index + hit.matchLen);
      let valMatch = matchReportNumber(afterAlias);
      let valEnd;
      // A number directly inside an opening bracket is the printed range,
      // not the result ("13.8 g/dL Hemoglobin (13.5 - 17.5)").
      const afterIsRange = valMatch && /^\s*[\(\[]/.test(afterAlias.slice(0, valMatch.index));
      if (valMatch && !afterIsRange) {
        valEnd = hit.index + hit.matchLen + valMatch.index + valMatch.length;
      } else {
        // Some layouts print the result before the test name
        // ("13.8 g/dL Hemoglobin"): fall back to the last number before it.
        const prev = lastNumberBefore(remaining.slice(0, hit.index));
        if (!prev) {
          remaining = afterAlias; // alias with no number nearby; keep scanning rest of line
          continue;
        }
        valMatch = prev;
        valEnd = prev.index + prev.length;
      }
      const val = valMatch.value;

      if (!tests.find(t => t.name === biomarker.canonical)) {
        // first occurrence wins
        // Range/unit lookup is scoped to this biomarker's own segment — from
        // the earlier of (value, name) through just past the later — so
        // flattened multi-test lines still attribute each printed range and
        // unit to the correct biomarker.
        const segStart = Math.min(hit.index, valEnd);
        const segEnd = Math.max(hit.index + hit.matchLen, valEnd);
        const rangeScope = remaining.slice(segStart, segEnd + 80);
        const rangeInfo = parsePrintedRangeFromLine(rangeScope, biomarker.low, biomarker.high);
        const unit = extractUnitFromLine(remaining.slice(segStart, segEnd + 40), biomarker.unit);

        tests.push({
          name: biomarker.canonical,
          value: val,
          unit: unit,
          low: rangeInfo.low,
          high: rangeInfo.high,
          status: calculateStatus(val, rangeInfo.low, rangeInfo.high),
          printed: rangeInfo.printed,
          fuzzy: hit.dist !== undefined // OCR-typo match: user should double-check spelling
        });
      }
      remaining = remaining.slice(valEnd);
    }
  });

  return {
    lab_name: 'Metro Health Clinical Laboratories',
    report_date: new Date().toISOString().split('T')[0],
    tests: tests
  };
}

function generateLocalDynamicSummary(currentTests, previousTests = []) {
  const abnormal = currentTests.filter(t => t.status !== 'Normal');
  const improved = [];
  const worsened = [];
  if (previousTests && previousTests.length > 0) {
    currentTests.forEach(c => {
      const p = previousTests.find(item => item.name === c.name);
      if (!p) return;
      const evalRes = evaluateClinicalTrend(c.name, p.value, c.value, c.low, c.high);
      if (evalRes.trend === 'Improving') {
        improved.push(`${c.name} (moved from ${p.value} to ${c.value} ${c.unit} toward normal)`);
      } else if (evalRes.trend === 'Worsening') {
        worsened.push(`${c.name} (moved from ${p.value} to ${c.value} ${c.unit} away from normal)`);
      }
    });
  }

  const trendTitle = (improved.length > 0 && worsened.length === 0)
    ? 'Positive Trajectory with Key Metabolic Areas Needing Attention'
    : (worsened.length > improved.length
      ? 'Mixed Trend — Some Values Moved Away From Normal'
      : (abnormal.length > 0 ? 'Stable Clinical Baseline' : 'Optimal'));
  const trendSuffix = (improved.length > 0 || worsened.length > 0)
    ? ` Since the previous report, ${improved.length} value(s) moved toward normal${worsened.length > 0 ? ` and ${worsened.length} moved away.` : '.'}`
    : '';

  return {
    overall_trend: trendTitle,
    narrative: `Analysis of your ${currentTests.length} analyzed parameters demonstrates ${currentTests.length - abnormal.length} tests within normal reference intervals, and ${abnormal.length} tests outside reference bounds.${trendSuffix} Discuss these findings with your healthcare professional to tailor personal target goals.`,
    improved_values: improved,
    worsened_values: worsened,
    attention_needed: abnormal.map(a => `${a.name} (${a.value} ${a.unit}) is flagged as ${a.status.toLowerCase()} relative to reference limits (${a.low} - ${a.high}).`),
    doctor_questions: [
      `What target range would you like my ${abnormal.length > 0 ? abnormal[0].name : 'biomarkers'} to reach over the next 3 to 6 months?`,
      "What lifestyle or nutritional modifications do you advise based on these specific findings?",
      "Are there any follow-up panels or repeat tests recommended?",
      "When should we schedule my next blood work panel to track progress?"
    ]
  };
}

// ============================================================
// NAVIGATION CONTROLLER
// ============================================================
function navigateTo(viewId) {
  document.querySelectorAll('.nav-link').forEach(link => {
    if (link.getAttribute('data-view') === viewId) link.classList.add('active');
    else link.classList.remove('active');
  });

  document.querySelectorAll('.page-view').forEach(view => {
    if (view.id === viewId) view.classList.add('active');
    else view.classList.remove('active');
  });

  currentView = viewId;
  window.scrollTo({ top: 0, behavior: 'smooth' });

  if (viewId === 'viewDashboard') renderDashboard();
  else if (viewId === 'viewAnalysis') renderFullAnalysisTable();
  else if (viewId === 'viewComparison') runComparisonEngine();
  else if (viewId === 'viewHistory') renderHistoryTimeline();
  else if (viewId === 'viewDoctorSummary') renderDoctorSummaryView();
  else if (viewId === 'viewAISummary') generateDynamicAISummary();

  if (window.lucide) window.lucide.createIcons();
}

// ============================================================
// CLINICAL CONTEXT-AWARE COMPARISON ENGINE
// ============================================================
function calculateStatus(val, low, high) {
  if (low !== null && val < low) return (val < low * 0.7) ? 'Critical' : 'Low';
  if (high !== null && val > high) return (val > high * 1.3) ? 'Critical' : 'High';
  return 'Normal';
}

function evaluateClinicalTrend(testName, prevVal, currVal, low, high) {
  if (prevVal === currVal) return { trend: 'Stable', class: 'stable', label: 'Stable' };

  function getDistance(val) {
    if (val < low) return low - val;
    if (val > high) return val - high;
    return 0;
  }

  const prevDist = getDistance(prevVal);
  const currDist = getDistance(currVal);

  if (currDist < prevDist) return { trend: 'Improving', class: 'improving', label: 'Improving' };
  if (currDist > prevDist) return { trend: 'Worsening', class: 'worsening', label: 'Worsening' };
  return { trend: 'Stable', class: 'stable', label: 'Stable (Normal)' };
}

// ============================================================
// PAGE 7: DASHBOARD VIEW
// ============================================================
function renderDashboard() {
  renderGoals();
  renderReminders();
  if (!hasReports()) {
    document.getElementById('dashActiveDate').textContent = 'No reports yet';
    ['dashNormalCount', 'dashLowCount', 'dashHighCount', 'dashAttentionCount',
     'dashTotalCount', 'dashAbnormalCount', 'dashImprovedCount', 'dashWorsenedCount'
    ].forEach(id => { document.getElementById(id).textContent = '0'; });
    document.getElementById('dashOverallTrend').textContent = '—';
    document.getElementById('dashPreviewTableBody').innerHTML = emptyTableRow(7, NO_REPORTS_MSG);
    return;
  }
  const latestReport = REPORTS_STORE[REPORTS_STORE.length - 1];
  const prevReport = REPORTS_STORE.length > 1 ? REPORTS_STORE[REPORTS_STORE.length - 2] : null;

  document.getElementById('dashActiveDate').textContent = latestReport.dateLabel;

  let normalCount = 0;
  let lowCount = 0;
  let highCount = 0;
  let criticalCount = 0;
  let improvedCount = 0;
  let worsenedCount = 0;

  latestReport.tests.forEach(test => {
    if (test.status === 'Normal') normalCount++;
    else if (test.status === 'Low') lowCount++;
    else if (test.status === 'High') highCount++;
    else if (test.status === 'Critical') criticalCount++;

    if (prevReport) {
      const prev = prevReport.tests.find(p => p.name === test.name);
      if (prev) {
        const evalResult = evaluateClinicalTrend(test.name, prev.value, test.value, test.low, test.high);
        if (evalResult.trend === 'Improving') improvedCount++;
        if (evalResult.trend === 'Worsening') worsenedCount++;
      }
    }
  });

  document.getElementById('dashNormalCount').textContent = normalCount;
  document.getElementById('dashLowCount').textContent = lowCount;
  document.getElementById('dashHighCount').textContent = highCount;
  document.getElementById('dashAttentionCount').textContent = (criticalCount + highCount);

  document.getElementById('dashTotalCount').textContent = latestReport.tests.length;
  document.getElementById('dashAbnormalCount').textContent = (lowCount + highCount + criticalCount);
  document.getElementById('dashImprovedCount').textContent = improvedCount;
  document.getElementById('dashWorsenedCount').textContent = worsenedCount;
  document.getElementById('dashOverallTrend').textContent = (improvedCount >= worsenedCount) ? 'Improving' : 'Attention Needed';

  // Quick Table Preview
  const tbody = document.getElementById('dashPreviewTableBody');
  tbody.innerHTML = latestReport.tests.slice(0, 6).map(test => {
    const prev = prevReport ? prevReport.tests.find(p => p.name === test.name) : null;
    const diff = prev ? (test.value - prev.value).toFixed(1) : '-';

    return `
      <tr onclick="openTestDetailModal('${test.name}')">
        <td><strong>${test.name}</strong></td>
        <td style="font-family: var(--font-mono); font-weight: 700;">${test.value}</td>
        <td style="color: var(--text-secondary);">${test.unit}</td>
        <td style="font-family: var(--font-mono); color: var(--text-muted);">${test.low} - ${test.high}</td>
        <td><span class="badge-status ${test.status.toLowerCase()}">${test.status}</span></td>
        <td style="font-family: var(--font-mono);">${prev ? prev.value : '-'}</td>
        <td style="font-family: var(--font-mono); font-weight: 600;">${diff > 0 ? '+' : ''}${diff}</td>
      </tr>
    `;
  }).join('');
}

// ============================================================
// PAGE 4: FULL REPORT ANALYSIS TABLE
// ============================================================
function renderFullAnalysisTable() {
  const tbody = document.getElementById('fullAnalysisTableBody');
  if (!hasReports()) {
    tbody.innerHTML = emptyTableRow(8, NO_REPORTS_MSG);
    return;
  }
  // Shows the History-selected report when set, otherwise the latest.
  // "Previous Result" comes from its chronological predecessor.
  const activeReport = getActiveReport();
  const prevReport = predecessorOf(activeReport);
  const isLatest = activeReport.id === REPORTS_STORE[REPORTS_STORE.length - 1].id;

  const indicator = document.getElementById('analysisActiveReport');
  if (indicator) {
    indicator.innerHTML = isLatest
      ? `Showing latest report: <strong>${activeReport.dateLabel}</strong>`
      : `Viewing: <strong>${activeReport.dateLabel}</strong> &nbsp;<button class="btn btn-secondary btn-sm" onclick="showLatestReport()">Show latest</button>`;
  }

  const searchTerm = (document.getElementById('analysisSearchInput').value || '').toLowerCase();
  const statusFilter = document.getElementById('analysisStatusFilter').value;

  const filteredTests = activeReport.tests.filter(test => {
    const matchesSearch = test.name.toLowerCase().includes(searchTerm);
    const matchesStatus = (statusFilter === 'all') || (test.status.toLowerCase() === statusFilter.toLowerCase());
    return matchesSearch && matchesStatus;
  });

  tbody.innerHTML = filteredTests.map(test => {
    const prev = prevReport ? prevReport.tests.find(p => p.name === test.name) : null;
    const diff = prev ? (test.value - prev.value).toFixed(1) : 'N/A';
    const rangeSource = test.printed ? 'Printed Lab Range' : 'Validated Range';

    return `
      <tr onclick="openTestDetailModal('${test.name}')">
        <td>
          <strong>${test.name}</strong>
          <div style="font-size: 0.74rem; color: var(--teal-primary);">${rangeSource}</div>
        </td>
        <td style="font-family: var(--font-mono); font-size: 1rem; font-weight: 700;">${test.value}</td>
        <td style="color: var(--text-secondary);">${test.unit}</td>
        <td style="font-family: var(--font-mono);">${test.low} - ${test.high}</td>
        <td><span class="badge-status ${test.status.toLowerCase()}">${test.status}</span></td>
        <td style="font-family: var(--font-mono);">${prev ? prev.value : '-'}</td>
        <td style="font-family: var(--font-mono); font-weight: 600;">
          ${diff !== 'N/A' ? (diff > 0 ? `+${diff}` : diff) : '-'}
        </td>
        <td>
          <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); openTestDetailModal('${test.name}')">
            Details
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

function filterAnalysisTable() {
  renderFullAnalysisTable();
}

function showLatestReport() {
  activeReportId = null;
  renderFullAnalysisTable();
}

function openReportById(id) {
  activeReportId = id;
  navigateTo('viewAnalysis');
}

function compareReportById(id) {
  // Current = clicked report, previous = its chronological predecessor
  // (or the earliest other report when it is the first one).
  const idx = REPORTS_STORE.findIndex(r => r.id === id);
  const prev = idx > 0 ? REPORTS_STORE[idx - 1] : REPORTS_STORE.find(r => r.id !== id);
  navigateTo('viewComparison');
  const prevSel = document.getElementById('compPrevSelect');
  const currSel = document.getElementById('compCurrSelect');
  if (currSel) currSel.value = String(id);
  if (prevSel && prev) prevSel.value = String(prev.id);
  runComparisonEngine();
}

// ============================================================
// PAGE 5: COMPARISON ENGINE & TREND GRAPH
// ============================================================
function runComparisonEngine() {
  const tbody = document.getElementById('comparisonTableBody');
  if (REPORTS_STORE.length < 2) {
    tbody.innerHTML = emptyTableRow(7, REPORTS_STORE.length === 0
      ? NO_REPORTS_MSG
      : 'Only one report uploaded. Upload a second report to enable Previous vs Current comparison.');
    if (comparisonChartInstance) { comparisonChartInstance.destroy(); comparisonChartInstance = null; }
    return;
  }
  const prevSelVal = document.getElementById('compPrevSelect').value;
  const currSelVal = document.getElementById('compCurrSelect').value;

  // Selects carry report ids (with legacy date-value fallback).
  const prevReport = REPORTS_STORE.find(r => String(r.id) === prevSelVal)
    || REPORTS_STORE.find(r => r.date === prevSelVal)
    || REPORTS_STORE[0];
  const currReport = REPORTS_STORE.find(r => String(r.id) === currSelVal)
    || REPORTS_STORE.find(r => r.date === currSelVal)
    || REPORTS_STORE[REPORTS_STORE.length - 1];

  tbody.innerHTML = currReport.tests.map(currTest => {
    const prevTest = prevReport.tests.find(p => p.name === currTest.name);
    if (!prevTest) return '';

    const pVal = prevTest.value;
    const cVal = currTest.value;
    const absDiff = (cVal - pVal).toFixed(1);
    const pctDiff = pVal !== 0 ? (((cVal - pVal) / pVal) * 100).toFixed(1) : '0.0';

    const evalResult = evaluateClinicalTrend(currTest.name, pVal, cVal, currTest.low, currTest.high);

    return `
      <tr onclick="openTestDetailModal('${currTest.name}')">
        <td><strong>${currTest.name}</strong></td>
        <td style="color: var(--text-secondary);">${currTest.unit}</td>
        <td style="font-family: var(--font-mono);">${pVal}</td>
        <td style="font-family: var(--font-mono); font-weight: 700; color: var(--teal-primary);">${cVal}</td>
        <td style="font-family: var(--font-mono); font-weight: 600;">${absDiff > 0 ? `+${absDiff}` : absDiff}</td>
        <td style="font-family: var(--font-mono); font-weight: 600;">${pctDiff > 0 ? `+${pctDiff}` : pctDiff}%</td>
        <td>
          <span class="badge-trend ${evalResult.class}">
            <i data-lucide="${evalResult.trend === 'Improving' ? 'trending-up' : (evalResult.trend === 'Worsening' ? 'trending-down' : 'minus')}" style="width: 12px; height: 12px;"></i>
            ${evalResult.label}
          </span>
        </td>
      </tr>
    `;
  }).join('');

  updateTrendChart();
  if (window.lucide) window.lucide.createIcons();
}

function updateTrendChart() {
  // Multi-test overlay: up to 3 selected biomarkers, each on its own y-axis
  // (different units/scales share one canvas readably this way).
  const names = selectedOverlayTests();
  if (!hasReports() || names.length === 0) {
    if (comparisonChartInstance) { comparisonChartInstance.destroy(); comparisonChartInstance = null; }
    return;
  }
  const ctx = document.getElementById('comparisonTrendCanvas').getContext('2d');

  if (comparisonChartInstance) comparisonChartInstance.destroy();

  const dates = REPORTS_STORE.map(r => r.dateLabel);
  const datasets = names.map((testName, i) => {
    const c = OVERLAY_COLORS[i % OVERLAY_COLORS.length];
    return {
      label: testName,
      data: REPORTS_STORE.map(r => {
        const t = r.tests.find(item => item.name === testName);
        return t ? t.value : null;
      }),
      borderColor: c.line,
      backgroundColor: c.fill,
      fill: i === 0,
      tension: 0.35,
      borderWidth: 3,
      pointBackgroundColor: '#ffffff',
      pointBorderColor: c.line,
      pointBorderWidth: 2.5,
      pointRadius: 6,
      yAxisID: i === 0 ? 'y' : ('y' + i)
    };
  });

  // Preserve the old reference-max line when a single test is charted.
  if (names.length === 1) {
    const solo = REPORTS_STORE[REPORTS_STORE.length - 1].tests.find(t => t.name === names[0]);
    if (solo) {
      datasets.push({
        label: `Normal Maximum (${solo.high} ${solo.unit})`,
        data: dates.map(() => solo.high),
        borderColor: 'rgba(22, 163, 74, 0.65)',
        borderDash: [5, 5],
        borderWidth: 2,
        pointRadius: 0,
        fill: false,
        yAxisID: 'y'
      });
    }
  }

  const scales = {
    y: { grid: { color: 'rgba(0, 0, 0, 0.06)' }, ticks: { font: { family: 'JetBrains Mono' } } },
    x: { grid: { color: 'transparent' }, ticks: { font: { family: 'Plus Jakarta Sans', weight: '600' } } }
  };
  names.forEach((testName, i) => {
    if (i === 0) return;
    scales['y' + i] = {
      position: 'right',
      grid: { drawOnChartArea: false },
      ticks: { font: { family: 'JetBrains Mono', size: 10 } },
      title: { display: true, text: testName, font: { size: 10 } }
    };
  });

  comparisonChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: dates,
      datasets: datasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'top', labels: { font: { family: 'Plus Jakarta Sans', weight: '600' }, boxWidth: 12 } }
      },
      scales: scales
    }
  });
}

// ============================================================
// HEALTH GOALS, RETEST REMINDERS & CHART OVERLAY
// ============================================================
function storageGet(key) {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
  } catch (e) { return null; }
}

function storageSet(key, value) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key, value);
  } catch (e) { /* private mode etc: features stay session-only */ }
}

function loadJSON(key, fallback) {
  try {
    const raw = storageGet(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return (parsed === null || parsed === undefined) ? fallback : parsed;
  } catch (e) { return fallback; }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---- Personal health goals (target value per biomarker) ----
const GOALS_KEY = 'bloodreport_goals_v1';

function loadGoals() {
  const g = loadJSON(GOALS_KEY, {});
  return (g && typeof g === 'object' && !Array.isArray(g)) ? g : {};
}

function saveGoals(g) {
  storageSet(GOALS_KEY, JSON.stringify(g));
}

function testHistory(name) {
  return REPORTS_STORE
    .map(r => {
      const t = r.tests.find(x => x.name === name);
      return t ? { label: r.dateLabel, value: t.value, unit: t.unit } : null;
    })
    .filter(Boolean);
}

function goalProgress(name) {
  const goals = loadGoals();
  if (goals[name] === undefined || goals[name] === null || isNaN(parseFloat(goals[name]))) return null;
  const hist = testHistory(name);
  if (hist.length === 0) return null;
  const target = parseFloat(goals[name]);
  const baseline = hist[0].value;
  const current = hist[hist.length - 1].value;
  const unit = hist[hist.length - 1].unit || '';
  const denom = target - baseline;
  let reached;
  let pct;
  if (denom === 0) {
    reached = current === target;
    pct = reached ? 100 : 0;
  } else {
    reached = denom > 0 ? current >= target : current <= target;
    pct = Math.max(0, Math.min(100, Math.round(((current - baseline) / denom) * 100)));
    if (reached) pct = 100;
  }
  return { name, baseline, current, target, unit, pct, reached, remaining: target - current };
}

function renderGoals() {
  const box = document.getElementById('goalsList');
  if (!box) return;
  const goals = loadGoals();
  const names = Object.keys(goals);
  if (names.length === 0) {
    box.innerHTML = '<div class="empty-state-notice" style="padding: 16px;">No goals yet — open any test and set a target value.</div>';
    return;
  }
  if (!hasReports()) {
    box.innerHTML = `<div class="empty-state-notice" style="padding: 16px;">${NO_REPORTS_MSG}</div>`;
    return;
  }
  const cards = names.map(name => {
    const p = goalProgress(name);
    if (!p) return '';
    const statusLine = p.reached
      ? '<span style="color: var(--status-normal); font-weight: 700;">Goal reached ✓</span>'
      : `<span>${Math.abs(Math.round(p.remaining * 10) / 10)} ${escapeHtml(p.unit)} to go (now ${p.current})</span>`;
    return `
      <div class="goal-item">
        <div class="goal-item-top">
          <strong>${escapeHtml(name)}</strong>
          <span style="font-family: var(--font-mono); font-size: 0.78rem; color: var(--text-secondary);">${p.baseline} → ${p.current} → 🎯 ${p.target} ${escapeHtml(p.unit)}</span>
        </div>
        <div class="goal-bar-track"><div class="goal-bar-fill${p.reached ? ' reached' : ''}" style="width: ${p.pct}%;"></div></div>
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 0.78rem; color: var(--text-secondary);">
          <span>${p.pct}% there</span>
          ${statusLine}
          <button class="btn btn-secondary btn-sm" style="padding: 2px 8px;" onclick="removeGoal('${escapeHtml(name).replace(/'/g, "\\'")}')">Remove</button>
        </div>
      </div>`;
  }).filter(Boolean);
  box.innerHTML = cards.length > 0 ? cards.join('') : '<div class="empty-state-notice" style="padding: 16px;">Goals refer to tests not in your reports.</div>';
  if (window.lucide) window.lucide.createIcons();
}

function removeGoal(name) {
  const goals = loadGoals();
  delete goals[name];
  saveGoals(goals);
  renderGoals();
}

let modalGoalTest = null;

function refreshModalGoal(testName) {
  modalGoalTest = testName;
  const input = document.getElementById('modalGoalInput');
  const status = document.getElementById('modalGoalStatus');
  if (!input || !status) return;
  const goals = loadGoals();
  if (goals[testName] !== undefined && goals[testName] !== null) {
    input.value = goals[testName];
    status.innerHTML = `Current target: <strong style="font-family: var(--font-mono);">${escapeHtml(goals[testName])}</strong> — track it on the Dashboard.`;
  } else {
    input.value = '';
    status.textContent = 'No personal target set yet.';
  }
}

function setModalGoal() {
  if (!modalGoalTest) return;
  const input = document.getElementById('modalGoalInput');
  const v = input ? parseFloat(input.value) : NaN;
  if (isNaN(v)) {
    alert('Enter a numeric target value first.');
    return;
  }
  const goals = loadGoals();
  goals[modalGoalTest] = v;
  saveGoals(goals);
  refreshModalGoal(modalGoalTest);
  renderGoals();
}

function clearModalGoal() {
  if (!modalGoalTest) return;
  const goals = loadGoals();
  delete goals[modalGoalTest];
  saveGoals(goals);
  refreshModalGoal(modalGoalTest);
  renderGoals();
}

// ---- Retest reminders ----
const REMINDERS_KEY = 'bloodreport_reminders_v1';

function loadReminders() {
  const r = loadJSON(REMINDERS_KEY, []);
  return Array.isArray(r) ? r : [];
}

function saveReminders(list) {
  storageSet(REMINDERS_KEY, JSON.stringify(list));
}

function addReminder() {
  const sel = document.getElementById('reminderTestSelect');
  const dateEl = document.getElementById('reminderDateInput');
  const test = sel ? sel.value : '';
  const due = dateEl ? dateEl.value : '';
  if (!test) {
    alert('Upload a report first so there is something to retest.');
    return;
  }
  if (!due) {
    alert('Pick a due date for the reminder.');
    return;
  }
  const list = loadReminders();
  list.push({ id: Date.now(), test: test, due: due, done: false });
  saveReminders(list);
  if (dateEl) dateEl.value = '';
  renderReminders();
}

function toggleReminderDone(id) {
  const list = loadReminders().map(r => (r.id === id ? { ...r, done: !r.done } : r));
  saveReminders(list);
  renderReminders();
}

function deleteReminder(id) {
  saveReminders(loadReminders().filter(r => r.id !== id));
  renderReminders();
}

function reminderBadge(r) {
  if (r.done) return '<span class="reminder-badge done-badge">Done</span>';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(r.due + 'T00:00:00');
  if (isNaN(due)) return '<span class="reminder-badge upcoming">Scheduled</span>';
  const days = Math.round((due - today) / 86400000);
  if (days < 0) return `<span class="reminder-badge overdue">Overdue by ${Math.abs(days)}d</span>`;
  if (days === 0) return '<span class="reminder-badge soon">Due today</span>';
  if (days <= 14) return `<span class="reminder-badge soon">Due in ${days}d</span>`;
  return `<span class="reminder-badge upcoming">Due in ${days}d</span>`;
}

function renderReminders() {
  const sel = document.getElementById('reminderTestSelect');
  if (sel) {
    const keep = sel.value;
    const tests = hasReports() ? REPORTS_STORE[REPORTS_STORE.length - 1].tests : [];
    sel.innerHTML = '<option value="Full blood panel">Full blood panel</option>' +
      tests.map(t => `<option value="${escapeHtml(t.name)}">${escapeHtml(t.name)}</option>`).join('');
    if (keep && [...sel.options].some(o => o.value === keep)) sel.value = keep;
  }
  const box = document.getElementById('remindersList');
  if (!box) return;
  const list = loadReminders().slice().sort((a, b) => ((a.done ? 1 : 0) - (b.done ? 1 : 0)) || String(a.due).localeCompare(String(b.due)));
  if (list.length === 0) {
    box.innerHTML = '<div class="empty-state-notice" style="padding: 16px;">No reminders. Add one above to stay on schedule.</div>';
    return;
  }
  box.innerHTML = list.map(r => `
    <div class="reminder-item${r.done ? ' done' : ''}">
      <input type="checkbox" ${r.done ? 'checked' : ''} onchange="toggleReminderDone(${r.id})" title="Mark done" style="accent-color: var(--teal-primary); width: 15px; height: 15px; flex-shrink: 0;">
      <div style="min-width: 0;">
        <div class="reminder-title"><strong>${escapeHtml(r.test)}</strong></div>
        <div style="font-size: 0.76rem; color: var(--text-muted);">Due ${escapeHtml(r.due)}</div>
      </div>
      ${reminderBadge(r)}
      <button class="btn btn-secondary btn-sm" style="padding: 2px 8px; flex-shrink: 0;" onclick="deleteReminder(${r.id})" title="Delete reminder">✕</button>
    </div>`).join('');
}

// ---- Trend chart overlay selection (up to 3 tests) ----
const OVERLAY_COLORS = [
  { line: '#0d9488', fill: 'rgba(13, 148, 136, 0.10)' },
  { line: '#0284c7', fill: 'rgba(2, 132, 199, 0.10)' },
  { line: '#ea580c', fill: 'rgba(234, 88, 12, 0.10)' }
];

function selectedOverlayTests() {
  const box = document.getElementById('trendOverlayChecks');
  if (!box || typeof box.querySelectorAll !== 'function') return [];
  return [...box.querySelectorAll('input[type="checkbox"]:checked')].map(cb => cb.value).slice(0, 3);
}

function renderOverlayChecks() {
  const box = document.getElementById('trendOverlayChecks');
  if (!box) return;
  if (!hasReports()) {
    box.innerHTML = '<span style="font-size: 0.8rem; color: var(--text-muted);">Upload reports to compare trends.</span>';
    return;
  }
  const latest = REPORTS_STORE[REPORTS_STORE.length - 1];
  const prevChecked = new Set(selectedOverlayTests());
  const names = latest.tests.map(t => t.name);
  if (prevChecked.size === 0 && names.length > 0) {
    prevChecked.add(names.includes('Vitamin D (25-OH)') ? 'Vitamin D (25-OH)' : names[0]);
  }
  box.innerHTML = names.map(n => `
    <label class="check-chip${prevChecked.has(n) ? ' checked' : ''}">
      <input type="checkbox" value="${escapeHtml(n)}" ${prevChecked.has(n) ? 'checked' : ''} onchange="limitOverlayChecks(this)"> ${escapeHtml(n)}
    </label>`).join('');
}

function limitOverlayChecks(cb) {
  const box = document.getElementById('trendOverlayChecks');
  if (!box) return;
  const checked = [...box.querySelectorAll('input[type="checkbox"]:checked')];
  if (checked.length > 3) {
    cb.checked = false;
    alert('Select up to 3 tests to keep the chart readable.');
    return;
  }
  [...box.querySelectorAll('.check-chip')].forEach(label => {
    const input = label.querySelector('input');
    if (label.classList && label.classList.toggle) label.classList.toggle('checked', !!(input && input.checked));
  });
  updateTrendChart();
}

// ============================================================
// PAGE 3: UPLOAD REPORT & GEMINI EXTRACTION
// ============================================================
function loadSampleTextIntoInput() {
  const sample = `METRO HEALTH CLINICAL LABORATORIES
Patient: Alex Rivera (34M)
Date: 2026-10-04

Fasting Glucose: 114 mg/dL (Reference Range: 70 - 99 mg/dL) [HIGH]
HbA1c: 5.9 % (Reference Range: 4.0 - 5.6 %) [HIGH]
Total Cholesterol: 238 mg/dL (Reference Range: < 200 mg/dL) [HIGH]
Triglycerides: 185 mg/dL (Reference Range: < 150 mg/dL) [HIGH]
HDL Cholesterol: 42 mg/dL (Reference Range: > 40 mg/dL) [NORMAL]
LDL Cholesterol: 162 mg/dL (Reference Range: < 100 mg/dL) [HIGH]
ALT (SGPT): 48 U/L (Reference Range: 7 - 40 U/L) [HIGH]
Vitamin D (25-OH): 29.0 ng/mL (Reference Range: 30.0 - 100.0 ng/mL) [LOW]
Hemoglobin: 15.2 g/dL (Reference Range: 13.5 - 17.5 g/dL) [NORMAL]`;

  document.getElementById('rawReportTextInput').value = sample;
}

async function processTextWithGemini() {
  const textArea = document.getElementById('rawReportTextInput');
  const text = (textArea.value || '').trim();
  if (!text) {
    alert('Please enter or paste blood report text, or upload a PDF / photo report to extract.');
    return;
  }

  const progressBox = document.getElementById('uploadProgressContainer');
  const fill = document.getElementById('uploadProgressBarFill');
  const progressText = document.getElementById('uploadProgressText');

  progressBox.style.display = 'block';
  fill.style.width = '30%';
  progressText.textContent = 'Extracting biomarkers...';

  try {
    const result = await geminiService.extractBiomarkers(text);
    const extracted = (result && result.tests) ? result.tests : [];
    fill.style.width = '100%';
    progressText.textContent = extracted.length > 0
      ? `Extraction complete! ${extracted.length} biomarker${extracted.length === 1 ? '' : 's'} ready — please verify below.`
      : 'No values auto-detected.';

    setTimeout(() => {
      progressBox.style.display = 'none';
      fill.style.width = '0%';
      if (extracted.length === 0) {
        // Keep the UX unblocked: show the editable table so the user can
        // add rows manually, instead of a dead-end that "cannot make a report".
        ocrWorkingTests = [];
        renderOcrReviewTable();
        alert('Could not auto-detect lab values from this text. The editable table is now open — use "Add Test" to enter values manually, or check that the text contains lines like "Hemoglobin: 13.8 g/dL".');
        return;
      }
      ocrWorkingTests = extracted.map(t => {
        const lowNum = (t.low !== null && t.low !== undefined && t.low !== '') ? parseFloat(t.low) : null;
        const highNum = (t.high !== null && t.high !== undefined && t.high !== '') ? parseFloat(t.high) : null;
        const libHit = BIOMARKER_LIBRARY.find(b => b.canonical.toLowerCase() === String(t.name || '').toLowerCase());
        const low = (lowNum !== null && !isNaN(lowNum)) ? lowNum : (libHit ? libHit.low : 0);
        const high = (highNum !== null && !isNaN(highNum)) ? highNum : (libHit ? libHit.high : 100);
        return {
          name: t.name,
          value: parseFloat(t.value),
          unit: t.unit || (libHit ? libHit.unit : ''),
          low: low,
          high: high,
          printed: (t.printed !== undefined) ? t.printed : true,
          fuzzy: !!t.fuzzy,
          source: ((result && result.source) ? result.source : 'AI Extracted') + (t.fuzzy ? ' (verify spelling)' : '')
        };
      }).filter(t => t.name && !isNaN(t.value));
      if (ocrWorkingTests.length === 0) {
        renderOcrReviewTable();
        alert('Extracted values were invalid. Please use "Add Test" to enter values manually.');
        return;
      }
      renderOcrReviewTable();
    }, 400);

  } catch (err) {
    fill.style.width = '100%';
    progressBox.style.display = 'none';
    console.warn(`Extraction notice: ${err.message}. Using dynamic fallback parser.`);
    fallbackRegexExtraction(text);
  }
}

// --- File upload: PDF (.pdf), photos (.png/.jpg/.jpeg), plain text (.txt) ---
// Previous version used FileReader.readAsText() for EVERY file type, so binary
// PDFs and photos produced garbage text, zero biomarkers were detected, and the
// user could never reach "Confirm & Analyze Report". This version branches by
// file type: text is read directly, PDFs via pdf.js, images via tesseract.js OCR.
if (typeof window !== 'undefined' && window.pdfjsLib && window.pdfjsLib.GlobalWorkerOptions) {
  try {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  } catch (e) { /* worker config optional */ }
}

function setUploadProgress(pct, label) {
  const progressBox = document.getElementById('uploadProgressContainer');
  const fill = document.getElementById('uploadProgressBarFill');
  const progressText = document.getElementById('uploadProgressText');
  if (progressBox) progressBox.style.display = 'block';
  if (fill) fill.style.width = pct + '%';
  if (progressText && label) progressText.textContent = label;
}

async function extractTextFromPDF(file) {
  if (!window.pdfjsLib) {
    throw new Error('PDF engine (pdf.js) failed to load. Please check your internet connection and try again, or copy-paste the report text manually.');
  }
  const buffer = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: buffer }).promise;
  let fullText = '';
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    setUploadProgress(Math.round((pageNum / pdf.numPages) * 70), `Reading PDF page ${pageNum} of ${pdf.numPages}...`);
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    // Rebuild line breaks from item coordinates. Without this, all text on a
    // page collapses into a single line and the biomarker parser (which works
    // line-by-line) would only pick up the first test on each page.
    const items = (content.items || []).slice().sort((a, b) =>
      (b.transform[5] - a.transform[5]) || (a.transform[4] - b.transform[4]));
    const lines = [];
    let current = null;
    items.forEach(item => {
      const y = item.transform[5];
      if (!current || Math.abs(current.y - y) > 3) {
        current = { y: y, items: [] };
        lines.push(current);
      }
      current.items.push(item);
    });
    const pageText = lines
      .map(l => l.items
        .sort((a, b) => a.transform[4] - b.transform[4])
        .map(i => (i.str || '').trim())
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim())
      .filter(Boolean)
      .join('\n');
    fullText += pageText + '\n';
  }
  return fullText;
}

async function extractTextFromImage(file) {
  if (!window.Tesseract) {
    throw new Error('OCR engine (tesseract.js) failed to load. Please check your internet connection and try again, or copy-paste the report text manually.');
  }
  setUploadProgress(15, 'Running OCR on image (this can take ~10-30 seconds)...');
  const result = await window.Tesseract.recognize(file, 'eng', {
    logger: (m) => {
      if (m.status === 'recognizing text' && typeof m.progress === 'number') {
        setUploadProgress(15 + Math.round(m.progress * 60), `Running OCR on image... ${Math.round(m.progress * 100)}%`);
      }
    }
  });
  return (result && result.data && result.data.text) ? result.data.text : '';
}

async function handleFileSelect(e) {
  const file = e.target.files ? e.target.files[0] : null;
  if (!file) return;

  const allowedExts = ['.pdf', '.png', '.jpg', '.jpeg', '.txt'];
  const lowerName = (file.name || '').toLowerCase();
  const ext = '.' + (lowerName.split('.').pop() || '');
  const isTextType = (file.type || '').startsWith('text') || ext === '.txt';

  if (!allowedExts.includes(ext) && !isTextType) {
    alert('Unsupported file type. Please upload a PDF, JPG, PNG, or TXT report.');
    e.target.value = '';
    return;
  }
  if (file.size > 16 * 1024 * 1024) {
    alert('File is larger than the 16 MB limit. Please upload a smaller file.');
    e.target.value = '';
    return;
  }

  try {
    let extractedText = '';
    if (isTextType) {
      setUploadProgress(20, `Reading ${file.name}...`);
      extractedText = await file.text();
    } else if (ext === '.pdf' || file.type === 'application/pdf') {
      setUploadProgress(10, `Reading PDF ${file.name}...`);
      extractedText = await extractTextFromPDF(file);
    } else {
      // PNG / JPG / JPEG scanned photo
      extractedText = await extractTextFromImage(file);
    }

    if (!extractedText || !extractedText.trim()) {
      document.getElementById('uploadProgressContainer').style.display = 'none';
      alert('No readable text was found in this file. If it is a scanned photo, try a clearer image, or paste the report text manually below.');
      e.target.value = '';
      return;
    }

    document.getElementById('rawReportTextInput').value = extractedText.trim();
    setUploadProgress(80, 'Text extracted. Detecting biomarkers...');
    await processTextWithGemini();
  } catch (err) {
    console.error('File extraction failed:', err);
    const box = document.getElementById('uploadProgressContainer');
    if (box) box.style.display = 'none';
    alert('Could not extract text from this file: ' + (err.message || err) + '\nYou can still paste the report text manually below and click "Extract Biomarkers".');
  } finally {
    // Reset so the same file can be selected again
    e.target.value = '';
  }
}

function fallbackRegexExtraction(text) {
  const parsed = fallbackParseReportText(text);
  ocrWorkingTests = (parsed.tests || []).map(t => ({ ...t, source: 'Local Parser' }));

  if (ocrWorkingTests.length > 0) {
    renderOcrReviewTable();
  } else {
    renderOcrReviewTable();
    alert('Could not auto-detect lab values from this text. Use "Add Test" in the table below to enter values manually.');
  }
}

function renderOcrReviewTable() {
  const container = document.getElementById('ocrReviewContainer');
  const tbody = document.getElementById('ocrTableBody');
  container.style.display = 'block';

  if (!ocrWorkingTests || ocrWorkingTests.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding: 18px; color: var(--text-muted);">No values detected yet. Click "Add Test" to enter a biomarker manually, e.g. Hemoglobin | 13.8 | g/dL | 13.5 | 17.5</td></tr>`;
  } else {
    tbody.innerHTML = ocrWorkingTests.map((t, index) => `
    <tr>
      <td><input type="text" class="ocr-input" value="${String(t.name).replace(/"/g, '&quot;')}" onchange="ocrWorkingTests[${index}].name = this.value"></td>
      <td><input type="number" step="0.1" class="ocr-input" style="width: 90px;" value="${t.value}" onchange="ocrWorkingTests[${index}].value = parseFloat(this.value)"></td>
      <td><input type="text" class="ocr-input" style="width: 80px;" value="${t.unit || ''}" onchange="ocrWorkingTests[${index}].unit = this.value"></td>
      <td><input type="number" step="0.1" class="ocr-input" style="width: 80px;" value="${t.low}" onchange="ocrWorkingTests[${index}].low = parseFloat(this.value)"></td>
      <td><input type="number" step="0.1" class="ocr-input" style="width: 80px;" value="${t.high}" onchange="ocrWorkingTests[${index}].high = parseFloat(this.value)"></td>
      <td style="font-size: 0.8rem; color: var(--text-muted);">${t.source || (t.printed === false ? 'Validated Range' : 'Lab Report')}</td>
      <td>
        <button class="btn btn-secondary" style="padding: 4px 8px; color: var(--status-urgent);" onclick="deleteOcrRow(${index})">
          <i data-lucide="trash-2" style="width: 14px; height: 14px;"></i>
        </button>
      </td>
    </tr>
  `).join('');
  }

  if (window.lucide) window.lucide.createIcons();
  container.scrollIntoView({ behavior: 'smooth' });
}

function addNewOcrRow() {
  ocrWorkingTests.push({
    name: 'New Biomarker',
    value: 0.0,
    unit: 'mg/dL',
    low: 10.0,
    high: 50.0,
    source: 'User Entry'
  });
  renderOcrReviewTable();
}

function deleteOcrRow(index) {
  ocrWorkingTests.splice(index, 1);
  renderOcrReviewTable();
}

function refreshReportSelectors() {
  // Keep Previous/Current dropdowns and the trend-chart dropdown in sync so a
  // newly uploaded report can immediately be compared and graphed.
  const prevSel = document.getElementById('compPrevSelect');
  const currSel = document.getElementById('compCurrSelect');
  if (prevSel && currSel) {
    const prevVal = prevSel.value;
    const currVal = currSel.value;
    // Option values are report ids (not dates) so two uploads on the same
    // day remain independently selectable for comparison.
    const options = REPORTS_STORE.map(r => `<option value="${r.id}">${r.dateLabel}</option>`).join('');
    prevSel.innerHTML = options;
    currSel.innerHTML = options;
    // Default: previous = second-last, current = last
    if (REPORTS_STORE.length >= 2) {
      prevSel.value = String(REPORTS_STORE[REPORTS_STORE.length - 2].id);
      currSel.value = String(REPORTS_STORE[REPORTS_STORE.length - 1].id);
    }
    if (prevVal && [...prevSel.options].some(o => o.value === prevVal)) prevSel.value = prevVal;
    if (currVal && [...currSel.options].some(o => o.value === currVal)) currSel.value = currVal;
  }
  renderOverlayChecks();
}

async function confirmOcrAndAnalyze() {
  const validTests = (ocrWorkingTests || []).filter(t => t.name && t.name.trim() && !isNaN(parseFloat(t.value)));
  if (validTests.length === 0) {
    alert('No valid biomarkers in the verification list. Extract a report, or use "Add Test" to enter at least one Test Name + Value.');
    return;
  }

  const confirmedTests = validTests.map(t => {
    const value = parseFloat(t.value);
    const low = parseFloat(t.low);
    const high = parseFloat(t.high);
    return {
      name: String(t.name).trim(),
      value: value,
      unit: (t.unit || '').trim(),
      low: isNaN(low) ? 0 : low,
      high: isNaN(high) ? 100 : high,
      status: calculateStatus(value, isNaN(low) ? 0 : low, isNaN(high) ? 100 : high),
      printed: (t.printed !== undefined) ? !!t.printed : true
    };
  });

  const todayISO = new Date().toISOString().split('T')[0];
  const prettyDate = new Date().toLocaleDateString('en-US', { month: 'long', day: '2-digit', year: 'numeric' });
  const nextId = REPORTS_STORE.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1;
  const newReport = {
    id: nextId,
    date: todayISO,
    dateLabel: `${prettyDate} (Upload #${nextId})`,
    lab: 'Clinical Laboratory Import',
    filename: 'imported_report.pdf',
    tests: confirmedTests
  };

  REPORTS_STORE.push(newReport);
  document.getElementById('ocrReviewContainer').style.display = 'none';
  ocrWorkingTests = [];
  latestGeminiSummary = null; // stale summary belongs to the previous report
  refreshReportSelectors();

  if (window.confetti) {
    window.confetti({ particleCount: 50, spread: 60, origin: { y: 0.6 } });
  }

  // Persist to backend SQLite so previous data survives page refreshes.
  // Awaited (not fire-and-forget) so failures are visible; the report is
  // already in the session store, so the app keeps working offline.
  try {
    const saveRes = await fetch('/api/analyze-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        report_date: newReport.date,
        laboratory_name: newReport.lab,
        filename: newReport.filename,
        tests: confirmedTests.map(t => ({
          test_name: t.name, value: t.value, unit: t.unit,
          ref_low: t.low, ref_high: t.high
        }))
      })
    });
    if (saveRes.ok) {
      const saved = await saveRes.json();
      if (saved && saved.report_id) newReport.id = saved.report_id;
      refreshReportSelectors();
    } else {
      console.warn('Backend save failed; this report will last for this session only. Start the backend (python backend/app.py) to persist reports.');
    }
  } catch (e) {
    console.warn('Backend unavailable; this report will last for this session only. Start the backend (python backend/app.py) to persist reports.', e);
  }

  navigateTo('viewDashboard');
}

// ============================================================
// PAGE 6: DYNAMIC GEMINI AI SUMMARY
// ============================================================
async function generateDynamicAISummary() {
  const loading = document.getElementById('aiSummaryLoading');
  const content = document.getElementById('aiSummaryContent');
  if (!hasReports()) {
    document.getElementById('aiNarrativeText').innerHTML = NO_REPORTS_MSG;
    return;
  }
  loading.classList.add('active');
  content.style.opacity = '0.4';

  const currentReport = REPORTS_STORE[REPORTS_STORE.length - 1];
  const previousReport = REPORTS_STORE.length > 1 ? REPORTS_STORE[REPORTS_STORE.length - 2] : null;

  try {
    const summary = await geminiService.generateSummary(currentReport.tests, previousReport ? previousReport.tests : []);
    latestGeminiSummary = summary;
    renderSummaryToUI(summary);
  } catch (err) {
    console.warn(`Summary notice: ${err.message}. Generating dynamic synthesis.`);
    renderFallbackSummary(currentReport, previousReport);
  } finally {
    loading.classList.remove('active');
    content.style.opacity = '1';
  }
}

function renderSummaryToUI(summary) {
  // Tolerate malformed AI payloads: every section degrades to a sensible
  // default instead of throwing and blanking the summary.
  const safe = (summary && typeof summary === 'object') ? summary : {};
  const narrative = (typeof safe.narrative === 'string' && safe.narrative.trim())
    ? safe.narrative
    : 'Summary unavailable for this report. Please try generating again.';
  const improved = Array.isArray(safe.improved_values) ? safe.improved_values : [];
  const attention = Array.isArray(safe.attention_needed) ? safe.attention_needed : [];
  const worsened = Array.isArray(safe.worsened_values) ? safe.worsened_values : [];
  const questions = Array.isArray(safe.doctor_questions) && safe.doctor_questions.length > 0
    ? safe.doctor_questions
    : [
      "What target range would you like my flagged parameters to reach?",
      "Are there specific dietary or lifestyle modifications you recommend?",
      "When should we schedule repeat testing to track progress?"
    ];

  document.getElementById('aiNarrativeText').innerHTML = narrative.replace(/\n\n/g, '<br><br>');

  // Improved
  const improvedList = document.getElementById('aiImprovedList');
  improvedList.innerHTML = improved.length > 0
    ? improved.map(v => `<li>${v}</li>`).join('')
    : '<li style="color: var(--text-muted);">No significant improvements recorded in this interval.</li>';

  // Attention
  const attentionList = document.getElementById('aiAttentionList');
  attentionList.innerHTML = attention.length > 0
    ? attention.map(v => `<li>${v}</li>`).join('')
    : '<li style="color: var(--status-normal);">All tested parameters are within reference bounds.</li>';

  // Worsened (if any)
  const worsenedContainer = document.getElementById('aiWorsenedContainer');
  const worsenedList = document.getElementById('aiWorsenedList');
  if (worsened.length > 0) {
    worsenedContainer.style.display = 'block';
    worsenedList.innerHTML = worsened.map(v => `<li>${v}</li>`).join('');
  } else {
    worsenedContainer.style.display = 'none';
  }

  // Doctor Questions
  const docQuestions = document.getElementById('aiDoctorQuestionsList');
  docQuestions.innerHTML = questions.map((q, idx) => `
    <div class="doctor-question-item">
      <span class="doctor-q-num">${idx + 1}</span>
      <span>${q}</span>
    </div>
  `).join('');
}

function renderFallbackSummary(currentReport, previousReport) {
  const abnormal = currentReport.tests.filter(t => t.status !== 'Normal');
  const fallback = {
    narrative: `Analysis of your ${currentReport.tests.length} tests indicates ${currentReport.tests.length - abnormal.length} tests in normal range, and ${abnormal.length} tests outside reference bounds.`,
    improved_values: [],
    attention_needed: abnormal.map(a => `${a.name} (${a.value} ${a.unit}) is flagged as ${a.status.toLowerCase()}`),
    doctor_questions: [
      "What target range would you like my flagged parameters to reach?",
      "Are there specific dietary or lifestyle modifications you recommend?",
      "When should we schedule repeat testing to track progress?"
    ]
  };
  renderSummaryToUI(fallback);
}

// ============================================================
// PAGE 10: DOCTOR-READY SUMMARY VIEW
// ============================================================
function renderDoctorSummaryView() {
  const tbody = document.getElementById('docSummaryAbnormalBody');
  const changesList = document.getElementById('docSummaryChangesList');
  const questionsList = document.getElementById('docSummaryQuestionsList');
  // Firebase TODO: bind patient profile here after integration.
  // Profile removed for now, so these render neutral placeholders.
  document.getElementById('docPatientName').textContent = '—';
  document.getElementById('docPatientAgeSex').textContent = '—';
  if (!hasReports()) {
    document.getElementById('docReportDate').textContent = '—';
    tbody.innerHTML = emptyTableRow(5, NO_REPORTS_MSG);
    changesList.innerHTML = '<li>No reports uploaded yet.</li>';
    questionsList.innerHTML = '<li>Upload a report to generate consultation questions.</li>';
    return;
  }
  const latestReport = REPORTS_STORE[REPORTS_STORE.length - 1];
  const prevReport = REPORTS_STORE.length > 1 ? REPORTS_STORE[REPORTS_STORE.length - 2] : null;

  document.getElementById('docReportDate').textContent = latestReport.dateLabel;

  // Abnormal Table
  const abnormalTests = latestReport.tests.filter(t => t.status !== 'Normal');
  tbody.innerHTML = abnormalTests.length > 0
    ? abnormalTests.map(t => `
      <tr>
        <td><strong>${t.name}</strong></td>
        <td>${t.value} ${t.unit}</td>
        <td>${t.low} - ${t.high} ${t.unit}</td>
        <td><span class="badge-status ${t.status.toLowerCase()}">${t.status}</span></td>
        <td>Outside standard reference interval.</td>
      </tr>
    `).join('')
    : '<tr><td colspan="5" style="text-align:center; color:var(--status-normal);">All parameters within reference intervals.</td></tr>';

  // Major Changes
  if (prevReport) {
    const changes = latestReport.tests
      .map(curr => {
        const prev = prevReport.tests.find(p => p.name === curr.name);
        if (!prev) return null;
        const diff = (curr.value - prev.value).toFixed(1);
        if (Math.abs(diff) > 0) {
          const evalRes = evaluateClinicalTrend(curr.name, prev.value, curr.value, curr.low, curr.high);
          return `<li><strong>${curr.name}:</strong> Changed from ${prev.value} to ${curr.value} ${curr.unit} (${diff > 0 ? '+' : ''}${diff}) — <em>${evalRes.label}</em></li>`;
        }
        return null;
      })
      .filter(Boolean);
    changesList.innerHTML = changes.length > 0 ? changes.join('') : '<li>No significant quantitative shifts observed.</li>';
  } else {
    changesList.innerHTML = '<li>Single report baseline. No previous report to compare.</li>';
  }

  // Doctor Questions from Gemini
  if (latestGeminiSummary && latestGeminiSummary.doctor_questions) {
    questionsList.innerHTML = latestGeminiSummary.doctor_questions.map(q => `<li>${q}</li>`).join('');
  } else {
    questionsList.innerHTML = `
      <li>What target range would you like my flagged parameters to reach?</li>
      <li>Do you recommend lifestyle interventions or medical therapy?</li>
      <li>When should we repeat this panel?</li>
    `;
  }
}

// ============================================================
// PAGE 8: REPORT HISTORY
// ============================================================
function renderHistoryTimeline() {
  const container = document.getElementById('historyTimelineContainer');
  if (!hasReports()) {
    container.innerHTML = `<div class="empty-state-notice">${NO_REPORTS_MSG}</div>`;
    return;
  }
  container.innerHTML = REPORTS_STORE.slice().reverse().map(report => `
    <div class="history-card">
      <div>
        <div class="history-date-badge">${report.dateLabel}</div>
        <div style="font-size: 0.85rem; color: var(--text-secondary); margin-top: 4px;">
          ${report.lab} • ${report.tests.length} Biomarkers Tested
        </div>
      </div>
      <div class="btn-group">
        <button class="btn btn-secondary" onclick="openReportById(${report.id})">
          <i data-lucide="eye" style="width: 14px; height: 14px;"></i> Open Report
        </button>
        <button class="btn btn-primary" onclick="compareReportById(${report.id})">
          <i data-lucide="git-compare" style="width: 14px; height: 14px;"></i> Compare
        </button>
      </div>
    </div>
  `).join('');

  if (window.lucide) window.lucide.createIcons();
}

async function eraseAllData() {
  // Permanently erase all stored reports (session + server + uploaded files).
  if (REPORTS_STORE.length === 0) {
    alert('No stored reports to erase.');
    return;
  }
  if (!confirm(`Permanently erase all ${REPORTS_STORE.length} stored report(s) and uploaded files? This cannot be undone.`)) return;
  try {
    const res = await fetch('/api/reports', { method: 'DELETE' });
    if (!res.ok) throw new Error('Server refused.');
  } catch (e) {
    // Backend down: session data was never persisted server-side anyway.
    if (!confirm('Backend unavailable — erase reports from this session only?')) return;
  }
  REPORTS_STORE.length = 0;
  activeReportId = null;
  latestGeminiSummary = null;
  ocrWorkingTests = [];
  refreshReportSelectors();
  renderHistoryTimeline();
  if (window.lucide) window.lucide.createIcons();
}

// ============================================================
// PAGE 9 & MODAL: TEST DETAIL VIEW (WITH GEMINI)
// ============================================================
async function openTestDetailModal(testName) {
  if (!hasReports()) return;
  // Look up in the report currently being viewed (History selection),
  // falling back to the latest. Trend chart still spans all reports.
  const scopeReport = getActiveReport() || REPORTS_STORE[REPORTS_STORE.length - 1];
  const test = scopeReport.tests.find(t => t.name === testName)
    || REPORTS_STORE[REPORTS_STORE.length - 1].tests.find(t => t.name === testName);
  if (!test) return;

  document.getElementById('modalDetailTitle').textContent = test.name;
  refreshModalGoal(test.name);
  document.getElementById('modalDetailCurrentVal').textContent = test.value;
  document.getElementById('modalDetailUnit').textContent = test.unit;
  document.getElementById('modalDetailRange').textContent = `${test.low} - ${test.high}`;

  const statusBadgeContainer = document.getElementById('modalDetailStatusBadge');
  statusBadgeContainer.innerHTML = `<span class="badge-status ${test.status.toLowerCase()}">${test.status}</span>`;

  // Default placeholders while fetching Gemini or fallback
  document.getElementById('modalDetailExplanation').textContent = `${test.name} is a key diagnostic biomarker used to measure physiological homeostasis.`;
  document.getElementById('modalDetailFactors').textContent = 'Hydration status, recent meals, exercise, and collection time.';
  document.getElementById('modalDetailDoctorGuidance').textContent = 'Review any out-of-range findings with your primary physician.';

  // Render Mini Chart
  renderModalTrendChart(test.name, test.unit, test.low, test.high);
  document.getElementById('testDetailModal').classList.add('active');

  // Attempt dynamic Gemini explanation via backend (.env)
  try {
    const exp = await geminiService.explainBiomarker(test.name, test.value, test.unit, test.low, test.high);
    if (exp && exp.explanation) document.getElementById('modalDetailExplanation').textContent = exp.explanation;
    if (exp && exp.factors) document.getElementById('modalDetailFactors').textContent = exp.factors;
    if (exp && exp.guidance) document.getElementById('modalDetailDoctorGuidance').textContent = exp.guidance;
  } catch (e) {
    // Keep clean defaults
  }

  if (window.lucide) window.lucide.createIcons();
}

function renderModalTrendChart(testName, unit, low, high) {
  const ctx = document.getElementById('modalTrendCanvas').getContext('2d');
  if (modalChartInstance) modalChartInstance.destroy();

  const labels = REPORTS_STORE.map(r => r.dateLabel);
  const vals = REPORTS_STORE.map(r => {
    const found = r.tests.find(t => t.name === testName);
    return found ? found.value : null;
  });

  modalChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: `${testName} (${unit})`,
          data: vals,
          borderColor: '#0284c7',
          backgroundColor: 'rgba(2, 132, 199, 0.1)',
          fill: true,
          tension: 0.3,
          borderWidth: 2.5,
          pointBackgroundColor: '#ffffff',
          pointBorderColor: '#0284c7',
          pointRadius: 5
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { grid: { color: 'rgba(0,0,0,0.05)' }, ticks: { font: { family: 'JetBrains Mono', size: 10 } } },
        x: { grid: { display: false }, ticks: { font: { family: 'Plus Jakarta Sans', size: 10 } } }
      }
    }
  });
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) modal.classList.remove('active');
}

// ============================================================
// PERSISTENCE: HYDRATE SAVED REPORTS FROM BACKEND ON STARTUP
// ============================================================
async function hydrateReportsFromBackend() {
  // Restores previously uploaded reports saved in SQLite via
  // /api/analyze-report, so previous data survives page refreshes and the
  // AI summary always has history to compare against. Silent no-op offline.
  let backendAvailable = false;
  try {
    const res = await fetch('/api/reports');
    if (!res.ok) return false;
    const reports = await res.json();
    if (!Array.isArray(reports) || reports.length === 0) return true;
    backendAvailable = true;
    // Chronological ascending: latest report stays last in REPORTS_STORE.
    reports.sort((a, b) => String(a.report_date).localeCompare(String(b.report_date)));
    for (const r of reports) {
      try {
        const rr = await fetch(`/api/reports/${r.id}/results`);
        if (!rr.ok) continue;
        const rows = await rr.json();
        const tests = (Array.isArray(rows) ? rows : []).map(t => ({
          name: t.test_name,
          value: parseFloat(t.value),
          unit: t.unit || '',
          low: (t.reference_low !== null && t.reference_low !== undefined && t.reference_low !== '') ? parseFloat(t.reference_low) : 0,
          high: (t.reference_high !== null && t.reference_high !== undefined && t.reference_high !== '') ? parseFloat(t.reference_high) : 100,
          status: t.status || 'Normal',
          printed: true
        })).filter(t => t.name && !isNaN(t.value));
        if (tests.length === 0) continue;
        let dateLabel = r.report_date || '';
        try {
          const d = new Date((r.report_date || '') + 'T00:00:00');
          if (!isNaN(d)) dateLabel = d.toLocaleDateString('en-US', { month: 'long', day: '2-digit', year: 'numeric' });
        } catch (e) { /* keep raw date */ }
        if (REPORTS_STORE.some(x => x.id === r.id)) continue; // avoid duplicates
        REPORTS_STORE.push({
          id: r.id,
          date: r.report_date,
          dateLabel: dateLabel,
          lab: r.laboratory_name || 'Clinical Laboratory',
          filename: r.uploaded_file || '',
          tests: tests
        });
      } catch (e) { /* skip unreadable report, keep the rest */ }
    }
  } catch (err) {
    console.warn('Backend unavailable, starting with an empty session store:', err);
    return false;
  }
  return backendAvailable;
}

// ============================================================
// INITIALIZATION
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {

  // Theme Toggle Button
  const themeBtn = document.getElementById('themeToggleBtn');
  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      const html = document.documentElement;
      const current = html.getAttribute('data-theme');
      const next = current === 'dark' ? 'light' : 'dark';
      html.setAttribute('data-theme', next);

      const icon = document.getElementById('themeIcon');
      if (icon) {
        icon.setAttribute('data-lucide', next === 'dark' ? 'sun' : 'moon');
        if (window.lucide) window.lucide.createIcons();
      }
    });
  }

  // Setup Drag & Drop Upload Handlers
  const dropZone = document.getElementById('uploadDropZone');
  if (dropZone) {
    ['dragenter', 'dragover'].forEach(name => {
      dropZone.addEventListener(name, (e) => {
        e.preventDefault();
        dropZone.classList.add('dragover');
      });
    });

    ['dragleave', 'drop'].forEach(name => {
      dropZone.addEventListener(name, (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
      });
    });

    dropZone.addEventListener('drop', (e) => {
      const files = e.dataTransfer.files;
      if (files.length > 0) {
        handleFileSelect({ target: { files: files } });
      }
    });
  }

  // Initial View (restore saved reports first so dashboard, comparison
  // and AI summary have previous data immediately after a refresh)
  await hydrateReportsFromBackend();
  refreshReportSelectors();
  navigateTo('viewLanding');
});
