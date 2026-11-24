import { afterEach, describe, expect, it, vi } from 'vitest';
import qrcode from 'qrcode-terminal';
import { printQr, renderQr, terminalQrStyle } from '../qr.js';

// The classic console's font is measured at startup: pin it
const font = vi.hoisted(() => ({ cjk: false as boolean | null }));
vi.mock('../windows-console.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../windows-console.js')>()),
  consoleHasCjkFont: () => font.cjk,
}));

const URL_TEXT = 'spck://connect?clientId=abcdefghijkl&secret=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQR&rs=cli-na-1.spck.io';

/** Light (true) / dark (false) modules of a half-block drawing, margin included. */
function halfBlockModules(lines: string[]): boolean[][] {
  const rows = lines.flatMap((line) => [
    [...line].map((ch) => ch === '█' || ch === '▀'),
    [...line].map((ch) => ch === '█' || ch === '▄'),
  ]);
  // The top half of the first line is outside the code, and so is the bottom
  // half of the last one when the code has an odd number of rows
  const size = lines[0].length;
  return rows.slice(1, 1 + size);
}

/** Light (true) / dark (false) modules of a cell drawing. */
function cellModules(lines: string[]): boolean[][] {
  return lines.map((line) => {
    const modules: boolean[] = [];
    let light = false;
    for (const [, color, cell] of line.matchAll(/\x1b\[(\d+)m|( {2})/g)) {
      if (color) light = color === '107';
      else if (cell) modules.push(light);
    }
    return modules;
  });
}

describe('terminalQrStyle()', () => {
  afterEach(() => { font.cjk = false; });

  it('uses half blocks outside Windows', () => {
    font.cjk = true;
    expect(terminalQrStyle('linux', {})).toBe('halfBlocks');
    expect(terminalQrStyle('darwin', {})).toBe('halfBlocks');
  });

  it('uses half blocks in the classic Windows console with a font like Consolas', () => {
    expect(terminalQrStyle('win32', {})).toBe('halfBlocks');
  });

  it('uses cells in the classic Windows console with a CJK font, which draws blocks wide', () => {
    font.cjk = true;
    expect(terminalQrStyle('win32', {})).toBe('cells');
  });

  it('uses cells in the classic Windows console when its font is unknown', () => {
    font.cjk = null;
    expect(terminalQrStyle('win32', {})).toBe('cells');
  });

  it.each([
    ['WT_SESSION', 'f2c4d6e8-0000-0000-0000-000000000000'],
    ['TERM_PROGRAM', 'vscode'],
    ['ConEmuPID', '1234'],
    ['TERMINAL_EMULATOR', 'JetBrains-JediTerm'],
    ['TERM', 'xterm-256color'],
  ])('uses half blocks in Windows terminals that set %s', (name, value) => {
    font.cjk = null;
    expect(terminalQrStyle('win32', { [name]: value })).toBe('halfBlocks');
  });
});

describe('renderQr()', () => {
  it('draws half blocks exactly as qrcode-terminal does', () => {
    let expected = '';
    qrcode.generate(URL_TEXT, { small: true }, (output) => { expected = output; });
    expect(renderQr(URL_TEXT, 'halfBlocks').join('\n')).toBe(expected.trimEnd());
  });

  it('draws cells as square modules of spaces on colored backgrounds', () => {
    const lines = renderQr(URL_TEXT, 'cells');
    for (const line of lines) {
      const plain = line.replace(/\x1b\[\d+m/g, '');
      expect(plain).toMatch(/^ +$/);
      expect(plain.length).toBe(lines.length * 2);
      expect(line.endsWith('\x1b[0m')).toBe(true);
    }
  });

  it('draws the same code in both styles', () => {
    const cells = cellModules(renderQr(URL_TEXT, 'cells'));
    expect(cells).toEqual(halfBlockModules(renderQr(URL_TEXT, 'halfBlocks')));
    // A light margin all around
    expect(cells[0].every(Boolean)).toBe(true);
    expect(cells[cells.length - 1].every(Boolean)).toBe(true);
    expect(cells.every((row) => row[0] && row[row.length - 1])).toBe(true);
  });
});

describe('printQr()', () => {
  const original = { platform: process.platform, isTTY: process.stdout.isTTY };

  function classicWindowsConsole(isTTY = true) {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    for (const name of ['WT_SESSION', 'TERM_PROGRAM', 'ConEmuPID', 'TERMINAL_EMULATOR', 'TERM']) vi.stubEnv(name, undefined);
    Object.assign(process.stdout, { isTTY });
  }

  afterEach(() => {
    font.cjk = false;
    Object.defineProperty(process, 'platform', { value: original.platform });
    Object.assign(process.stdout, { isTTY: original.isTTY });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('prints half blocks in the classic Windows console with a font like Consolas', () => {
    classicWindowsConsole();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    printQr(URL_TEXT);
    expect(log).toHaveBeenCalledExactlyOnceWith(renderQr(URL_TEXT, 'halfBlocks').join('\n'));
  });

  it('prints cells in the classic Windows console with a CJK font', () => {
    classicWindowsConsole();
    font.cjk = true;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    printQr(URL_TEXT);
    // Even when taller than the window: it scrolls, and half blocks couldn't be scanned
    expect(log).toHaveBeenCalledExactlyOnceWith(renderQr(URL_TEXT, 'cells').join('\n'));
  });

  it('prints half blocks, without colors, when the output is not a terminal', () => {
    classicWindowsConsole(false);
    font.cjk = true;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    printQr(URL_TEXT);
    expect(log).toHaveBeenCalledExactlyOnceWith(renderQr(URL_TEXT, 'halfBlocks').join('\n'));
  });
});
