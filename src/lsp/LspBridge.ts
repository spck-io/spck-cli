// Translates LSC-shaped messages (workers/server.ts protocol) to/from LSP.
// Per-server config (command, languageIds) is supplied at construction so
// pyright-langserver and typescript-language-server share this class.
//
// Why mutate the request: LSC's wire contract (see workers/server.ts) is
// "augment the incoming request with response fields and ship it back".
// handleMessage preserves that so the browser-side LSC client decoder works
// without any branching.

import * as path from 'path';
import * as url from 'url';
import { LspProcess } from './LspProcess.js';

export interface LspBridgeConfig {
  // Display name (e.g. "pyright", "typescript-language-server").
  name: string;
  command: string;
  args?: string[];
  // LSP languageId per file extension, e.g. { '.py': 'python' }
  languageIds: Record<string, string>;
  // Optional initialization options passed to LSP `initialize`.
  initializationOptions?: any;
}

export interface LscRequest {
  type?: string;
  types?: string[];
  name?: string;
  newName?: string;
  directoryName?: string;
  position?: { line: number; character: number };
  triggerCharacter?: string;
  text?: string;
  edits?: any[];
  contentLength?: number;
  mode?: string;
  id?: number;
  // Response fields (populated by handleMessage)
  info?: any;
  completions?: any[];
  signature?: any;
  validate?: any[];
  def?: any;
  refs?: any[];
  rename?: any;
  renameInfo?: any;
  missing?: boolean;
}

interface OpenDoc {
  uri: string;
  text: string;
  version: number;
  languageId: string;
}

const FENCE_RE = /```[^\n]*\n([\s\S]*?)```/g;

export class LspBridge {
  private proc: LspProcess;
  private docs: Map<string, OpenDoc> = new Map(); // by absolute path
  private diagnostics: Map<string, any[]> = new Map(); // by absolute path
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private rootPath: string;
  private rootPathWithSep: string;

  constructor(rootPath: string, private cfg: LspBridgeConfig) {
    this.rootPath = path.resolve(rootPath);
    this.rootPathWithSep = this.rootPath + path.sep;
    this.proc = new LspProcess({
      command: cfg.command,
      args: cfg.args,
      cwd: this.rootPath,
      name: cfg.name,
    });
  }

