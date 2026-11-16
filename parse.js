// fast-marked-v2 — a fast drop-in replacement for marked 18.1.3.
//
// parse(markdown) returns exactly the HTML marked 18.1.3 produces with its
// default options (GFM on, breaks off, pedantic off, async off), for every
// input string. Dependency-free, plain modern JS (Node 22+).
//
// Design: a line-based block parser (CommonMark 0.31.2 + GFM 0.29) feeding a
// delimiter-stack inline parser (CommonMark Appendix A), both written to
// avoid regular expressions in hot paths: character classes are table
// lookups, block starts dispatch on the first character, masking is a
// manual scan, and text escaping is a single regex pass.

// ------------------------------------------------------------------ characters

// ASCII tables (indexed by char code). Non-ASCII characters fall back to a
// Unicode regex, which is rare in practice and never on a hot path.
const WS_T = new Uint8Array(128);
for (const c of [9, 10, 11, 12, 13, 32]) WS_T[c] = 1;

const PUNCT_T = new Uint8Array(128);
for (const ch of '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~') PUNCT_T[ch.charCodeAt(0)] = 1;

const ALNUM_T = new Uint8Array(128); // [0-9A-Za-z]
for (let c = 48; c <= 57; c++) ALNUM_T[c] = 1;
for (let c = 65; c <= 90; c++) ALNUM_T[c] = 1;
for (let c = 97; c <= 122; c++) ALNUM_T[c] = 1;

const EMAIL_LOCAL_T = new Uint8Array(128); // [A-Za-z0-9._+-]
for (let c = 0; c < 128; c++) if (ALNUM_T[c]) EMAIL_LOCAL_T[c] = 1;
for (const ch of '._+-') EMAIL_LOCAL_T[ch.charCodeAt(0)] = 1;

const EMAIL_DOMAIN_T = new Uint8Array(128); // [A-Za-z0-9_-]
for (let c = 0; c < 128; c++) if (ALNUM_T[c]) EMAIL_DOMAIN_T[c] = 1;
EMAIL_DOMAIN_T[95] = 1; EMAIL_DOMAIN_T[45] = 1;

const NONASCII_PUNCT_RE = /[\p{P}\p{S}]/u;
const NONASCII_WS_RE = /\s/;

// Character (a one-char string, or undefined) -> is it whitespace?
function isWS(ch) {
  if (ch === undefined) return false;
  const code = ch.charCodeAt(0);
  return code < 128 ? WS_T[code] === 1 : NONASCII_WS_RE.test(ch);
}
// Character -> is it punctuation (CommonMark sense)?
function isPunct(ch) {
  if (ch === undefined) return false;
  const code = ch.charCodeAt(0);
  return code < 128 ? PUNCT_T[code] === 1 : NONASCII_PUNCT_RE.test(ch);
}
// Char code -> ASCII punctuation? (code must be < 128)
function isPunctCode(code) { return PUNCT_T[code] === 1; }

// ------------------------------------------------------------------ escaping

// One regex pass for inline text: valid numeric references are decoded
// (out of range / surrogates become U+FFFD), named-entity-looking runs
// (&word;) are left alone, every other & becomes &amp;, and < > " ' are
// escaped. Matches marked: named entities pass through raw, numeric
// references are decoded and the decoded character is escaped if needed.
const TEXT_ESC_RE = /&#(?:\d{1,7}|[xX][0-9a-fA-F]{1,6});|&\w+;|[&<>"']/g;
function escText(s) {
  return s.replace(TEXT_ESC_RE, (m) => {
    const c0 = m.charCodeAt(0);
    if (m.length === 1) {
      if (c0 === 38) return '&amp;';   // &
      if (c0 === 60) return '&lt;';    // <
      if (c0 === 62) return '&gt;';    // >
      if (c0 === 34) return '&quot;';  // "
      return '&#39;';                  // '
    }
    if (c0 === 38 && m.charCodeAt(1) === 35) {
      // numeric reference &#...; / &#x...;
      let cp;
      if (m.charCodeAt(2) === 120 || m.charCodeAt(2) === 88) cp = parseInt(m.slice(3, -1), 16);
      else cp = parseInt(m.slice(2, -1), 10);
      if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) cp = 0xFFFD;
      const ch = String.fromCodePoint(cp);
      if (ch === '&') return '&amp;';
      if (ch === '<') return '&lt;';
      if (ch === '>') return '&gt;';
      if (ch === '"') return '&quot;';
      if (ch === "'") return '&#39;';
      return ch;
    }
    return m; // &word; — a named entity, left as-is
  });
}

// Code spans / code blocks: every & becomes &amp; (no entity pass-through).
const CODE_ESC_RE = /[&<>"']/g;
function escEncode(s) {
  return s.replace(CODE_ESC_RE, (m) => {
    const c0 = m.charCodeAt(0);
    if (c0 === 38) return '&amp;';
    if (c0 === 60) return '&lt;';
    if (c0 === 62) return '&gt;';
    if (c0 === 34) return '&quot;';
    return '&#39;';
  });
}
// Attribute values / info strings: & is left alone before a valid entity.
function escAttr(s) { return escText(s); }

// marked's cleanUrl: encodeURI, with %25 restored to %, then attribute-escape
// happens at the call site. Returns null when encodeURI throws (lone
// surrogate in the URL); the caller then falls back to the raw href.
function cleanUrl(href) {
  try { return encodeURI(href).replace(/%25/g, '%'); } catch (e) { return null; }
}

// Backslash-escapable ASCII punctuation, as a Set for the link parsers.
const PUNCT_SET = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));

// ------------------------------------------------------------------ link labels

// Reference labels are normalized by: unescaping only \[, \] and \\,
// collapsing whitespace runs to one space, trimming, lowercasing, and
// folding ß/ẞ to ss (CommonMark + marked's case folding).
const _normCache = new Map();
function normalizeLabel(label) {
  const hit = _normCache.get(label);
  if (hit !== undefined) return hit;
  const out = label.replace(/\\([\[\]\\])/g, '$1').replace(/\s+/g, ' ').trim().toLowerCase().replace(/ß/g, 'ss').replace(/ẞ/g, 'ss');
  if (_normCache.size > 4096) _normCache.clear();
  _normCache.set(label, out);
  return out;
}

// text[i] === '['; return the index just past the matching ] (one level of
// nesting allowed when allowNested), or -1. Backslash escapes are skipped.
function matchBracketGroup(text, i, allowNested) {
  let j = i + 1;
  const n = text.length;
  while (j < n) {
    const d = text[j];
    if (d === '\\') { j += 2; continue; }
    if (d === ']') return j + 1;
    if (d === '[') {
      if (!allowNested) return -1;
      const inner = matchBracketGroup(text, j, false);
      if (inner === -1) return -1;
      j = inner; continue;
    }
    j++;
  }
  return -1;
}

// marked's link-text pattern: a sequence of nested [...] groups, backslash
// escapes, code-span-like units, or any char except [ ] \ `. A stray ] or
// an unmatched backtick makes the label invalid.
function labelTextValid(text) {
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '\\') { if (i + 1 >= n) return false; i += 2; continue; }
    if (c === '[') {
      const end = matchBracketGroup(text, i, true);
      if (end === -1) return false;
      i = end; continue;
    }
    if (c === '`') {
      let j = i;
      while (j < n && text[j] === '`') j++;
      const run = j - i;
      let k = j;
      while (k < n && text[k] !== '`') k++;
      if (k < n) {
        let m = k;
        while (m < n && text[m] === '`') m++;
        i = m; continue;
      }
      if (run >= 2 && j === n) { i = j; continue; }
      return false;
    }
    if (c === ']') return false;
    i++;
  }
  return true;
}

// marked's shortcut/collapsed reference label: no unescaped [ or ], no
// newline followed by a blank line, not whitespace-only.
function shortcutLabelValid(text) {
  if (!text || !/\S/.test(text)) return false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (c === '[' || c === ']') return false;
    if (c === '\n') {
      let j = i + 1;
      while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++;
      if (j >= text.length || text[j] === '\n') return false;
    }
  }
  return true;
}

// Parse an inline link destination/title starting at s[i] (just after ']').
// Returns {dest, title, end} or null. dest/title are raw (unescaped) strings.
function parseInlineLink(s, i) {
  const n = s.length;
  if (s[i] !== '(') return null;
  let j = i + 1;
  while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
  if (j >= n) return null;
  let dest = '';
  if (s[j] === '<') {
    j++;
    const start = j;
    while (j < n && s[j] !== '>' && s[j] !== '\n') {
      if (s[j] === '\\' && j + 1 < n && PUNCT_SET.has(s[j + 1])) j += 2;
      else if (s[j] === '<') return null;
      else j++;
    }
    if (j >= n || s[j] !== '>') return null;
    dest = s.slice(start, j);
    j++;
  } else {
    let depth = 0;
    const start = j;
    while (j < n) {
      const c = s[j];
      if (c === ' ' || c === '\t' || c === '\n' || c < ' ') break;
      if (c === '\\' && j + 1 < n && PUNCT_SET.has(s[j + 1])) { j += 2; continue; }
      if (c === '(') { depth++; j++; continue; }
      if (c === ')') {
        if (depth === 0) break;
        depth--; j++; continue;
      }
      j++;
    }
    dest = s.slice(start, j);
  }
  dest = dest.replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
  let title = null;
  let k = j;
  while (k < n && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++;
  if (k < n && (s[k] === '"' || s[k] === "'" || s[k] === '(')) {
    const q = s[k];
    const closeQ = q === '(' ? ')' : q;
    let m = k + 1;
    const tstart = m;
    let ok = false;
    while (m < n) {
      if (s[m] === '\\' && m + 1 < n && PUNCT_SET.has(s[m + 1])) { m += 2; continue; }
      if (s[m] === closeQ) { ok = true; break; }
      if (q === '(' && (s[m] === '(' || s[m] === ')')) break;
      m++;
    }
    if (!ok) return null;
    title = s.slice(tstart, m).replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
    k = m + 1;
    while (k < n && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++;
  }
  if (k >= n || s[k] !== ')') return null;
  return { dest, title, end: k + 1 };
}

// Parse a reference label starting at s[i] == '['. Returns {label, end} or null.
function parseRefLabel(s, i) {
  const n = s.length;
  if (s[i] !== '[') return null;
  let depth = 0, j = i + 1;
  while (j < n) {
    const c = s[j];
    if (c === '\\' && j + 1 < n && PUNCT_SET.has(s[j + 1])) { j += 2; continue; }
    if (c === '[') { depth++; j++; continue; }
    if (c === ']') {
      if (depth === 0) return { label: s.slice(i + 1, j), end: j + 1 };
      depth--; j++; continue;
    }
    j++;
  }
  return null;
}

// Does an inline link (or image) form at s[p] === '['? The label must be
// valid per marked's pattern and the (dest) must parse.
function linkWillFormAt(s, p) {
  const afterLabel = matchBracketGroup(s, p, true);
  if (afterLabel === -1) return false;
  const label = s.slice(p + 1, afterLabel - 1);
  if (!labelTextValid(label)) return false;
  return parseInlineLink(s, afterLabel) !== null;
}

// Does the span s[start..end) contain a [ that forms a link?
function labelContainsLink(s, start, end, refs) {
  for (let p = start; p < end; p++) {
    if (s[p] === '[' && (linkWillFormAt(s, p) || (refs && bracketFormsRefLink(s, p, refs)))) return true;
    if (s[p] === '\\') p++;
  }
  return false;
}

// Does the bracket at [ position p form a (full/collapsed/shortcut)
// reference link? (Inline links are covered by linkWillFormAt.)
function bracketFormsRefLink(s, p, refs) {
  const afterLabel = matchBracketGroup(s, p, true);
  if (afterLabel === -1) return false;
  const label = s.slice(p + 1, afterLabel - 1);
  if (!labelTextValid(label)) return false;
  const rl = parseRefLabel(s, afterLabel);
  if (rl && rl.label !== '' && shortcutLabelValid(rl.label)) {
    if (refs.get(normalizeLabel(rl.label))) return true;
  }
  if (rl && rl.label === '' && shortcutLabelValid(label)) {
    if (refs.get(normalizeLabel(label))) return true;
  }
  if (shortcutLabelValid(label)) {
    if (refs.get(normalizeLabel(label))) return true;
  }
  return false;
}

// Does the ] at closePos close a bracket that will actually form a link?
// A bracket whose label holds a forming link does NOT form (marked's
// linkEmitted rule), so its ] is literal.
function closeBracketFormsLink(s, closePos, refs) {
  let depth = 0, j = closePos - 1;
  while (j >= 0) {
    const c = s[j];
    if (c === '\\') { j -= 2; continue; }
    if (c === ']') { depth++; j--; continue; }
    if (c === '[') {
      if (depth === 0) break;
      depth--; j--; continue;
    }
    j--;
  }
  if (j < 0 || s[j] !== '[') return false;
  if (!bracketVisibleInMask(s, j, refs)) return false;
  const formsInline = linkWillFormAt(s, j);
  const formsRef = refs ? bracketFormsRefLink(s, j, refs) : false;
  if (!formsInline && !formsRef) return false;
  return !labelContainsLink(s, j + 1, closePos, refs);
}

// ------------------------------------------------------------------ raw HTML tags

// Match a raw HTML tag / comment / PI / declaration / CDATA at pos i.
// Returns the end index (exclusive) or -1.
function matchHtmlTag(s, i) {
  const n = s.length;
  if (s[i] !== '<') return -1;
  if (s.startsWith('<!--', i)) {
    if (s[i + 4] === '>') return i + 5;
    if (s[i + 4] === '-' && s[i + 5] === '>') return i + 6;
    const e = s.indexOf('-->', i + 4);
    return e === -1 ? -1 : e + 3;
  }
  if (s.startsWith('<?', i)) {
    const e = s.indexOf('?>', i + 2);
    return e === -1 ? -1 : e + 2;
  }
  if (s.startsWith('<!', i)) {
    const c = s[i + 2];
    if (c === undefined) return -1;
    if (c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z') {
      const e = s.indexOf('>', i + 2);
      return e === -1 ? -1 : e + 1;
    }
    if (s.startsWith('<![CDATA[', i)) {
      const e = s.indexOf(']]>', i + 9);
      return e === -1 ? -1 : e + 3;
    }
    return -1;
  }
  let j = i + 1;
  let closing = false;
  if (s[j] === '/') { closing = true; j++; }
  if (j >= n) return -1;
  const c0 = s.charCodeAt(j);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return -1;
  while (j < n) {
    const code = s.charCodeAt(j);
    if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 45) j++;
    else break;
  }
  if (closing) {
    while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
    return (j < n && s[j] === '>') ? j + 1 : -1;
  }
  while (true) {
    let sawWS = false;
    while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) { j++; sawWS = true; }
    if (j >= n) return -1;
    if (s[j] === '>') return j + 1;
    if (s[j] === '/' && s[j + 1] === '>') return j + 2;
    if (!sawWS) return -1;
    const ac = s.charCodeAt(j);
    if (!((ac >= 65 && ac <= 90) || (ac >= 97 && ac <= 122) || ac === 95 || ac === 58)) return -1;
    while (j < n) {
      const code = s.charCodeAt(j);
      if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 95 || code === 46 || code === 58 || code === 45) j++;
      else break;
    }
    let k = j;
    while (k < n && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++;
    if (s[k] === '=') {
      j = k + 1;
      while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
      if (j >= n) return -1;
      const q = s[j];
      if (q === '"' || q === "'") {
        j++;
        while (j < n && s[j] !== q) j++;
        if (j >= n) return -1;
        j++;
      } else {
        if (j >= n) return -1;
        if (isWS(s[j]) || s[j] === '"' || s[j] === "'" || s[j] === '=' || s[j] === '<' || s[j] === '`' || s[j] === '>') return -1;
        while (j < n && !isWS(s[j]) && s[j] !== '"' && s[j] !== "'" && s[j] !== '=' && s[j] !== '<' && s[j] !== '`' && s[j] !== '>') j++;
      }
    }
  }
}

