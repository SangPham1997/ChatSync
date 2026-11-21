// Minimal vscode module mock for vitest. Only covers surface used by
// src/context/providers/* and src/review/* at import + call time.
// Real VS Code host provides this at runtime; unit tests inject this stub.
export const workspace = {
  workspaceFolders: undefined as undefined | Array<{ uri: any }>,
  fs: {
    readFile: async (_uri: any): Promise<Uint8Array> => new Uint8Array(),
    readDirectory: async (_uri: any): Promise<Array<[string, number]>> => [],
  },
}

export const Uri = {
  joinPath: (_base: any, ..._parts: string[]) => ({ fsPath: '' }),
}

export const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 }

export const languages = {
  getDiagnostics: (_uri?: any): Array<[any, any[]]> => [],
}

export const commands = {
  registerCommand: (_id: string, _fn: (...a: any[]) => any) => ({ dispose: () => {} }),
  executeCommand: async (_id: string, ..._args: any[]): Promise<any> => undefined,
}

export const window = {
  showWarningMessage: (_msg: string) => Promise.resolve(undefined),
  showErrorMessage: (_msg: string) => Promise.resolve(undefined),
  showInformationMessage: (_msg: string) => Promise.resolve(undefined),
  createWebviewPanel: (_type: string, _title: string, _col: any, _opts?: any) => ({
    webview: {
      html: '',
      asWebviewUri: (u: any) => u,
      cspSource: 'mock-csp',
      onDidReceiveMessage: () => ({ dispose: () => {} }),
      postMessage: async (_msg: any) => true,
    },
    onDidDispose: () => ({ dispose: () => {} }),
    reveal: () => {},
    dispose: () => {},
  }),
}

export const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 }

export const DiagnosticSeverity = {
  Error: 0, Warning: 1, Information: 2, Hint: 3,
}

export interface Disposable { dispose(): void }
export interface ExtensionContext {
  subscriptions: Disposable[]
  extensionPath: string
  extensionUri: any
}

export default {}