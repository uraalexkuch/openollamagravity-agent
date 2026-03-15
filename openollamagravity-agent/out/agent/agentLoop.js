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
//  4. buildSystemPrompt(language, skills, wsCtx, wsPath, wsRoot) — формує промпт
//  5. history = [system, ...contextMessages, user:task]
//  6. Цикл кроків: LLM → parseToolCall → executeTool → history → наступний крок
//  7. Якщо LLM не повертає <tool_call> — emit('answer'), кінець
// ─────────────────────────────────────────────────────────────────────────────
// ── СИСТЕМНИЙ ПРОМПТ ──────────────────────────────────────────────────────────
function buildSystemPrompt(language, skills, workspaceContext, workspacePath, workspaceRoot) {
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
    // Контекст workspace (активний файл, package.json тощо)
    const wsBlock = workspaceContext
        ? `\n\nWORKSPACE CONTEXT:\n${workspaceContext}`
        : '';
    // Реальний шлях до workspace — агент використовує для побудови шляхів
    // workspaceRoot — абсолютний шлях до кореня відкритого проекту
    // Агент ЗОБОВ'ЯЗАНИЙ використовувати цей шлях і не вигадувати свій
    const rootBlock = (workspaceRoot || workspacePath)
        ? `\n\nWORKSPACE ROOT: ${workspaceRoot || workspacePath}\n`
            + `When working within the project, use this path as your base.\n`
            + `CROSS-PROJECT ACCESS: You can access, read, and edit files in ANY project on the user's computer by using absolute paths in tool arguments.`
        : '';
    return `You are an advanced autonomous coding and cybersecurity agent.
You always explain what you are doing so the user understands your progress.

OUTPUT FORMAT & TOOL CALLING:
- You are an autonomous agent. You MUST continue calling tools until you have all the information needed to finish the task.
- When you need to call a tool, write 1-2 sentences in ${language} explaining WHAT you found or plan to do, THEN the tool call wrapped in XML tags.
- NEVER output tool names or JSON directly. ALWAYS wrap in <tool_call> tags.
- CONTINUATION RULE: Do NOT provide a final answer until you have actually verified your changes or confirmed the required information. If you just called a tool, wait for the <tool_result> before concluding.

Example of a CORRECT tool call:
  Починаю з огляду структури проекту.
  <tool_call>
  <name>list_files</name>
  <args>{"path": "D:\\\\web_project"}</args>
  </tool_call>

NARRATION RULES:
- Write 1-2 sentences BEFORE every tool call.
- After reading a file → mention detected language or framework.
- For web_search: explain WHY you are searching.

AVAILABLE TOOLS:
1. read_file(path, start_line?, end_line?)
   - Read file contents, optionally limited to a line range
2. write_file(path, content, mode?)
   - Write a file. mode: "overwrite" (default) or "append"
3. edit_file(path, start_line, end_line, new_content)
   - Replace specific lines in a file
4. list_files(path?, depth?)
   - List directory tree (depth 1-5, default 3)
5. search_files(pattern, path?, file_pattern?)
   - Regex search across files. file_pattern filters by filename
6. run_terminal(command, cwd?)
   - Execute an allowed shell command
7. get_diagnostics(path?)
   - Get VSCode errors/warnings, optionally for one file
8. get_file_outline(path)
   - Get symbols/functions/classes in a file
9. create_directory(path)
   - Create a directory (including parents)
10. delete_file(path)
    - Delete a file (requires user confirmation)
11. get_workspace_info(path?)
    - Get project type, name, dependencies, and scripts for a specific path or the current root
12. web_search(query)
    - Search the internet/documentation for solutions or info (via Perplexica)
13. list_skills()
    - List available skill files and guides from the antigravity-awesome-skills repository
14. read_skill(name)
    - Read a specific skill file to learn best practices and instructions

HOW TO CALL A TOOL:
<tool_call>
<name>TOOL_NAME</name>
<args>{"arg1": "value1", "arg2": "value2"}</args>
</tool_call>

0. CONTEXT GATHERING: If the task involves a specific path or project, ALWAYS start by calling list_files and get_workspace_info(path) to understand the real architecture, dependencies, and available scripts. NEVER assume project technology (e.g., don't assume Express if it's NestJS).
1. PLANNING: Before making any file changes, you MUST output a structured plan in the chat using exactly this format:
   ### Proposed Changes
   - [Module/Component Name]: Explain the logic changes based on the ACTUAL code you read. List files to modify.
   ### Verification Plan
   - Explain how you will test these changes (e.g., what terminal commands you will run, what manual steps are required). Use the scripts found in get_workspace_info.
2. EXECUTION: Execute your plan using tools (edit_file, write_file). Use absolute paths if working on external projects.
3. VERIFICATION: Use "run_terminal" to build/test the project and verify your changes. Fix any errors that arise.
4. REPORTING: When the task is fully complete and verified, provide a final report in the chat using exactly this format:
   ### Walkthrough
   - Briefly explain what was done.
   ### Changes Made
   - [Project/Folder Name]: Detailed list of modifications.
   ### Verification Results
   - Provide the output of your self-tests, terminal commands, or explain how it was verified. Include any "NOTE" sections if manual intervention (like DB migrations) is needed.

TECHNICAL RULES:
1. ALWAYS communicate, explain, and write your final answers in ${language}. This is a strict requirement.
2. Think step by step. Before writing code, read the relevant files first.
3. Only call ONE tool per response turn.
4. After the tool result, continue reasoning or call another tool.
5. WINDOWS PATHS — always double backslash in JSON args (e.g. {"path": "D:\\\\web_project\\\\src\\\\main.ts"}).
6. CROSS-PROJECT ACCESS: You can access files, read, edit, and run commands in ANY project on the user's computer by using absolute paths (e.g., "D:\\\\web_project\\\\intern50\\\\backend") in tool arguments (path, cwd).
7. Prefer small targeted edits (edit_file) over full rewrites (write_file) when possible.
8. SELF-TESTING: You MUST verify your changes! Use "run_terminal" to run builds (e.g. "npm run start:dev", "npm run build", "tsc") or tests in the target project's directory (using the 'cwd' argument) to ensure everything compiles and works without errors.
${skillsBlock}${wsBlock}${rootBlock}`.trim();
}
// ── TOOL CALL PARSER ─────────────────────────────────────────────────────────
/**
 * Виправляє JSON з Windows-шляхами та іншими некоректними backslash.
 *
 * Проблема: LLM генерує {"path": "D:\web_project\src"} де \w, \s — не валідні
 * JSON escape → JSON.parse кидає SyntaxError.
 *
 * Рішення: посимвольний обхід JSON-рядків, подвоюємо лише невалідні escapes.
 * Валідні JSON escapes: \" \\ \/ \b \f \n \r \t \uXXXX
 */