// ------------------------------------------------------------------ GFM autolinks

// Punctuation that marked's extended-URL backpedal drops when trailing.
const TRIM_PUNCT_T = new Uint8Array(128);
for (const ch of '?!.,:;*\'"_~)') TRIM_PUNCT_T[ch.charCodeAt(0)] = 1;

// The longest prefix of u that is a valid bare URL: good runs, balanced
// (...) groups, & not starting a trailing entity, and punctuation runs
// that do not reach the very end. (Manual equivalent of marked's
// backpedal regex, iterated to a fixed point.)
function trimExtendedUrl(u) {
  const n = u.length;
  let i = 0;
  while (i < n) {
    const code = u.charCodeAt(i);
    const c = u[i];
    if (c === '(') {
      const close = u.indexOf(')', i + 1);
      if (close === -1) break;
      i = close + 1;
    } else if (c === '&') {
      let j = i + 1;
      while (j < n && ALNUM_T[u.charCodeAt(j)] === 1) j++;
      if (j > i + 1 && j < n && u[j] === ';' && j === n - 1) break;
      i++;
    } else if (code < 128 && TRIM_PUNCT_T[code] === 1) {
      let j = i;
      while (j < n && u.charCodeAt(j) < 128 && TRIM_PUNCT_T[u.charCodeAt(j)] === 1) j++;
      if (j === n) break;
      i = j;
    } else {
      i++;
    }
  }
  return u.slice(0, i);
}

// Greedy URL run for bare autolinks: chars except whitespace and <; a (
// is included only if a ) occurs later in the same run. When stopAtBracket
// is set, a [ ends the run and a ] ends it only if it closes a bracket
// that will actually form a link.
function greedyUrl(s, i, stopAtBracket, refs) {
  const n = s.length;
  let j = i;
  while (j < n) {
    const c = s[j];
    if (c === ' ' || c === '\t' || c === '\n' || c === '<') break;
    if (stopAtBracket && c === '[') break;
    if (stopAtBracket && c === ']' && closeBracketFormsLink(s, j, refs)) break;
    if (c === '(') {
      let k = j + 1, ok = false;
      while (k < n) {
        const d = s[k];
        if (d === ' ' || d === '\t' || d === '\n' || d === '<') break;
        if (d === ')') { ok = true; break; }
        k++;
      }
      if (!ok) break;
    }
    j++;
  }
  return j;
}

// The ) position closing a link destination that urlPos sits inside, or -1.
// Marked's link tokenizer consumes [...](dest) before the URL tokenizer
// runs, so a bare autolink inside a dest must not reach past the dest's
// closing ). The autolink is capped at the ), not suppressed.
function linkDestCloseParen(s, urlPos, refs) {
  let i = urlPos - 1;
  while (i >= 0 && s[i] !== ' ' && s[i] !== '\t' && s[i] !== '\n' && s[i] !== '(' && s[i] !== ')' && s[i] !== '[' && s[i] !== ']') i--;
  while (i >= 0 && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n')) i--;
  if (i >= 0 && s[i] === '<') { i--; while (i >= 0 && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n')) i--; }
  if (i < 0 || s[i] !== '(') return -1;
  if (i - 1 < 0 || s[i - 1] !== ']') return -1;
  let depth = 0, j = i - 2;
  while (j >= 0) {
    const c = s[j];
    if (c === '\\') { j -= 2; continue; }
    if (c === ']') { depth++; j--; continue; }
    if (c === '[') {
      if (depth === 0) break;
      depth--; j--; continue;
    }
    j--;
  }
  if (j < 0 || s[j] !== '[') return -1;
  if (!bracketVisibleInMask(s, j, refs)) return -1;
  const afterLabel = matchBracketGroup(s, j, true);
  if (afterLabel === -1) return -1;
  const label = s.slice(j + 1, afterLabel - 1);
  if (!labelTextValid(label)) return -1;
  if (labelContainsLink(s, j + 1, afterLabel - 1, refs)) return -1;
  const il = parseInlineLink(s, afterLabel);
  if (!il) return -1;
  return il.end - 1;
}

// ------------------------------------------------------------------ masking
// marked's emStrong scan runs over a masked copy of the inline text in
// which code spans, link spans and HTML tags are hidden, so delimiters
// inside them cannot close emphasis. All replacements are
// length-preserving, so masked[i] lines up with s[i].

// Find the closing backtick run for an opener run of length `run` whose
// content starts at openEnd. Returns the closing run's start, or -1.
// The content may hold shorter backtick runs; the first run of exactly
// `run` backticks closes it.
function findCodeClose(s, openEnd, run) {
  const n = s.length;
  let k = openEnd;
  while (k < n) {
    if (s[k] === '`') {
      let m = k;
      while (m < n && s[m] === '`') m++;
      if (m - k === run) return k;
      k = m;
    } else k++;
  }
  return -1;
}

// Mask pass 1 (anyPunctuationOutsideCode): matched code spans keep their
// fences and have inner backticks replaced by '+'; backslash-escaped
// punctuation becomes '++'; unmatched backtick runs are left alone.
// Positions are found with a regex scan (C++), not a per-char JS loop.
const NEXT_ANY_RE = /[`\\]/g;
function maskAnyPunct(t) {
  const n = t.length;
  let out = '';
  let i = 0, last = 0;
  NEXT_ANY_RE.lastIndex = 0;
  while (i < n) {
    NEXT_ANY_RE.lastIndex = i;
    const m = NEXT_ANY_RE.exec(t);
    if (!m) break;
    const j = m.index;
    if (t[j] === '`') {
      let k = j;
      while (k < n && t[k] === '`') k++;
      const run = k - j;
      const close = findCodeClose(t, k, run);
      if (close !== -1) {
        out += t.slice(last, j);
        let inner = t.slice(k, close);
        if (inner.indexOf('`') !== -1) inner = inner.replace(/`/g, '+');
        out += t.slice(j, k) + inner + t.slice(close, close + run);
        i = close + run; last = i;
        continue;
      }
      i = k; continue;
    }
    if (j + 1 < n && isPunct(t[j + 1])) {
      out += t.slice(last, j);
      out += '++';
      i = j + 2; last = i; continue;
    }
    i = j + 1;
  }
  out += t.slice(last);
  return out;
}

// Try to match a [...](...) span starting at t[i] === '['. Returns the
// end index (exclusive) or -1. The label is a run of non-bracket chars
// and code-span-like units; the destination allows one level of parens.
function matchLinkSpan(t, i) {
  const n = t.length;
  let j = i + 1;
  while (j < n) {
    const c = t[j];
    if (c === ']') {
      if (t[j + 1] !== '(') return -1;
      return matchLinkDest(t, j + 2);
    }
    if (c === '[') return -1;
    if (c === '`') {
      let k = j;
      while (k < n && t[k] === '`') k++;
      const run = k - j;
      if (k >= n) return -1;
      let q = k;
      while (q < n && t[q] !== '`') q++;
      if (q >= n) return -1;
      let m = q;
      while (m < n && t[m] === '`') m++;
      if (m - q !== run) return -1;
      j = m;
      continue;
    }
    j++;
  }
  return -1;
}

// Parse a link destination starting just after '('. Returns the index
// just past the closing ')', or -1.
function matchLinkDest(t, i) {
  const n = t.length;
  let j = i;
  while (j < n) {
    const c = t[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '(') {
      let k = j + 1, ok = false;
      while (k < n) {
        const d = t[k];
        if (d === '\\') { k += 2; continue; }
        if (d === '(') break;
        if (d === ')') { ok = true; break; }
        k++;
      }
      if (!ok) return -1;
      j = k + 1;
      continue;
    }
    if (c === ')') return j + 1;
    j++;
  }
  return -1;
}

// Mask pass 2 (blockSkip): [...](...) spans, code spans and <...> tags
// become [aaa...], except a [...] span that will form a link — its text
// is re-lexed on its own in marked, so emphasis inside it resolves
// normally. Positions are found with a regex scan (C++).
const NEXT_SKIP_RE = /[[`<]/g;
function maskBlockSkip(t, s) {
  const n = t.length;
  let out = '';
  let last = 0;
  let i = 0;
  NEXT_SKIP_RE.lastIndex = 0;
  while (i < n) {
    NEXT_SKIP_RE.lastIndex = i;
    const m = NEXT_SKIP_RE.exec(t);
    if (!m) break;
    const j = m.index;
    const c = t[j];
    if (c === '[') {
      const end = matchLinkSpan(t, j);
      if (end !== -1) {
        out += t.slice(last, j);
        if (linkWillFormAt(s, j)) out += t.slice(j, end);
        else out += '[' + 'a'.repeat(Math.max(0, end - j - 2)) + ']';
        last = end; i = end; continue;
      }
      i = j + 1; continue;
    }
    if (c === '`' && (j === 0 || t[j - 1] !== '`')) {
      let k = j;
      while (k < n && t[k] === '`') k++;
      const run = k - j;
      const close = findCodeClose(t, k, run);
      if (close !== -1) {
        const end = close + run;
        out += t.slice(last, j);
        out += '[' + 'a'.repeat(Math.max(0, end - j - 2)) + ']';
        last = end; i = end; continue;
      }
      i = k; continue;
    }
    if (c === '<' && t[j + 1] !== ' ') {
      let k = j + 1;
      while (k < n && t[k] !== '>' && t[k] !== '<') k++;
      if (k < n && t[k] === '>') {
        const end = k + 1;
        out += t.slice(last, j);
        out += '[' + 'a'.repeat(Math.max(0, end - j - 2)) + ']';
        last = end; i = end; continue;
      }
      i = j + 1; continue;
    }
    i = j + 1;
  }
  out += t.slice(last);
  return out;
}

// Mask pass 0 (reflinkSearch): a defined reference link whose span holds
// a backtick is masked before the other passes, so its contents cannot
// start a code span that swallows later emphasis. A span whose label
// itself contains a link is left unmasked. Positions are found with a
// regex scan (C++).
const NEXT_REFLINK_RE = /[![]/g;
function maskReflinks(s, refs) {
  if (!refs || refs.size === 0 || !s.includes('[') || !s.includes('`')) return s;
  let out = '', i = 0;
  const n = s.length;
  NEXT_REFLINK_RE.lastIndex = 0;
  while (i < n) {
    NEXT_REFLINK_RE.lastIndex = i;
    const m = NEXT_REFLINK_RE.exec(s);
    if (!m) break;
    const j = m.index;
    out += s.slice(i, j);
    i = j;
    let start = i;
    if (s[i] === '!' && i + 1 < n && s[i + 1] === '[') i++;
    if (s[i] === '[') {
      const p = i;
      const afterLabel = matchBracketGroup(s, p, true);
      if (afterLabel !== -1) {
        const label = s.slice(p + 1, afterLabel - 1);
        // Check the reference exists first: the label scans below are
        // the expensive part, and most brackets are not defined refs.
        const rl = parseRefLabel(s, afterLabel);
        let end = -1;
        if (rl && rl.label !== '' && shortcutLabelValid(rl.label) && refs.has(normalizeLabel(rl.label))) end = rl.end;
        else if (rl && rl.label === '' && shortcutLabelValid(label) && refs.has(normalizeLabel(label))) end = rl.end;
        else if (shortcutLabelValid(label) && refs.has(normalizeLabel(label)) && s[afterLabel] !== '(') end = afterLabel;
        if (end !== -1 && labelTextValid(label) && !labelContainsLink(s, p + 1, afterLabel - 1, refs) && s.slice(start, end).includes('`')) {
            const span = s.slice(start, end);
            let masked = '';
            for (let q = 0; q < span.length; q++) {
              const ch = span[q];
              masked += (ch === '*' || ch === '_' || ch === '~') ? ch : 'a';
            }
            out += '[' + masked.slice(1, -1) + ']';
            i = end;
            continue;
          }
      }
      out += s.slice(start, p + 1);
      i = p + 1;
      continue;
    }
    out += s[i];
    i++;
  }
  out += s.slice(i);
  return out;
}

// Version counter for the refs map: bumped whenever a definition is
// added, so the masked-text cache below never serves a stale entry.
let _refsVer = 0;
let _maskS = null, _maskR = null, _maskV = -1, _maskT = null;
function maskedTextFor(s, refs) {
  if (s !== _maskS || refs !== _maskR || _refsVer !== _maskV) {
    _maskS = s; _maskR = refs; _maskV = _refsVer; _maskT = computeMaskedText(s, refs);
  }
  return _maskT;
}
function computeMaskedText(s, refs) {
  if (!s.includes('`') && !s.includes('[') && !s.includes('<') && !s.includes('\\')) return s;
  let t = maskReflinks(s, refs);
  t = maskAnyPunct(t);
  t = maskBlockSkip(t, s);
  return t;
}
// Is the [ at position j visible (not swallowed by a masked span)?
function bracketVisibleInMask(s, j, refs) {
  return maskedTextFor(s, refs)[j] === '[';
}

// ------------------------------------------------------------------ inline tokenizer

// marked's Lexer keeps inLink state across the whole document: an inline
// <a ...> tag sets it, </a> clears it, and bare GFM autolinks are
// suppressed while it is set. An unclosed <a> in one paragraph therefore
// suppresses bare autolinks in later paragraphs; angle-bracket autolinks
// are not gated. Reset per parse() call.
let _inLink = false;

// Extra char table for angle-bracket email local parts.
const ANGLE_LOCAL_T = new Uint8Array(128);
for (let c = 0; c < 128; c++) if (ALNUM_T[c]) ANGLE_LOCAL_T[c] = 1;
for (const ch of ".!#$%&'*+/=?^_`{|}~-") ANGLE_LOCAL_T[ch.charCodeAt(0)] = 1;

// Try an angle-bracket autolink <scheme:...> or <email> at s[i] === '<'.
// Bounded to 200 chars, like marked's slice. Returns {raw, end, email}
// or null.
function angleAutolink(s, i) {
  const n = Math.min(s.length, i + 200);
  let j = i + 1;
  if (j >= n) return null;
  const c0 = s.charCodeAt(j);
  if ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)) {
    // scheme: <letter [A-Za-z0-9+.-]{1,31} : [^<>\s]* >
    j++;
    let count = 1;
    while (j < n && count < 32) {
      const code = s.charCodeAt(j);
      if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 43 || code === 46 || code === 45) { j++; count++; }
      else break;
    }
    if (count >= 2 && j < n && s[j] === ':') {
      j++;
      let k = j;
      while (k < n && s[k] !== '>' && s[k] !== '<' && !isWS(s[k])) k++;
      if (k < n && s[k] === '>') return { raw: s.slice(i + 1, k), end: k + 1, email: false };
    }
  }
  // email: local@domain(.domain)+
  j = i + 1;
  const localStart = j;
  while (j < n && ANGLE_LOCAL_T[s.charCodeAt(j)] === 1) j++;
  if (j === localStart || j >= n || s[j] !== '@') return null;
  j++;
  let labels = 0;
  while (true) {
    if (j >= n) return null;
    const dc = s.charCodeAt(j);
    if (!((dc >= 65 && dc <= 90) || (dc >= 97 && dc <= 122) || (dc >= 48 && dc <= 57))) return null;
    j++;
    while (j < n && (ALNUM_T[s.charCodeAt(j)] === 1 || s[j] === '-')) j++;
    if (s[j - 1] === '-') return null;
    labels++;
    if (j < n && s[j] === '.') { j++; continue; }
    break;
  }
  if (labels < 2) return null;
  if (j >= n || s[j] !== '>') return null;
  return { raw: s.slice(i + 1, j), end: j + 1, email: true };
}

