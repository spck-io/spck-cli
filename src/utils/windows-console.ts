/**
 * The classic Windows console (conhost), which still hosts cmd and PowerShell
 * on Windows 10 unless another terminal is installed, and how it draws text.
 */

import { execFileSync } from 'child_process';

/**
 * True in the classic Windows console. Other Windows terminals identify
 * themselves: Windows Terminal sets WT_SESSION, VS Code and others set
 * TERM_PROGRAM, ConEmu sets ConEmuPID, JetBrains IDEs set TERMINAL_EMULATOR,
 * and mintty/MSYS set TERM.
 */
export function isClassicWindowsConsole(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
  if (platform !== 'win32') return false;
  return !(env.WT_SESSION || env.TERM_PROGRAM || env.ConEmuPID || env.TERMINAL_EMULATOR || env.TERM);
}

/** The number in chcp's output ("Active code page: 936", localized) */
export function parseCodePage(chcpOutput: string): number | null {
  const match = /(\d+)\D*$/.exec(chcpOutput);
  return match ? Number(match[1]) : null;
}

let codePage: number | null | undefined;

/** The console's code page, or null when it can't be read. */
export function consoleCodePage(): number | null {
  if (codePage === undefined) {
    try {
      // chcp reports the console it's attached to: ours
      const output = execFileSync('chcp.com', { encoding: 'latin1', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000, windowsHide: true });
      codePage = parseCodePage(output);
    } catch {
      codePage = null;
    }
  }
  return codePage;
}

// Chinese, Japanese and Korean code pages, which encode some characters in two bytes
const DOUBLE_BYTE_ENCODINGS: Record<number, string> = { 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5' };
const doubleByteSets = new Map<string, Set<string>>();

function doubleByteChars(encoding: string): Set<string> {
  let chars = doubleByteSets.get(encoding);
  if (!chars) {
    // Decode every lead/trail byte pair; a space after each keeps the decoder in step
    const bytes: number[] = [];
    for (let lead = 0x81; lead <= 0xfe; lead++) {
      for (let trail = 0x40; trail <= 0xfe; trail++) bytes.push(lead, trail, 0x20);
    }
    const decoded = new TextDecoder(encoding).decode(new Uint8Array(bytes)).split(' ');
    chars = new Set(decoded.filter((ch) => ch.length === 1 && ch !== '�'));
    doubleByteSets.set(encoding, chars);
  }
  return chars;
}

/**
 * Those of `chars` that the classic console draws two columns wide. With a
 * Chinese, Japanese or Korean code page it switches to a CJK font, which draws
 * the symbols the code page encodes in two bytes (· ● … █) full width. Letters
 * such as é keep their usual half-width glyphs.
 */
export function wideInConsole(chars: string, cp: number | null = consoleCodePage()): string[] {
  const encoding = cp === null ? undefined : DOUBLE_BYTE_ENCODINGS[cp];
  if (!encoding) return [];
  const doubleByte = doubleByteChars(encoding);
  return [...chars].filter((ch) => doubleByte.has(ch) && !/\p{L}/u.test(ch));
}
