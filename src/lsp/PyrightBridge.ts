import { LspBridge } from './LspBridge.js';
import { resolveLocalBin } from './resolve.js';

export function createPyrightBridge(rootPath: string): LspBridge {
  const { command, args } = resolveLocalBin('pyright', 'pyright-langserver');
  return new LspBridge(rootPath, {
    name: 'pyright',
    command,
    args: [...args, '--stdio'],
    languageIds: { '.py': 'python', '.pyi': 'python' },
  });
}