// Greedy match end for a bare email starting at s[i] (a word char):
// local@label(.label)*.label, the last label ending in an alnum char.
// Returns the end index (exclusive) or -1. Bounded to 300 chars.
function bareEmailMatchEnd(s, i) {
  const n = Math.min(s.length, i + 300);
  let j = i;
  while (j < n && EMAIL_LOCAL_T[s.charCodeAt(j)] === 1) j++;
  if (j === i || j >= n || s[j] !== '@') return -1;
  j++;
  let labels = 0;
  let matchEnd = -1;
  while (true) {
    const start = j;
    while (j < n && EMAIL_DOMAIN_T[s.charCodeAt(j)] === 1) j++;
    if (j === start) return matchEnd; // empty label: the sequence ends here
    labels++;
    if (labels >= 2) {
      // this label may be the final one: it must end with an alnum char
      let end = j;
      while (end > start && ALNUM_T[s.charCodeAt(end - 1)] !== 1) end--;
      if (end > start) matchEnd = end;
      // a label with no alnum at all can only be intermediate: keep the
      // earlier matchEnd and carry on scanning
    }
    if (j < n && s[j] === '.') { j++; continue; }
    break;
  }
  return matchEnd;
}

// Scan inline text into a node list. refs: Map of normalized label ->
// {dest, title}. Node types: text, code, delim, open, close, html,
// autolink, br.
function tokenizeInline(s, refs) {
  const n = s.length;
  const nodes = [];
  let i = 0;
  let textStart = 0;
  // positions of unclosed [ / ![ openers (the value is the [ or ! pos)
  const openStack = [];
  // a bare-email scan needs an @ within 200 chars; most paragraphs have
  // none, so check once instead of indexOf-ing from every word start
  const hasAt = s.indexOf('@') !== -1;
  const flushText = (end) => {
    if (end > textStart) nodes.push({ t: 'text', s: s.slice(textStart, end), pos: textStart, end });
  };
  // is position p preceded by an odd run of backslashes?
  const isEscaped = (p) => {
    let b = 0;
    for (let q = p - 1; q >= 0 && s[q] === '\\'; q--) b++;
    return b % 2 === 1;
  };
  // Try a bare-email autolink starting at the current i (a word char).
  // Returns true when one formed (i advanced past it).
  const emailAt = () => {
    const prevIsWord = i > 0 && s.charCodeAt(i - 1) < 128 && EMAIL_LOCAL_T[s.charCodeAt(i - 1)] === 1 && !(s[i - 1] === '_' && i >= 2 && s[i - 2] === '_');
    if (prevIsWord) return false;
    const atIdx = s.indexOf('@', i);
    if (atIdx === -1 || atIdx - i >= 200) return false;
    const mEnd = bareEmailMatchEnd(s, i);
    if (mEnd === -1) return false;
    let email = s.slice(i, mEnd);
    let valid = true;
    const trailingUnderscoreCloses = () => {
      for (let k = nodes.length - 1; k >= 0; k--) {
        const nd = nodes[k];
        if (nd.t === 'delim' && nd.ch === '_') return nd.canOpen === true;
      }
      return false;
    };
    while (true) {
      const after = s[i + email.length];
      if (after === undefined || after === '' || !(after.charCodeAt(0) < 128 && EMAIL_DOMAIN_T[after.charCodeAt(0)] === 1)) break;
      if (after === '_' && trailingUnderscoreCloses()) break;
      const cut = email.lastIndexOf('.');
      const at = email.indexOf('@');
      if (cut <= at) { valid = false; break; }
      email = email.slice(0, cut);
    }
    if (!valid || email.indexOf('.', email.indexOf('@')) === -1) return false;
    let start = i, prefix = '';
    if (i >= 7 && s.slice(i - 7, i) === 'mailto:') { start = i - 7; prefix = 'mailto:'; }
    else if (i >= 5 && s.slice(i - 5, i) === 'xmpp:') { start = i - 5; prefix = 'xmpp:'; }
    let url = email, adv = email.length;
    if (prefix === 'xmpp:') {
      const pathStart = i + email.length;
      if (s[pathStart] === '/') {
        let pe = pathStart + 1;
        while (pe < n && (ALNUM_T[s.charCodeAt(pe)] === 1 || s[pe] === '_' || s[pe] === '@' || s[pe] === '.' || s[pe] === '-')) pe++;
        if (pe > pathStart + 1) { url += s.slice(pathStart, pe); adv += pe - pathStart; }
      }
    }
    flushText(start);
    nodes.push({ t: 'autolink', url: prefix ? prefix + url : 'mailto:' + url, text: prefix + url, pos: start, end: i + adv });
    i += adv; textStart = i;
    return true;
  };
  // Dispatch on the character code: one table lookup instead of a long
  // chain of string comparisons per character.
  while (i < n) {
    const code = s.charCodeAt(i);
    switch (code) {
      case 92: { // backslash: only ASCII punctuation can be escaped
        const d = s[i + 1];
        if (d === '\n') { flushText(i); nodes.push({ t: 'br', pos: i, end: i + 2 }); i += 2; while (i < n && (s[i] === ' ' || s[i] === '\t')) i++; textStart = i; continue; }
        if (d !== undefined && d.charCodeAt(0) < 128 && PUNCT_T[d.charCodeAt(0)] === 1) { flushText(i); nodes.push({ t: 'text', s: d, pos: i, end: i + 2 }); i += 2; textStart = i; continue; }
        i++;
        continue;
      }
      case 96: { // code span
        let j = i;
        while (j < n && s[j] === '`') j++;
        const run = j - i;
        // The scan must not cross a ] that closes a bracket opened
        // BEFORE the code span when a link would form there (marked's
        // link regex claims that ] first). A ] closing a bracket
        // opened inside the prospective code span does not block it.
        // Backslashes are literal inside a code span: only \[ / \]
        // count as escaped brackets.
        let k = j, found = -1, fend = -1, aborted = false;
        const baseDepth = openStack.length;
        const scanStack = openStack.slice();
        let preScan = baseDepth;
        while (k < n) {
          if (s[k] === '`') {
            let m = k;
            while (m < n && s[m] === '`') m++;
            if (m - k === run) { found = k; fend = m; break; }
            k = m;
          } else if (s[k] === '[' && !isEscaped(k)) {
            scanStack.push(k);
            k++;
          } else if (s[k] === ']' && !isEscaped(k)) {
            if (scanStack.length > preScan) {
              scanStack.pop();
              k++;
            } else if (preScan > 0) {
              const openerPos = scanStack[scanStack.length - 1];
              const openerEnd = openerPos + (s[openerPos] === '!' ? 2 : 1);
              const label = s.slice(openerEnd, k);
              let forms = false;
              if (labelTextValid(label)) {
                const after = k + 1;
                if (parseInlineLink(s, after)) forms = true;
                else {
                  const rl = parseRefLabel(s, after);
                  if (rl && rl.label !== '' && shortcutLabelValid(rl.label)) {
                    if (refs.get(normalizeLabel(rl.label))) forms = true;
                  } else if (rl && rl.label === '' && shortcutLabelValid(label)) {
                    if (refs.get(normalizeLabel(label))) forms = true;
                  } else if (!rl && shortcutLabelValid(label)) {
                    if (refs.get(normalizeLabel(label))) forms = true;
                  }
                }
              }
              if (forms) { aborted = true; break; }
              scanStack.pop(); preScan--;
              k++;
            } else k++;
          } else k++;
        }
        if (aborted) { i = j; continue; }
        if (found !== -1) {
          flushText(i);
          let content = s.slice(j, found);
          content = content.replace(/\n/g, ' ');
          if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
            content = content.slice(1, -1);
          }
          nodes.push({ t: 'code', s: content, pos: i, end: fend });
          i = fend; textStart = i; continue;
        }
        i = j; continue;
      }
      case 42: case 95: case 126: { // * _ ~ emphasis / strikethrough
        const c = code === 42 ? '*' : code === 95 ? '_' : '~';
        let j = i;
        while (j < n && s[j] === c) j++;
        let len = j - i;
        if (c === '~' && len >= 3) { i = j; continue; }
        const before = i > 0 ? s[i - 1] : undefined;
        const after = j < n ? s[j] : undefined;
        const beforeWS = i === 0 || isWS(before);
        const afterWS = j >= n || isWS(after);
        const beforeP = isPunct(before);
        const afterP = isPunct(after);
        const leftFlank = !afterWS && (!afterP || beforeWS || beforeP);
        const rightFlank = !beforeWS && (!beforeP || afterWS || afterP);
        let canOpen, canClose;
        if (c === '_') {
          canOpen = leftFlank && (!rightFlank || beforeP);
          canClose = rightFlank && (!leftFlank || afterP);
        } else {
          canOpen = leftFlank;
          canClose = rightFlank;
        }
        if (c === '~' && len > 2) len = 2;
        if (canOpen || canClose) {
          flushText(i);
          nodes.push({ t: 'delim', ch: c, len, canOpen, canClose, active: true, used: 0, pos: i, end: j });
          i = j; textStart = i; continue;
        }
        i = j; continue;
      }
      case 91: { // [ bracket
        flushText(i);
        nodes.push({ t: 'open', image: false, active: true, pos: i, end: i + 1 });
        openStack.push(i);
        i++; textStart = i; continue;
      }
      case 33: { // ! (only special as ![)
        if (s[i + 1] === '[') {
          flushText(i);
          nodes.push({ t: 'open', image: true, active: true, pos: i, end: i + 2 });
          openStack.push(i);
          i += 2; textStart = i; continue;
        }
        i++;
        continue;
      }
      case 93: { // ] close bracket
        flushText(i);
        nodes.push({ t: 'close', pos: i, end: i + 1 });
        if (openStack.length) openStack.pop();
        i++; textStart = i; continue;
      }
      case 60: { // < raw html / autolink
        const e = matchHtmlTag(s, i);
        if (e !== -1) {
          flushText(i);
          const tag = s.slice(i, e);
          if (/^<a /i.test(tag)) _inLink = true;
          else if (/^<\/a>/i.test(tag)) _inLink = false;
          nodes.push({ t: 'html', s: tag, pos: i, end: e }); i = e; textStart = i; continue;
        }
        const al = angleAutolink(s, i);
        if (al) {
          flushText(i);
          const raw = al.raw;
          const url = (al.email && !raw.includes(':')) ? 'mailto:' + raw : raw;
          nodes.push({ t: 'autolink', url, text: raw, angle: true, pos: i, end: al.end });
          i = al.end; textStart = i; continue;
        }
        i++;
        continue;
      }
      case 32: { // space: hard break is 2+ spaces + newline
        let j = i;
        while (s[j] === ' ') j++;
        if (j - i >= 2 && s[j] === '\n') { flushText(i); nodes.push({ t: 'br', pos: i, end: j + 1 }); i = j + 1; while (i < n && (s[i] === ' ' || s[i] === '\t')) i++; textStart = i; continue; }
        i++;
        continue;
      }
      case 119: { // w — www. autolink
        if (!_inLink && s.startsWith('www.', i)) {
          const prev = i > 0 ? s[i - 1] : undefined;
          const okPrev = prev === undefined || isWS(prev) || prev === '(' || prev === '*' || prev === '_' || prev === '~';
          if (okPrev) {
            const end = greedyUrl(s, i, openStack.length > 0, refs);
            if (end > i + 4) {
              const first = s.slice(i + 4, end);
              if (first.length > 0 && (ALNUM_T[first.charCodeAt(0)] === 1 || first[0] === '-')) {
                let u = trimExtendedUrl(s.slice(i, end));
                const dc = linkDestCloseParen(s, i, refs);
                if (dc !== -1 && i + u.length > dc) u = s.slice(i, dc);
                if (u.length > 4) { flushText(i); nodes.push({ t: 'autolink', url: 'http://' + u, text: u, pos: i, end: i + u.length }); i += u.length; textStart = i; continue; }
              }
            }
          }
        }
        if (!_inLink && hasAt && EMAIL_LOCAL_T[code] === 1 && emailAt()) continue;
        i++;
        continue;
      }
      case 104: case 72: case 102: case 70: { // h H f F — scheme autolink
        if (!_inLink) {
          const l0 = code | 32;
          let prefixLen = 0;
          if (l0 === 104) { // h
            if ((s.charCodeAt(i + 1) | 32) === 116 && (s.charCodeAt(i + 2) | 32) === 116 && (s.charCodeAt(i + 3) | 32) === 112) {
              if (s[i + 4] === ':' && s[i + 5] === '/' && s[i + 6] === '/') prefixLen = 7;
              else if ((s.charCodeAt(i + 4) | 32) === 115 && s[i + 5] === ':' && s[i + 6] === '/' && s[i + 7] === '/') prefixLen = 8;
            }
          } else if (l0 === 102) { // f
            if ((s.charCodeAt(i + 1) | 32) === 116 && (s.charCodeAt(i + 2) | 32) === 112 && s[i + 3] === ':' && s[i + 4] === '/' && s[i + 5] === '/') prefixLen = 6;
          }
          if (prefixLen > 0) {
            const end = greedyUrl(s, i, openStack.length > 0, refs);
            const afterPrefix = s.slice(i + prefixLen, end);
            if (afterPrefix.length > 0 && (ALNUM_T[afterPrefix.charCodeAt(0)] === 1 || afterPrefix[0] === '-')) {
              let u = trimExtendedUrl(s.slice(i, end));
              const dc = linkDestCloseParen(s, i, refs);
              if (dc !== -1 && i + u.length > dc) u = s.slice(i, dc);
              if (u.length > prefixLen) { flushText(i); nodes.push({ t: 'autolink', url: u, text: u, pos: i, end: i + u.length }); i += u.length; textStart = i; continue; }
            }
          }
        }
        if (!_inLink && hasAt && EMAIL_LOCAL_T[code] === 1 && emailAt()) continue;
        i++;
        continue;
      }
      default: { // ordinary char: a bare email may start here
        if (!_inLink && hasAt && code < 128 && EMAIL_LOCAL_T[code] === 1 && emailAt()) continue;
        i++;
        continue;
      }
    }
  }
  flushText(n);
  return nodes;
}

