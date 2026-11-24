/**
 * QR codes drawn in the terminal.
 *
 * Most terminals draw the half-block characters (▀ ▄ █) as exact halves of a
 * cell, so two rows of modules fit in each line. The classic Windows console
 * (conhost) draws them with the font's own glyphs instead. On Chinese, Japanese
 * and Korean Windows it forces a CJK font whose blocks are drawn wider than a
 * cell with gaps between them, and the code can't be scanned. Cells avoid
 * glyphs: each module is two spaces with a background color, which is exact
 * in any font but twice the size.
 */

import { createRequire } from 'module';
import qrcode from 'qrcode-terminal';
import { isClassicWindowsConsole, wideInConsole } from './windows-console.js';

export type QrStyle = 'halfBlocks' | 'cells';

interface QRCodeModel {
  addData(data: string): void;
  make(): void;
  modules: boolean[][]; // true = dark
}

const require = createRequire(import.meta.url);
// qrcode-terminal's encoder, to get the modules rather than its drawing
const QRCode = require('qrcode-terminal/vendor/QRCode') as new (typeNumber: number, level: number) => QRCodeModel;
const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel') as { L: number };

const LIGHT = '\x1b[107m'; // bright white background
const DARK = '\x1b[40m'; // black background
const RESET = '\x1b[0m';

/**
 * 'cells' in the classic Windows console. Cells draw correctly in any
 * terminal, so one taken for the classic console only gets a larger code.
 */
export function terminalQrStyle(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): QrStyle {
  return isClassicWindowsConsole(platform, env) ? 'cells' : 'halfBlocks';
}

/** The code as terminal lines, with a one-module light margin. */
export function renderQr(text: string, style: QrStyle): string[] {
  if (style === 'halfBlocks') {
    let output = '';
    qrcode.generate(text, { small: true }, (qr) => { output = qr; });
    return output.split('\n').filter((line) => line.length > 0);
  }

  const code = new QRCode(-1, QRErrorCorrectLevel.L); // the level qrcode-terminal uses
  code.addData(text);
  code.make();
  const size = code.modules.length + 2;
  const lines: string[] = [];
  for (let row = 0; row < size; row++) {
    let line = '';
    let dark: boolean | null = null;
    for (let col = 0; col < size; col++) {
      const isDark = code.modules[row - 1]?.[col - 1] === true;
      if (isDark !== dark) line += isDark ? DARK : LIGHT;
      dark = isDark;
      line += '  ';
    }
    lines.push(line + RESET);
  }
  return lines;
}

/** Print a code for a phone to scan, in the style this terminal draws correctly. */
export function printQr(text: string): void {
  const { stdout } = process;
  if (stdout.isTTY && terminalQrStyle() === 'cells') {
    const lines = renderQr(text, 'cells');
    // Cells are twice the size: use half blocks if cells don't fit on screen,
    // unless the console's font draws block characters wide and distorts them
    const fits = lines.length < (stdout.rows || 0) && lines.length * 2 <= (stdout.columns || 0);
    if (fits || wideInConsole('█▀▄').length > 0) {
      console.log(lines.join('\n'));
      return;
    }
  }
  qrcode.generate(text, { small: true });
}
