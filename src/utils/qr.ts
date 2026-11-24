/**
 * QR codes drawn in the terminal.
 *
 * Most terminals draw the half-block characters (▀ ▄ █) as exact halves of a
 * cell, so two rows of modules fit in each line. The classic Windows console
 * (conhost) draws them with the font's own glyphs instead. That works in
 * Consolas or Lucida Console, but Chinese fonts (which Chinese Windows uses
 * for cmd and PowerShell) draw █ and ▄ wider than a cell, over the next one,
 * and the code can't be scanned. Cells avoid glyphs: each module is two spaces
 * with a background color, which is exact in any font but twice the size.
 */

import { createRequire } from 'module';
import qrcode from 'qrcode-terminal';
import { consoleHasCjkFont, isClassicWindowsConsole } from './windows-console.js';

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
 * 'cells' in the classic Windows console with a Chinese, Japanese or Korean
 * font, or whose font wasn't measured: cells are exact in any font. (Japanese
 * fonts draw half blocks correctly, but measuring can't tell them apart.)
 */
export function terminalQrStyle(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): QrStyle {
  if (!isClassicWindowsConsole(platform, env)) return 'halfBlocks';
  return consoleHasCjkFont() === false ? 'halfBlocks' : 'cells';
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
  // Cells may be taller than the window, but the output scrolls
  const style = process.stdout.isTTY ? terminalQrStyle() : 'halfBlocks';
  console.log(renderQr(text, style).join('\n'));
}