// ------------------------------------------------------------------ inline tree

// Plain text of a node list (for image alt text and reference labels).
function plainTextOf(first, last) {
  let out = '';
  let cur = first;
  while (cur && cur !== last) {
    if (cur.t === 'text' || cur.t === 'code' || cur.t === 'html') out += cur.s;
    else if (cur.t === 'delim') out += cur.ch.repeat(cur.numDelims);
    else if (cur.t === 'open') out += cur.image ? '![' : '[';
    else if (cur.t === 'close') out += ']';
    else if (cur.t === 'autolink') out += cur.text;
    else if (cur.t === 'br') { /* contributes nothing */ }
    else if (cur.t === 'image') out += cur.alt;
    else if (cur.t === 'link' || cur.t === 'em' || cur.t === 'strong' || cur.t === 'del') {
      out += plainTextOf(cur.childHead, null);
    }
    cur = cur.next;
  }
  return out;
}

// Remove a node from the top-level linked list.
function unlink(node) {
  if (node.prev) node.prev.next = node.next;
  if (node.next) node.next.prev = node.prev;
  node.next = node.prev = null;
  node.removed = true;
}

// Autolinks do not form inside link text: a bare URL inside [...] is
// plain text (nested <a> is invalid). Convert bare autolink nodes to
// text nodes, recursing into emphasis/strong/del/link children.
function stripAutolinks(first) {
  let cur = first;
  while (cur) {
    if (cur.t === 'autolink' && !cur.angle) {
      cur.t = 'text';
      cur.s = cur.text;
      cur.url = undefined;
    } else if (cur.childHead) {
      stripAutolinks(cur.childHead);
    }
    cur = cur.next;
  }
}

// Does bracket B (an open node) form a link? Find its closing ] by
// depth-counting from fromPos, then check for ( / [ / a defined shortcut
// ref. Returns the index of the closing ] or null.
function bracketWillLinkFrom(B, fromPos, s, refs) {
  let depth = 1, k = fromPos;
  while (k < s.length) {
    if (s[k] === '\\' && k + 1 < s.length) { k += 2; continue; }
    if (s[k] === '[') depth++;
    else if (s[k] === ']') { depth--; if (depth === 0) break; }
    k++;
  }
  if (depth !== 0) return null;
  const after = s[k + 1];
  if (after === '(' || after === '[') return k;
  const label = s.slice(B.end, k);
  if (refs.has(normalizeLabel(label))) return k;
  return null;
}

// marked's emStrong closer scan, over the delim nodes after opener op:
// a nested opener-like run raises the delimiter requirement (m), a
// both-flanking closer that violates the rule of 3 is skipped (f), and a
// closer must cover m. Returns {closer, use, tag, bPrime} for the first
// closer that covers m, or null. The scan is tried for every suffix of
// the opener run, so **foo* can still pair using the second *.
function scanStarOpener(op, s, refs, masked) {
  const len = op.rem !== undefined ? op.rem : op.numDelims;
  const before = op.pos > 0 ? s[op.pos - 1] : undefined;
  const afterOp = op.end < s.length ? s[op.end] : undefined;
  const pNonSpace = before !== undefined && !isWS(before);
  const h = before === '*' || before === '_' || isPunct(before);
  const d = isPunct(afterOp);
  const R = pNonSpace && (d || (op.ch === '*' && !h));
  // an opener inside a link's text cannot pair past that link's ]
  const bOpen = op.bOpen;
  let bOpenClose = -1;
  if (bOpen && bOpen.pos < op.pos) {
    const c = bracketWillLinkFrom(bOpen, op.pos, s, refs);
    if (c !== null) bOpenClose = c;
  }
  for (let offset = 0; offset < len; offset++) {
    const k = len - offset;
    const y = len;
    const o = offset > 0;
    let m = k, f = 0;
    let firstStar = true;
    for (let cur = op.next; cur; cur = cur.next) {
      if (cur.t !== 'delim' || cur.ch !== op.ch || cur.removed || cur.parent) continue;
      if (cur.numDelims <= 0) continue;
      if (bOpenClose !== -1 && cur.pos > bOpenClose) continue;
      if (masked && !delimVisibleInMaskNode(cur, masked)) continue;
      if (firstStar) {
        firstStar = false;
        if (hasDoubleUnderscoreAlone(s, op.end, cur.pos) && startsWithDoubleUnderscore(s, cur.end)) continue;
      }
      const b = cur.bOpen;
      if (b && b.pos > op.pos && bracketWillLinkFrom(b, cur.pos, s, refs) !== null) continue;
      const blen = cur.rem !== undefined ? cur.rem : cur.numDelims;
      if (blen <= 0) continue;
      if (cur.canOpen && !cur.canClose) { m += blen; continue; }
      if (cur.canOpen && cur.canClose) {
        if (o) break;
        if (y % 3 !== 0 && (y + blen) % 3 === 0) { f += blen; continue; }
      } else if (R) {
        if (y % 3 !== 0 && (y + blen) % 3 === 0) { f += blen; continue; }
      }
      m -= blen;
      if (m > 0) continue;
      const bPrime = Math.min(blen, blen + m + f);
      const use = (Math.min(k, bPrime) % 2 === 1) ? 1 : 2;
      return { closer: cur, use, tag: use === 2 ? 'strong' : 'em', bPrime };
    }
  }
  return null;
}

// A delim run is visible to the emStrong scan iff it is intact in the
// masked text (not swallowed by a masked link/code/html span). Checked
// char by char — no slice/repeat allocation per call.
function delimVisibleInMaskNode(node, masked) {
  const ch = node.ch;
  for (let p = node.pos; p < node.end; p++) {
    if (masked[p] !== ch) return false;
  }
  return true;
}

// Does s[start..end) match /^[^_*]*?__[^_*]*?$/ — i.e. it holds exactly
// one __ pair and no other * or _? (marked's closer-regex first
// alternative, used to skip a single * between a __ pair.)
function hasDoubleUnderscoreAlone(s, start, end) {
  let us = 0, usPos = -1;
  for (let p = start; p < end; p++) {
    const c = s[p];
    if (c === '*') return false;
    if (c === '_') {
      us++;
      if (us === 1) usPos = p;
      else if (us === 2 && p !== usPos + 1) return false;
      else if (us > 2) return false;
    }
  }
  return us === 2;
}

// Does s from `start` match /^[^_*]*?__/ — non-*_ chars then __?
function startsWithDoubleUnderscore(s, start) {
  for (let p = start; p < s.length; p++) {
    const c = s[p];
    if (c === '*') return false;
    if (c === '_') return s[p + 1] === '_';
  }
  return false;
}

// Pre-pass: for each * opener, record the pairing marked's closer scan
// finds (closer node, delims used, em/strong); an opener with no closer
// is dead. The stack resolver enforces these pairings: an opener
// reserved for another closer is skipped. If two openers claim the same
// closer, the earlier one wins and the later one is dead.
function markDeadStarOpeners(head, s, refs, masked) {
  for (let cur = head; cur; cur = cur.next) {
    if (cur.t === 'delim' && cur.ch === '*') cur.rem = cur.numDelims;
  }
  for (let cur = head; cur; cur = cur.next) {
    if (cur.t === 'delim' && cur.ch === '*' && cur.canOpen && cur.numDelims > 0) {
      const pair = scanStarOpener(cur, s, refs, masked);
      if (!pair) { cur.dead = true; continue; }
      cur.pairCloser = pair.closer;
      cur.pairUse = pair.use;
      cur.pairTag = pair.tag;
      cur.pairBPrime = pair.bPrime;
      pair.closer.pairOpener = cur;
      pair.closer.rem = Math.max(0, (pair.closer.rem !== undefined ? pair.closer.rem : pair.closer.numDelims) - pair.use);
    }
  }
}

