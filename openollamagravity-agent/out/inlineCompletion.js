"use strict";
// Copyright (c) 2026 Юрій Кучеренко. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root for full license information.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.InlineCompletionProvider = void 0;
const vscode = __importStar(require("vscode"));
class InlineCompletionProvider {
    constructor(ollama) {
        this.ollama = ollama;
        this._reqId = 0;
    }
    async provideInlineCompletionItems(document, position, _ctx, token) {
        const cfg = vscode.workspace.getConfiguration('openollamagravity');
        if (!cfg.get('inlineCompletionEnabled', true))
            return;
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
        const delay = cfg.get('inlineCompletionDelay', 700);
        await new Promise(resolve => {
            this._debounceResolve = resolve;
            this._debounceTimer = setTimeout(() => {
                this._debounceTimer = undefined;
                this._debounceResolve = undefined;
                resolve();
            }, delay);
        });
        if (token.isCancellationRequested)
            return;
        const currentLineTrimmed = document
            .lineAt(position.line)
            .text
            .substring(0, position.character)
            .trim();
        if (!currentLineTrimmed)
            return;
        const startLine = Math.max(0, position.line - 50);
        const prefix = document.getText(new vscode.Range(new vscode.Position(startLine, 0), position));
        const endLine = Math.min(document.lineCount - 1, position.line + 10);
        const suffix = document.getText(new vscode.Range(position, new vscode.Position(endLine, document.lineAt(endLine).text.length)));
        const id = ++this._reqId;
        const prompt = buildPrompt(document.languageId, prefix, suffix);
        const maxTokens = cfg.get('maxTokens', 4096);
        // Створюємо новий контролер та підв'язуємо скасування від VS Code
        this._abortController = new AbortController();
        token.onCancellationRequested(() => this._abortController?.abort());
        // generate() accepts (prompt, maxTokens, model?) — no signal param.
        // We race it against the VS Code cancellation token manually.
        const suggestionPromise = this.ollama
            .generate(prompt, Math.min(maxTokens, 256), undefined)
            .catch(() => '');
        const cancelPromise = new Promise(resolve => {
            token.onCancellationRequested(() => resolve(''));
            // Also resolve empty if the request was superseded
            this._abortController?.signal.addEventListener('abort', () => resolve(''), { once: true });
        });
        const suggestion = await Promise.race([suggestionPromise, cancelPromise]);
        if (id !== this._reqId || token.isCancellationRequested)
            return;
        const trimmed = cleanSuggestion(suggestion, prefix);
        if (!trimmed)
            return;
        return {
            items: [
                new vscode.InlineCompletionItem(trimmed, new vscode.Range(position, position)),
            ],
        };
    }
}
exports.InlineCompletionProvider = InlineCompletionProvider;
function buildPrompt(lang, prefix, suffix) {
    return (`<|fim_prefix|>` +
        `// Language: ${lang}\n` +
        prefix +
        `<|fim_suffix|>` +
        suffix +
        `<|fim_middle|>`);
}
function cleanSuggestion(raw, prefix) {
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
        const firstLine = s.substring(0, firstNewline).trim();
        const opensBlock = firstLine.endsWith('{') || firstLine.endsWith('(') || firstLine.endsWith('[') || firstLine.endsWith(':');
        if (!opensBlock) {
            s = s.substring(0, firstNewline);
        }
    }
    return s.trimEnd();
}
