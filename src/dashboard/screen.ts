/**
 * ANSI-aware text helpers for laying out the dashboard.
 */

// CSI sequences (colors, cursor) and OSC sequences (hyperlinks, titles)
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ANSI_AT_START = new RegExp('^(?:' + ANSI_PATTERN.source + ')');

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/** Terminal column width of a code point (wide East Asian / emoji = 2). */
function charWidth(cp: number): number {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp >= 0x300 && cp <= 0x36f) return 0; // combining marks
  if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0; // ZWJ, variation selectors
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

export function visibleWidth(text: string): number {
  let width = 0;
  for (const ch of stripAnsi(text)) width += charWidth(ch.codePointAt(0)!);
  return width;
}

/**
 * Cut a (possibly colored) string to at most `width` columns. Escape
 * sequences are kept so colors stay intact; a reset is appended if the
 * string contained any.
 */
export function truncate(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  let out = '';
  let used = 0;
  let hadAnsi = false;
  let i = 0;
  while (i < text.length) {
    const escape = text[i] === '\x1b' ? ANSI_AT_START.exec(text.slice(i)) : null;
    if (escape) {
      out += escape[0];
      hadAnsi = true;
      i += escape[0].length;
      continue;
    }
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    const w = charWidth(ch.codePointAt(0)!);
    if (used + w > width) break;
    out += ch;
    used += w;
    i += ch.length;
  }
  return hadAnsi ? out + '\x1b[0m' : out;
}

/** Pad (or truncate) to exactly `width` columns. */
export function fit(text: string, width: number): string {
  const cut = truncate(text, width);
  return cut + ' '.repeat(Math.max(0, width - visibleWidth(cut)));
}

/** Word-wrap plain text to `width` columns. */
export function wrap(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (visibleWidth(candidate) <= width) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      line = visibleWidth(word) > width ? truncate(word, width) : word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

/** "45s", "12m", "3h 05m", "2d 4h" */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** "512 B", "50 KB", "1.2 MB" */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}