// Build the inline tree from tokenized nodes. s = source string, refs = Map.
// Returns the head node of the top-level list.
function buildInlineTree(s, refs) {
  const nodes = tokenizeInline(s, refs);
  if (nodes.length === 0) return null;
  for (let i = 0; i < nodes.length; i++) {
    nodes[i].next = nodes[i + 1] || null;
    nodes[i].prev = nodes[i - 1] || null;
    nodes[i].parent = null;
    nodes[i].removed = false;
    if (nodes[i].t === 'delim') nodes[i].numDelims = nodes[i].len;
  }
  let head = nodes[0];
  // Innermost still-open bracket before each node, in one linear pass
  // (the old code re-walked from head for every opener and closer).
  {
    const stack = [];
    for (let cur = head; cur; cur = cur.next) {
      cur.bOpen = stack.length ? stack[stack.length - 1] : null;
      if (cur.t === 'open') stack.push(cur);
      else if (cur.t === 'close' && stack.length) stack.pop();
    }
  }
  // The masked text is only consulted for delimiter pairing, so a
  // paragraph with no delimiters never needs it (and the mask passes
  // are a noticeable share of the whole run).
  let hasDelim = false;
  for (let cur = head; cur; cur = cur.next) {
    if (cur.t === 'delim') { hasDelim = true; break; }
  }
  const masked = hasDelim ? maskedTextFor(s, refs) : null;
  if (hasDelim) markDeadStarOpeners(head, s, refs, masked);
  const delimStack = [];
  const bracketStack = [];
  let cur = head;
  while (cur) {
    const next = cur.next;
    if (cur.removed || cur.parent) { cur = next; continue; }
    if (cur.t === 'delim') {
      if (cur.canClose && cur.numDelims > 0 && delimVisibleInMaskNode(cur, masked)) {
        // innermost still-open bracket before this closer: openers at or
        // before it are outside the bracket pair and cannot match a
        // closer inside it — but ONLY if that bracket will actually
        // form a link; if it will not, the delimiters may still pair.
        // Every bracketStack entry precedes cur, so the innermost is
        // the last valid entry — no full scan needed.
        let bracketPos = -1, bracketNode = null;
        for (let bi = bracketStack.length - 1; bi >= 0; bi--) {
          const b = bracketStack[bi];
          if (!b.removed && !b.parent && b.active) { bracketPos = b.pos; bracketNode = b; break; }
        }
        let bracketWillLink = false;
        if (bracketNode) {
          let depth = 1, k = cur.pos;
          while (k < s.length) {
            if (s[k] === '\\' && k + 1 < s.length) { k += 2; continue; }
            if (s[k] === '[') depth++;
            else if (s[k] === ']') { depth--; if (depth === 0) break; }
            k++;
          }
          if (depth === 0) {
            const after = s[k + 1];
            if (after === '(' || after === '[') bracketWillLink = true;
            else {
              const label = s.slice(bracketNode.end, k);
              if (refs.has(normalizeLabel(label))) bracketWillLink = true;
            }
          }
        }
        if (!bracketWillLink) bracketPos = -1;
        while (cur.numDelims > 0 && !cur.removed) {
          let opener = null, oi = -1;
          for (let k = delimStack.length - 1; k >= 0; k--) {
            const o = delimStack[k];
            if (o.removed || o.parent || o.dead || o.numDelims <= 0 || !o.canOpen || o.ch !== cur.ch) continue;
            if (o.pos < bracketPos) continue;
            if (o.pairCloser && o.pairCloser !== cur) {
              if (!(o.pairCloser.pos > cur.pos && o.numDelims > o.pairUse)) continue;
            }
            if (((o.canOpen && o.canClose) || (cur.canOpen && cur.canClose)) &&
              (o.numDelims + cur.numDelims) % 3 === 0 &&
              (o.numDelims % 3 !== 0 || cur.numDelims % 3 !== 0)) continue;
            opener = o; oi = k; break;
          }
          if (!opener) break;
          const isDel = cur.ch === '~';
          // The recorded pairing only decides WHICH closer an opener
          // pairs with; the delims used and tag come from the stack's
          // default computation — marked's scan describes the outermost
          // token, while the stack pairs innermost first.
          const use = isDel ? Math.min(opener.numDelims, cur.numDelims)
            : (opener.numDelims >= 2 && cur.numDelims >= 2) ? 2 : 1;
          const tag = isDel ? 'del' : use === 2 ? 'strong' : 'em';
          const emNode = { t: tag, ch: cur.ch, pos: opener.pos, end: cur.end, next: null, prev: null, parent: null, removed: false, childHead: null };
          let childHead = opener.next, childTail = null;
          let c = opener.next;
          while (c && c !== cur) { childTail = c; c = c.next; }
          if (childHead && childHead !== cur) {
            emNode.childHead = childHead;
            if (childHead.prev) childHead.prev.next = null;
            childHead.prev = null;
            if (childTail) childTail.next = null;
            let cc = childHead;
            while (cc) { cc.parent = emNode; cc = cc.next; }
          }
          emNode.prev = opener;
          emNode.next = cur;
          opener.next = emNode;
          cur.prev = emNode;
          opener.numDelims -= use;
          // The recorded pairing's raw consumes bPrime delims of the
          // closer, and the bPrime-use excess stays inside the em/strong
          // text — minus the delims inner pairings already consumed
          // from this closer (those are inside as inner tokens, not
          // literal).
          let consumeC = use;
          if (!isDel && opener.pairCloser === cur && opener.pairBPrime !== undefined &&
            (opener.numDelims <= 0 || cur.numDelims - use <= 0)) {
            const extra = Math.max(0, opener.pairBPrime - use - (cur.len - cur.numDelims));
            consumeC = use + extra;
            if (extra > 0) {
              const lit = { t: 'text', s: cur.ch.repeat(extra), pos: cur.pos + use, end: cur.pos + consumeC, next: null, prev: null, parent: emNode, removed: false };
              if (childTail) { childTail.next = lit; lit.prev = childTail; }
              else { emNode.childHead = lit; }
              childTail = lit;
            }
          }
          cur.numDelims -= consumeC;
          if (opener.numDelims === 0) {
            unlink(opener);
            if (head === opener) head = emNode;
            delimStack.splice(oi, 1);
          }
          if (cur.numDelims === 0) {
            unlink(cur);
            cur = null;
            break;
          }
        }
        if (cur && cur.removed) { cur = next; continue; }
        if (cur && !cur.removed && cur.canOpen && !cur.dead && cur.numDelims > 0) delimStack.push(cur);
        cur = next;
        continue;
      }
      if (!cur.removed && cur.canOpen && !cur.dead && cur.numDelims > 0) delimStack.push(cur);
    } else if (cur.t === 'open') {
      bracketStack.push(cur);
    } else if (cur.t === 'close') {
      // Take the TOP opener (most recent), not the nearest active one:
      // if it is inactive (a link formed inside it), this ] is literal
      // and must NOT pair with an earlier opener; pop it.
      let oi = -1, opener = null;
      for (let k = bracketStack.length - 1; k >= 0; k--) {
        const o = bracketStack[k];
        if (!o.removed && !o.parent) { opener = o; oi = k; break; }
      }
      if (opener && !opener.active) {
        bracketStack.splice(oi, 1);
        opener = null;
      }
      if (opener) {
        const after = cur.end;
        let link = null, linkEnd = -1;
        const text = s.slice(opener.end, cur.pos);
        const il = labelTextValid(text) ? parseInlineLink(s, after) : null;
        if (il) { link = il; linkEnd = il.end; }
        else {
          const rl = parseRefLabel(s, after);
          const fullOk = rl && rl.label !== '' && labelTextValid(text) && shortcutLabelValid(rl.label);
          if (fullOk) {
            const ref = refs.get(normalizeLabel(rl.label));
            if (ref) { link = { dest: ref.dest, title: ref.title }; linkEnd = rl.end; }
          } else if (rl && rl.label === '' && shortcutLabelValid(text)) {
            const ref = refs.get(normalizeLabel(text));
            if (ref) { link = { dest: ref.dest, title: ref.title }; linkEnd = rl.end; }
          } else if (!fullOk) {
            const ref = shortcutLabelValid(text) ? refs.get(normalizeLabel(text)) : undefined;
            if (ref) { link = { dest: ref.dest, title: ref.title }; linkEnd = after; }
          }
        }
        if (link) {
          const isImage = opener.image;
          const linkNode = isImage
            ? { t: 'image', dest: link.dest, title: link.title, alt: '', pos: opener.pos, end: linkEnd, next: null, prev: null, parent: null, removed: false, childHead: null }
            : { t: 'link', dest: link.dest, title: link.title, pos: opener.pos, end: linkEnd, next: null, prev: null, parent: null, removed: false, childHead: null };
          let childHead = opener.next, childTail = null;
          let c = opener.next;
          while (c && c !== cur) { childTail = c; c = c.next; }
          if (isImage) {
            linkNode.alt = plainTextOf(childHead, cur);
            let cc = childHead;
            while (cc && cc !== cur) { const nx = cc.next; cc.next = cc.prev = null; cc.removed = true; cc = nx; }
          } else if (childHead && childHead !== cur) {
            linkNode.childHead = childHead;
            if (childHead.prev) childHead.prev.next = null;
            childHead.prev = null;
            if (childTail) childTail.next = null;
            stripAutolinks(childHead);
            let cc = childHead;
            while (cc) { cc.parent = linkNode; cc = cc.next; }
          }
          // Find the first node at/after linkEnd, splitting a text node.
          // Nodes before it (the link suffix) are removed and bypassed.
          let suffixEnd = cur.next;
          let sn = cur.next;
          while (sn && sn.pos < linkEnd) {
            const nx = sn.next;
            if (sn.t === 'text' && sn.end > linkEnd) {
              sn.s = sn.s.slice(linkEnd - sn.pos);
              sn.pos = linkEnd;
              suffixEnd = sn;
              break;
            }
            sn.removed = true;
            sn = nx;
            suffixEnd = sn;
          }
          linkNode.prev = opener.prev;
          linkNode.next = suffixEnd;
          if (opener.prev) opener.prev.next = linkNode;
          if (suffixEnd) suffixEnd.prev = linkNode;
          if (head === opener) head = linkNode;
          opener.next = opener.prev = null; opener.removed = true;
          cur.next = cur.prev = null; cur.removed = true;
          bracketStack.splice(oi, 1);
          if (!isImage) {
            // A link deactivates remaining LINK openers (no nested
            // links) but NOT image openers: an image can still form
            // around a link, using the link as alt text.
            for (const b of bracketStack) if (!b.image) b.active = false;
          }
        } else {
          // No link formed: remove this opener from the stack so a
          // later ] can pair with an earlier one.
          bracketStack.splice(oi, 1);
        }
      }
    }
    cur = next;
  }
  return head;
}

// Render an inline node list to HTML.
function renderInlineList(head) {
  let out = '';
  let cur = head;
  while (cur) {
    switch (cur.t) {
      case 'text': out += escText(cur.s); break;
      case 'code': out += '<code>' + escEncode(cur.s) + '</code>'; break;
      case 'html': out += cur.s; break;
      case 'br': out += '<br>'; break;
      case 'delim': out += cur.ch.repeat(cur.numDelims); break;
      case 'open': out += cur.image ? '![' : '['; break;
      case 'close': out += ']'; break;
      case 'autolink': {
        const href = escAttr(cleanUrl(cur.url) ?? cur.url);
        out += '<a href="' + href + '">' + escText(cur.text) + '</a>';
        break;
      }
      case 'link': {
        const href = escAttr(cleanUrl(cur.dest) ?? cur.dest);
        out += '<a href="' + href + '"';
        if (cur.title !== null && cur.title !== undefined) out += ' title="' + escAttr(cur.title) + '"';
        out += '>' + renderInlineList(cur.childHead) + '</a>';
        break;
      }
      case 'image': {
        const src = escAttr(cleanUrl(cur.dest) ?? cur.dest);
        out += '<img src="' + src + '" alt="' + escAttr(cur.alt) + '"';
        if (cur.title !== null && cur.title !== undefined) out += ' title="' + escAttr(cur.title) + '"';
        out += '>';
        break;
      }
      case 'em': out += '<em>' + renderInlineList(cur.childHead) + '</em>'; break;
      case 'strong': out += '<strong>' + renderInlineList(cur.childHead) + '</strong>'; break;
      case 'del': out += '<del>' + renderInlineList(cur.childHead) + '</del>'; break;
    }
    cur = cur.next;
  }
  return out;
}

function parseInline(s, refs) {
  if (s === '') return '';
  return renderInlineList(buildInlineTree(s, refs));
}

// ------------------------------------------------------------------ block parser
// Line-based container parser. Lines carry a `lazy` flag (true when the
// line did not match the current container's markers — only meaningful
// for the table rule inside blockquotes) and a `col` (the absolute
// column the line's text starts at).

