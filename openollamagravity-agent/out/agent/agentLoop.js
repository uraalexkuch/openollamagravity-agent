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
// СИСТЕМНИЙ ПРОМПТ
// ─────────────────────────────────────────────────────────────────────────────
function buildSystemPrompt(language, loadedSkills) {
    // ── Блок знань: лише завантажені релевантні скіли ──────────────────────────
    const skillsBlock = loadedSkills.length === 0
        ? ''
        : [
            '━━━ RELEVANT SKILLS FOR THIS TASK ━━━',
            'The following skills were automatically selected based on your task.',
            'Apply their workflows, commands, and verification steps.',
            '',
            ...loadedSkills.map(s => `### SKILL: ${s.name}\n${s.content}`),
            '━━━ END OF SKILLS ━━━',
        ].join('\n');
    return `
You are an advanced autonomous coding and cybersecurity agent.

CRITICAL INSTRUCTION:
To call a tool, output ONLY the raw XML block below. No prose, no markdown around it.

<tool_call>
<n>tool_name</n>
<args>{"key": "value"}</args>
</tool_call>

AVAILABLE TOOLS:
- name: list_files        args: {"path": "...", "depth": 3}
- name: read_file         args: {"path": "..."}
- name: write_file        args: {"path": "...", "content": "..."}
- name: run_terminal      args: {"command": "...", "cwd": "..."}
- name: create_directory  args: {"path": "..."}
- name: list_skills       args: {}
- name: read_skill        args: {"name": "skill_path"}

RULES:
1. ONE <tool_call> block per response — nothing before or after.
2. Final answer → reply in ${language} with no XML.
3. Use absolute paths for user projects.
4. Use ONLY exact tool names above — never invent names.
5. If the task requires a skill NOT listed below, call list_skills first,
   then read_skill for the relevant one.

${skillsBlock}
`.trim();
}
// ── TOOL CALL PARSER ──────────────────────────────────────────────────────────
function parseToolCall(text) {
    const block = text.match(/<tool_call>([\s\S]*?)<\/tool_call>/i);
    if (!block)
        return null;
    const inner = block[1];
    const nameMatch = inner.match(/<n>\s*([\w_]+)\s*<\/n>/i)
        || inner.match(/<name>\s*([\w_]+)\s*<\/name>/i);
    if (!nameMatch)
        return null;
    const name = nameMatch[1].trim();
    const argsMatch = inner.match(/<args>([\s\S]*?)<\/args>/i);
    if (!argsMatch)
        return { name, args: {} };
    const raw = argsMatch[1].trim();
    if (!raw || raw === '{}')
        return { name, args: {} };
    try {
        const fixed = raw.replace(/"(path|cwd|name|command)"\s*:\s*"([^"]*)"/g, (_, k, v) => `"${k}": "${v.replace(/(?<!\\)\\/g, '\\\\').replace(/\\\\\\\\/g, '\\\\')}"`);
        return { name, args: JSON.parse(fixed) };
    }
    catch {
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
    async run(task, contextMessages = [], workspaceContext = '', language = 'Ukrainian') {
        this.running = true;
        this._abortCtrl = new AbortController();
        const signal = this._abortCtrl.signal;
        const cfg = vscode.workspace.getConfiguration('openollamagravity');
        const maxSteps = cfg.get('maxAgentSteps', 25);
        // ── PROGRESSIVE DISCLOSURE: автоматичний підбір скілів до запуску агента ──
        //
        // Система сама читає frontmatter (~30-50 токенів) кожного SKILL.md,
        // порівнює з текстом задачі і завантажує ПОВНИЙ текст лише релевантних.
        // Агент отримує їх вже готовими у системному промпті.
        // Жодного зайвого токена на нерелевантні скіли зі 600+ бази.
        let loadedSkills = [];
        try {
            loadedSkills = await Tools.autoLoadSkillsForTask(task, 3);
            if (loadedSkills.length > 0) {
                // Показуємо користувачу які скіли були підібрані та завантажені
                this.emit({
                    type: 'skills_loaded',
                    content: `Підібрано ${loadedSkills.length} скіл(и) для задачі`,
                    skills: loadedSkills.map(s => ({
                        name: s.name,
                        description: s.description,
                        score: s.score,
                    })),
                });
                client_1.oogLogger.appendLine(`[Agent] Скіли для задачі:\n` +
                    loadedSkills.map(s => `  • ${s.name} (score=${s.score})`).join('\n'));
            }
            else {
                client_1.oogLogger.appendLine('[Agent] Релевантних скілів не знайдено — агент працює без скілів.');
            }
        }
        catch (e) {
            client_1.oogLogger.appendLine(`[Agent] Помилка підбору скілів: ${e.message}`);
        }
        // ── Ініціалізуємо системний промпт з вже вбудованими скілами ──────────────
        if (this._history.length === 0) {
            const sysPrompt = buildSystemPrompt(language, loadedSkills);
            this._history.push({ role: 'system', content: sysPrompt });
            if (contextMessages.length > 0)
                this._history.push(...contextMessages);
        }
        this._history.push({ role: 'user', content: task });
        // ── Основний цикл агента ──────────────────────────────────────────────────
        for (let step = 1; step <= maxSteps; step++) {
            if (signal.aborted)
                break;
            this.emit({ type: 'step', content: '', step, totalSteps: maxSteps });
            let output = '';
            try {
                output = await this._streamWithTimeout(step, maxSteps, signal);
            }
            catch (err) {
                this.emit({ type: 'error', content: err.message });
                break;
            }
            const tool = parseToolCall(output);
            if (!tool) {
                this.emit({ type: 'answer', content: output });
                break;
            }
            this.emit({
                type: 'tool_call',
                content: `Calling: ${tool.name}`,
                toolName: tool.name,
                toolArgs: tool.args,
            });
            const res = await this._executeTool(tool.name, tool.args);
            this.emit({
                type: 'tool_result',
                content: res.output,
                toolName: tool.name,
                ok: res.ok,
            });
            this._history.push({ role: 'assistant', content: output });
            this._history.push({
                role: 'user',
                content: `<tool_result><n>${tool.name}</n><ok>${res.ok}</ok><o>${res.output}</o></tool_result>`,
            });
        }
        this.running = false;
        this.emit({ type: 'done', content: '' });
    }
    async _streamWithTimeout(step, total, signal) {
        const ms = vscode.workspace
            .getConfiguration('openollamagravity')
            .get('firstTokenTimeoutSec', 180) * 1000;
        return new Promise((resolve, reject) => {
            let started = false;
            const timer = setTimeout(() => {
                if (!started)
                    reject(new Error('Ollama не відповіла за таймаутом. Спробуйте меншу модель.'));
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
    async _executeTool(name, args) {
        const confirm = async (msg) => (await vscode.window.showWarningMessage(`OOG: ${msg}`, 'Allow', 'Deny')) === 'Allow';
        switch (name) {
            case 'read_file': return Tools.readFile(args);
            case 'write_file': return Tools.writeFile(args, p => confirm(`Записати у ${p}`));
            case 'list_files': return Tools.listFiles(args);
            case 'run_terminal': return Tools.runTerminal(args, c => confirm(`Запустити: ${c}`));
            case 'create_directory': return Tools.createDirectory(args);
            // Fallback: агент може запросити скіл вручну якщо авто-підбір не вистачив
            case 'list_skills': return Tools.listSkills();
            case 'read_skill': return Tools.readSkill(args);
            default:
                return {
                    ok: false,
                    output: `CRITICAL ERROR: Tool "${name}" does not exist! ` +
                        `Valid: read_file, write_file, list_files, run_terminal, ` +
                        `create_directory, list_skills, read_skill.`,
                };
        }
    }
}
exports.AgentLoop = AgentLoop;
