import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

function out(): vscode.OutputChannel {
  return (channel ??= vscode.window.createOutputChannel('PR Open'));
}

/** Append a line to the "PR Open" output channel (created lazily). */
export function log(message: string): void {
  out().appendLine(message);
}

/** Reveal the channel, which is where the per-click timing breakdown lands. */
export function showLog(): void {
  out().show(true);
}
