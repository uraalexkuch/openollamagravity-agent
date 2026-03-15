// Copyright (c) 2026 Юрій Кучеренко. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root for full license information.

import * as vscode from 'vscode';
import { OllamaClient } from './ollama/client';

export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private _debounceResolve: (() => void) | undefined;
  private _reqId = 0;
  private _abortController: AbortController | undefined;

  constructor(private readonly ollama: OllamaClient) {}

  async provideInlineCompletionItems(
      document: vscode.TextDocument,
      position: vscode.Position,
      _ctx: vscode.InlineCompletionContext,
      token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionList | undefined> {
    const cfg = vscode.workspace.getConfiguration('openollamagravity');
    if (!cfg.get<boolean>('inlineCompletionEnabled', true)) return;

    // ── Скасування попереднього запиту ──
    if (this._abortController) {
      this._abortController.abort();
    }
    if (this._debounceTimer !== undefined) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = undefined;
      this._debounceResolve?.();
      this._debounceResolve = undefined;
    }

    const delay = cfg.get<number>('inlineCompletionDelay', 700);
    await new Promise<void>(resolve => {
      this._debounceResolve = resolve;
      this._debounceTimer   = setTimeout(() => {
        this._debounceTimer   = undefined;
        this._debounceResolve = undefined;
        resolve();
      }, delay);
    });

    if (token.isCancellationRequested) return;

    const currentLineTrimmed = document
        .lineAt(position.line)
        .text
        .substring(0, position.character)
        .trim();

    if (!currentLineTrimmed) return;

    const startLine = Math.max(0, position.line - 50);
    const prefix    = document.getText(
        new vscode.Range(new vscode.Position(startLine, 0), position)
    );

    const endLine = Math.min(document.lineCount - 1, position.line + 10);
    const suffix  = document.getText(
        new vscode.Range(position, new vscode.Position(endLine, document.lineAt(endLine).text.length))
    );

    const id = ++this._reqId;

    const prompt    = buildPrompt(document.languageId, prefix, suffix);
    const maxTokens = cfg.get<number>('maxTokens', 4096);

    // Створюємо новий контролер та підв'язуємо скасування від VS Code
    this._abortController = new AbortController();
    token.onCancellationRequested(() => this._abortController?.abort());

    // Передаємо signal в generate
    const suggestion = await this.ollama
        .generate(prompt, Math.min(maxTokens, 256), undefined, this._abortController.signal)
        .catch(() => '');

    if (id !== this._reqId || token.isCancellationRequested) return;

    const trimmed = cleanSuggestion(suggestion, prefix);
    if (!trimmed) return;

    return {
      items: [
        new vscode.InlineCompletionItem(
            trimmed,
            new vscode.Range(position, position)
        ),
      ],
    };
  }
}

function buildPrompt(lang: string, prefix: string, suffix: string): string {
  return (
      `<|fim_prefix|>` +
      `// Language: ${lang}\n` +
      prefix +
      `<|fim_suffix|>` +
      suffix +
      `<|fim_middle|>`
  );
}

function cleanSuggestion(raw: string, prefix: string): string {
  let s = raw;
  s = s
      .replace(/<\|fim_prefix\|>/g, '')
      .replace(/<\|fim_suffix\|>/g, '')
      .replace(/<\|fim_middle\|>/g, '')
      .replace(/<\|endoftext\|>/g, '');

  if (s.startsWith(prefix)) {
    s = s.slice(prefix.length);
  }

  const prefixLines = prefix.split('\n');
  const lastPrefixLine = prefixLines[prefixLines.length - 1];
  if (lastPrefixLine.trim() !== '' && s.includes('\n')) {
    const firstNewline = s.indexOf('\n');
    const firstLine    = s.substring(0, firstNewline).trim();
    const opensBlock   = firstLine.endsWith('{') || firstLine.endsWith('(') || firstLine.endsWith('[') || firstLine.endsWith(':');
    if (!opensBlock) {
      s = s.substring(0, firstNewline);
    }
  }

  return s.trimEnd();
}