  // Ensure the language server is spawned and initialized exactly once.
  async ensureStarted(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      this.proc.start();
      this.proc.onNotification((method, params) => this.onNotification(method, params));
      const rootUri = url.pathToFileURL(this.rootPath).href;
      await this.proc.request('initialize', {
        processId: process.pid,
        rootUri,
        rootPath: this.rootPath,
        capabilities: this.clientCapabilities(),
        initializationOptions: this.cfg.initializationOptions,
        workspaceFolders: [{ uri: rootUri, name: path.basename(this.rootPath) }],
      }, 30000);
      this.proc.notify('initialized', {});
      // Pyright won't start analysis until it receives didChangeConfiguration;
      // empty settings let it use its own defaults and is a no-op for tsserver.
      this.proc.notify('workspace/didChangeConfiguration', { settings: {} });
      this.initialized = true;
    })();
    return this.initPromise;
  }

  async stop(): Promise<void> {
    if (!this.initialized && !this.initPromise) return;
    try {
      if (this.initialized) await this.proc.request('shutdown', null, 5000).catch(() => {});
    } finally {
      await this.proc.stop();
    }
  }

  supportsExt(ext: string): boolean {
    return ext in this.cfg.languageIds;
  }

  // Main entry: translate one LSC request, return augmented request.
  async handleMessage(req: LscRequest): Promise<LscRequest> {
    await this.ensureStarted();
    const types = req.types && req.types.length ? req.types : (req.type ? [req.type] : []);
    for (const type of types) {
      try {
        await this.dispatch(type, req);
      } catch (err: any) {
        console.error(`[${this.cfg.name}] error handling ${type}:`, err?.message || err);
        // Editor expects a response; mark missing so the client can fall back.
        if (this.isQueryType(type)) req.missing = true;
      }
    }
    return req;
  }

  // ---- internals ----

  private isQueryType(type: string): boolean {
    return ['completion', 'info', 'signature', 'validate', 'def', 'ref', 'rename', 'renameInfo'].includes(type);
  }

  private async dispatch(type: string, req: LscRequest): Promise<void> {
    switch (type) {
      case 'add':
      case 'update':
        return this.openOrUpdate(req.name!, req.text || '');
      case 'edit':
        return this.applyEdits(req);
      case 'remove':
        return this.close(req.name!);
      case 'removeFolder':
        return this.closeFolder(req.name!);
      case 'move':
        await this.close(req.name!);
        if (req.text != null) await this.openOrUpdate(req.newName!, req.text);
        return;
      case 'moveFolder':
        return this.moveFolder(req.name!, req.newName!);
      case 'setCurrentDirectory':
        return; // tracked at the service layer; LSP servers infer from rootUri
      case 'clear':
        return this.clearAll();
      case 'completion':
        return this.completion(req);
      case 'info':
        return this.info(req);
      case 'signature':
        return this.signature(req);
      case 'validate':
        return this.validate(req);
      case 'def':
        return this.definition(req);
      case 'ref':
        return this.references(req);
      case 'rename':
        return this.rename(req);
      case 'renameInfo':
        return this.renameInfo(req);
    }
  }

  private clientCapabilities(): any {
    return {
      textDocument: {
        synchronization: { dynamicRegistration: false, willSave: false, didSave: false },
        completion: { completionItem: { snippetSupport: false, documentationFormat: ['plaintext'] } },
        hover: { contentFormat: ['plaintext', 'markdown'] },
        signatureHelp: { signatureInformation: { documentationFormat: ['plaintext'] } },
        definition: {},
        references: {},
        rename: { prepareSupport: true },
        publishDiagnostics: {},
      },
      workspace: {
        configuration: true,
        workspaceFolders: true,
      },
      window: { workDoneProgress: true },
    };
  }

  private toRelPath(absPath: string): string {
    if (absPath.startsWith(this.rootPathWithSep) || absPath === this.rootPath) {
      return absPath.slice(this.rootPath.length) || path.sep;
    }
    return absPath;
  }

  private locationToTextSpan(loc: any): any {
    return {
      fileName: this.toRelPath(url.fileURLToPath(loc.uri)),
      textSpan: {
        startPosition: { row: loc.range.start.line, column: loc.range.start.character },
        endPosition: { row: loc.range.end.line, column: loc.range.end.character },
        start: 0,
        length: 0,
      },
    };
  }

  private resolveAbs(name: string): string {
    // Paths already under rootPath pass through unchanged.
    if (name === this.rootPath || name.startsWith(this.rootPathWithSep)) return name;
    // Server-relative paths from the RLSC client start with '/' but are
    // relative to rootPath, not the OS root — strip the leading separator.
    const rel = name.startsWith(path.sep) ? name.slice(path.sep.length) : name;
    return path.resolve(this.rootPath, rel);
  }

  private toUri(name: string): string {
    return url.pathToFileURL(this.resolveAbs(name)).href;
  }

  private extOf(name: string): string {
    return path.extname(name).toLowerCase();
  }

  private languageIdFor(name: string): string | null {
    return this.cfg.languageIds[this.extOf(name)] || null;
  }

  private onNotification(method: string, params: any): void {
    if (method === 'textDocument/publishDiagnostics') {
      const filePath = url.fileURLToPath(params.uri);
      this.diagnostics.set(filePath, params.diagnostics || []);
    }
  }

  // ---- file sync ----

  private async openOrUpdate(name: string, text: string): Promise<void> {
    const languageId = this.languageIdFor(name);
    if (!languageId) return;
    const abs = this.resolveAbs(name);
    const uri = this.toUri(name);
    const existing = this.docs.get(abs);
    if (!existing) {
      this.docs.set(abs, { uri, text, version: 1, languageId });
      this.proc.notify('textDocument/didOpen', {
        textDocument: { uri, languageId, version: 1, text },
      });
    } else {
      existing.version += 1;
      existing.text = text;
      this.proc.notify('textDocument/didChange', {
        textDocument: { uri, version: existing.version },
        contentChanges: [{ text }],
      });
    }
  }

  private async applyEdits(req: LscRequest): Promise<void> {
    const abs = this.resolveAbs(req.name!);
    const doc = this.docs.get(abs);
    if (!doc) { req.missing = true; return; }
    const edits = req.edits || [];
    doc.text = applyLspEdits(doc.text, edits);
    doc.version += 1;
    this.proc.notify('textDocument/didChange', {
      textDocument: { uri: doc.uri, version: doc.version },
      contentChanges: edits.map((e: any) => ({ range: e.range, text: e.newText })),
    });
    if (req.contentLength != null && doc.text.length !== req.contentLength) {
      // Doc is out of sync (e.g. git changed the file). Close so the next
      // addFile triggers a fresh didOpen with the correct content.
      this.proc.notify('textDocument/didClose', { textDocument: { uri: doc.uri } });
      this.docs.delete(abs);
      this.diagnostics.delete(abs);
      req.missing = true;
    }
  }

  private async close(name: string): Promise<void> {
    const abs = this.resolveAbs(name);
    const doc = this.docs.get(abs);
    if (!doc) return;
    this.proc.notify('textDocument/didClose', { textDocument: { uri: doc.uri } });
    this.docs.delete(abs);
    this.diagnostics.delete(abs);
  }

  private async closeFolder(name: string): Promise<void> {
    const folderAbs = this.resolveAbs(name);
    const prefix = folderAbs.endsWith(path.sep) ? folderAbs : folderAbs + path.sep;
    for (const abs of Array.from(this.docs.keys())) {
      if (abs === folderAbs || abs.startsWith(prefix)) {
        const doc = this.docs.get(abs)!;
        this.proc.notify('textDocument/didClose', { textDocument: { uri: doc.uri } });
        this.docs.delete(abs);
        this.diagnostics.delete(abs);
      }
    }
  }

  private async moveFolder(oldName: string, newName: string): Promise<void> {
    // Conservative: close everything under old; the editor will re-open
    // affected files via addFile on session change.
    await this.closeFolder(oldName);
    void newName;
  }

  private async clearAll(): Promise<void> {
    for (const doc of this.docs.values()) {
      this.proc.notify('textDocument/didClose', { textDocument: { uri: doc.uri } });
    }
    this.docs.clear();
    this.diagnostics.clear();
  }

  // ---- queries ----

  private async completion(req: LscRequest): Promise<void> {
    const uri = this.toUri(req.name!);
    const result = await this.proc.request('textDocument/completion', {
      textDocument: { uri },
      position: req.position,
      context: req.triggerCharacter
        ? { triggerKind: 2, triggerCharacter: req.triggerCharacter }
        : { triggerKind: 1 },
    });
    const items = Array.isArray(result) ? result : (result?.items || []);
    req.completions = items.map((it: any) => ({
      caption: it.label,
      value: it.insertText || it.label,
      meta: '',
      kind: lspCompletionKindToString(it.kind),
      score: 0,
    }));
  }

  private async info(req: LscRequest): Promise<void> {
    const uri = this.toUri(req.name!);
    const result = await this.proc.request('textDocument/hover', {
      textDocument: { uri },
      position: req.position,
    });
    if (!result) return;
    const contents = result.contents;
    let raw = '';
    if (typeof contents === 'string') raw = contents;
    else if (Array.isArray(contents)) raw = contents.map((c: any) => typeof c === 'string' ? c : c.value).join('\n');
    else if (contents && typeof contents.value === 'string') raw = contents.value;
    // First markdown code fence is the type signature → displayParts.
    // Remaining text/fences become documentation.
    const displayParts: { text: string; kind: string }[] = [];
    const docParts: { text: string }[] = [];
    FENCE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    let lastIndex = 0;
    let firstFence = true;
    while ((match = FENCE_RE.exec(raw)) !== null) {
      const before = raw.slice(lastIndex, match.index).trim();
      if (before) docParts.push({ text: before });
      const fence = match[0].trim();
      if (firstFence) { displayParts.push({ text: fence, kind: 'markdown' }); firstFence = false; }
      else docParts.push({ text: match[1].trim() });
      lastIndex = match.index + match[0].length;
    }
    const trailing = raw.slice(lastIndex).trim();
    if (trailing) docParts.push({ text: trailing });
    if (displayParts.length === 0 && raw.trim()) displayParts.push({ text: raw.trim(), kind: 'text' });
    req.info = { displayParts, documentation: docParts };
  }

  private async signature(req: LscRequest): Promise<void> {
    const uri = this.toUri(req.name!);
    const result = await this.proc.request('textDocument/signatureHelp', {
      textDocument: { uri },
      position: req.position,
      context: { triggerKind: 1, isRetrigger: false, triggerCharacter: req.triggerCharacter },
    });
    if (!result || !result.signatures || !result.signatures.length) return;
    req.signature = {
      items: result.signatures.map((s: any) => {
        // Parse the full label to get function name and return type.
        // label format: "fnName(params): ReturnType" or "fnName(params) => ReturnType"
        const parenIdx = s.label.indexOf('(');
        const lastParenIdx = s.label.lastIndexOf(')');
        const fnName = parenIdx !== -1 ? s.label.slice(0, parenIdx) : s.label;
        const returnSuffix = lastParenIdx !== -1 ? s.label.slice(lastParenIdx + 1) : '';
        return {
          prefixDisplayParts: [
            { text: fnName, kind: 'methodName' },
            { text: '(', kind: 'punctuation' },
          ],
          suffixDisplayParts: returnSuffix
            ? [{ text: ')', kind: 'punctuation' }, { text: returnSuffix }]
            : [{ text: ')', kind: 'punctuation' }],
          separatorDisplayParts: [{ text: ',', kind: 'punctuation' }, { text: ' ', kind: 'space' }],
          parameters: (s.parameters || []).map((p: any) => {
            // p.label is a string or [start, end] offsets into s.label
            const displayText = Array.isArray(p.label)
              ? s.label.slice(p.label[0], p.label[1])
              : (typeof p.label === 'string' ? p.label : '');
            const name = displayText.split(':')[0].trim();
            return {
              name,
              displayParts: displayText ? [{ text: displayText }] : [],
              documentation: p.documentation ? [toDocPart(p.documentation)] : [],
            };
          }),
          documentation: s.documentation ? [toDocPart(s.documentation)] : [],
        };
      }),
      selectedItemIndex: result.activeSignature ?? 0,
      argumentIndex: result.activeParameter ?? 0,
      argumentCount: result.signatures[result.activeSignature ?? 0]?.parameters?.length ?? 0,
    };
  }

  private async validate(req: LscRequest): Promise<void> {
    // Diagnostics arrive via publishDiagnostics push notifications. Trigger
    // an open/update beforehand so the server has the latest content; then
    // return whatever we've cached.
    const abs = this.resolveAbs(req.name!);
    const diags = this.diagnostics.get(abs) || [];
    req.validate = diags.map((d: any) => ({
      message: d.message,
      severity: d.severity,
      source: d.source,
      code: d.code,
      range: d.range,
      // LSC shape uses `start`/`length` indices on top of `range` in some
      // call sites. Editor-side code currently consumes `range` directly
      // for diagnostics — leave LSP shape for now.
    }));
  }

  private async definition(req: LscRequest): Promise<void> {
    const uri = this.toUri(req.name!);
    const result = await this.proc.request('textDocument/definition', {
      textDocument: { uri },
      position: req.position,
    });
    const locations = normalizeLocations(result);
    if (!locations.length) return;
    // LSC client (language-server.js:goToDefinition) prefers startPosition/
    // endPosition over indexToPosition when present, so we provide them
    // directly and leave start/length as 0.
    req.def = locations.map(loc => this.locationToTextSpan(loc));
  }

  private async references(req: LscRequest): Promise<void> {
    const uri = this.toUri(req.name!);
    const result = await this.proc.request('textDocument/references', {
      textDocument: { uri },
      position: req.position,
      context: { includeDeclaration: true },
    });
    req.refs = normalizeLocations(result).map(loc => this.locationToTextSpan(loc));
  }

  private async rename(req: LscRequest): Promise<void> {
    const uri = this.toUri(req.name!);
    // The editor only needs locations; pass a placeholder newName — the
    // editor prompts the user for the real one and applies edits client-side
    // via applyChanges (editor.language-server.js:165).
    const result = await this.proc.request('textDocument/rename', {
      textDocument: { uri },
      position: req.position,
      newName: '__spck_rename_placeholder__',
    });
    if (!result || !result.changes) return;
    // Pass through the LSP WorkspaceEdit shape — the LSC client's
    // getRenameLocations callback (language-server.js:209) already handles
    // `data.rename.changes` natively.
    const changes: Record<string, any> = {};
    for (const lspUri in result.changes) {
      changes[this.toRelPath(url.fileURLToPath(lspUri))] = result.changes[lspUri];
    }
    req.rename = { changes };
  }

  private async renameInfo(req: LscRequest): Promise<void> {
    const uri = this.toUri(req.name!);
    try {
      const result = await this.proc.request('textDocument/prepareRename', {
        textDocument: { uri },
        position: req.position,
      });
      if (result) {
        req.renameInfo = { canRename: true, kind: 'Variable', displayName: result.placeholder || '' };
      }
    } catch {
      req.renameInfo = { canRename: false };
    }
  }
}

