import * as vscode from 'vscode';

export interface ChatSyncConfig {
  enabled: boolean;
  port: number;
  portFallbackRange: number;
  host: string;
  requireToken: boolean;
  token: string;
  allowedOrigins: string[];
  maxFileSizeKB: number;
  maxContextChars: number;
  applyMode: 'diff' | 'direct';
  autoSave: boolean;
  previewTimeoutSeconds: number;
  allowRunCommand: boolean;
  allowTerminal: boolean;
  rateLimitPerMinute: number;
  logRequests: boolean;
}

export function getConfig(): ChatSyncConfig {
  const c = vscode.workspace.getConfiguration('chatsync');
  const get = <T,>(k: string, d: T): T => {
    const v = c.get<T>(k);
    return v === undefined || v === null ? d : v;
  };
  return {
    enabled: get<boolean>('enabled', true),
    port: get<number>('port', 3847),
    portFallbackRange: get<number>('portFallbackRange', 10),
    host: get<string>('host', '127.0.0.1'),
    requireToken: get<boolean>('requireToken', true),
    token: get<string>('token', ''),
    allowedOrigins: get<string[]>('allowedOrigins', [
      'https://chat.deepseek.com',
      'https://chatgpt.com',
      'https://claude.ai',
      'https://gemini.google.com',
      'http://localhost:*',
      'http://127.0.0.1:*',
    ]),
    maxFileSizeKB: get<number>('maxFileSizeKB', 1024),
    maxContextChars: get<number>('maxContextChars', 60000),
    applyMode: get<'diff' | 'direct'>('applyMode', 'diff'),
    autoSave: get<boolean>('autoSave', false),
    previewTimeoutSeconds: get<number>('previewTimeoutSeconds', 300),
    allowRunCommand: get<boolean>('allowRunCommand', false),
    allowTerminal: get<boolean>('allowTerminal', false),
    rateLimitPerMinute: get<number>('rateLimitPerMinute', 240),
    logRequests: get<boolean>('logRequests', true),
  };
}
