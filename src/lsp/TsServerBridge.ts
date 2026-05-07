import { LspBridge } from './LspBridge.js';
import { resolveLocalBin } from './resolve.js';

export function createTsServerBridge(rootPath: string): LspBridge {
  const { command, args } = resolveLocalBin('typescript-language-server', 'typescript-language-server');
  return new LspBridge(rootPath, {
    name: 'typescript-language-server',
    command,
    args: [...args, '--stdio'],
    languageIds: {
      '.ts': 'typescript',
      '.tsx': 'typescriptreact',
      '.mts': 'typescript',
      '.cts': 'typescript',
      '.js': 'javascript',
      '.jsx': 'javascriptreact',
      '.mjs': 'javascript',
      '.cjs': 'javascript',
    },
    initializationOptions: {
      preferences: {
        includeCompletionsForModuleExports: true,
        includeCompletionsWithInsertText: true,
      },
    },
  });
}