function repairJson(raw) {
    let result = '';
    let inString = false;
    let i = 0;
    while (i < raw.length) {
        const ch = raw[i];
        if (!inString) {
            if (ch === '"') {
                inString = true;
            }
            result += ch;
            i++;
            continue;
        }
        if (ch === '\\') {
            const next = raw[i + 1] ?? '';
            if (/["\\\/bfnrtu]/.test(next)) {
                result += ch + next; // валідний escape — залишаємо
            }
            else {
                result += '\\\\' + next; // невалідний escape — подвоюємо backslash
            }
            i += 2;
            continue;
        }
        if (ch === '"') {
            inString = false;
        }
        result += ch;
        i++;
    }
    return result;
}
/**
 * Парсить <tool_call> блок з відповіді LLM.
 * Три спроби: прямий parse → auto-repair → error повернення агенту.
 * Ніколи не ковтає помилку мовчки — агент завжди знає що пішло не так.
 */
function parseToolCall(text) {
    const block = text.match(/<tool_call>([\s\S]*?)<\/tool_call>/i);
    if (!block)
        return null;
    // Витягуємо текст ДО <tool_call> — це пояснення/нарація агента
    const blockStart = text.indexOf('<tool_call>');
    const narration = text.slice(0, blockStart).trim();
    const inner = block[1];
    const nameMatch = inner.match(/<n>\s*([\w_]+)\s*<\/n>/i) ||
        inner.match(/<n>\s*([\w_]+)\s*<\/name>/i);
    if (!nameMatch)
        return null;
    const name = nameMatch[1].trim();
    const argsMatch = inner.match(/<args>([\s\S]*?)<\/args>/i);
    if (!argsMatch)
        return { name, narration, args: {} };
    const raw = argsMatch[1].trim();
    if (!raw || raw === '{}')
        return { name, narration, args: {} };
    // Спроба 1: прямий parse
    try {
        return { name, narration, args: JSON.parse(raw) };
    }
    catch { /* next */ }
    // Спроба 2: auto-repair backslash
    try {
        const args = JSON.parse(repairJson(raw));
        client_1.oogLogger.appendLine(`[Agent] JSON auto-repaired for "${name}"`);
        return { name, narration, args };
    }
    catch (e) {
        // Спроба 3: повертаємо parseError — агент отримає конкретне повідомлення
        const preview = raw.slice(0, 120).replace(/\n/g, ' ');
        const msg = `JSON parse error: ${e.message} | raw: ${preview}`;
        client_1.oogLogger.appendLine(`[Agent] ⚠️  ${msg}`);
        return { name, narration, args: {}, parseError: msg };
    }
}
// ── AGENT LOOP ────────────────────────────────────────────────────────────────
class AgentLoop {
    constructor(_ollama) {
        this._ollama = _ollama;
        this._history = [];
        this._listeners = [];
        /** Множина folderName вже завантажених скілів — для дедуплікації при динамічному пошуку */
        this._loadedFolders = new Set();
        this.running = false;
    }
    on(fn) { this._listeners.push(fn); }
    off(fn) { this._listeners = this._listeners.filter(l => l !== fn); }
    emit(ev) { this._listeners.forEach(l => l(ev)); }
    stop() { this._abortCtrl?.abort(); this.running = false; }
    clearHistory() {
        this._history = [];
        this._loadedFolders.clear();
        client_1.oogLogger.appendLine('[Agent] Історію очищено.');
    }
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
    async run(task, contextMessages = [], workspaceContext = '', language = 'Ukrainian', workspaceRoot = '') {
        this.running = true;
        this._abortCtrl = new AbortController();
        const signal = this._abortCtrl.signal;
        const maxSteps = vscode.workspace
            .getConfiguration('openollamagravity')
            .get('maxAgentSteps', 25);
        // Якщо workspaceRoot не передано явно — беремо з VSCode
        const resolvedRoot = workspaceRoot
            || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
            || '';
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
                // Об'єднуємо задачу + контекст + шлях проекту для пошуку скілів
                const taskContext = [task, workspaceContext, resolvedRoot].filter(Boolean).join('\n');
                loadedSkills = await Tools.autoLoadSkillsForTask(taskContext, workspaceContext, 3);
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
            // workspacePath беремо напряму з VSCode — агент використовує його для шляхів
            const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
            const sysPrompt = buildSystemPrompt(language, loadedSkills, workspaceContext, workspacePath, resolvedRoot);
            client_1.oogLogger.appendLine(`[Agent] System prompt: ${sysPrompt.length} chars` +
                (loadedSkills.length > 0
                    ? `, включає ${loadedSkills.length} скіл(и)`
                    : ', без скілів'));
            // Запам'ятовуємо завантажені скіли для дедуплікації при динамічному пошуку
            loadedSkills.forEach(s => this._loadedFolders.add(s.folderName));
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
            // Нарація — текст який агент написав ПЕРЕД <tool_call>
            if (tool.narration) {
                this.emit({ type: 'narration', content: tool.narration });
            }
            // Якщо args не вдалось розпарсити — повертаємо помилку агенту одразу,
            // не викликаємо інструмент з порожніми args (це призводить до "вкажіть path")
            if (tool.parseError) {
                this.emit({
                    type: 'tool_call', content: `Parse error: ${tool.name}`,
                    toolName: tool.name, toolArgs: {},
                });
                const errMsg = `TOOL CALL FAILED — could not parse your <args> JSON.\n` +
                    `Error: ${tool.parseError}\n\n` +
                    `REQUIRED FIX:\n` +
                    `1. Use double backslashes in Windows paths: "D:\\\\web_project\\\\file.txt"\n` +
                    `2. Escape all special chars in JSON strings\n` +
                    `3. Do NOT use single backslash \\ inside JSON strings\n` +
                    `Retry your tool call with correct JSON.`;
                this.emit({ type: 'tool_result', content: errMsg, toolName: tool.name, ok: false });
                this._history.push({ role: 'assistant', content: output });
                this._history.push({
                    role: 'user',
                    content: `<tool_result>\n<n>${tool.name}</n>\n<ok>false</ok>\n` +
                        `<o>${errMsg}</o>\n</tool_result>`,
                });
                continue; // даємо агенту шанс виправитись
            }
            // Є tool_call з валідними args → виконуємо інструмент
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
            // ── ДИНАМІЧНИЙ ПОШУК СКІЛІВ ─────────────────────────────────────────────
            // Аналізуємо вміст tool_result на сигнали: мова, фреймворк, технологія.
            // Нові знайдені скіли одразу вставляються в history — LLM використовує
            // їх вже на наступному кроці, без зайвих list_skills / read_skill запитів.
            if (res.ok) {
                await this._discoverSkillsFromResult(tool.name, res.output);
            }
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
            case 'edit_file': return Tools.editFile(args, (p, d) => confirm(`Редагувати ${p}:\n${d}`));
            case 'list_files': return Tools.listFiles(args);
            case 'search_files': return Tools.searchFiles(args);
            case 'run_terminal': return Tools.runTerminal(args, c => confirm(`Запустити: ${c}`));
            case 'get_diagnostics': return Tools.getDiagnostics(args);
            case 'get_file_outline': return Tools.getFileOutline(args);
            case 'create_directory': return Tools.createDirectory(args);
            case 'delete_file': return Tools.deleteFile(args, p => confirm(`Видалити файл ${p}?`));
            case 'get_workspace_info': return Tools.getWorkspaceInfo(args);
            // Fallback: агент сам запитує скіл якщо авто-підбір не вистачив
            case 'list_skills': return Tools.listSkills();
            case 'read_skill': return Tools.readSkill(args);
            case 'web_search': return Tools.webSearch(args);
            default:
                return {
                    ok: false,
                    output: `CRITICAL ERROR: Unknown tool "${name}". ` +
                        `Valid tools: read_file, write_file, edit_file, list_files, search_files, run_terminal, ` +
                        `get_diagnostics, get_file_outline, create_directory, delete_file, get_workspace_info, list_skills, read_skill, web_search. ` +
                        `Fix your <tool_call> and use an exact tool name from the list.`,
                };
        }
    }
    // ── ДИНАМІЧНИЙ ПОШУК СКІЛІВ ──────────────────────────────────────────────
    //
    // Жодних хардкодованих патернів.
    // Вміст tool_result токенізується і напряму скорується проти frontmatter
    // всіх незавантажених скілів — збіг по тегах/описі вирішує автоматично.
    async _discoverSkillsFromResult(toolName, resultContent) {
        try {
            const { skills: newSkills, contextTokens } = await Tools.discoverSkillsFromContext(toolName, resultContent, this._loadedFolders, 2, // максимум нових скілів за раз
            2);
            if (newSkills.length === 0)
                return;
            // Реєструємо щоб не завантажувати повторно
            newSkills.forEach(s => this._loadedFolders.add(s.folderName));
            // Вставляємо в history одразу після tool_result.
            // role:'user' з префіксом — Ollama не підтримує кілька system-messages.
            const hint = `[SYSTEM: Нові скіли знайдено з контексту (tokens: ${contextTokens.slice(0, 8).join(', ')})]\n\n` +
                newSkills.map(s => `### SKILL: ${s.name}\n` +
                    `<!-- folder: ${s.folderName} | score: ${s.score} -->\n\n` +
                    s.content).join('\n\n---\n\n');
            this._history.push({ role: 'user', content: hint });
            // Повідомляємо UI
            this.emit({
                type: 'skills_discovered',
                content: `Знайдено ${newSkills.length} скіл(и) з контексту`,
                skills: newSkills.map(s => ({
                    name: s.name,
                    folderName: s.folderName,
                    description: s.description,
                    score: s.score,
                })),
                signals: contextTokens.slice(0, 10),
            });
            client_1.oogLogger.appendLine('[Agent] Динамічно з контексту:\n' +
                newSkills.map(s => `  • [${s.score}] ${s.folderName} → "${s.name}"`).join('\n'));
        }
        catch (e) {
            client_1.oogLogger.appendLine(`[Agent] Skills discovery error: ${e.message}`);
        }
    }
}
exports.AgentLoop = AgentLoop;