function splitLines(src) {
  const lines = [];
  let start = 0;
  let blank = true;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\n') {
      lines.push({ text: src.slice(start, i), lazy: false, col: 0, blank });
      start = i + 1;
      blank = true;
    } else if (c !== ' ' && c !== '\t') blank = false;
  }
  if (start < src.length) lines.push({ text: src.slice(start), lazy: false, col: 0, blank });
  return lines;
}
function isBlankLine(t) {
  for (let i = 0; i < t.length; i++) if (t[i] !== ' ' && t[i] !== '\t') return false;
  return true;
}
// Columns of leading whitespace, counting tabs to the next multiple of 4.
function indentOf(t, startCol) {
  let n = startCol || 0;
  let i = 0;
  for (; i < t.length; i++) {
    if (t[i] === ' ') n++;
    else if (t[i] === '\t') n += 4 - (n % 4);
    else break;
  }
  return n - (startCol || 0);
}
// Expand the tabs in a leading run of spaces/tabs to spaces, tracking
// columns from `startCol`. Only the leading whitespace run is touched.
function expandLeadingTabs(s, startCol) {
  let col = startCol || 0, i = 0;
  let out = '';
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) {
    if (s[i] === ' ') { out += ' '; col++; i++; }
    else { const adv = 4 - (col % 4); out += ' '.repeat(adv); col += adv; i++; }
  }
  return out + s.slice(i);
}
// Fenced-code dedent: remove up to `n` leading-whitespace CHARACTERS
// from a content line (a tab counts as one character).
function fenceDedent(line, n) {
  if (n <= 0) return line;
  let i = 0;
  while (i < line.length && i < n && (line[i] === ' ' || line[i] === '\t')) i++;
  return line.slice(i);
}
// Indented-code dedent: remove 1-4 leading spaces, or 0-3 spaces
// followed by a tab (the tab is removed, not expanded).
function indentedCodeDedent(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ' && i < 3) i++;
  if (i < line.length && line[i] === '\t') return line.slice(i + 1);
  let j = 0;
  while (j < line.length && line[j] === ' ' && j < 4) j++;
  return j > 0 ? line.slice(j) : line;
}
// Strip up to `count` columns of indent from the start of t, where t
// starts at absolute column startCol. Returns {rest, newCol}.
function stripIndent(t, count, startCol) {
  let col = startCol || 0, i = 0;
  const target = col + count;
  while (i < t.length && col < target) {
    const c = t[i];
    if (c === ' ') { col++; i++; }
    else if (c === '\t') {
      const adv = 4 - (col % 4);
      if (col + adv <= target) { col += adv; i++; }
      else {
        const remaining = target - col;
        return { rest: ' '.repeat(adv - remaining) + t.slice(i + 1), newCol: target };
      }
    } else break;
  }
  if (i < t.length && t[i] === '\t' && col === target) {
    const adv = 4 - (col % 4);
    return { rest: ' '.repeat(adv) + t.slice(i + 1), newCol: col + adv };
  }
  return { rest: t.slice(i), newCol: col };
}
// Strip a blockquote marker (> + optional space/tab) from t (starting at
// absolute column startCol). Returns {content, newCol} or null.
function stripBlockquoteMarker(t, startCol) {
  let col = startCol || 0, i = 0;
  while (i < t.length && t[i] === ' ' && col - (startCol || 0) < 3) { i++; col++; }
  if (i >= t.length || t[i] !== '>') return null;
  i++; col++;
  let j = i;
  while (j < t.length && (t[j] === ' ' || t[j] === '\t')) j++;
  if (j === i) return { content: t.slice(i), newCol: col };
  const expanded = expandLeadingTabs(t.slice(i), i);
  return { content: expanded.slice(1), newCol: col + 1 };
}

// ---- tables ----
// Split a table row on unescaped | ; leading/trailing pipes stripped;
// cells trimmed. An escaped \| becomes a literal |.
function splitTableCells(line) {
  let i = 0, n = line.length;
  while (i < n && line[i] === ' ') i++;
  if (line[i] === '|') i++;
  let end = n;
  while (end > i && line[end - 1] === ' ') end--;
  if (end > i && line[end - 1] === '|') end--;
  const cells = [];
  let start = i;
  for (let k = i; k < end; k++) {
    if (line[k] === '|' && line[k - 1] !== '\\') {
      cells.push(line.slice(start, k).replace(/\\\|/g, '|').trim());
      start = k + 1;
    }
  }
  cells.push(line.slice(start, end).replace(/\\\|/g, '|').trim());
  return cells;
}
// Alignment of one delimiter cell, or undefined when it is not one.
function delimCellAlign(cell) {
  let i = 0, n = cell.length;
  let left = false, right = false;
  if (cell[i] === ':') { left = true; i++; }
  const dashStart = i;
  while (i < n && cell[i] === '-') i++;
  if (i === dashStart) return undefined;
  if (i < n && cell[i] === ':') { right = true; i++; }
  if (i !== n) return undefined;
  return left && right ? 'center' : left ? 'left' : right ? 'right' : null;
}
// Parse a delimiter row: returns the alignments array or null. A row
// holds only -, :, |, spaces and tabs, with at most 3 spaces of indent.
function parseDelimiterRow(line) {
  if (indentOf(line, 0) > 3) return null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== '-' && c !== ':' && c !== '|' && c !== ' ' && c !== '\t') return null;
  }
  const cells = splitTableCells(line);
  if (cells.length === 0) return null;
  const align = [];
  for (const cell of cells) {
    const a = delimCellAlign(cell);
    if (a === undefined) return null;
    align.push(a);
  }
  return align;
}
function isDelimiterRow(line) { return parseDelimiterRow(line) !== null; }

// ---- HTML blocks ----
const HTML_BLOCK_START = [
  { re: /^ {0,3}<(script|pre|style|textarea)([ \t>]|\/>|$)/i, end: /<\/(script|pre|style|textarea)>/i },
  { re: /^ {0,3}<!--/, end: /-->/ },
  { re: /^ {0,3}<\?/, end: /\?>/ },
  { re: /^ {0,3}<![A-Za-z]/, end: />/ },
  { re: /^ {0,3}<!\[CDATA\[/, end: /\]\]>/ },
];
const HTML_BLOCK_TAG_RE = /^ {0,3}<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t>]|\/>|$)/i;
const HTML_TYPE7_OPEN_RE = /^ {0,3}<[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:"[^"]*"|'[^']*'|[^\s"'=<`>]+))?)*[ \t]*\/?>[ \t]*$/;
const HTML_TYPE7_CLOSE_RE = /^ {0,3}<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>[ \t]*$/;

function htmlBlockStart(line) {
  // fast reject: an HTML block starts with < after at most 3 spaces
  let i = 0;
  while (i < line.length && line[i] === ' ' && i < 3) i++;
  if (line[i] !== '<') return null;
  for (let k = 0; k < HTML_BLOCK_START.length; k++) {
    if (HTML_BLOCK_START[k].re.test(line)) return { type: k + 1, endRe: HTML_BLOCK_START[k].end };
  }
  if (HTML_BLOCK_TAG_RE.test(line)) return { type: 6, endRe: null };
  if (HTML_TYPE7_OPEN_RE.test(line) || HTML_TYPE7_CLOSE_RE.test(line)) return { type: 7, endRe: null };
  return null;
}

// Returns fence info {ch, len, info} or null. A backtick fence whose info
// string contains a backtick is NOT a fence.
function fenceInfo(t) {
  let i = 0;
  while (i < t.length && t[i] === ' ' && i < 3) i++;
  if (i >= t.length) return null;
  const ch = t[i];
  if (ch !== '`' && ch !== '~') return null;
  let j = i;
  while (j < t.length && t[j] === ch) j++;
  if (j - i < 3) return null;
  const info = t.slice(j).trim();
  if (ch === '`' && info.includes('`')) return null;
  return { ch, len: j - i, info };
}

// ---- link reference definitions ----
// Try to parse a link ref def starting at lines[startIdx].
// Returns {endIdx (exclusive), dest, title, label} or null.
function parseLinkDef(lines, startIdx) {
  const n = lines.length;
  let li = startIdx;
  let t = lines[li].text;
  let pos = 0;
  let lead = 0;
  while (lead < t.length && t[lead] === ' ' && lead < 3) lead++;
  pos = lead;
  if (t[pos] !== '[') return null;
  pos++;
  let label = '';
  let closed = false;
  while (!closed) {
    while (pos < t.length) {
      const ch = t[pos];
      if (ch === '\\' && pos + 1 < t.length && (t[pos + 1] === '[' || t[pos + 1] === ']' || t[pos + 1] === '\\')) { label += t[pos + 1]; pos += 2; continue; }
      if (ch === '[') return null;
      if (ch === ']') { closed = true; pos++; break; }
      label += ch; pos++;
    }
    if (closed) break;
    li++;
    if (li >= n) return null;
    if (lines[li].blank) return null;
    t = lines[li].text; pos = 0;
    label += '\n';
  }
  const normLabel = normalizeLabel(label);
  if (normLabel === '' || label.length > 999) return null;
  while (pos < t.length && t[pos] === ' ') pos++;
  if (pos >= t.length) {
    li++;
    if (li >= n) return null;
    if (lines[li].blank) return null;
    t = lines[li].text; pos = 0;
    while (pos < t.length && t[pos] === ' ') pos++;
  }
  if (t[pos] !== ':') return null;
  pos++;
  let destLine = -1;
  while (true) {
    while (pos < t.length && (t[pos] === ' ' || t[pos] === '\t')) pos++;
    if (pos < t.length) { destLine = li; break; }
    li++;
    if (li >= n) return null;
    if (lines[li].blank) return null;
    t = lines[li].text; pos = 0;
  }
  let dest = '';
  if (t[pos] === '<') {
    pos++;
    let dEnd = -1;
    while (pos < t.length) {
      const ch = t[pos];
      if (ch === '>') { dEnd = pos; break; }
      if (ch === '<') return null;
      if (ch === '\\' && pos + 1 < t.length && PUNCT_SET.has(t[pos + 1])) { dest += t[pos + 1]; pos += 2; continue; }
      dest += ch; pos++;
    }
    if (dEnd < 0) return null;
    pos = dEnd + 1;
  } else {
    let depth = 0, started = false;
    while (pos < t.length) {
      const ch = t[pos];
      if (ch === ' ' || ch === '\t') break;
      if (ch === '\\' && pos + 1 < t.length && PUNCT_SET.has(t[pos + 1])) { dest += t[pos + 1]; pos += 2; started = true; continue; }
      if (ch === '(') { depth++; dest += ch; pos++; started = true; continue; }
      if (ch === ')') { if (depth === 0) break; depth--; dest += ch; pos++; started = true; continue; }
      if (ch < ' ') return null;
      dest += ch; pos++; started = true;
    }
    if (!started) return null;
    if (depth !== 0) return null;
  }
  // After the dest: optional title, then only whitespace to end of line.
  // A title requires whitespace (or a line break) before it.
  let title = null, endIdx = destLine + 1;
  let hadSpace = false, crossedLine = false;
  while (true) {
    while (pos < t.length && (t[pos] === ' ' || t[pos] === '\t')) { pos++; hadSpace = true; }
    if (pos < t.length) break;
    li++;
    if (li >= n) return { label: normLabel, dest, title: null, endIdx: destLine + 1 };
    if (lines[li].blank) return { label: normLabel, dest, title: null, endIdx: destLine + 1 };
    t = lines[li].text; pos = 0; hadSpace = true; crossedLine = true;
  }
  if (!hadSpace) return null;
  const titleStartLine = li;
  const q = t[pos];
  if (q === '"' || q === "'" || q === '(') {
    const closeQ = q === '(' ? ')' : q;
    let titleText = '';
    pos++;
    let closedT = false, badParen = false;
    let closeLine = li, closePos = -1;
    while (true) {
      let stop = false;
      while (pos < t.length) {
        const ch = t[pos];
        if (ch === '\\' && pos + 1 < t.length && PUNCT_SET.has(t[pos + 1])) { titleText += t[pos + 1]; pos += 2; continue; }
        if (ch === closeQ) { closedT = true; closeLine = li; closePos = pos; stop = true; break; }
        if (q === '(' && (ch === '(' || ch === ')')) { badParen = true; stop = true; break; }
        titleText += ch; pos++;
      }
      if (stop) break;
      li++;
      if (li >= n) return null;
      if (lines[li].blank) return null;
      titleText += '\n';
      t = lines[li].text; pos = 0;
    }
    if (badParen) return null;
    if (!closedT) return null;
    const after = t.slice(closePos + 1);
    if (/^[ \t]*$/.test(after)) {
      title = titleText;
      endIdx = closeLine + 1;
    } else {
      if (titleStartLine === destLine) return null;
      title = null;
      endIdx = destLine + 1;
    }
  } else {
    if (crossedLine) return { label: normLabel, dest, title: null, endIdx: destLine + 1 };
    return null;
  }
  return { dest, title, endIdx, label: normLabel };
}

// Extract leading link ref defs from paragraph lines. Registers them in
// refs (first definition wins). Returns the remaining lines.
function extractLinkDefs(paraLines, refs) {
  let idx = 0;
  while (idx < paraLines.length) {
    const d = parseLinkDef(paraLines, idx);
    if (!d) break;
    if (!refs.has(d.label)) { refs.set(d.label, { dest: d.dest, title: d.title }); _refsVer++; }
    idx = d.endIdx;
  }
  return paraLines.slice(idx);
}

