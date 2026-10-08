"""
BloodReport AI - Backend API Service
Flask REST API connecting SQLite database, OCR/file extraction,
clinical report comparison logic, and AI educational summaries.
"""

import os
import json
import re
import urllib.request
import sys
from datetime import datetime
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS

sys.path.insert(0, os.path.dirname(__file__))
from database import get_db_connection, init_db, ensure_default_user

# Load .env file securely from root or backend directory
try:
    from dotenv import load_dotenv
    load_dotenv()
    load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))
except ImportError:
    pass

# Manual fallback parser for .env if python-dotenv is not installed
for env_path in [
    os.path.join(os.path.dirname(__file__), '..', '.env'),
    os.path.join(os.path.dirname(__file__), '.env'),
    '.env'
]:
    if os.path.exists(env_path):
        try:
            with open(env_path, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith('#') and '=' in line:
                        k, v = line.split('=', 1)
                        k = k.strip()
                        v = v.strip().strip('"').strip("'")
                        if not os.environ.get(k):
                            os.environ[k] = v
        except Exception:
            pass

def get_gemini_api_key():
    """Retrieve Gemini API key strictly from environment / .env file"""
    key = os.environ.get('GEMINI_API_KEY', '').strip()
    if key and key != 'your_gemini_api_key_here':
        return key
    return None

def call_gemini_api(prompt):
    """Secure server-side call to Google Gemini 1.5 Flash using .env key"""
    api_key = get_gemini_api_key()
    if not api_key:
        raise ValueError("GEMINI_API_KEY not configured in .env file.")

    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key={api_key}"
    payload = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.2,
            "responseMimeType": "application/json"
        }
    }).encode('utf-8')

    req = urllib.request.Request(
        url,
        data=payload,
        headers={'Content-Type': 'application/json'},
        method='POST'
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        res_data = json.loads(resp.read().decode('utf-8'))
        raw_text = res_data['candidates'][0]['content']['parts'][0]['text']
        return json.loads(raw_text)

app = Flask(__name__, static_folder='../', static_url_path='/')
CORS(app)

# Ensure database is initialized
init_db()

UPLOAD_FOLDER = os.path.join(os.path.dirname(__file__), 'uploads')
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024  # 16 MB limit

# Validated standard reference range library (used when report doesn't print one)
VALIDATED_REFERENCE_RANGES = {
    'Hemoglobin': {'unit': 'g/dL', 'low': 13.5, 'high': 17.5, 'desired': 'normal'},
    'Hematocrit': {'unit': '%', 'low': 41.0, 'high': 50.0, 'desired': 'normal'},
    'RBC Count': {'unit': 'million/uL', 'low': 4.0, 'high': 5.5, 'desired': 'normal'},
    'MCV': {'unit': 'fL', 'low': 80.0, 'high': 100.0, 'desired': 'normal'},
    'MCH': {'unit': 'pg', 'low': 27.0, 'high': 33.0, 'desired': 'normal'},
    'MCHC': {'unit': 'g/dL', 'low': 32.0, 'high': 36.0, 'desired': 'normal'},
    'RDW-CV': {'unit': '%', 'low': 11.5, 'high': 14.5, 'desired': 'normal'},
    'ESR': {'unit': 'mm/hr', 'low': 0.0, 'high': 20.0, 'desired': 'down_if_high'},
    'Neutrophils': {'unit': '%', 'low': 40.0, 'high': 70.0, 'desired': 'normal'},
    'Lymphocytes': {'unit': '%', 'low': 20.0, 'high': 40.0, 'desired': 'normal'},
    'Monocytes': {'unit': '%', 'low': 2.0, 'high': 8.0, 'desired': 'normal'},
    'Eosinophils': {'unit': '%', 'low': 1.0, 'high': 4.0, 'desired': 'normal'},
    'Basophils': {'unit': '%', 'low': 0.0, 'high': 1.0, 'desired': 'normal'},
    'MPV': {'unit': 'fL', 'low': 7.5, 'high': 11.5, 'desired': 'normal'},
    'TSH': {'unit': 'mIU/L', 'low': 0.4, 'high': 4.0, 'desired': 'normal'},
    'T3 Total': {'unit': 'ng/dL', 'low': 80.0, 'high': 200.0, 'desired': 'normal'},
    'T4 Total': {'unit': 'ug/dL', 'low': 5.0, 'high': 12.0, 'desired': 'normal'},
    'Serum Urea': {'unit': 'mg/dL', 'low': 15.0, 'high': 40.0, 'desired': 'down_if_high'},
    'BUN': {'unit': 'mg/dL', 'low': 7.0, 'high': 20.0, 'desired': 'down_if_high'},
    'WBC Count': {'unit': '10^3/uL', 'low': 4.5, 'high': 11.0, 'desired': 'normal'},
    'Platelets': {'unit': '10^3/uL', 'low': 150.0, 'high': 450.0, 'desired': 'normal'},
    'Fasting Glucose': {'unit': 'mg/dL', 'low': 70.0, 'high': 99.0, 'desired': 'down_if_high'},
    'HbA1c': {'unit': '%', 'low': 4.0, 'high': 5.6, 'desired': 'down_if_high'},
    'Total Cholesterol': {'unit': 'mg/dL', 'low': 120.0, 'high': 200.0, 'desired': 'down_if_high'},
    'Triglycerides': {'unit': 'mg/dL', 'low': 40.0, 'high': 150.0, 'desired': 'down_if_high'},
    'HDL Cholesterol': {'unit': 'mg/dL', 'low': 40.0, 'high': 80.0, 'desired': 'up_if_low'},
    'LDL Cholesterol': {'unit': 'mg/dL', 'low': 50.0, 'high': 100.0, 'desired': 'down_if_high'},
    'ALT (SGPT)': {'unit': 'U/L', 'low': 7.0, 'high': 40.0, 'desired': 'down_if_high'},
    'AST (SGOT)': {'unit': 'U/L', 'low': 10.0, 'high': 40.0, 'desired': 'down_if_high'},
    'eGFR': {'unit': 'mL/min', 'low': 60.0, 'high': 120.0, 'desired': 'up_if_low'},
    'Serum Creatinine': {'unit': 'mg/dL', 'low': 0.70, 'high': 1.30, 'desired': 'normal'},
    'Vitamin D (25-OH)': {'unit': 'ng/mL', 'low': 30.0, 'high': 100.0, 'desired': 'up_if_low'},
    'Vitamin B12': {'unit': 'pg/mL', 'low': 200.0, 'high': 900.0, 'desired': 'normal'},
    'Ferritin': {'unit': 'ng/mL', 'low': 30.0, 'high': 400.0, 'desired': 'up_if_low'},
    'hs-CRP': {'unit': 'mg/L', 'low': 0.1, 'high': 1.0, 'desired': 'down_if_high'},
}

# Short-form aliases so lines like "Vitamin D: 29", "Glucose: 114" or
# "ALT: 48" still resolve to the correct canonical biomarker. Matching uses
# (?<!\w)...(?!\w) so short tokens ("ast", "alt", "hb") never match inside
# other words ("fasting" contains "ast", "health" contains "alt").
BIOMARKER_ALIASES = {
    'Fasting Glucose': ['fasting glucose', 'blood glucose', 'blood sugar', 'glucose fasting', 'glucose', 'fbs', 'fasting blood sugar'],
    'HbA1c': ['hba1c', 'hb a1c', 'glycated hemoglobin', 'glycated haemoglobin', 'glycosylated hemoglobin', 'glycohemoglobin', 'a1c'],
    'Total Cholesterol': ['total cholesterol', 'cholesterol total', 'serum cholesterol'],
    'Triglycerides': ['triglycerides', 'triglyceride', 'trig'],
    'HDL Cholesterol': ['hdl cholesterol', 'hdl-c', 'hdl'],
    'LDL Cholesterol': ['ldl cholesterol', 'ldl-c', 'ldl'],
    'ALT (SGPT)': ['alt (sgpt)', 'alt', 'sgpt', 'alanine aminotransferase'],
    'AST (SGOT)': ['ast (sgot)', 'ast', 'sgot', 'aspartate aminotransferase'],
    'Vitamin D (25-OH)': ['vitamin d (25-oh)', 'vitamin d 25-oh', 'vitamin d', 'vit d', '25-oh vitamin d', '25-hydroxy vitamin d'],
    'Vitamin B12': ['vitamin b12', 'vit b12', 'b12', 'cobalamin'],
    'Hemoglobin': ['hemoglobin', 'haemoglobin', 'hb', 'hgb', 'hb level'],
    'Hematocrit': ['hematocrit', 'haematocrit', 'hct', 'packed cell volume', 'pcv'],
    'RBC Count': ['rbc count', 'rbc', 'red blood cell', 'red blood corpuscle', 'erythrocyte'],
    'MCV': ['mcv', 'mean corpuscular volume'],
    'MCH': ['mch', 'mean corpuscular hemoglobin'],
    'MCHC': ['mchc', 'mean corpuscular hemoglobin concentration'],
    'RDW-CV': ['rdw-cv', 'rdw cv', 'rdw', 'red cell distribution width'],
    'ESR': ['esr', 'erythrocyte sedimentation rate', 'westergren'],
    'Neutrophils': ['neutrophils', 'neutrophil', 'neut', 'polymorphs', 'polymorph'],
    'Lymphocytes': ['lymphocytes', 'lymphocyte', 'lymph'],
    'Monocytes': ['monocytes', 'monocyte', 'mono'],
    'Eosinophils': ['eosinophils', 'eosinophil', 'eosino', 'eos'],
    'Basophils': ['basophils', 'basophil', 'baso'],
    'MPV': ['mpv', 'mean platelet volume'],
    'TSH': ['tsh', 'thyroid stimulating hormone', 'thyrotropin'],
    'T3 Total': ['t3 total', 't3', 'triiodothyronine'],
    'T4 Total': ['t4 total', 't4', 'thyroxine'],
    'Serum Urea': ['serum urea', 'urea'],
    'BUN': ['bun', 'blood urea nitrogen'],
    'WBC Count': ['wbc count', 'wbc', 'white blood cell', 'leukocyte', 'tlc', 'total leukocyte'],
    'Platelets': ['platelets', 'platelet', 'platelet count', 'thrombocyte', 'plt'],
    'eGFR': ['egfr', 'estimated gfr', 'glomerular filtration'],
    'Serum Creatinine': ['serum creatinine', 'creatinine'],
    'Ferritin': ['ferritin', 'serum ferritin'],
    'hs-CRP': ['hs-crp', 'hs crp', 'high sensitivity crp', 'c-reactive protein', 'crp'],
}

# Pre-sorted (longest alias first) so "HDL Cholesterol" beats "HDL", etc.
_ALIAS_PATTERNS = []
for _canonical, _aliases in BIOMARKER_ALIASES.items():
    for _a in _aliases:
        _ALIAS_PATTERNS.append((_canonical, _a))
_ALIAS_PATTERNS.sort(key=lambda x: -len(x[1]))


def _alias_to_regex(alias):
    # Escape then allow flexible whitespace; require non-word chars around.
    esc = re.escape(alias).replace(r'\ ', r'\s+')
    return re.compile(r'(?<!\w)' + esc + r'(?!\w)', re.IGNORECASE)


_ALIAS_REGEXES = [(_canonical, _alias, _alias_to_regex(_alias)) for (_canonical, _alias) in _ALIAS_PATTERNS]


def _dist_from_normal(val, low, high):
    """Distance of a value outside its reference interval (0 when inside)."""
    try:
        v = float(val)
    except (TypeError, ValueError):
        return 0.0
    try:
        if low is not None and v < float(low):
            return float(low) - v
        if high is not None and v > float(high):
            return v - float(high)
    except (TypeError, ValueError):
        return 0.0
    return 0.0


def _trend_lists(current_tests, previous_tests):
    """Compare current vs previous tests by clinical distance from normal.

    Returns (improved, worsened) note lists. Never raises on messy input.
    """
    improved, worsened = [], []
    if not previous_tests:
        return improved, worsened
    prev_by_name = {}
    for t in previous_tests or []:
        if isinstance(t, dict):
            key = t.get('name') or t.get('test_name')
            if key:
                prev_by_name[str(key)] = t
    for c in current_tests or []:
        if not isinstance(c, dict):
            continue
        cname = c.get('name') or c.get('test_name')
        if not cname:
            continue
        p = prev_by_name.get(str(cname))
        if not p:
            continue
        try:
            pv, cv = float(p.get('value')), float(c.get('value'))
        except (TypeError, ValueError):
            continue
        if pv == cv:
            continue
        low = c.get('low', c.get('ref_low'))
        high = c.get('high', c.get('ref_high'))
        pd = _dist_from_normal(pv, low, high)
        cd = _dist_from_normal(cv, low, high)
        unit = c.get('unit', '') or ''
        if cd < pd:
            improved.append(f"{cname} (moved from {pv} to {cv} {unit} toward normal)".strip())
        elif cd > pd:
            worsened.append(f"{cname} (moved from {pv} to {cv} {unit} away from normal)".strip())
    return improved, worsened


def determine_status(value, ref_low, ref_high):
    if ref_low is not None and value < ref_low:
        if value < (ref_low * 0.7):
            return 'Critical'
        return 'Low'
    if ref_high is not None and value > ref_high:
        if value > (ref_high * 1.3):
            return 'Critical'
        return 'High'
    return 'Normal'


class _Span:
    """Minimal match-like (start/end) for fuzzy hits in free text."""
    def __init__(self, s, e):
        self._s, self._e = s, e

    def start(self):
        return self._s

    def end(self):
        return self._e


def _levenshtein(a, b):
    if a == b:
        return 0
    m, n = len(a), len(b)
    if m == 0:
        return n
    if n == 0:
        return m
    prev = list(range(n + 1))
    for i in range(1, m + 1):
        cur = [i] + [0] * n
        ai = a[i - 1]
        for j in range(1, n + 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (0 if ai == b[j - 1] else 1))
        prev = cur
    return prev[n]


def _fuzzy_threshold(alias):
    ln = len(alias)
    if ln >= 7:
        return 2
    if ln >= 4:
        return 1
    return 0  # short tokens (hb, ast, t3) stay exact to avoid false hits


def _same_digits(a, b):
    da = ''.join(ch for ch in a if ch.isdigit())
    db = ''.join(ch for ch in b if ch.isdigit())
    return da == db


def find_fuzzy_biomarker_in_line(line):
    """Second pass for scanned-photo OCR typos ("HemogIobin" for Hemoglobin).

    Runs only when exact matching found nothing. Single-token aliases only,
    pure numbers skipped, digit sequences must agree exactly.
    Returns (canonical, _Span) or (None, None).
    """
    words = [(m.group(0), m.start()) for m in re.finditer(r'[A-Za-z0-9]+(?:[\/\-][A-Za-z0-9]+)*', line)]
    words = [(t, i) for (t, i) in words if not re.fullmatch(r'[0-9.]+', t)]
    if not words:
        return None, None
    best_key = None
    best_hit = (None, None)
    for canonical, alias, _rx in _ALIAS_REGEXES:
        if re.search(r'\s', alias):
            continue
        th = _fuzzy_threshold(alias)
        if th == 0:
            continue
        al = alias.lower()
        for text, idx in words:
            wl = text.lower()
            if abs(len(wl) - len(al)) > th:
                continue
            if not _same_digits(text, alias):
                continue
            d = _levenshtein(wl, al)
            if 0 < d <= th:
                key = (d, idx, -len(alias))
                if best_key is None or key < best_key:
                    best_key = key
                    best_hit = (canonical, _Span(idx, idx + len(text)))
    return best_hit


def find_biomarker_in_line(line):
    """Return (canonical, match_obj) for the best alias hit, or (None, None).

    Earliest occurrence in the string wins; longest alias breaks ties at the
    same position (so "HDL Cholesterol" beats "HDL"). Position-first ordering
    is what makes multi-test lines and flattened PDF text extract in order.
    """
    best_key = None
    best_hit = (None, None)
    for canonical, alias, rx in _ALIAS_REGEXES:
        m = rx.search(line)
        if m:
            key = (m.start(), -len(alias))
            if best_key is None or key < best_key:
                best_key = key
                best_hit = (canonical, m)
    return best_hit


def _normalize_report_line(line):
    # "Glucose, Fasting" -> "Glucose Fasting" (matches "glucose fasting"
    # alias). Only commas/semicolons between letters are joined — "/" is
    # left alone because units (mg/dL, U/L, ng/mL) need it.
    line = re.sub(r'([A-Za-z])\s*[,\;]\s*([A-Za-z])', r'\1 \2', line)
    line = re.sub(r'[ \t]+', ' ', line)
    return line.strip()


def _match_report_number(s):
    """First numeric result, supporting thousands separators ("2,50,000")."""
    m = re.search(r'[-+]?[\d,]+(?:\.\d+)?', s)
    if not m:
        return None
    try:
        val = float(m.group(0).replace(',', ''))
    except ValueError:
        return None
    return {'text': m.group(0), 'index': m.start(), 'length': len(m.group(0)), 'value': val}


def _last_number_before(s):
    """Last number before a test name, for result-first layouts
    ("13.8 g/dL Hemoglobin"). Rejects trailing dates ("2026-10-04 Hb")."""
    trimmed = s.rstrip()
    if re.search(r'(19|20)\d{2}-\d{1,2}-\d{1,2}$', trimmed):
        return None
    all_nums = list(re.finditer(r'[-+]?[\d,]+(?:\.\d+)?', trimmed))
    if not all_nums:
        return None
    last = all_nums[-1]
    try:
        val = float(last.group(0).replace(',', ''))
    except ValueError:
        return None
    return {'text': last.group(0), 'index': last.start(), 'length': len(last.group(0)), 'value': val}


def local_extract_tests(report_text):
    """Shared local parser used when Gemini is unavailable.

    Scans each whole line for biomarkers (not just the first hit) so that
    flattened PDF text with several tests on one line still yields the full
    set for the Verify Extracted Laboratory Values table. The value is taken
    AFTER the biomarker name (report dates are ignored) and printed
    "< 200" / "> 40" / "70 - 99" ranges are honored when present.
    Returns a list of {name, value, unit, low, high, status, printed}.
    """
    results = []
    seen = set()
    for raw_line in (report_text or '').replace('\f', '\n').split('\n'):
        line = _normalize_report_line(raw_line.strip())
        if len(line) < 3:
            continue
        remaining = line
        guard = 0
        while remaining and guard < 10:
            guard += 1
            # Exact match first; OCR-typo-tolerant fuzzy match as fallback.
            marker, alias_hit = find_biomarker_in_line(remaining)
            if not marker:
                marker, alias_hit = find_fuzzy_biomarker_in_line(remaining)
            if not marker:
                break
            details = VALIDATED_REFERENCE_RANGES.get(marker)
            if not details:
                remaining = remaining[alias_hit.end():]
                continue
            after_alias = remaining[alias_hit.end():]
            val_match = _match_report_number(after_alias)
            # A number directly inside an opening bracket is the printed
            # range, not the result ("13.8 g/dL Hemoglobin (13.5 - 17.5)").
            after_is_range = bool(val_match) and bool(re.match(r'\s*[\(\[]', after_alias[:val_match['index']]))
            if val_match and not after_is_range:
                val_end = alias_hit.end() + val_match['index'] + val_match['length']
            else:
                # Result printed before the test name ("13.8 g/dL Hemoglobin").
                prev = _last_number_before(remaining[:alias_hit.start()])
                if not prev:
                    remaining = after_alias  # alias with no number nearby; keep scanning rest of line
                    continue
                val_match = prev
                val_end = prev['index'] + prev['length']
            val = val_match['value']
            if marker not in seen:
                # Range lookup is scoped to this biomarker's own segment —
                # from the earlier of (value, name) through just past the
                # later — so flattened lines attribute ranges correctly.
                seg_start = min(alias_hit.start(), val_end)
                seg_end = max(alias_hit.end(), val_end)
                range_scope = remaining[seg_start:seg_end + 80]
                low, high, printed = parse_printed_range(range_scope, details['low'], details['high'])
                results.append({
                    'name': marker,
                    'value': val,
                    'unit': details['unit'],
                    'low': low,
                    'high': high,
                    'status': determine_status(val, low, high),
                    'printed': printed
                })
                seen.add(marker)
            remaining = remaining[val_end:]
    return results


ALLOWED_UPLOAD_EXTS = {'.pdf', '.png', '.jpg', '.jpeg', '.txt'}


def parse_printed_range(line, default_low, default_high):
    """Extract a printed reference interval from a report line.

    Handles "70 - 99", "70 to 99", "< 200" (upper bound only) and
    "> 40" (lower bound only), preferring content inside () or [].
    Returns (low, high, printed_bool).
    """
    paren_chunks = re.findall(r'[\(\[]([^\)\]]+)[\)\]]', line)
    zones = paren_chunks if paren_chunks else [line]
    for zone in zones:
        lt = re.search(r'<\s*(\d+\.?\d*)', zone)
        if lt:
            try:
                return default_low, float(lt.group(1)), True
            except ValueError:
                pass
        gt = re.search(r'>\s*(\d+\.?\d*)', zone)
        if gt:
            try:
                return float(gt.group(1)), default_high, True
            except ValueError:
                pass
        rng = re.search(r'(\d+\.?\d*)\s*(?:-|–|—|to)\s*(\d+\.?\d*)', zone, re.IGNORECASE)
        if rng:
            try:
                lo, hi = float(rng.group(1)), float(rng.group(2))
                if hi > lo and hi < 100000:
                    return lo, hi, True
            except ValueError:
                pass
    return default_low, default_high, False


def extract_text_from_upload(filepath, filename):
    """Return (text, error_message). Supports .txt directly and .pdf via
    pypdf when installed. Image files (.png/.jpg) need client-side OCR
    (tesseract.js) so the backend returns a clear message instead of garbage.
    """
    ext = os.path.splitext(filename or '')[1].lower()
    if ext in ('.txt', '.csv', '.log', '.md', ''):
        try:
            with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                return f.read(), None
        except Exception as e:
            return '', f'Could not read text file: {e}'
    if ext == '.pdf':
        try:
            from pypdf import PdfReader
        except ImportError:
            return '', 'PDF support requires the "pypdf" package. Run: pip install -r backend/requirements.txt. As a workaround, open the PDF, copy its text, and paste it into "Or Paste Raw Blood Report Text".'
        try:
            reader = PdfReader(filepath)
            pages = [(p.extract_text() or '') for p in reader.pages]
            text = '\n'.join(pages)
            if not text.strip():
                return '', 'No selectable text found in this PDF (it may be a scanned image). Please use a clearer file, upload a photo for OCR on the Upload page, or paste the report text manually.'
            return text, None
        except Exception as e:
            return '', f'Could not parse PDF: {e}'
    if ext in ('.png', '.jpg', '.jpeg', '.bmp', '.tiff', '.tif', '.webp'):
        return '', 'Image uploads are OCR-processed in the browser (tesseract.js). If you called the API directly, please use the website Upload page or POST raw_text instead.'
    return '', f'Unsupported file type "{ext}". Please upload PDF, JPG, PNG, or TXT (max 16 MB).'

# ============================================================
# API ROUTES
# ============================================================

@app.route('/api/health', methods=['GET'])
def health_check():
    return jsonify({
        'status': 'healthy',
        'application': 'BloodReport AI API',
        'version': '1.0.0',
        'gemini_configured': bool(get_gemini_api_key()),
        'timestamp': datetime.utcnow().isoformat()
    })

# ============================================================
# GEMINI AI SECURE SERVER-SIDE ENDPOINTS (API KEY FROM .ENV)
# ============================================================

@app.route('/api/gemini/status', methods=['GET'])
def gemini_status():
    """Checks whether GEMINI_API_KEY is configured in .env without exposing the key"""
    key = get_gemini_api_key()
    return jsonify({
        'configured': bool(key),
        'model': 'gemini-1.5-flash',
        'key_source': '.env file'
    })

@app.route('/api/gemini/extract', methods=['POST'])
def gemini_extract():
    """Extracts biomarkers using server-side Gemini API key from .env"""
    data = request.json or {} if request.is_json else {}
    report_text = data.get('raw_text', '') if isinstance(data, dict) else ''

    if 'file' in request.files:
        upload = request.files['file']
        filename = upload.filename or 'uploaded_report.txt'
        ext = os.path.splitext(filename)[1].lower()
        if ext == '.pdf':
            tmp_path = os.path.join(app.config['UPLOAD_FOLDER'], filename)
            upload.save(tmp_path)
            report_text, err = extract_text_from_upload(tmp_path, filename)
            if err:
                return jsonify({'error': err, 'tests': []}), 400
        elif ext in ('.png', '.jpg', '.jpeg', '.bmp', '.tiff', '.tif', '.webp'):
            return jsonify({'error': 'Image uploads are OCR-processed in the browser (tesseract.js). Please use the website Upload page or POST raw_text instead.', 'tests': []}), 400
        elif ext in ALLOWED_UPLOAD_EXTS or ext == '':
            try:
                report_text = upload.read().decode('utf-8', errors='ignore')
            except Exception:
                report_text = ''
        else:
            return jsonify({'error': f'Unsupported file type "{ext}". Please upload PDF, JPG, PNG, or TXT.', 'tests': []}), 400

    if not report_text.strip():
        return jsonify({'error': 'No report text provided for extraction'}), 400

    api_key = get_gemini_api_key()
    if api_key:
        try:
            prompt = f"""
            You are a clinical laboratory extraction assistant.
            Extract all blood test biomarker results from the provided text into a valid JSON object matching this schema:
            {{
              "lab_name": "Name of clinical laboratory or 'Clinical Laboratory'",
              "report_date": "{datetime.now().strftime('%Y-%m-%d')}",
              "tests": [
                {{
                  "name": "Biomarker name",
                  "value": 114.0,
                  "unit": "mg/dL",
                  "low": 70.0,
                  "high": 99.0,
                  "status": "Normal" | "Low" | "High" | "Critical",
                  "printed": true
                }}
              ]
            }}

            Report Text:
            {report_text[:8000]}
            """
            result = call_gemini_api(prompt)
            result['source'] = 'gemini-1.5-flash (.env)'
            return jsonify(result)
        except Exception as e:
            print(f"Gemini API extract error: {e}")

    # Fallback local extraction when the .env key is missing or the call failed.
    extracted = local_extract_tests(report_text)

    return jsonify({
        'lab_name': 'Clinical Laboratory',
        'report_date': datetime.now().strftime('%Y-%m-%d'),
        'tests': extracted,
        'source': 'local regex fallback (GEMINI_API_KEY missing in .env)'
    })

@app.route('/api/gemini/summary', methods=['POST'])
def gemini_summary():
    """Generates non-diagnostic educational summary using Gemini API key from .env"""
    data = request.json or {}
    current_tests = data.get('current_tests', [])
    previous_tests = data.get('previous_tests', [])

    api_key = get_gemini_api_key()
    if api_key and current_tests:
        try:
            prompt = f"""
            You are BloodReport AI, an educational health assistant.
            Adhere strictly to safety boundaries:
            - Do NOT diagnose any diseases or conditions.
            - Do NOT prescribe or adjust medications.
            - AI-generated information is for educational purposes only and does not replace professional medical advice.

            Current Blood Tests:
            {json.dumps(current_tests)}

            Previous Blood Tests (if any):
            {json.dumps(previous_tests)}

            Generate a simple-language educational summary in JSON with this exact schema:
            {{
              "overall_trend": "Brief overall trend summary title",
              "narrative": "2-3 paragraphs in simple language explaining the findings, noting improvements or areas to watch without diagnosing",
              "improved_values": ["test name and brief improvement note"],
              "worsened_values": ["test name and brief worsening note if any"],
              "attention_needed": ["test name and clear explanation of why attention is warranted"],
              "doctor_questions": ["Question 1 to discuss with physician", "Question 2", "Question 3", "Question 4"]
            }}
            """
            result = call_gemini_api(prompt)
            if not isinstance(result, dict) or not isinstance(result.get('narrative'), str):
                raise ValueError("Gemini returned an unexpected summary shape.")
            result['source'] = 'gemini-1.5-flash (.env)'
            return jsonify(result)
        except Exception as e:
            print(f"Gemini API summary error: {e}")

    # Fallback dynamic rule-based synthesis (with real trend computation so
    # second/subsequent reports show improved vs worsened values).
    abnormal = [t for t in current_tests if isinstance(t, dict) and t.get('status') in ('High', 'Low', 'Critical')]
    improved, worsened = _trend_lists(current_tests, previous_tests)
    if improved and not worsened:
        overall = 'Positive Trajectory with Key Metabolic Areas Needing Attention'
    elif worsened and len(worsened) > len(improved):
        overall = 'Mixed Trend — Some Values Moved Away From Normal'
    elif abnormal:
        overall = 'Stable with specific parameters warranting physician review'
    else:
        overall = 'Optimal'
    return jsonify({
        'overall_trend': overall,
        'narrative': f"Analysis of your {len(current_tests)} tested biomarkers reveals {len(current_tests) - len(abnormal)} tests in normal range and {len(abnormal)} tests outside reference limits." + (f" Since the previous report, {len(improved)} value(s) moved toward normal" + (f" and {len(worsened)} moved away." if worsened else ".") if (improved or worsened) else ""),
        'improved_values': improved,
        'worsened_values': worsened,
        'attention_needed': [f"{t.get('name')} ({t.get('value')} {t.get('unit')}) is {t.get('status', '').lower()}." for t in abnormal],
        'doctor_questions': [
            "What target range would you like my flagged parameters to reach over the next 3 to 6 months?",
            "What lifestyle or dietary modifications do you advise based on these results?",
            "When should we schedule repeat testing to track progress?"
        ],
        'source': 'local fallback (GEMINI_API_KEY missing in .env)'
    })

@app.route('/api/gemini/explain', methods=['POST'])
def gemini_explain():
    """Explains a single biomarker dynamically using Gemini key from .env"""
    data = request.json or {}
    test_name = data.get('test_name', '')
    value = data.get('value', 0)
    unit = data.get('unit', '')
    low = data.get('low', 0)
    high = data.get('high', 100)

    api_key = get_gemini_api_key()
    if api_key and test_name:
        try:
            prompt = f"""
            Explain the blood biomarker '{test_name}' with current value {value} {unit} (reference range: {low} - {high}).
            Return JSON:
            {{
              "explanation": "2-3 clear, simple sentences explaining what this biomarker measures in the body",
              "factors": "Common non-disease factors that affect this level (e.g., fasting, hydration, exercise, time of collection)",
              "guidance": "1-2 practical sentences advising what to discuss with a healthcare professional"
            }}
            """
            result = call_gemini_api(prompt)
            return jsonify(result)
        except Exception as e:
            print(f"Gemini explanation error: {e}")

    return jsonify({
        'explanation': f"{test_name} is a routine diagnostic biomarker measured in clinical blood panels.",
        'factors': "Hydration status, recent meals, exercise, and collection time.",
        'guidance': "Review any deviations with your physician to establish personalized target goals."
    })


# 1. USER PROFILE ENDPOINTS
@app.route('/api/user/profile', methods=['GET'])
def get_user_profile():
    conn = get_db_connection()
    user = conn.execute('SELECT * FROM Users LIMIT 1').fetchone()
    conn.close()
    if user:
        return jsonify(dict(user))
    return jsonify({'error': 'User not found'}), 404

@app.route('/api/user/profile', methods=['PUT'])
def update_user_profile():
    data = request.json or {}
    conn = get_db_connection()
    user_id = ensure_default_user(conn)
    conn.execute('''
    UPDATE Users
    SET name = ?, age = ?, sex = ?, date_of_birth = ?, height = ?, weight = ?, pregnancy_status = ?
    WHERE id = ?
    ''', (
        data.get('name', 'Local User'),
        data.get('age'),
        data.get('sex'),
        data.get('date_of_birth'),
        data.get('height'),
        data.get('weight'),
        data.get('pregnancy_status'),
        user_id
    ))
    conn.commit()
    conn.close()
    return jsonify({'message': 'Profile updated successfully'})

# 2. UPLOAD & OCR EXTRACTION (POST /api/upload-report)
@app.route('/api/upload-report', methods=['POST'])
def upload_report():
    """
    Accepts PDF, JPG, PNG, or TXT file or raw text.
    Extracts text and uses Gemini API or regex parser to identify candidate blood test values.
    Returns preview data so the user can verify and edit before database storage.
    """
    api_key = get_gemini_api_key()
    file_text = ""
    filename = "uploaded_report.txt"
    raw_text_hint = ""

    if 'file' in request.files:
        file = request.files['file']
        filename = file.filename or 'uploaded_report.txt'
        ext = os.path.splitext(filename)[1].lower()
        if ext not in ALLOWED_UPLOAD_EXTS:
            return jsonify({'error': f'Unsupported file type "{ext}". Please upload PDF, JPG, PNG, or TXT (max 16 MB).', 'extracted_tests': []}), 400
        filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
        file.save(filepath)
        if ext == '.txt':
            try:
                with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                    file_text = f.read()
            except Exception as e:
                return jsonify({'error': f'Could not read text file: {e}', 'extracted_tests': []}), 400
        elif ext == '.pdf':
            file_text, err = extract_text_from_upload(filepath, filename)
            if err:
                return jsonify({'error': err, 'extracted_tests': []}), 400
        else:
            # Scanned photo: OCR runs in the browser (tesseract.js). The API
            # cannot do server-side OCR without a system tesseract install, so
            # return a clear message instead of silent garbage extraction.
            return jsonify({'error': 'Photo reports are OCR-processed in the browser. Please upload via the website Upload page (which runs tesseract.js automatically), or paste the report text as raw_text.', 'extracted_tests': []}), 400
    elif request.is_json and request.json and 'raw_text' in request.json:
        file_text = request.json.get('raw_text', '') or ''
        filename = request.json.get('filename', 'pasted_report.txt')
        raw_text_hint = 'pasted text'

    if not (file_text or '').strip():
        return jsonify({'error': 'No readable text found. For PDFs, ensure the file has selectable text; for scanned photos use the website Upload page (browser OCR) or paste the report text manually.', 'extracted_tests': []}), 400

    extracted_tests = []
    gemini_used = False

    # 1. Try extracting with Gemini API if key is present
    if api_key and file_text.strip():
        try:
            import urllib.request
            prompt = f"""
            You are a clinical laboratory extraction assistant.
            Extract all blood test biomarker results from the provided text into a JSON object adhering to this schema:
            {{
              "lab_name": "Metro Health Clinical Laboratories",
              "report_date": "{datetime.now().strftime('%Y-%m-%d')}",
              "tests": [
                {{
                  "name": "Fasting Glucose",
                  "value": 114.0,
                  "unit": "mg/dL",
                  "low": 70.0,
                  "high": 99.0,
                  "status": "Normal" | "Low" | "High" | "Critical",
                  "printed": true
                }}
              ]
            }}
            Report text to extract from:
            {file_text[:8000]}
            """
            req_data = json.dumps({
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {"temperature": 0.1, "responseMimeType": "application/json"}
            }).encode('utf-8')

            url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key={api_key}"
            req = urllib.request.Request(url, data=req_data, headers={'Content-Type': 'application/json'}, method='POST')
            with urllib.request.urlopen(req, timeout=15) as resp:
                res_body = json.loads(resp.read().decode('utf-8'))
                raw_json = res_body['candidates'][0]['content']['parts'][0]['text']
                parsed = json.loads(raw_json)
                for t in parsed.get('tests', []):
                    extracted_tests.append({
                        'test_name': t.get('name'),
                        'value': float(t.get('value', 0)),
                        'unit': t.get('unit', ''),
                        'ref_low': float(t.get('low')) if t.get('low') is not None else None,
                        'ref_high': float(t.get('high')) if t.get('high') is not None else None,
                        'status': t.get('status', 'Normal'),
                        'is_lab_printed_range': t.get('printed', True)
                    })
                gemini_used = True
        except Exception as e:
            print(f"Gemini API extraction failed, falling back to dynamic parser: {e}")

    # 2. Local fallback extraction if Gemini was not used or returned empty.
    if not extracted_tests and file_text.strip():
        for t in local_extract_tests(file_text):
            extracted_tests.append({
                'test_name': t['name'],
                'value': t['value'],
                'unit': t['unit'],
                'ref_low': t['low'],
                'ref_high': t['high'],
                'status': t['status'],
                'is_lab_printed_range': t['printed']
            })

    if not extracted_tests:
        return jsonify({
            'filename': filename,
            'report_date': datetime.now().strftime('%Y-%m-%d'),
            'laboratory_name': 'Clinical Laboratory Analysis',
            'extracted_tests': [],
            'gemini_powered': False,
            'message': 'No biomarkers detected. ' + ('Gemini returned no values; ' if gemini_used else '') + 'Please check the file contains lines like "Hemoglobin: 13.8 g/dL" or add values manually in the verification table.',
            'raw_text_preview': file_text[:2000]
        }), 200

    return jsonify({
        'filename': filename,
        'report_date': datetime.now().strftime('%Y-%m-%d'),
        'laboratory_name': 'Clinical Laboratory Analysis',
        'extracted_tests': extracted_tests,
        'gemini_powered': gemini_used,
        'message': 'Report text successfully extracted via ' + ('Gemini AI' if gemini_used else 'Clinical Parser') + '. Please review values before submitting.'
    })

# 3. CONFIRM & ANALYZE REPORT (POST /api/analyze-report)
@app.route('/api/analyze-report', methods=['POST'])
def analyze_report():
    data = request.json or {}
    report_date = data.get('report_date', datetime.now().strftime('%Y-%m-%d'))
    lab_name = data.get('laboratory_name', 'Clinical Laboratory')
    uploaded_file = data.get('filename', 'uploaded_report.pdf')
    tests = data.get('tests', [])

    conn = get_db_connection()
    cursor = conn.cursor()

    # Lazily ensure an owner row exists (no demo users are seeded).
    user_id = ensure_default_user(conn)

    # Insert new report
    cursor.execute('''
    INSERT INTO Reports (user_id, report_date, uploaded_file, laboratory_name)
    VALUES (?, ?, ?, ?)
    ''', (user_id, report_date, uploaded_file, lab_name))
    report_id = cursor.lastrowid

    # Insert test results
    for t in tests:
        val = float(t.get('value', 0))
        ref_low = float(t.get('ref_low', 0)) if t.get('ref_low') is not None else None
        ref_high = float(t.get('ref_high', 0)) if t.get('ref_high') is not None else None
        status = determine_status(val, ref_low, ref_high)

        cursor.execute('''
        INSERT INTO TestResults (report_id, test_name, value, unit, reference_low, reference_high, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ''', (report_id, t.get('test_name'), val, t.get('unit', ''), ref_low, ref_high, status))

    conn.commit()
    conn.close()

    return jsonify({
        'report_id': report_id,
        'message': 'Report successfully saved and analyzed.',
        'tests_count': len(tests)
    })

# 4. LIST REPORTS (GET /api/reports)
@app.route('/api/reports', methods=['GET'])
def get_reports():
    conn = get_db_connection()
    reports = conn.execute('''
    SELECT r.id, r.report_date, r.uploaded_file, r.laboratory_name, r.created_at,
           COUNT(t.id) as total_tests,
           SUM(CASE WHEN t.status = 'Normal' THEN 1 ELSE 0 END) as normal_tests,
           SUM(CASE WHEN t.status IN ('High', 'Low', 'Critical') THEN 1 ELSE 0 END) as abnormal_tests
    FROM Reports r
    LEFT JOIN TestResults t ON r.id = t.report_id
    GROUP BY r.id
    ORDER BY r.report_date DESC
    ''').fetchall()
    conn.close()

    return jsonify([dict(r) for r in reports])

# 5. GET SINGLE REPORT (GET /api/reports/:id)
@app.route('/api/reports/<int:report_id>', methods=['GET'])
def get_report(report_id):
    conn = get_db_connection()
    report = conn.execute('SELECT * FROM Reports WHERE id = ?', (report_id,)).fetchone()
    conn.close()
    if report:
        return jsonify(dict(report))
    return jsonify({'error': 'Report not found'}), 404

# 6. GET REPORT RESULTS (GET /api/reports/:id/results)
@app.route('/api/reports/<int:report_id>/results', methods=['GET'])
def get_report_results(report_id):
    conn = get_db_connection()
    results = conn.execute('''
    SELECT * FROM TestResults WHERE report_id = ? ORDER BY test_name ASC
    ''', (report_id,)).fetchall()
    conn.close()

    return jsonify([dict(r) for r in results])

# 7. CLINICAL COMPARISON ENGINE (POST /api/compare)
@app.route('/api/compare', methods=['POST'])
def compare_reports():
    """
    Compares two reports by test name.
    Calculates absolute change, percentage change, and clinically-aware trend.
    Evaluates whether the value moved toward or away from the applicable reference interval!
    """
    data = request.json or {}
    prev_id = data.get('previous_report_id')
    curr_id = data.get('current_report_id')

    if not prev_id or not curr_id:
        return jsonify({'error': 'Both previous_report_id and current_report_id are required'}), 400

    conn = get_db_connection()
    prev_results = {r['test_name']: dict(r) for r in conn.execute('SELECT * FROM TestResults WHERE report_id = ?', (prev_id,)).fetchall()}
    curr_results = {r['test_name']: dict(r) for r in conn.execute('SELECT * FROM TestResults WHERE report_id = ?', (curr_id,)).fetchall()}
    
    prev_report = conn.execute('SELECT * FROM Reports WHERE id = ?', (prev_id,)).fetchone()
    curr_report = conn.execute('SELECT * FROM Reports WHERE id = ?', (curr_id,)).fetchone()
    conn.close()

    comparisons = []
    total_improved = 0
    total_worsened = 0
    total_stable = 0

    for name, curr in curr_results.items():
        if name in prev_results:
            prev = prev_results[name]
            p_val = prev['value']
            c_val = curr['value']
            diff = round(c_val - p_val, 2)
            pct_change = round(((c_val - p_val) / p_val * 100), 1) if p_val != 0 else 0.0

            ref_low = curr['reference_low']
            ref_high = curr['reference_high']

            # Clinical Context-Aware Improvement Logic:
            # Did the value move closer to or further from the normal reference interval?
            trend = 'Stable'
            if diff == 0:
                trend = 'Stable'
                total_stable += 1
            else:
                # Calculate distance from normal zone
                def distance_from_normal(val, low, high):
                    if val < low:
                        return low - val
                    elif val > high:
                        return val - high
                    return 0.0  # inside normal range

                prev_dist = distance_from_normal(p_val, ref_low, ref_high)
                curr_dist = distance_from_normal(c_val, ref_low, ref_high)

                if curr_dist < prev_dist:
                    trend = 'Improving'
                    total_improved += 1
                elif curr_dist > prev_dist:
                    trend = 'Worsening'
                    total_worsened += 1
                else:
                    # Both inside normal range
                    trend = 'Stable (Within Normal Range)'
                    total_stable += 1

            comparisons.append({
                'test_name': name,
                'unit': curr['unit'],
                'reference_low': ref_low,
                'reference_high': ref_high,
                'previous_value': p_val,
                'current_value': c_val,
                'absolute_change': diff,
                'percentage_change': pct_change,
                'status': curr['status'],
                'trend': trend
            })

    return jsonify({
        'previous_report': dict(prev_report) if prev_report else {},
        'current_report': dict(curr_report) if curr_report else {},
        'comparisons': comparisons,
        'summary': {
            'total_compared': len(comparisons),
            'improved': total_improved,
            'worsened': total_worsened,
            'stable': total_stable,
            'overall_trend': 'Improving' if total_improved > total_worsened else ('Worsening' if total_worsened > total_improved else 'Stable')
        }
    })

# 8. DELETE REPORT (DELETE /api/reports/:id)
@app.route('/api/reports/<int:report_id>', methods=['DELETE'])
def delete_report(report_id):
    conn = get_db_connection()
    conn.execute('DELETE FROM TestResults WHERE report_id = ?', (report_id,))
    conn.execute('DELETE FROM Reports WHERE id = ?', (report_id,))
    conn.commit()
    conn.close()
    return jsonify({'message': f'Report #{report_id} and related test results deleted successfully.'})

# 8b. ERASE ALL STORED DATA (DELETE /api/reports)
@app.route('/api/reports', methods=['DELETE'])
def delete_all_reports():
    """User-requested wipe: removes every stored report, all test results,
    and all uploaded files from the server. Cannot be undone."""
    conn = get_db_connection()
    conn.execute('DELETE FROM TestResults')
    conn.execute('DELETE FROM Reports')
    conn.commit()
    conn.close()
    removed_files = 0
    try:
        for fname in os.listdir(app.config['UPLOAD_FOLDER']):
            fpath = os.path.join(app.config['UPLOAD_FOLDER'], fname)
            if os.path.isfile(fpath):
                os.remove(fpath)
                removed_files += 1
    except Exception as e:
        print(f"Upload folder cleanup warning: {e}")
    return jsonify({'message': 'All stored reports and uploaded files erased.', 'removed_files': removed_files})

# 9. AI SIMPLE-LANGUAGE EXPLANATION GENERATOR (POST /api/ai-summary)
@app.route('/api/ai-summary', methods=['POST'])
def generate_ai_summary():
    """
    Generates a simple-language summary adhering strictly to project guidelines:
    - Overall trend
    - Improved values
    - Worsened values
    - Abnormal values needing attention
    - Questions to discuss with a healthcare professional
    - Does NOT diagnose diseases or prescribe medication
    """
    data = request.json or {}
    report_id = data.get('report_id')
    api_key = get_gemini_api_key()

    conn = get_db_connection()
    tests = conn.execute('SELECT * FROM TestResults WHERE report_id = ?', (report_id,)).fetchall()
    conn.close()

    if not tests:
        return jsonify({'error': 'No test results found for this report'}), 404

    test_list = [dict(t) for t in tests]
    abnormal = [t for t in test_list if t['status'] in ('High', 'Low', 'Critical')]

    # 1. If Gemini API key is provided, generate dynamically via Gemini
    if api_key:
        try:
            import urllib.request
            prompt = f"""
            You are BloodReport AI, an educational health assistant.
            Adhere strictly to these safety boundaries:
            - Do NOT diagnose any diseases or conditions.
            - Do NOT prescribe or change any medications or dosages.
            - State that AI-generated information is for educational purposes only and does not replace professional medical advice.

            Given these actual blood test results:
            {json.dumps([{'name': t['test_name'], 'value': t['value'], 'unit': t['unit'], 'status': t['status'], 'ref': f"{t['reference_low']}-{t['reference_high']}"} for t in test_list])}

            Return a valid JSON object adhering strictly to this schema:
            {{
              "overall_trend": "Brief overall trend description",
              "narrative": "2-3 paragraphs in simple language explaining the findings",
              "improved_values": ["test name and brief improvement note"],
              "worsened_values": ["test name and brief worsening note if any"],
              "attention_needed": ["test name and reason attention is warranted"],
              "doctor_questions": ["question 1", "question 2", "question 3", "question 4"]
            }}
            """
            req_data = json.dumps({
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {"temperature": 0.2, "responseMimeType": "application/json"}
            }).encode('utf-8')

            url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key={api_key}"
            req = urllib.request.Request(url, data=req_data, headers={'Content-Type': 'application/json'}, method='POST')
            with urllib.request.urlopen(req, timeout=15) as resp:
                res_body = json.loads(resp.read().decode('utf-8'))
                raw_json = res_body['candidates'][0]['content']['parts'][0]['text']
                parsed = json.loads(raw_json)
                parsed['abnormal_values'] = [
                    {'name': t['test_name'], 'value': f"{t['value']} {t['unit']}", 'status': t['status']}
                    for t in abnormal
                ]
                parsed['disclaimer'] = 'AI-generated information is for educational purposes only and does not replace professional medical advice.'
                parsed['gemini_powered'] = True
                return jsonify(parsed)
        except Exception as e:
            print(f"Gemini summary generation failed, using dynamic rule generator: {e}")

    # 2. Dynamic Rule Synthesis fallback based on actual database values (no hardcoded static strings)
    attention_items = [
        f"{t['test_name']} ({t['value']} {t['unit']}) is currently {t['status'].lower()} relative to reference limits ({t['reference_low']} - {t['reference_high']})."
        for t in abnormal
    ]

    summary_content = {
        'overall_trend': 'Stable with specific parameters warranting physician review' if abnormal else 'Optimal - all tested parameters within reference intervals',
        'narrative': f"Analysis of your {len(test_list)} analyzed tests reveals {len(test_list) - len(abnormal)} tests within normal intervals and {len(abnormal)} tests outside standard limits. Review the specific flagged items below with your physician.",
        'abnormal_values': [
            {'name': t['test_name'], 'value': f"{t['value']} {t['unit']}", 'status': t['status']}
            for t in abnormal
        ],
        'improved_values': [],
        'worsened_values': [],
        'attention_needed': attention_items if attention_items else ["All tested parameters are within reference bounds."],
        'doctor_questions': [
            f"What target range would you like my {abnormal[0]['test_name']} to reach over the next 3 to 6 months?" if abnormal else "When should we schedule my next routine panel?",
            "What lifestyle or dietary modifications do you advise based on these results?",
            "Are there any additional follow-up diagnostic panels or repeat tests you recommend?",
            "How do my current prescription medications or supplements relate to these laboratory results?"
        ],
        'disclaimer': 'AI-generated information is for educational purposes only and does not replace professional medical advice.',
        'gemini_powered': False
    }

    return jsonify(summary_content)

# Serve Frontend Root
@app.route('/')
def serve_index():
    return send_from_directory('../', 'index.html')

@app.route('/<path:path>')
def serve_static(path):
    return send_from_directory('../', path)

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    print(f"BloodReport AI backend starting on port {port}...")
    app.run(host='0.0.0.0', port=port, debug=True)
