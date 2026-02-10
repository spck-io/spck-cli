/**
 * Tests for SearchService - Line Trimming Functionality
 */

import { SearchService } from '../SearchService.js';

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

describe('SearchService - Search Functionality', () => {
  let service: SearchService;
  let testRoot: string;
  let mockSocket: any;

  beforeEach(async () => {
    const fs = require('fs/promises');
    const path = require('path');
    const os = require('os');

    // Create temporary test directory
    testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'search-test-'));
    service = new SearchService(testRoot, 10 * 1024 * 1024, 64 * 1024);

    // Create mock socket for RPC notifications
    mockSocket = {
      id: 'test-socket',
      data: { uid: 'test-user', deviceId: 'test-device' },
      emit: jest.fn(),
      on: jest.fn(),
      off: jest.fn(),
    };

    // Create test files
    await fs.writeFile(path.join(testRoot, 'file1.txt'), 'Hello world\nThis is a test\nAnother line');
    await fs.writeFile(path.join(testRoot, 'file2.txt'), 'Testing search\nNo matches here');
    await fs.writeFile(path.join(testRoot, 'file3.js'), 'const test = 42;\nconsole.log(test);');

    // Create subdirectory with files
    await fs.mkdir(path.join(testRoot, 'subdir'));
    await fs.writeFile(path.join(testRoot, 'subdir', 'nested.txt'), 'Nested test file\nWith multiple lines');
  });

  afterEach(async () => {
    const fs = require('fs/promises');
    // Clean up test directory
    try {
      await fs.rm(testRoot, { recursive: true, force: true });
    } catch {}
  });

  describe('handle method', () => {
    it('should handle findWithStream method', async () => {
      await expect(
        service.handle('findWithStream', {
          glob: '**/*.txt',
          maxResults: 10,
          maxLength: 100,
          searchTerm: 'test',
          matchCase: false,
          useRegEx: false,
          onlyWholeWords: false,
        }, mockSocket)
      ).resolves.not.toThrow();

      // Should have sent results to socket
      expect(mockSocket.emit).toHaveBeenCalled();
    });

    it('should throw error for unknown method', async () => {
      await expect(
        service.handle('unknownMethod', {}, mockSocket)
      ).rejects.toMatchObject({
        code: -32601, // METHOD_NOT_FOUND
        message: expect.stringContaining('Method not found'),
      });
    });
  });

  describe('findWithStream (Node.js implementation)', () => {
    it('should find matches in text files', async () => {
      const results: any[] = [];

      mockSocket.emit.mockImplementation((event: string, data: any) => {
        if (event === 'rpc' && data.method === 'search.results') {
          results.push(...data.params.results);
        }
      });

      await service.handle('findWithStream', {
        glob: '*.txt',  // Match .txt files in root
        maxResults: 100,
        maxLength: 100,
        searchTerm: 'test',
        matchCase: false,
        useRegEx: false,
        onlyWholeWords: false,
      }, mockSocket);

      // Should find matches in file1.txt
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r: any) => r.path.includes('file1.txt'))).toBe(true);
    });

    it('should respect case sensitivity', async () => {
      const results: any[] = [];

      mockSocket.emit.mockImplementation((event: string, data: any) => {
        if (event === 'rpc' && data.method === 'search.results') {
          results.push(...data.params.results);
        }
      });

      await service.handle('findWithStream', {
        glob: '**/*.txt',
        maxResults: 100,
        maxLength: 100,
        searchTerm: 'TEST',
        matchCase: true,
        useRegEx: false,
        onlyWholeWords: false,
      }, mockSocket);

      // Should not find matches (all lowercase in files)
      expect(results.length).toBe(0);
    });

    it('should support regex patterns', async () => {
      const results: any[] = [];

      mockSocket.emit.mockImplementation((event: string, data: any) => {
        if (event === 'rpc' && data.method === 'search.results') {
          results.push(...data.params.results);
        }
      });

      await service.handle('findWithStream', {
        glob: '**/*.txt',
        maxResults: 100,
        maxLength: 100,
        searchTerm: 't[eE]st',
        matchCase: false,
        useRegEx: true,
        onlyWholeWords: false,
      }, mockSocket);

      expect(results.length).toBeGreaterThan(0);
    });

    it('should respect whole word matching', async () => {
      const results: any[] = [];

      mockSocket.emit.mockImplementation((event: string, data: any) => {
        if (event === 'rpc' && data.method === 'search.results') {
          results.push(...data.params.results);
        }
      });

      await service.handle('findWithStream', {
        glob: '**/*.txt',
        maxResults: 100,
        maxLength: 100,
        searchTerm: 'test',
        matchCase: false,
        useRegEx: false,
        onlyWholeWords: true,
      }, mockSocket);

      // Should find whole word "test" but not "Testing"
      const matchValues = results.map((r: any) => r.value);
      expect(matchValues).toContain('test');
      expect(matchValues.some((v: string) => v.toLowerCase() === 'testing')).toBe(false);
    });

    it('should respect maxResults limit', async () => {
      const results: any[] = [];

      mockSocket.emit.mockImplementation((event: string, data: any) => {
        if (event === 'rpc' && data.method === 'search.results') {
          results.push(...data.params.results);
        }
      });

      await service.handle('findWithStream', {
        glob: '**/*',
        maxResults: 2,
        maxLength: 100,
        searchTerm: 'test',
        matchCase: false,
        useRegEx: false,
        onlyWholeWords: false,
      }, mockSocket);

      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('should filter by glob pattern', async () => {
      const results: any[] = [];

      mockSocket.emit.mockImplementation((event: string, data: any) => {
        if (event === 'rpc' && data.method === 'search.results') {
          results.push(...data.params.results);
        }
      });

      await service.handle('findWithStream', {
        glob: '**/*.js',
        maxResults: 100,
        maxLength: 100,
        searchTerm: 'test',
        matchCase: false,
        useRegEx: false,
        onlyWholeWords: false,
      }, mockSocket);

      // Should only find matches in .js files
      expect(results.every((r: any) => r.path.endsWith('.js'))).toBe(true);
    });

    it('should send completion notification', async () => {
      await service.handle('findWithStream', {
        glob: '**/*.txt',
        maxResults: 100,
        maxLength: 100,
        searchTerm: 'test',
        matchCase: false,
        useRegEx: false,
        onlyWholeWords: false,
      }, mockSocket);

      // Find the done notification
      const doneCall = mockSocket.emit.mock.calls.find((call: any) =>
        call[0] === 'rpc' &&
        call[1].method === 'search.results' &&
        call[1].params.done === true
      );

      expect(doneCall).toBeDefined();
      expect(doneCall[1].params.total).toBeGreaterThanOrEqual(0);
    });

    it('should include correct match positions', async () => {
      const results: any[] = [];

      mockSocket.emit.mockImplementation((event: string, data: any) => {
        if (event === 'rpc' && data.method === 'search.results') {
          results.push(...data.params.results);
        }
      });

      await service.handle('findWithStream', {
        glob: 'file1.txt',  // Match specific file
        maxResults: 100,
        maxLength: 100,
        searchTerm: 'test',
        matchCase: false,
        useRegEx: false,
        onlyWholeWords: false,
      }, mockSocket);

      expect(results.length).toBeGreaterThan(0);
      const match = results[0];

      // Verify match structure
      expect(match).toHaveProperty('start');
      expect(match).toHaveProperty('end');
      expect(match).toHaveProperty('line');
      expect(match).toHaveProperty('value');
      expect(match).toHaveProperty('match');
      expect(match).toHaveProperty('path');

      // Verify value is extracted correctly from line
      expect(match.line.substring(match.match.start, match.match.end)).toBe(match.value);
    });
  });

  describe('cleanup', () => {
    it('should cleanup without errors', () => {
      expect(() => service.cleanup()).not.toThrow();
    });
  });
});
