/**
 * Minimal in-memory stub of the `vscode` API, enough to boot the ChatSync
 * extension host logic outside VSCode (smoke tests, CI).
 *
 * Documents are backed by real files on disk so /apply round-trips are real.
 */
const fs = require('fs');
const path = require('path');

const EndOfLine = { LF: 1, CRLF: 2 };
const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };
const StatusBarAlignment = { Left: 1, Right: 2 };
const TextEditorRevealType = { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 };
const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2 };

class Uri {
  constructor(fsPath, scheme = 'file') {
    this.scheme = scheme;
    this.fsPath = fsPath;
    this.path = fsPath;
    this.authority = '';
    this.query = '';
    this.fragment = '';
  }
  static file(p) {
    return new Uri(p, 'file');
  }
  static parse(s) {
    return new Uri(s.replace(/^file:\/\//, ''), 'file');
  }
  toString() {
    return `file://${this.fsPath}`;
  }
  with() {
    return this;
  }
}

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
  isBefore(o) {
    return this.line < o.line || (this.line === o.line && this.character < o.character);
  }
  translate(l = 0, c = 0) {
    return new Position(this.line + l, this.character + c);
  }
}

class Range {
  constructor(start, end) {
    if (start instanceof Position) {
      this.start = start;
      this.end = end;
    } else {
      this.start = new Position(start, end);
      this.end = new Position(arguments[2], arguments[3]);
    }
    if (this.end.isBefore(this.start)) {
      const t = this.start;
      this.start = this.end;
      this.end = t;
    }
  }
  get isEmpty() {
    return this.start.line === this.end.line && this.start.character === this.end.character;
  }
}

class Selection extends Range {
  constructor(anchor, active) {
    super(anchor, active);
    this.anchor = anchor;
    this.active = active;
  }
}

class TextLine {
  constructor(text, lineNumber) {
    this.text = text;
    this.lineNumber = lineNumber;
    this.range = new Range(new Position(lineNumber, 0), new Position(lineNumber, text.length));
    this.rangeIncludingLineBreak = this.range;
    this.firstNonWhitespaceCharacterIndex = text.search(/\S/) === -1 ? text.length : text.search(/\S/);
    this.isEmptyWhitespace = this.firstNonWhitespaceCharacterIndex === text.length;
  }
}

class TextDocument {
  constructor(uri) {
    this.uri = uri;
    this.fileName = uri.fsPath;
    this.isUntitled = false;
    this.isDirty = false;
    this.isClosed = false;
    this.version = 1;
    this.languageId = guessLanguage(uri.fsPath);
    this._cache = null;
  }
  _text() {
    if (this._cache === null) {
      this._cache = fs.existsSync(this.uri.fsPath) ? fs.readFileSync(this.uri.fsPath, 'utf8') : '';
    }
    return this._cache;
  }
  _invalidate() {
    this._cache = null;
    this.version++;
  }
  getText(range) {
    const text = this._text();
    if (!range) {
      return text;
    }
    return text.slice(this.offsetAt(range.start), this.offsetAt(range.end));
  }
  get eol() {
    // mirror VSCode: the document's dominant line ending
    return this._text().includes('\r\n') ? EndOfLine.CRLF : EndOfLine.LF;
  }
  get lineCount() {
    return this._text().split('\n').length;
  }
  lineAt(lineOrPos) {
    const n = typeof lineOrPos === 'number' ? lineOrPos : lineOrPos.line;
    const lines = this._text().split('\n');
    return new TextLine(lines[Math.max(0, Math.min(n, lines.length - 1))] ?? '', n);
  }
  offsetAt(pos) {
    const lines = this._text().split('\n');
    let off = 0;
    for (let i = 0; i < Math.min(pos.line, lines.length - 1); i++) {
      off += lines[i].length + 1;
    }
    if (pos.line >= lines.length) {
      return this._text().length;
    }
    return off + Math.min(pos.character, lines[pos.line].length);
  }
  positionAt(offset) {
    const text = this._text().slice(0, Math.max(0, offset));
    const lines = text.split('\n');
    return new Position(lines.length - 1, lines[lines.length - 1].length);
  }
  save() {
    this.isDirty = false;
    return Promise.resolve(true);
  }
}

function guessLanguage(p) {
  const ext = path.extname(p).toLowerCase();
  return (
    {
      '.ts': 'typescript', '.tsx': 'typescriptreact', '.js': 'javascript', '.jsx': 'javascriptreact',
      '.json': 'json', '.md': 'markdown', '.py': 'python', '.html': 'html', '.css': 'css',
      '.txt': 'plaintext', '.yml': 'yaml', '.yaml': 'yaml',
    }[ext] || 'plaintext'
  );
}

class WorkspaceEdit {
  constructor() {
    this.entries = [];
  }
  replace(uri, range, text) {
    this.entries.push({ uri, range, text });
  }
  insert(uri, pos, text) {
    this.entries.push({ uri, range: new Range(pos, pos), text });
  }
  delete(uri, range) {
    this.entries.push({ uri, range, text: '' });
  }
  get size() {
    return this.entries.length;
  }
}

class TabInputText {
  constructor(uri) {
    this.uri = uri;
  }
}

/* ---------------- state ---------------- */

const state = {
  root: undefined,
  docs: new Map(),
  diagnostics: [],
  active: undefined,
  shownMessages: [],
  executedCommands: [],
  quickPickAnswer: 'FIRST_BUTTON', // what showInformationMessage resolves to;
                                   // set to null to simulate "user ignored the notification"
  terminals: [],
  outputLines: [],
};

function docFor(fsPath) {
  const key = fsPath;
  let d = state.docs.get(key);
  if (!d) {
    d = new TextDocument(Uri.file(key));
    state.docs.set(key, d);
  }
  return d;
}

/* ---------------- namespaces ---------------- */

const workspace = {
  get workspaceFolders() {
    return state.root ? [{ name: path.basename(state.root), uri: Uri.file(state.root), index: 0 }] : undefined;
  },
  get textDocuments() {
    return [...state.docs.values()];
  },
  getConfiguration(section) {
    const values = state.config?.[section ?? ''] ?? {};
    return {
      get(key, dflt) {
        return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : dflt;
      },
      update() {
        return Promise.resolve();
      },
      has(key) {
        return Object.prototype.hasOwnProperty.call(values, key);
      },
      inspect(key) {
        return { defaultValue: undefined, globalValue: values[key] };
      },
    };
  },
  openTextDocument(arg) {
    const p = typeof arg === 'string' ? arg : arg instanceof Uri ? arg.fsPath : arg.fsPath;
    if (!fs.existsSync(p)) {
      return Promise.reject(new Error(`cannot open ${p} (ENOENT)`));
    }
    const d = docFor(p);
    d._invalidate();
    return Promise.resolve(d);
  },
  applyEdit(we) {
    for (const e of we.entries) {
      const d = docFor(e.uri.fsPath);
      d._invalidate();
      const text = d.getText();
      const start = d.offsetAt(e.range.start);
      const end = d.offsetAt(e.range.end);
      const next = text.slice(0, start) + e.text + text.slice(end);
      fs.writeFileSync(e.uri.fsPath, next, 'utf8');
      d._invalidate();
      d.isDirty = true;
    }
    return Promise.resolve(true);
  },
  onDidChangeConfiguration() {
    return { dispose() {} };
  },
  asRelativePath(p) {
    return state.root ? path.relative(state.root, typeof p === 'string' ? p : p.fsPath) : String(p);
  },
};

const window = {
  get activeTextEditor() {
    return state.active;
  },
  get visibleTextEditors() {
    return state.active ? [state.active] : [];
  },
  get terminals() {
    return state.terminals;
  },
  tabGroups: {
    all: [],
  },
  showTextDocument(doc) {
    const d = typeof doc === 'string' ? docFor(doc) : doc instanceof Uri ? docFor(doc.fsPath) : doc;
    state.active = makeEditor(d);
    return Promise.resolve(state.active);
  },
  showInformationMessage(msg, ...items) {
    state.shownMessages.push({ kind: 'info', msg, items });
    const opts = items.find((i) => i && typeof i === 'object' && i.modal !== undefined);
    const buttons = items.filter((i) => typeof i === 'string');
    void opts;
    const answer = state.quickPickAnswer;
    if (answer === 'FIRST_BUTTON') {
      return Promise.resolve(buttons[0]);
    }
    return Promise.resolve(answer === null ? undefined : answer);
  },
  showWarningMessage(msg) {
    state.shownMessages.push({ kind: 'warn', msg });
    return Promise.resolve(undefined);
  },
  showErrorMessage(msg) {
    state.shownMessages.push({ kind: 'error', msg });
    return Promise.resolve(undefined);
  },
  showQuickPick(items) {
    return Promise.resolve(Array.isArray(items) ? items[0] : undefined);
  },
  createOutputChannel(name) {
    return {
      name,
      appendLine: (l) => state.outputLines.push(l),
      append: (l) => state.outputLines.push(l),
      show() {},
      clear() {
        state.outputLines.length = 0;
      },
      dispose() {},
    };
  },
  createStatusBarItem() {
    return { text: '', tooltip: '', command: '', show() {}, hide() {}, dispose() {} };
  },
  createTerminal(opts) {
    const t = { name: (opts && opts.name) || 'Terminal', sent: [], show() {}, sendText(text) { this.sent.push(text); }, dispose() {} };
    state.terminals.push(t);
    return t;
  },
  onDidChangeActiveTextEditor() {
    return { dispose() {} };
  },
  withProgress(_o, task) {
    return task({ report() {} }, { isCancellationRequested: false });
  },
};

function makeEditor(doc, selections) {
  const sel = selections && selections.length ? selections : [new Selection(new Position(0, 0), new Position(0, 0))];
  return {
    document: doc,
    selections: sel,
    selection: sel[0],
    visibleRanges: [new Range(new Position(0, 0), new Position(Math.max(0, doc.lineCount - 1), 0))],
    revealRange() {},
    edit(cb) {
      const builder = {
        replace(range, text) {
          const we = new WorkspaceEdit();
          we.replace(doc.uri, range, text);
          return workspace.applyEdit(we);
        },
        insert(pos, text) {
          const we = new WorkspaceEdit();
          we.insert(doc.uri, pos, text);
          return workspace.applyEdit(we);
        },
      };
      return cb(builder);
    },
  };
}

const languages = {
  getDiagnostics() {
    return state.diagnostics.map((d) => [d.uri, d.diagnostics]);
  },
};

const commands = {
  executeCommand(command, ...args) {
    state.executedCommands.push({ command, args });
    return Promise.resolve(undefined);
  },
  registerCommand(command, cb) {
    state.registeredCommands = state.registeredCommands || new Map();
    state.registeredCommands.set(command, cb);
    return { dispose() {} };
  },
};

class Diagnostic {
  constructor(range, message, severity) {
    this.range = range;
    this.message = message;
    this.severity = severity ?? DiagnosticSeverity.Error;
  }
}

class ExtensionContext {
  constructor() {
    this.subscriptions = [];
    this.globalState = {
      _m: new Map(),
      get(k, d) {
        return this._m.has(k) ? this._m.get(k) : d;
      },
      update(k, v) {
        this._m.set(k, v);
        return Promise.resolve();
      },
    };
    this.extensionPath = path.resolve(__dirname, '..');
    this.extensionUri = Uri.file(this.extensionPath);
  }
}

const env = {
  clipboard: {
    _text: '',
    writeText(t) {
      this._text = t;
      return Promise.resolve();
    },
    readText() {
      return Promise.resolve(this._text);
    },
  },
  openExternal(uri) {
    state.openedUrls = state.openedUrls || [];
    state.openedUrls.push(String(uri));
    return Promise.resolve(true);
  },
  machineId: 'stub-machine',
  sessionId: 'stub-session',
  appName: 'Visual Studio Code (stub)',
};

const version = '1.90.0-stub';

module.exports = {
  // classes
  Uri, Position, Range, Selection, TextDocument, TextLine, WorkspaceEdit, Diagnostic,
  TabInputText, TabInputTextDiff: class {}, ExtensionContext, MarkdownString: class { constructor(v) { this.value = v; } },
  ThemeColor: class { constructor(id) { this.id = id; } },
  EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} },
  CancellationTokenSource: class { constructor() { this.token = { isCancellationRequested: false }; } dispose() {} },
  // enums
  EndOfLine, DiagnosticSeverity, StatusBarAlignment, TextEditorRevealType, ViewColumn,
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  ProgressLocation: { Notification: 15, Window: 10 },
  // namespaces
  workspace, window, commands, languages, env,
  version,
  // test helpers (not part of the real API)
  __state: state,
  __makeEditor: makeEditor,
  __setActive(fsPath, selections) {
    const d = docFor(fsPath);
    d._invalidate();
    state.active = makeEditor(d, selections);
    return state.active;
  },
  __scheduleDiagnostics(uriFsPath, diags, delayMs) {
    setTimeout(() => {
      module.exports.__setDiagnostics(uriFsPath, diags);
    }, delayMs);
  },
  __clearDiagnostics() {
    state.diagnostics.length = 0;
  },
  __setDiagnostics(uriFsPath, diags) {
    const entry = state.diagnostics.find((d) => d.uri.fsPath === uriFsPath);
    if (entry) {
      entry.diagnostics = diags;
    } else {
      state.diagnostics.push({ uri: Uri.file(uriFsPath), diagnostics: diags });
    }
  },
  __answerMessage(answer) {
    state.quickPickAnswer = answer;
  },
};
