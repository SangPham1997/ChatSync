import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function initLogger(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('ChatSync');
  }
  return channel;
}

export function getChannel(): vscode.OutputChannel | undefined {
  return channel;
}

function stamp(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

export function log(...args: unknown[]): void {
  channel?.appendLine(`[${stamp()}] ${args.map(fmt).join(' ')}`);
}

export function warn(...args: unknown[]): void {
  channel?.appendLine(`[${stamp()}] WARN ${args.map(fmt).join(' ')}`);
}

export function error(...args: unknown[]): void {
  channel?.appendLine(`[${stamp()}] ERROR ${args.map(fmt).join(' ')}`);
}

function fmt(a: unknown): string {
  if (typeof a === 'string') {
    return a;
  }
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}