// Finalize a paragraph: extract link ref defs; if lines remain, make a para node.
function finalizeParagraph(paraLines, refs) {
  const remaining = extractLinkDefs(paraLines, refs);
  if (remaining.length === 0) return null;
  return { type: 'para', text: remaining.map(l => l.text).join('\n') };
}

// ---- block start dispatch ----
// What block (if any) starts at lines[idx]? inPara controls the
// list-interruption rules. Returns 'atx' | 'fence' | 'hr' | 'html' |
// 'blockquote' | 'list' | null. Dispatches on the first character after
// at most 3 spaces, so plain paragraph lines return null immediately.
function blockStartKind(idx, lines, inPara, inListItem) {
  const t = lines[idx].text;
  let i = 0;
  while (i < t.length && t[i] === ' ' && i < 3) i++;
  if (i >= t.length) return null;
  const c = t[i];
  if (c === '#') {
    let j = i;
    while (j < t.length && t[j] === '#') j++;
    if (j - i >= 1 && j - i <= 6 && (j >= t.length || t[j] === ' ' || t[j] === '\t')) return 'atx';
    return null;
  }
  if (c === '`' || c === '~') {
    if (fenceInfo(t)) return 'fence';
    return null;
  }
  if (c === '*' || c === '-' || c === '_') {
    // thematic break: 3+ of the same char, only spaces/tabs otherwise
    let count = 0, ok = true;
    for (let k = i; k < t.length; k++) {
      if (t[k] === c) count++;
      else if (t[k] !== ' ' && t[k] !== '\t') { ok = false; break; }
    }
    if (ok && count >= 3) return 'hr';
    return listKind(t, i, inPara, inListItem);
  }
  if (c === '<') {
    const hb = htmlBlockStart(t);
    if (hb && (hb.type <= 6 || !inPara)) return 'html';
    return null;
  }
  if (c === '>') return 'blockquote';
  if (c === '+' || (c >= '0' && c <= '9')) return listKind(t, i, inPara, inListItem);
  return null;
}

// List-interruption rules for a marker at lines position i (after <=3
// spaces). Returns 'list' or null. Inside a list item (inListItem) an
// ordered list may interrupt a paragraph whatever its start number.
function listKind(t, i, inPara, inListItem) {
  const c = t[i];
  let markerEnd;
  if (c === '*' || c === '+' || c === '-') markerEnd = i + 1;
  else {
    let j = i;
    while (j < t.length && t[j] >= '0' && t[j] <= '9') j++;
    if (j - i < 1 || j - i > 9) return null;
    if (t[j] !== '.' && t[j] !== ')') return null;
    markerEnd = j + 1;
  }
  if (markerEnd < t.length && t[markerEnd] !== ' ' && t[markerEnd] !== '\t') return null;
  if (!inPara) return 'list';
  // a list can interrupt a paragraph only for bullets, for an empty
  // item it cannot, and for ordered lists only when the start is 1
  // (or inside a list item, where any start number interrupts)
  let k = markerEnd;
  while (k < t.length && (t[k] === ' ' || t[k] === '\t')) k++;
  if (k >= t.length) return null;
  if (c === '*' || c === '+' || c === '-') return 'list';
  return (parseInt(t.slice(i, markerEnd - 1), 10) === 1 || inListItem) ? 'list' : null;
}

// Is this line a block start? inPara controls list-interruption rules.
// (Used by the blockquote/list collectors on already-stripped lines.)
function isBlockStartLine(t, col, inPara) {
  let i = 0;
  while (i < t.length && t[i] === ' ' && i < 3) i++;
  if (i >= t.length) return false;
  const c = t[i];
  if (c === '#') {
    let j = i;
    while (j < t.length && t[j] === '#') j++;
    if (j - i >= 1 && j - i <= 6 && (j >= t.length || t[j] === ' ' || t[j] === '\t')) return true;
    return false;
  }
  if (c === '`' || c === '~') return fenceInfo(t) !== null;
  if (c === '*' || c === '-' || c === '_') {
    let count = 0, ok = true;
    for (let k = i; k < t.length; k++) {
      if (t[k] === c) count++;
      else if (t[k] !== ' ' && t[k] !== '\t') { ok = false; break; }
    }
    if (ok && count >= 3) return true;
    return listKind(t, i, inPara, false) !== null;
  }
  if (c === '<') {
    const hb = htmlBlockStart(t);
    return hb !== null && hb.type <= 6;
  }
  if (c === '>') return true;
  if (indentOf(t, col) >= 4 && !inPara) return true;
  if (c === '+' || (c >= '0' && c <= '9')) return listKind(t, i, inPara, false) !== null;
  return false;
}

// ---------------------------------------------------------------- parseBlocks
// lines: [{text, lazy, col, blank}]; refs: Map. Returns {blocks, loose}.
// blocks: [{type, ...}]. `loose` is true when a blank line separates blocks.

