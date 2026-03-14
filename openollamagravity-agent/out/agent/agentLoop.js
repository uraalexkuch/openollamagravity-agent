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
const vscode = __importStar(require("vscode"));
const Tools = __importStar(require("./tools"));
const getToolsSchema = (language) => `
You are an autonomous coding agent with access to the following tools.
Call them by wrapping your tool call in <tool_call> XML tags.

TOOLS:
1. list_files({"path?": ".", "depth?": 3})
   - List files and folders in the workspace.
2. read_file({"path": "...", "start_line?": 1, "end_line?": N})
   - Read file contents, optionally limited to a line range.
3. write_file({"path": "...", "content": "...", "mode?": "overwrite|append"})
   - Write a file. mode: "overwrite" (default) or "append".
4. edit_file({"path": "...", "start_line": N, "end_line": N, "new_content": "..."})
   - Replace specific lines in a file.
5. run_terminal({"command": "...", "cwd?": "."})
   - Execute an allowed shell command.
6. get_workspace_info({})
   - Get project type, name, dependencies.
7. get_diagnostics({"path?": "..."})
   - Get VSCode errors/warnings.
8. list_skills({})
   - List available skill files and guides from the skills repository.
9. read_skill({"name": "path/to/SKILL.md"})
   - Read a specific skill file to learn best practices and instructions.

HOW TO CALL A TOOL:
<tool_call>
<name>TOOL_NAME</name>
<args>{"arg1": "value"}</args>
</tool_call>

CRITICAL RULES:
- ALWAYS communicate, explain, and write your final answers in ${language}.
- Only call ONE tool per response turn.
- After the tool result, continue reasoning or call another tool.
- When you have a final answer or completed the task, write it normally without a tool_call.
- ARGUMENTS MUST BE VALID JSON. You MUST use double quotes for JSON keys (e.g., {"path": "."} NOT {path: "."}).
- Do NOT forget the opening <tool_call> tag.

MANDATORY WORKFLOW FOR ALL TASKS:
0. SKILLS CHECK: 
   - Read the [SYSTEM HINT] at the end of the user's prompt (if provided) and call read_skill({"name": "..."}) for EACH suggested file BEFORE writing any code.
   - If no hint is provided, you may optionally call list_skills({}) to find relevant instructions.
1. PLANNING: Write a ### Proposed Changes plan in Markdown.
2. EXECUTION: Execute your plan using tools (edit_file, write_file).
3. VERIFICATION: Use "run_terminal" to build/test and verify your changes.
`.trim();
function parseToolCall(text) {
    // Дозволяємо пропущену < у tool_call та можливу відсутність закриваючого тегу
    // або взагалі відсутність тегу <tool_call>, якщо є <name> та <args>
    const match = text.match(/(?:<)?tool_call>?\s*<name>([\w_]+)<\/name>\s*<args>([\s\S]*?)<\/args>/i)
        || text.match(/<name>([\w_]+)<\/name>\s*<args>([\s\S]*?)<\/args>/i);
    if (!match)
        return null;
    const name = match[1].trim();
    let argsText = match[2].trim();
    // Евристика для виправлення невалідного JSON від LLM
    if (argsText) {
        // 1. Додаємо подвійні лапки навколо ключів: {path: ".", depth: 3} -> {"path": ".", "depth": 3}
        argsText = argsText.replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":');
        // 2. Заміна одинарних лапок на подвійні (наприклад {'path': '.'})
        argsText = argsText.replace(/'([^']*)'/g, '"$1"');
        // 3. Прибираємо зайві коми в кінці (trailing commas: {"path": ".", })
        argsText = argsText.replace(/,\s*}/g, '}');
    }
    let args = {};
    try {
        args = JSON.parse(argsText || '{}');
    }
    catch (e) {
        console.warn('[Agent] Failed to parse repaired args:', argsText);
    }
    return { name, args };
}
class AgentLoop {
    constructor(ollama) {
        this._listeners = [];
        this._history = [];
        this.running = false;
        this._ollama = ollama;
    }
    on(fn) { this._listeners.push(fn); }
    off(fn) { this._listeners = this._listeners.filter(l => l !== fn); }
    emit(ev) { this._listeners.forEach(l => l(ev)); }
    stop() { this._abortCtrl?.abort(); this.running = false; }
    clearHistory() { this._history = []; }
    async run(task, contextMessages = [], workspaceContext = '', language = 'Ukrainian') {
        this.running = true;
        this._abortCtrl = new AbortController();
        const signal = this._abortCtrl.signal;
        const maxSteps = vscode.workspace.getConfiguration('openollamagravity').get('maxAgentSteps', 25);
        const sysPrompt = getToolsSchema(language) +
            (workspaceContext ? `\n\nWORKSPACE:\n${workspaceContext}` : '');
        if (this._history.length === 0) {
            this._history.push({ role: 'system', content: sysPrompt });
            if (contextMessages.length > 0)
                this._history.push(...contextMessages);
        }
        else {
            this._history[0] = { role: 'system', content: sysPrompt };
        }
        // ─────────────────────────────────────────────────────────
        // АВТОМАТИЧНИЙ ПІДБІР СКІЛІВ НА ОСНОВІ ЗАПИТУ
        // ─────────────────────────────────────────────────────────
        let finalTask = task;
        try {
            const skillsRes = await Tools.listSkills();
            if (skillsRes.ok) {
                const taskLower = task.toLowerCase();
                const suggestedSkills = [];
                const lines = skillsRes.output.split('\n');
                for (const line of lines) {
                    const cleanPath = line.trim();
                    if (cleanPath.endsWith('.md')) {
                        // Витягуємо назву файлу (наприклад "react" з "frameworks/react.md")
                        const fileName = cleanPath.split('/').pop()?.replace('.md', '').toLowerCase();
                        if (fileName) {
                            // Екрануємо спецсимволи та шукаємо слово як окремий токен у запиті
                            const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                            const regex = new RegExp(`\\b${escaped}\\b`, 'i');
                            if (regex.test(taskLower)) {
                                suggestedSkills.push(cleanPath);
                            }
                        }
                    }
                }
                // Якщо знайдено збіги — додаємо жорстку інструкцію в кінець завдання
                if (suggestedSkills.length > 0) {
                    finalTask += `\n\n[SYSTEM HINT]: Based on your request keywords, you MUST read these relevant skills first using read_skill:\n`
                        + suggestedSkills.map(s => `- {"name": "${s}"}`).join('\n');
                }
            }
        }
        catch (e) {
            /* Ігноруємо помилки читання скілів, щоб не перервати роботу агента */
        }
        // ─────────────────────────────────────────────────────────
        this._history.push({ role: 'user', content: finalTask });
        this.emit({ type: 'step', content: 'Starting task...', step: 0, totalSteps: maxSteps });
        for (let step = 1; step <= maxSteps; step++) {
            if (signal.aborted) {
                this.emit({ type: 'done', content: 'Stopped.' });
                this.running = false;
                return;
            }
            this.emit({ type: 'thinking', content: '', step, totalSteps: maxSteps });
            let output = '';
            try {
                output = await this._streamWithTimeout(step, maxSteps, signal);
            }
            catch (err) {
                this.emit({ type: 'error', content: err.message });
                break;
            }
            const call = parseToolCall(output);
            if (!call) {
                this.emit({ type: 'answer', content: output });
                break;
            }
            this.emit({ type: 'tool_call', content: `Calling ${call.name}`, toolName: call.name, toolArgs: call.args });
            const res = await this.executeTool(call.name, call.args);
            this.emit({ type: 'tool_result', content: res.output, toolName: call.name, ok: res.ok });
            this._history.push({ role: 'assistant', content: output });
            this._history.push({
                role: 'user',
                content: `<tool_result>\n<name>${call.name}</name>\n<ok>${res.ok}</ok>\n<output>${res.output}</output>\n</tool_result>`,
            });
        }
        this.running = false;
        this.emit({ type: 'done', content: 'Complete.' });
    }
    async _streamWithTimeout(step, totalSteps, signal) {
        const cfg = vscode.workspace.getConfiguration('openollamagravity');
        const firstTokenTimeoutMs = cfg.get('firstTokenTimeoutSec', 90) * 1000;
        return new Promise((resolve, reject) => {
            let firstTokenReceived = false;
            let timeoutHandle;
            const timeoutError = () => {
                reject(new Error(`Ollama не відповідає. Можливо, контекст завеликий. Спробуйте очистити чат або перезапустити Ollama.`));
            };
            timeoutHandle = setTimeout(timeoutError, firstTokenTimeoutMs);
            this._ollama.chatStream(this._history, (tok) => {
                if (!firstTokenReceived) {
                    firstTokenReceived = true;
                    clearTimeout(timeoutHandle);
                    timeoutHandle = undefined;
                }
                this.emit({ type: 'thinking', content: tok, step, totalSteps });
            }, signal, this.model).then((fullOutput) => {
                clearTimeout(timeoutHandle);
                resolve(fullOutput);
            }).catch((err) => {
                clearTimeout(timeoutHandle);
                reject(err);
            });
        });
    }
    async executeTool(name, args) {
        const confirm = async (label) => (await vscode.window.showWarningMessage(`OOG: ${label}`, 'Allow', 'Deny')) === 'Allow';
        switch (name) {
            case 'read_file': return Tools.readFile(args);
            case 'write_file': return Tools.writeFile(args, async (p) => confirm(`Write ${p}`));
            case 'edit_file': return Tools.editFile(args, async (p) => confirm(`Edit ${p}`));
            case 'list_files': return Tools.listFiles(args);
            case 'get_workspace_info': return Tools.getWorkspaceInfo();
            case 'get_diagnostics': return Tools.getDiagnostics(args);
            case 'list_skills': return Tools.listSkills();
            case 'read_skill': return Tools.readSkill(args);
            case 'run_terminal': return Tools.runTerminal(args, async (c) => confirm(`Run ${c}`));
            default: return { ok: false, output: `Tool "${name}" is not implemented.` };
        }
    }
}
exports.AgentLoop = AgentLoop;
