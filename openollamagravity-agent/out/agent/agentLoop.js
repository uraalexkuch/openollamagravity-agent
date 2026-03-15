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
exports.AgentLoop = void 0;
// Copyright (c) 2026 Юрій Кучеренко.
const vscode = __importStar(require("vscode"));
const client_1 = require("../ollama/client");
const Tools = __importStar(require("./tools"));
// ─────────────────────────────────────────────────────────────────────────────
// ПОРЯДОК РОБОТИ (перевірений):
//
//  1. run(task) викликається з UI
//  2. autoLoadSkillsForTask(task) — сканує skills\, читає лише frontmatter,
//     скорує по тексту задачі, завантажує ПОВНИЙ текст топ-3 скілів
//  3. emit('skills_loaded') — UI показує які скіли підібрано
//  4. buildSystemPrompt(language, loadedSkills) — формує промпт з вбудованими скілами
//  5. history = [system, ...contextMessages, user:task]
//  6. Цикл кроків: LLM → parseToolCall → executeTool → history → наступний крок
//  7. Якщо LLM не повертає <tool_call> — emit('answer'), кінець
// ─────────────────────────────────────────────────────────────────────────────
// ── СИСТЕМНИЙ ПРОМПТ ──────────────────────────────────────────────────────────
function buildSystemPrompt(language, skills, workspaceContext) {
    // Блок підібраних скілів — вставляємо ПОВНИЙ текст кожного
    const skillsBlock = skills.length === 0 ? '' : [
        '',
        `━━━ SKILLS FOR THIS TASK (${skills.length}) ━━━`,
        'These skills were automatically matched to your task.',
        'Follow their workflows, commands, prerequisites and verification steps.',
        '',
        ...skills.map(s => `### SKILL: ${s.name}\n` +
            `<!-- folder: ${s.folderName} | relevance score: ${s.score} -->\n\n` +
            s.content),
        '━━━ END OF SKILLS ━━━',
    ].join('\n');
    // Контекст workspace (активний файл, виділений код, package.json тощо)
    const wsBlock = workspaceContext
        ? `\n\nWORKSPACE CONTEXT:\n${workspaceContext}`
        : '';
    return `You are an advanced autonomous coding and cybersecurity agent.

CRITICAL INSTRUCTION:
To call a tool, output ONLY the raw XML block below. No prose, no markdown.

<tool_call>
<name>tool_name_here</name>
<args>{"key": "value"}</args>
</tool_call>

AVAILABLE TOOLS:
- name: list_files        args: {"path": "...", "depth": 3}
- name: read_file         args: {"path": "..."}
- name: write_file        args: {"path": "...", "content": "..."}
- name: run_terminal      args: {"command": "...", "cwd": "..."}
- name: create_directory  args: {"path": "..."}
- name: list_skills       args: {}
- name: read_skill        args: {"name": "folder-name-of-skill"}

RULES:
1. ONE <tool_call> block per response — nothing before or after it.
2. Final answer (task complete, no more tool calls) → reply in ${language}, no XML.
3. Use absolute paths for user project files.
4. Use ONLY exact tool names listed above — never invent new ones.
5. If the task requires a skill NOT in the block below:
   a. Call list_skills to see all available skills (frontmatter only)
   b. Call read_skill {"name": "<folder-name>"} to load the relevant one
${skillsBlock}${wsBlock}`.trim();
}
// ── TOOL CALL PARSER ──────────────────────────────────────────────────────────
// Підтримує <name>...</name> (стандарт у промпті).
// Також приймає старий формат <n>...</n> як fallback.
function parseToolCall(text) {
    // Знаходимо перший <tool_call>...</tool_call> блок
    const block = text.match(/<tool_call>([\s\S]*?)<\/tool_call>/i);
    if (!block)
        return null;
    const inner = block[1];
    // Парсимо назву інструменту: <name>...</name> або <n>...</n>
    const nameMatch = inner.match(/<name>\s*([\w_]+)\s*<\/name>/i) ||
        inner.match(/<n>\s*([\w_]+)\s*<\/n>/i);
    if (!nameMatch)
        return null;
    const name = nameMatch[1].trim();
    // Парсимо аргументи
    const argsMatch = inner.match(/<args>([\s\S]*?)<\/args>/i);
    if (!argsMatch)
        return { name, args: {} };
    const raw = argsMatch[1].trim();
    if (!raw || raw === '{}')
        return { name, args: {} };
    try {
        // Нормалізуємо Windows-шляхи: одиночний \ → \\ щоб JSON.parse не падав
        const fixed = raw.replace(/"(path|cwd|name|command)"\s*:\s*"((?:[^"\\]|\\.)*)"/g, (_, k, v) => {
            // Якщо вже є \\ — не подвоюємо ще раз
            const normalized = v.replace(/\\(?!\\)/g, '\\\\');
            return `"${k}": "${normalized}"`;
        });
        return { name, args: JSON.parse(fixed) };
    }
    catch {
        // JSON parse failed — повертаємо name без args замість null,
        // щоб агент отримав помилку і міг виправити свій виклик
        return { name, args: {} };
    }
}
// ── AGENT LOOP ────────────────────────────────────────────────────────────────
class AgentLoop {
    constructor(_ollama) {
        this._ollama = _ollama;
        this._history = [];
        this._listeners = [];
        this.running = false;
    }
    on(fn) { this._listeners.push(fn); }
    off(fn) { this._listeners = this._listeners.filter(l => l !== fn); }
    emit(ev) { this._listeners.forEach(l => l(ev)); }
    stop() { this._abortCtrl?.abort(); this.running = false; }
    clearHistory() { this._history = []; client_1.oogLogger.appendLine('[Agent] Історію очищено.'); }
    // ── ГОЛОВНИЙ МЕТОД ──────────────────────────────────────────────────────────
    //
    // Порядок:
    //   КРОК 0: отримали task від користувача
    //   КРОК 1: autoLoadSkillsForTask — аналіз задачі, підбір скілів
    //   КРОК 2: emit('skills_loaded') — UI показує підібрані скіли
    //   КРОК 3: buildSystemPrompt — формуємо промпт з скілами та контекстом
    //   КРОК 4: history = [system, contextMessages, user:task]
    //   КРОК 5+: цикл LLM → tool → result → history → наступний крок LLM
    //   ФІНАЛ: LLM відповідає без <tool_call> → emit('answer')
    async run(task, contextMessages = [], workspaceContext = '', language = 'Ukrainian') {
        this.running = true;
        this._abortCtrl = new AbortController();
        const signal = this._abortCtrl.signal;
        const maxSteps = vscode.workspace
            .getConfiguration('openollamagravity')
            .get('maxAgentSteps', 25);
        // ── КРОК 1-2: підбір скілів ─────────────────────────────────────────────
        // Виконуємо лише на початку нової сесії (history порожня).
        // При продовженні діалогу скіли вже вбудовані в перший system-message.
        let loadedSkills = [];
        if (this._history.length === 0) {
            try {
                // tools.ts:
                //   scanSkillFolders() — рекурсивно знаходить всі SKILL.md
                //   readFrontmatter()  — читає лише перші 2 KB (YAML, ~30-50 токенів)
                //   scoreSkill()       — tags×3, description×2, name/folder×1
                //   Завантажуємо ПОВНИЙ текст лише топ-N скілів
                loadedSkills = await Tools.autoLoadSkillsForTask(task, 3);
            }
            catch (e) {
                client_1.oogLogger.appendLine(`[Agent] Skills auto-load error: ${e.message}`);
            }
            if (loadedSkills.length > 0) {
                // КРОК 2: повідомляємо UI
                this.emit({
                    type: 'skills_loaded',
                    content: `Підібрано ${loadedSkills.length} скіл(и) для задачі`,
                    skills: loadedSkills.map(s => ({
                        name: s.name,
                        folderName: s.folderName,
                        description: s.description,
                        score: s.score,
                    })),
                });
                client_1.oogLogger.appendLine('[Agent] Скіли для задачі:\n' +
                    loadedSkills.map(s => `  • [${s.score}] ${s.folderName}  →  "${s.name}"`).join('\n'));
            }
            else {
                client_1.oogLogger.appendLine('[Agent] Релевантних скілів не знайдено — продовжую без них.');
            }
            // КРОК 3: формуємо системний промпт з вбудованими скілами
            const sysPrompt = buildSystemPrompt(language, loadedSkills, workspaceContext);
            client_1.oogLogger.appendLine(`[Agent] System prompt: ${sysPrompt.length} chars` +
                (loadedSkills.length > 0
                    ? `, включає ${loadedSkills.length} скіл(и)`
                    : ', без скілів'));
            // КРОК 4: ініціалізуємо history
            this._history.push({ role: 'system', content: sysPrompt });
            if (contextMessages.length > 0)
                this._history.push(...contextMessages);
        }
        // Повідомлення користувача — завжди додаємо
        this._history.push({ role: 'user', content: task });
        // ── КРОКИ 5+: основний цикл ────────────────────────────────────────────
        for (let step = 1; step <= maxSteps; step++) {
            if (signal.aborted)
                break;
            this.emit({ type: 'step', content: '', step, totalSteps: maxSteps });
            // Запит до LLM
            let output = '';
            try {
                output = await this._streamWithTimeout(step, maxSteps, signal);
            }
            catch (err) {
                this.emit({ type: 'error', content: err.message });
                break;
            }
            client_1.oogLogger.appendLine(`[Agent] Step ${step} output (${output.length} chars)`);
            // Парсимо відповідь: tool_call або фінальна відповідь
            const tool = parseToolCall(output);
            if (!tool) {
                // Немає <tool_call> → LLM завершив задачу, повертаємо відповідь
                this.emit({ type: 'answer', content: output });
                break;
            }
            // Є tool_call → виконуємо інструмент
            this.emit({
                type: 'tool_call', content: `Calling: ${tool.name}`,
                toolName: tool.name, toolArgs: tool.args,
            });
            const res = await this._executeTool(tool.name, tool.args);
            this.emit({
                type: 'tool_result', content: res.output,
                toolName: tool.name, ok: res.ok,
            });
            // Зберігаємо у history повністю розгорнуті теги — LLM добре їх розуміє
            this._history.push({ role: 'assistant', content: output });
            this._history.push({
                role: 'user',
                content: `<tool_result>\n` +
                    `<name>${tool.name}</name>\n` +
                    `<ok>${res.ok}</ok>\n` +
                    `<output>${res.output}</output>\n` +
                    `</tool_result>`,
            });
        }
        this.running = false;
        this.emit({ type: 'done', content: '' });
    }
    // ── STREAM З ТАЙМАУТОМ ────────────────────────────────────────────────────
    async _streamWithTimeout(step, total, signal) {
        const ms = vscode.workspace
            .getConfiguration('openollamagravity')
            .get('firstTokenTimeoutSec', 180) * 1000;
        return new Promise((resolve, reject) => {
            let started = false;
            const timer = setTimeout(() => {
                if (!started) {
                    reject(new Error('Ollama не відповіла за таймаутом. Спробуйте меншу модель.'));
                }
            }, ms);
            this._ollama
                .chatStream(this._history, chunk => {
                started = true;
                clearTimeout(timer);
                this.emit({ type: 'thinking', content: chunk, step, totalSteps: total });
            }, signal, this.model)
                .then(resolve)
                .catch(reject);
        });
    }
    // ── ВИКОНАННЯ ІНСТРУМЕНТІВ ────────────────────────────────────────────────
    async _executeTool(name, args) {
        const confirm = async (msg) => (await vscode.window.showWarningMessage(`OOG: ${msg}`, 'Allow', 'Deny')) === 'Allow';
        switch (name) {
            case 'read_file': return Tools.readFile(args);
            case 'write_file': return Tools.writeFile(args, p => confirm(`Записати у ${p}`));
            case 'list_files': return Tools.listFiles(args);
            case 'run_terminal': return Tools.runTerminal(args, c => confirm(`Запустити: ${c}`));
            case 'create_directory': return Tools.createDirectory(args);
            // Fallback: агент сам запитує скіл якщо авто-підбір не вистачив
            case 'list_skills': return Tools.listSkills();
            case 'read_skill': return Tools.readSkill(args);
            default:
                return {
                    ok: false,
                    output: `CRITICAL ERROR: Unknown tool "${name}". ` +
                        `Valid tools: read_file, write_file, list_files, run_terminal, ` +
                        `create_directory, list_skills, read_skill. ` +
                        `Fix your <tool_call> and use an exact tool name from the list.`,
                };
        }
    }
}
exports.AgentLoop = AgentLoop;
