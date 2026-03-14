"use strict";
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
        // ── Debounce ────────────────────────────────────────────────────────────
        // Якщо попередній Promise ще чекає — завершуємо його достроково (не leak),
        // і скасовуємо таймер. Новий Promise стартує зі своїм таймером.
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
        // ── Перевірка контексту ──────────────────────────────────────────────────
        // Не генеруємо підказку на порожньому рядку або в коментарі
        const currentLineTrimmed = document
            .lineAt(position.line)
            .text
            .substring(0, position.character)
            .trim();
        if (!currentLineTrimmed)
            return;
        // ── Збираємо prefix (до 50 рядків вгору) ────────────────────────────────
        const startLine = Math.max(0, position.line - 50);
        const prefix = document.getText(new vscode.Range(new vscode.Position(startLine, 0), position));
        // ── Збираємо suffix (до 10 рядків вниз) для кращого контексту ───────────
        const endLine = Math.min(document.lineCount - 1, position.line + 10);
        const suffix = document.getText(new vscode.Range(position, new vscode.Position(endLine, document.lineAt(endLine).text.length)));
        // ── Фіксуємо ID запиту — якщо прийде новий, відкидаємо старий результат ─
        const id = ++this._reqId;
        const prompt = buildPrompt(document.languageId, prefix, suffix);
        const maxTokens = cfg.get('maxTokens', 4096);
        // Обмежуємо довжину inline-відповіді — не потрібен весь контекст
        const suggestion = await this.ollama
            .generate(prompt, Math.min(maxTokens, 256), undefined)
            .catch(() => '');
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
// ── Helpers ──────────────────────────────────────────────────────────────────
/**
 * Будує промпт у форматі FIM (Fill-in-the-Middle), який підтримують
 * CodeLlama, DeepSeek-Coder, Qwen-Coder та інші code-моделі.
 * Для моделей без FIM токенів — fallback на простий prefix.
 */
function buildPrompt(lang, prefix, suffix) {
    // FIM-формат (CodeLlama / DeepSeek-Coder / Qwen-Coder)
    return (`<|fim_prefix|>` +
        `// Language: ${lang}\n` +
        prefix +
        `<|fim_suffix|>` +
        suffix +
        `<|fim_middle|>`);
}
/**
 * Очищає відповідь моделі:
 *  - прибирає випадковий повтор prefix-а на початку
 *  - прибирає FIM-токени, якщо модель їх "просочила" у відповідь
 *  - обрізає до першого повного рядка, якщо рядок prefix-а не завершений
 */
function cleanSuggestion(raw, prefix) {
    let s = raw;
    // Видаляємо FIM-токени, якщо вони є у відповіді
    s = s
        .replace(/<\|fim_prefix\|>/g, '')
        .replace(/<\|fim_suffix\|>/g, '')
        .replace(/<\|fim_middle\|>/g, '')
        .replace(/<\|endoftext\|>/g, '');
    // Якщо модель повторила весь prefix — відрізаємо його
    if (s.startsWith(prefix)) {
        s = s.slice(prefix.length);
    }
    // Якщо поточний рядок prefix-а незакінчений — беремо тільки до першого \n
    const prefixLines = prefix.split('\n');
    const lastPrefixLine = prefixLines[prefixLines.length - 1];
    if (lastPrefixLine.trim() !== '' && s.includes('\n')) {
        // Дозволяємо однорядкове доповнення або блок (якщо перший рядок — відкрита дужка)
        const firstNewline = s.indexOf('\n');
        const firstLine = s.substring(0, firstNewline).trim();
        const opensBlock = firstLine.endsWith('{') || firstLine.endsWith('(') || firstLine.endsWith('[') || firstLine.endsWith(':');
        if (!opensBlock) {
            s = s.substring(0, firstNewline);
        }
    }
    return s.trimEnd();
}