function parseBlocks(lines, refs, inListItem) {
  const blocks = [];
  let loose = false;
  let para = null;
  let i = 0;
  const n = lines.length;

  const flushPara = () => {
    if (!para) return;
    const b = finalizeParagraph(para.lines, refs);
    if (b) {
      if (Array.isArray(b)) blocks.push(...b);
      else blocks.push(b);
    }
    para = null;
  };

  while (i < n) {
    const line = lines[i];
    const t = line.text;
    if (line.blank) {
      flushPara();
      i++;
      let j = i;
      while (j < n && lines[j].blank) j++;
      if (j < n && blocks.length > 0) loose = true;
      continue;
    }
    if (!para && isBlankLine(t)) { i++; continue; }
    if (line.lazy) {
      if (!para) para = { lines: [] };
      para.lines.push({ text: t, lazy: line.lazy, blank: false });
      i++;
      continue;
    }
    const inPara = para !== null;
    if (inPara && !line.lazy) {
      // setext underline
      const sm = setextUnderline(t);
      if (sm !== 0) {
        const remaining = extractLinkDefs(para.lines, refs);
        if (remaining.length > 0) {
          let text = remaining.map(l => l.text).join('\n');
          let a = 0;
          while (a < text.length && (text[a] === ' ' || text[a] === '\t')) a++;
          let b = text.length;
          while (b > a && (text[b - 1] === ' ' || text[b - 1] === '\t')) b--;
          text = text.slice(a, b);
          para = null;
          blocks.push({ type: 'heading', level: sm, text });
          i++;
          continue;
        }
        para = null;
        continue;
      }
      // table delimiter
      const align = parseDelimiterRow(t);
      if (align !== null) {
        const lastLine = para.lines[para.lines.length - 1];
        const headerCells = splitTableCells(lastLine.text);
        const exception = line.lazy && !lastLine.lazy && lines._inBlockquote;
        if (headerCells.length === align.length && !exception) {
          const earlier = para.lines.slice(0, -1);
          para = null;
          if (earlier.length > 0) {
            const b = finalizeParagraph(earlier, refs);
            if (b) { if (Array.isArray(b)) blocks.push(...b); else blocks.push(b); }
          }
          const table = { type: 'table', align, header: headerCells, rows: [] };
          i++;
          while (i < n) {
            const bl = lines[i];
            if (bl.blank && !bl.text.includes('\t')) break;
            if (blockStartKind(i, lines, false, inListItem)) break;
            table.rows.push(splitTableCells(bl.text));
            i++;
          }
          blocks.push(table);
          continue;
        }
      } else if (i + 1 < n && setextUnderline(lines[i + 1].text) === 0 && parseDelimiterRow(lines[i + 1].text) !== null) {
        // paragraph-stop: this line is a potential header and the NEXT
        // line is a delimiter row (setext wins over the table rule)
        const exception = lines[i + 1].lazy && !line.lazy && lines._inBlockquote;
        if (!exception) {
          flushPara();
          continue;
        }
      }
    }
    const kind = blockStartKind(i, lines, inPara, inListItem);
    if (kind === 'atx' || kind === 'fence' || kind === 'hr' || kind === 'html' || kind === 'blockquote' || kind === 'list') {
      flushPara();
      if (kind === 'atx') {
        let p = 0;
        while (p < t.length && t[p] === ' ') p++;
        let h = p;
        while (h < t.length && t[h] === '#') h++;
        const level = h - p;
        let q = h;
        while (q < t.length && (t[q] === ' ' || t[q] === '\t')) q++;
        let content = t.slice(q);
        let e = content.length;
        while (e > 0 && (content[e - 1] === ' ' || content[e - 1] === '\t')) e--;
        content = content.slice(0, e);
        if (/^#+$/.test(content)) content = '';
        else {
          let f = content.length;
          while (f > 0 && content[f - 1] === '#') f--;
          if (f < content.length && f > 0 && (content[f - 1] === ' ' || content[f - 1] === '\t')) {
            let g = f;
            while (g > 0 && (content[g - 1] === ' ' || content[g - 1] === '\t')) g--;
            content = content.slice(0, g);
          }
        }
        blocks.push({ type: 'heading', level, text: content });
        i++;
        continue;
      }
      if (kind === 'hr') { blocks.push({ type: 'hr' }); i++; continue; }
      if (kind === 'fence') {
        const fi = fenceInfo(t);
        const fenceCh = fi.ch;
        const fenceLen = fi.len;
        let fenceWsLen = 0;
        while (fenceWsLen < t.length && (t[fenceWsLen] === ' ' || t[fenceWsLen] === '\t')) fenceWsLen++;
        let info = fi.info;
        const sp = info.search(/[ \t]/);
        if (sp !== -1) info = info.slice(0, sp);
        info = info.replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
        const contentLines = [];
        i++;
        while (i < n) {
          const cl = lines[i].text;
          if (isFenceClose(cl, fenceCh, fenceLen)) { i++; break; }
          contentLines.push(fenceCh === '`' ? fenceDedent(cl, fenceWsLen) : cl);
          i++;
        }
        if (contentLines.length && contentLines[contentLines.length - 1] === '') contentLines.pop();
        blocks.push({ type: 'code', text: contentLines.join('\n') + (contentLines.length ? '\n' : ''), info, fenced: true });
        continue;
      }
      if (kind === 'html') {
        const hb = htmlBlockStart(t);
        const htmlLines = [t];
        i++;
        const srcEndsWithNL = lines._srcEndsWithNL;
        if (hb.type <= 5) {
          if (!hb.endRe.test(t)) {
            while (i < n) {
              const hl = lines[i].text;
              htmlLines.push(hl);
              i++;
              if (hb.endRe.test(hl)) break;
            }
          }
        } else {
          while (i < n && !lines[i].blank) { htmlLines.push(lines[i].text); i++; }
        }
        let htmlText = htmlLines.join('\n');
        if (hb.type <= 5) {
          if (i < n && lines[i].text !== '') htmlText += '\n';
          else if (i >= n && srcEndsWithNL) htmlText += '\n';
        } else {
          if (i >= n && srcEndsWithNL) htmlText += '\n';
        }
        blocks.push({ type: 'html', text: htmlText });
        continue;
      }
      if (kind === 'blockquote') {
        const res = collectBlockquote(lines, i, refs);
        blocks.push(res.node);
        i = res.endIdx;
        continue;
      }
      if (kind === 'list') {
        const res = collectList(lines, i, refs);
        blocks.push(res.node);
        i = res.endIdx;
        continue;
      }
    }
    // indented code (cannot interrupt a paragraph)
    if (!inPara && indentOf(t, line.col) >= 4) {
      flushPara();
      const codeLines = [];
      while (i < n) {
        const cl = lines[i];
        if (cl.blank) {
          let j = i + 1;
          while (j < n && lines[j].blank) j++;
          if (j < n && indentOf(lines[j].text, lines[j].col) >= 4) {
            while (i < j) { codeLines.push(indentedCodeDedent(lines[i].text)); i++; }
            continue;
          }
          break;
        }
        if (indentOf(cl.text, cl.col) < 4) break;
        codeLines.push(indentedCodeDedent(cl.text));
        i++;
      }
      while (codeLines.length && codeLines[codeLines.length - 1] === '') codeLines.pop();
      blocks.push({ type: 'code', text: codeLines.join('\n') + (codeLines.length ? '\n' : ''), info: '', fenced: false });
      continue;
    }
    // paragraph line
    if (!para) para = { lines: [] };
    para.lines.push({ text: t, lazy: line.lazy, blank: false });
    i++;
  }
  flushPara();
  return { blocks, loose };
}

// Setext underline: returns 1 for =, 2 for -, else 0.
function setextUnderline(t) {
  let i = 0;
  while (i < t.length && t[i] === ' ' && i < 3) i++;
  if (i >= t.length) return 0;
  const ch = t[i];
  if (ch !== '=' && ch !== '-') return 0;
  let j = i;
  while (j < t.length && t[j] === ch) j++;
  while (j < t.length && (t[j] === ' ' || t[j] === '\t')) j++;
  if (j !== t.length) return 0;
  return ch === '=' ? 1 : 2;
}

// Is this line a closing fence for a fence of ch/len? Up to 3 spaces,
// a run of ch of length >= len, then only spaces/tabs.
function isFenceClose(cl, ch, len) {
  let i = 0;
  while (i < cl.length && cl[i] === ' ' && i < 3) i++;
  let j = i;
  while (j < cl.length && cl[j] === ch) j++;
  if (j - i < len) return false;
  while (j < cl.length && (cl[j] === ' ' || cl[j] === '\t')) j++;
  return j === cl.length;
}

// ---------------------------------------------------------------- collectors

function collectBlockquote(lines, startIdx, refs) {
  const content = [];
  let i = startIdx;
  let inPara = false;
  let lastWasLazy = false;
  let fenceCh = null, fenceLen = 0;
  while (i < lines.length) {
    const line = lines[i];
    const stripped = stripBlockquoteMarker(line.text, line.col);
    if (stripped) {
      content.push({ text: stripped.content, lazy: false, col: stripped.newCol, blank: stripped.content === '' });
      if (fenceCh !== null) {
        if (isFenceClose(stripped.content, fenceCh, fenceLen)) { fenceCh = null; fenceLen = 0; }
        inPara = false;
      } else {
        const fi = fenceInfo(stripped.content);
        if (fi) { fenceCh = fi.ch; fenceLen = fi.len; inPara = false; }
        else if (isBlankLine(stripped.content)) inPara = false;
        else if (/^ {0,3}>/.test(stripped.content) || listMarkerInfo(stripped.content, stripped.newCol)) inPara = true;
        else if (isBlockStartLine(stripped.content, stripped.newCol, inPara)) inPara = false;
        else inPara = true;
      }
      lastWasLazy = false;
      i++;
      continue;
    }
    if (line.blank) break;
    if (fenceCh !== null) break;
    if (isBlockStartLine(line.text, line.col, inPara)) break;
    if (!inPara) break;
    let lazyText = line.text;
    let lazyCol = line.col;
    if (indentOf(lazyText, lazyCol) >= 4) {
      const st = stripIndent(lazyText, 4, lazyCol);
      lazyText = st.rest; lazyCol = st.newCol;
    }
    if (lastWasLazy && setextUnderline(lazyText) !== 0) lazyText = '    ' + lazyText;
    content.push({ text: lazyText, lazy: true, col: lazyCol, blank: false });
    inPara = true;
    lastWasLazy = true;
    i++;
  }
  content._inBlockquote = true;
  content._srcEndsWithNL = (i >= lines.length) && !!lines._srcEndsWithNL;
  const inner = parseBlocks(content, refs);
  return { node: { type: 'blockquote', children: inner.blocks }, endIdx: i };
}

// Compute list marker info for a line. Returns null if not a marker.
// A marker must be followed by whitespace (or end of line): `*foo` and
// `**bold**` are paragraphs, not list items.
function listMarkerInfo(t, col) {
  let lead = 0;
  while (lead < t.length && t[lead] === ' ' && lead < 3) lead++;
  if (lead >= t.length) return null;
  const c = t[lead];
  let marker;
  if (c === '*' || c === '+' || c === '-') marker = c;
  else if (c >= '0' && c <= '9') {
    let j = lead;
    while (j < t.length && t[j] >= '0' && t[j] <= '9') j++;
    if (j - lead < 1 || j - lead > 9) return null;
    if (t[j] !== '.' && t[j] !== ')') return null;
    marker = t.slice(lead, j + 1);
  } else return null;
  const after = t.slice(lead + marker.length);
  if (after !== '' && after[0] !== ' ' && after[0] !== '\t') return null;
  const markerEndCol = (col || 0) + lead + marker.length;
  const afterMarker = t.slice(lead + marker.length);
  let w = 0;
  while (w < afterMarker.length && (afterMarker[w] === ' ' || afterMarker[w] === '\t')) w++;
  const wsRun = afterMarker.slice(0, w);
  const expanded = expandLeadingTabs(wsRun, markerEndCol) + afterMarker.slice(w);
  const empty = w === afterMarker.length;
  let contentIndent, content, contentCol;
  if (empty) {
    contentIndent = markerEndCol + 1;
    content = '';
    contentCol = markerEndCol + 1;
  } else {
    let r = expanded.search(/[^ ]/);
    if (r > 4) r = 1;
    contentIndent = markerEndCol + r;
    content = expanded.slice(r);
    contentCol = markerEndCol + r;
  }
  const isOrdered = c >= '0' && c <= '9';
  return {
    marker, isOrdered,
    bullet: isOrdered ? null : marker,
    delim: isOrdered ? marker[marker.length - 1] : null,
    start: isOrdered ? parseInt(marker, 10) : null,
    contentIndent,
    content,
    contentCol,
    empty,
    lead,
  };
}

function collectList(lines, startIdx, refs) {
  const first = listMarkerInfo(lines[startIdx].text, lines[startIdx].col);
  const items = [];
  let cur = { lines: [], blankBetween: false };
  items.push(cur);
  let listLoose = false;
  let i = startIdx;
  const firstLine = lines[startIdx];
  const firstContent = first.content;
  cur.lines.push({ text: firstContent, lazy: false, col: first.contentCol, blank: isBlankLine(firstContent) });
  let inPara = !isBlankLine(firstContent) &&
    (/^ {0,3}>/.test(firstContent) || listMarkerInfo(firstContent, first.contentCol) ||
      !isBlockStartLine(firstContent, first.contentCol, false));
  let curContentIndent = first.contentIndent - (firstLine.col || 0);
  i++;
  let pendingBlanks = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.blank) { pendingBlanks++; inPara = false; i++; continue; }
    const mi = listMarkerInfo(line.text, line.col);
    const lineIndent = indentOf(line.text, line.col);
    // a block start that can't be inside the item ends the list
    if (lineIndent < curContentIndent) {
      let endsList = false;
      const lt = line.text;
      let p = 0;
      while (p < lt.length && lt[p] === ' ' && p < 3) p++;
      const fc = lt[p];
      if (fc === '*' || fc === '-' || fc === '_') {
        let count = 0, ok = true;
        for (let k = p; k < lt.length; k++) {
          if (lt[k] === fc) count++;
          else if (lt[k] !== ' ' && lt[k] !== '\t') { ok = false; break; }
        }
        if (ok && count >= 3) endsList = true;
      }
      if (!endsList && fc === '#') {
        let j = p;
        while (j < lt.length && lt[j] === '#') j++;
        if (j - p >= 1 && j - p <= 6 && (j >= lt.length || lt[j] === ' ' || lt[j] === '\t')) endsList = true;
      }
      if (!endsList && (fc === '`' || fc === '~')) {
        // any run of 3+ fence chars ends the list (no info check here)
        let j = p;
        while (j < lt.length && lt[j] === fc) j++;
        if (j - p >= 3) endsList = true;
      }
      if (!endsList && fc === '<') {
        const hb = htmlBlockStart(lt);
        if (hb && hb.type <= 6) endsList = true;
      }
      if (endsList) break;
    }
    // new item of the same list? (marker indent must be < content indent)
    if (mi && mi.isOrdered === first.isOrdered &&
      (first.isOrdered ? mi.delim === first.delim : mi.bullet === first.bullet) &&
      mi.lead <= 3 && mi.lead < curContentIndent) {
      if (pendingBlanks > 0) listLoose = true;
      pendingBlanks = 0;
      cur = { lines: [], blankBetween: false };
      items.push(cur);
      const content = mi.content;
      cur.lines.push({ text: content, lazy: false, col: mi.contentCol, blank: isBlankLine(content) });
      inPara = !isBlankLine(content) &&
        (/^ {0,3}>/.test(content) || listMarkerInfo(content, mi.contentCol) ||
          !isBlockStartLine(content, mi.contentCol, false));
      curContentIndent = mi.contentIndent - (line.col || 0);
      i++;
      continue;
    }
    // different list type -> end of this list
    if (mi && mi.lead <= 3 && mi.lead < curContentIndent) break;
    // inside current item? (indent >= contentIndent)
    if (lineIndent >= curContentIndent) {
      if (pendingBlanks > 0 && cur.lines.every(l => l.blank)) break;
      if (pendingBlanks > 0) { cur.blankBetween = true; for (let b = 0; b < pendingBlanks; b++) cur.lines.push({ text: '', lazy: false, col: line.col, blank: true }); pendingBlanks = 0; }
      const expandedLine = expandLeadingTabs(line.text, 0);
      const stripped = { rest: expandedLine.slice(curContentIndent), newCol: curContentIndent };
      cur.lines.push({ text: stripped.rest, lazy: false, col: stripped.newCol, blank: isBlankLine(stripped.rest) });
      if (isBlankLine(stripped.rest)) inPara = false;
      else if (/^ {0,3}>/.test(stripped.rest) || listMarkerInfo(stripped.rest, stripped.newCol)) inPara = true;
      else if (isBlockStartLine(stripped.rest, stripped.newCol, inPara)) inPara = false;
      else inPara = true;
      i++;
      continue;
    }
    // lazy continuation?
    if (pendingBlanks === 0 && inPara && !isBlockStartLine(line.text, line.col, true)) {
      let lazyText = line.text, lazyCol = line.col;
      if (indentOf(lazyText, lazyCol) >= 4) {
        const st = stripIndent(lazyText, 4, lazyCol);
        lazyText = st.rest; lazyCol = st.newCol;
      }
      cur.lines.push({ text: lazyText, lazy: true, col: lazyCol, blank: false });
      i++;
      continue;
    }
    break;
  }
  const listNode = {
    type: 'list',
    ordered: first.isOrdered,
    start: first.isOrdered ? first.start : null,
    delim: first.delim,
    bullet: first.bullet,
    tight: true,
    items: [],
  };
  let loose = listLoose;
  for (const it of items) {
    while (it.lines.length && isBlankLine(it.lines[it.lines.length - 1].text)) it.lines.pop();
    it.lines._inBlockquote = false;
    it.lines._srcEndsWithNL = false;
    const inner = parseBlocks(it.lines, refs, true);
    if (inner.loose) loose = true;
    listNode.items.push({ children: inner.blocks });
  }
  listNode.tight = !loose;
  return { node: listNode, endIdx: i - pendingBlanks, loose };
}

// ---------------------------------------------------------------- renderer

// Task list: [ ], [x] or [X] + spaces + non-whitespace text at the start
// of a list item's first paragraph. Returns {checked, rest} or null.
function taskInfo(text) {
  if (text.length < 4 || text[0] !== '[') return null;
  const m = text[1];
  if (m !== ' ' && m !== 'x' && m !== 'X') return null;
  if (text[2] !== ']') return null;
  let i = 3;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
  if (i === 3 || i >= text.length) return null;
  const rest = text.slice(i);
  if (rest.length === 0 || isWS(rest[0])) return null;
  return { checked: m !== ' ', rest };
}

function renderBlocks(blocks, refs, tightList) {
  let out = '';
  for (const b of blocks) {
    switch (b.type) {
      case 'para': {
        let html = parseInline(b.text, refs);
        if (b.task) {
          html = (b.task === 'checked'
            ? '<input checked="" disabled="" type="checkbox">'
            : '<input disabled="" type="checkbox">') + ' ' + html;
        }
        if (tightList) out += html;
        else out += '<p>' + html + '</p>\n';
        break;
      }
      case 'heading':
        out += '<h' + b.level + '>' + parseInline(b.text, refs) + '</h' + b.level + '>\n';
        break;
      case 'code': {
        out += '<pre><code';
        if (b.fenced && b.info) out += ' class="language-' + escText(b.info) + '"';
        out += '>' + escEncode(b.text) + '</code></pre>\n';
        break;
      }
      case 'html':
        out += b.text;
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'blockquote':
        out += '<blockquote>\n' + renderBlocks(b.children, refs, false) + '</blockquote>\n';
        break;
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        out += '<' + tag;
        if (b.ordered && b.start !== 1) out += ' start="' + b.start + '"';
        out += '>\n';
        for (const item of b.items) {
          const first = item.children[0];
          if (first && first.type === 'para') {
            const ti = taskInfo(first.text);
            if (ti) { first.text = ti.rest; first.task = ti.checked ? 'checked' : 'unchecked'; }
          }
          out += '<li>';
          out += renderBlocks(item.children, refs, b.tight);
          out += '</li>\n';
        }
        out += '</' + tag + '>\n';
        break;
      }
      case 'table': {
        out += '<table>\n<thead>\n<tr>\n';
        for (let k = 0; k < b.header.length; k++) {
          out += '<th';
          if (b.align[k]) out += ' align="' + b.align[k] + '"';
          out += '>' + parseInline(b.header[k], refs) + '</th>\n';
        }
        out += '</tr>\n</thead>\n';
        if (b.rows.length > 0) {
          out += '<tbody>';
          for (const row of b.rows) {
            out += '<tr>\n';
            for (let k = 0; k < b.header.length; k++) {
              const cell = k < row.length ? row[k] : '';
              out += '<td';
              if (b.align[k]) out += ' align="' + b.align[k] + '"';
              out += '>' + parseInline(cell, refs) + '</td>\n';
            }
            out += '</tr>\n';
          }
          out += '</tbody>';
        }
        out += '</table>\n';
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- main entry

export function parse(markdown) {
  const src = markdown.replace(/\r\n?/g, '\n');
  const lines = splitLines(src);
  lines._inBlockquote = false;
  lines._srcEndsWithNL = src.endsWith('\n');
  const refs = new Map();
  _inLink = false;
  const { blocks } = parseBlocks(lines, refs);
  return renderBlocks(blocks, refs, false);
}
