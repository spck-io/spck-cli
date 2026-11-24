/**
 * The classic Windows console (conhost), which still hosts cmd and PowerShell
 * on Windows 10 unless another terminal is installed, and how it lays out text.
 */

import type { Readable, Writable } from 'stream';

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

export interface ConsoleInput extends Readable {
  isRaw: boolean;
  setRawMode(mode: boolean): unknown;
}

const ENTER_ALT_SCREEN = '\x1b[?1049h';
const LEAVE_ALT_SCREEN = '\x1b[?1049l';
const CURSOR_POSITION_REPORT = /\x1b\[\d+;(\d+)R/;
// Two columns wide in Chinese, Japanese and Korean fonts, one in the others
const CJK_FONT_PROBE = '…';

/** Of the measured symbols, those the console lays out two columns wide; null before measuring or if it didn't answer. */
let wideChars: Set<string> | null = null;

/**
 * Measure how the console lays out `chars`. It doesn't report its font, and
 * the font decides: Chinese, Japanese and Korean fonts take two columns for
 * symbols like · ● … ↑ “, Lucida Console takes two for ●, and every font
 * takes two for ★. Code pages don't tell: a CJK font can stay in use after
 * `chcp 65001`.
 *
 * Each symbol is printed at the start of a line, then the console is asked
 * where the cursor went. One at a time: Windows 10 answers several requests
 * in reverse order. On the alternate screen, which the dashboard draws on:
 * after a code page change it can keep the widths of the console's original
 * font while the main screen uses the new one.
 *
 * Run it before anything else reads the input. Keys typed meanwhile are kept.
 */
export async function measureConsoleWidths(
  chars: string,
  input: ConsoleInput = process.stdin as ConsoleInput,
  output: Writable = process.stdout,
  timeoutMs = 500,
): Promise<void> {
  wideChars = await measure([...new Set(chars + CJK_FONT_PROBE)], input, output, timeoutMs);
}

function measure(chars: string[], input: ConsoleInput, output: Writable, timeoutMs: number): Promise<Set<string> | null> {
  return new Promise((resolve) => {
    const wasRaw = input.isRaw;
    try {
      input.setRawMode(true);
    } catch {
      resolve(null); // not a console
      return;
    }

    const wide = new Set<string>();
    let index = -1;
    let typed = '';
    const next = () => {
      index++;
      if (index === chars.length) finish(wide);
      else output.write(`\r${chars[index]}\x1b[6n`);
    };
    const onData = (data: Buffer) => {
      typed += data.toString('latin1');
      const reply = CURSOR_POSITION_REPORT.exec(typed);
      if (!reply) return;
      typed = typed.slice(0, reply.index) + typed.slice(reply.index + reply[0].length);
      // Printed from column 1, so a two-column symbol leaves the cursor in column 3
      if (Number(reply[1]) > 2) wide.add(chars[index]);
      next();
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    function finish(result: Set<string> | null) {
      clearTimeout(timer);
      input.off('data', onData);
      // Leave the alternate screen before raw mode, as the dashboard does (see Dashboard.stop)
      output.write('\r\x1b[K' + LEAVE_ALT_SCREEN);
      input.pause();
      if (!wasRaw) input.setRawMode(false);
      if (typed) input.unshift(Buffer.from(typed, 'latin1'));
      resolve(result);
    }

    input.on('data', onData);
    input.resume();
    output.write(ENTER_ALT_SCREEN);
    next();
  });
}

/** Those of `chars` the console lays out two columns wide, as measured; none before measuring. */
export function wideInConsole(chars: string): string[] {
  return wideChars ? [...chars].filter((ch) => wideChars!.has(ch)) : [];
}

/** Whether the console uses a Chinese, Japanese or Korean font; null if it wasn't measured. */
export function consoleHasCjkFont(): boolean | null {
  return wideChars ? wideChars.has(CJK_FONT_PROBE) : null;
}
