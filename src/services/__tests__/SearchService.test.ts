/**
 * Tests for SearchService - Line Trimming Functionality
 */

import { SearchService } from '../SearchService';

// Mock ripgrep utilities to prevent spawning child processes during tests
jest.mock('../../utils/ripgrep', () => ({
  isRipgrepAvailable: jest.fn().mockResolvedValue(false),
  executeRipgrep: jest.fn(),
  executeRipgrepStream: jest.fn(),
}));

describe('SearchService - Line Trimming', () => {
  let service: SearchService;

  beforeEach(() => {
    service = new SearchService(process.cwd(), 10 * 1024 * 1024, 64 * 1024);
  });

  // Helper to access private trimLineToMatch method
  function trimLineToMatch(
    lineText: string,
    matchStart: number,
    matchEnd: number,
    maxLength: number
  ): { line: string; offset: number } {
    return (service as any).trimLineToMatch(lineText, matchStart, matchEnd, maxLength);
  }

  describe('trimLineToMatch', () => {
    it('should return full line if shorter than maxLength', () => {
      const lineText = 'Short line with test';
      const result = trimLineToMatch(lineText, 16, 20, 100);

      expect(result.line).toBe(lineText);
      expect(result.offset).toBe(0);
    });

    it('should trim long line and center match', () => {
      const lineText = 'This is a very long line with the word test in the middle and more content after';
      const matchStart = lineText.indexOf('test'); // position of "test" = 39
      const matchEnd = matchStart + 4; // 43
      const maxLength = 40;

      const result = trimLineToMatch(lineText, matchStart, matchEnd, maxLength);

      expect(result.line.length).toBeLessThanOrEqual(maxLength);
      expect(result.line).toContain('test');

      // Verify match is in the trimmed line
      const relativeStart = matchStart - result.offset;
      const relativeEnd = matchEnd - result.offset;
      expect(result.line.substring(relativeStart, relativeEnd)).toBe('test');
    });

    it('should handle match at start of line', () => {
      const lineText = 'test is at the start of this very long line with lots of content';
      const matchStart = 0;
      const matchEnd = 4;
      const maxLength = 30;

      const result = trimLineToMatch(lineText, matchStart, matchEnd, maxLength);

      expect(result.line.length).toBeLessThanOrEqual(maxLength);
      expect(result.line).toMatch(/^test/);
      expect(result.offset).toBe(0);
    });

    it('should handle match at end of line', () => {
      const lineText = 'This is a very long line with lots of content and the match is at the end test';
      const matchStart = lineText.indexOf('test'); // position of "test" = 75
      const matchEnd = matchStart + 4; // 79
      const maxLength = 30;

      const result = trimLineToMatch(lineText, matchStart, matchEnd, maxLength);

      expect(result.line.length).toBeLessThanOrEqual(maxLength);
      expect(result.line).toMatch(/test$/);

      // Verify offset is calculated correctly
      const relativeStart = matchStart - result.offset;
      expect(result.line.substring(relativeStart)).toBe('test');
    });

    it('should handle match longer than maxLength', () => {
      const lineText = 'Before verylongmatchthatexceedsmaxlength After';
      const matchStart = 7;
      const matchEnd = 40;
      const maxLength = 20;

      const result = trimLineToMatch(lineText, matchStart, matchEnd, maxLength);

      expect(result.line.length).toBeLessThanOrEqual(maxLength);
      expect(result.offset).toBe(matchStart);
      expect(result.line).toMatch(/^verylongmatch/);
    });

    it('should handle maxLength of 38 (actual UI value)', () => {
      const lineText = 'Some code before the test keyword and some code after it';
      const matchStart = 21; // position of "test"
      const matchEnd = 25;
      const maxLength = 38;

      const result = trimLineToMatch(lineText, matchStart, matchEnd, maxLength);

      expect(result.line.length).toBeLessThanOrEqual(maxLength);
      expect(result.line).toContain('test');

      // Verify match positions are correct
      const relativeStart = matchStart - result.offset;
      const relativeEnd = matchEnd - result.offset;
      expect(result.line.substring(relativeStart, relativeEnd)).toBe('test');
    });

    it('should handle invalid maxLength (0 or negative)', () => {
      const lineText = 'Line with test';
      const result = trimLineToMatch(lineText, 10, 14, 0);

      // Should use default maxLength of 500
      expect(result.line).toBe(lineText);
      expect(result.offset).toBe(0);
    });

    it('should handle invalid match positions', () => {
      const lineText = 'Valid line text';

      // matchStart >= matchEnd
      const result1 = trimLineToMatch(lineText, 10, 10, 50);
      expect(result1.line).toBe(lineText);

      // matchStart < 0
      const result2 = trimLineToMatch(lineText, -1, 5, 50);
      expect(result2.line).toBe(lineText);

      // matchEnd > lineText.length
      const result3 = trimLineToMatch(lineText, 5, 100, 50);
      expect(result3.line).toBe(lineText);
    });

    it('should provide equal context on both sides when possible', () => {
      const lineText = 'aaaaaaaaaa test bbbbbbbbbb'; // 10 chars before and after "test"
      const matchStart = 11;
      const matchEnd = 15;
      const maxLength = 20; // 4 for match + 16 for context = 8 per side

      const result = trimLineToMatch(lineText, matchStart, matchEnd, maxLength);

      expect(result.line.length).toBeLessThanOrEqual(maxLength);
      expect(result.line).toContain('test');

      // Should have roughly equal context (allowing for word boundaries)
      const relativeStart = matchStart - result.offset;
      const beforeMatch = result.line.substring(0, relativeStart);
      const afterMatch = result.line.substring(relativeStart + 4);

      // Allow for some imbalance due to word boundaries and ellipsis
      expect(Math.abs(beforeMatch.length - afterMatch.length)).toBeLessThanOrEqual(8);
    });

    it('should handle unicode characters correctly', () => {
      const lineText = 'Some 中文 before test and 中文 after';
      const matchStart = lineText.indexOf('test'); // position of "test"
      const matchEnd = matchStart + 4;
      const maxLength = 30;

      const result = trimLineToMatch(lineText, matchStart, matchEnd, maxLength);

      expect(result.line).toContain('test');
      expect(result.line).toContain('中文');

      const relativeStart = matchStart - result.offset;
      const relativeEnd = matchEnd - result.offset;
      expect(result.line.substring(relativeStart, relativeEnd)).toBe('test');
    });

    it('should handle very long minified line (realistic scenario)', () => {
      // Simulate a minified JavaScript line
      const minifiedLine = 'function(){var a=1,b=2,c=3,d=4,e=5,f=6,g=7,h=8,i=9,j=10,k=11,l=12,m=13,n=14,o=15,p=16,q=17,r=18,s=19,t=20,u=21,v=22,w=23,x=24,y=25,z=26;return console.log("test")}'.repeat(10);
      const searchTerm = 'test';
      const matchStart = minifiedLine.indexOf(searchTerm);
      const matchEnd = matchStart + searchTerm.length;
      const maxLength = 38;

      const result = trimLineToMatch(minifiedLine, matchStart, matchEnd, maxLength);

      expect(result.line.length).toBeLessThanOrEqual(maxLength);
      expect(result.line).toContain('test');
      expect(result.line.length).toBeGreaterThan(0);

      // Verify the match is correctly positioned
      const relativeStart = matchStart - result.offset;
      const relativeEnd = matchEnd - result.offset;
      expect(result.line.substring(relativeStart, relativeEnd)).toBe('test');
    });

    it('should handle match at exact maxLength boundary', () => {
      const lineText = 'x'.repeat(100);
      const modifiedLine = lineText.substring(0, 50) + 'test' + lineText.substring(54);
      const matchStart = 50;
      const matchEnd = 54;
      const maxLength = 54; // Exactly match + all before

      const result = trimLineToMatch(modifiedLine, matchStart, matchEnd, maxLength);

      expect(result.line).toContain('test');
      expect(result.line.length).toBeLessThanOrEqual(maxLength);
    });
  });
});