function lineCharToOffset(text: string, line: number, character: number): number {
  let offset = 0;
  for (let i = 0; i < line; i++) {
    const nl = text.indexOf('\n', offset);
    if (nl === -1) return text.length;
    offset = nl + 1;
  }
  return Math.min(offset + character, text.length);
}

function applyLspEdits(text: string, edits: any[]): string {
  // Sort descending by start position so earlier edits don't shift later offsets.
  const sorted = [...edits].sort((a, b) => {
    const ld = b.range.start.line - a.range.start.line;
    return ld !== 0 ? ld : b.range.start.character - a.range.start.character;
  });
  for (const e of sorted) {
    const start = lineCharToOffset(text, e.range.start.line, e.range.start.character);
    const end = lineCharToOffset(text, e.range.end.line, e.range.end.character);
    text = text.slice(0, start) + (e.newText || '') + text.slice(end);
  }
  return text;
}

function toDocPart(doc: any): { text: string; kind?: string } {
  if (typeof doc === 'string') return { text: doc };
  const text = doc?.value || '';
  return doc?.kind === 'markdown' ? { text, kind: 'markdown' } : { text };
}

function normalizeLocations(result: any): any[] {
  if (!result) return [];
  if (Array.isArray(result)) {
    // LocationLink[] vs Location[]
    return result.map((r: any) => r.targetUri
      ? { uri: r.targetUri, range: r.targetSelectionRange || r.targetRange }
      : r);
  }
  if (result.uri) return [result];
  return [];
}

const COMPLETION_KIND_NAMES = [
  '', 'text', 'method', 'function', 'constructor', 'field', 'variable',
  'class', 'interface', 'module', 'property', 'unit', 'value', 'enum',
  'keyword', 'snippet', 'color', 'file', 'reference', 'folder',
  'enum member', 'constant', 'struct', 'event', 'operator', 'type parameter',
];

function lspCompletionKindToString(kind: number | undefined): string {
  if (typeof kind !== 'number') return '';
  return COMPLETION_KIND_NAMES[kind] || '';
}
