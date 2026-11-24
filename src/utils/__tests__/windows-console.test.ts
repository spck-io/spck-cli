import { describe, expect, it } from 'vitest';
import { isClassicWindowsConsole, parseCodePage, wideInConsole } from '../windows-console.js';

describe('isClassicWindowsConsole()', () => {
  it('is false outside Windows', () => {
    expect(isClassicWindowsConsole('linux', {})).toBe(false);
    expect(isClassicWindowsConsole('darwin', {})).toBe(false);
  });

  it('is true on Windows when no other terminal identifies itself', () => {
    expect(isClassicWindowsConsole('win32', {})).toBe(true);
  });

  it.each([
    ['WT_SESSION', 'f2c4d6e8-0000-0000-0000-000000000000'],
    ['TERM_PROGRAM', 'vscode'],
    ['ConEmuPID', '1234'],
    ['TERMINAL_EMULATOR', 'JetBrains-JediTerm'],
    ['TERM', 'xterm-256color'],
  ])('is false in Windows terminals that set %s', (name, value) => {
    expect(isClassicWindowsConsole('win32', { [name]: value })).toBe(false);
  });
});

describe('parseCodePage()', () => {
  it('reads chcp output in any language', () => {
    expect(parseCodePage('Active code page: 936\r\n')).toBe(936);
    expect(parseCodePage('活动代码页: 936\r\n')).toBe(936);
    expect(parseCodePage('Page de codes active : 850.\r\n')).toBe(850);
    expect(parseCodePage('')).toBeNull();
  });
});

describe('wideInConsole()', () => {
  // As a Chinese Windows 10 console (code page 936) stores them: checked
  // against its screen buffer
  it('finds the symbols a Chinese code page draws two columns wide', () => {
    expect(wideInConsole('·●○★↑→—…’“█▀▄', 936)).toEqual([...'·●○★↑→—…’“█▄']);
  });

  it('keeps letters narrow, which have half-width glyphs', () => {
    expect(wideInConsole('éóàüñ', 936)).toEqual([]);
  });

  it('follows the code page: Japanese has no middle dot or blocks', () => {
    expect(wideInConsole('·●█', 932)).toEqual(['●']);
  });

  it('finds none with other code pages', () => {
    for (const cp of [437, 850, 1252, 65001]) expect(wideInConsole('·●○█▀▄—…', cp)).toEqual([]);
    expect(wideInConsole('·●', null)).toEqual([]);
  });
});
