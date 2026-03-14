"use strict";
// Copyright (c) 2026 Юрій Кучеренко. All rights reserved.
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
const client_1 = require("../ollama/client");
const Tools = __importStar(require("./tools"));
const getToolsSchema = (language) => `
You are an autonomous coding agent.
CRITICAL: To call a tool, use XML: <tool_call><name>TOOL_NAME</name><args>{"arg": "val"}</args></tool_call>.

TOOLS:
1. list_files({"path": "...", "depth": 3})
2. read_file({"path": "..."})
3. write_file({"path": "...", "content": "..."})
4. run_terminal({"command": "...", "cwd": "..."})
5. create_directory({"path": "..."})
6. list_skills({})
7. read_skill({"name": "..."})

RULES:
- Reply in ${language}.
- CROSS-PROJECT: Use absolute paths like "D:\\\\web_project\\\\...".
- SKILLS: ALWAYS call list_skills({}) as your VERY FIRST step for any new project.
`.trim();
function parseToolCall(text) {
    const nameMatch = text.match(/<name>\s*([\w_]+)\s*<\/name>/i) || text.match(/"?name"?\s*:\s*"?([\w_]+)"?/i);
    if (!nameMatch)
        return null;
    const name = nameMatch[1].trim();
    let argsText = '';
    const argsMatch = text.match(/<args>([\s\S]*?)<\/args>/i) || text.match(/\{[\s\S]*\}/);
    if (argsMatch)
        argsText = (Array.isArray(argsMatch) ? (argsMatch[1] || argsMatch[0]) : argsMatch).trim();
    if (!argsText || argsText === '{}' || !argsText.includes('{'))
        return { name, args: {} };
    try {
        // Виправлення Windows шляхів (подвоєння бекслешів) перед парсингом JSON
        const fixedJson = argsText.replace(/"(path|cwd|file_pattern)"\s*:\s*"([^"]+)"/g, (m, k, v) => `"${k}": "${v.replace(/\\/g, '\\\\').replace(/\\\\\\\\/g, '\\\\')}"`);
        return { name, args: JSON.parse(fixedJson) };
    }
    catch {
        return { name, args: {} };
    }
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
    clearHistory() { this._history = []; client_1.oogLogger.appendLine('\n[Agent] Контекст очищено.'); }
    async run(task, contextMessages = [], workspaceContext = '', language = 'Ukrainian') {
        this.running = true;
        this._abortCtrl = new AbortController();
        const signal = this._abortCtrl.signal;
        const maxSteps = vscode.workspace.getConfiguration('openollamagravity').get('maxAgentSteps', 50);
        const sysPrompt = getToolsSchema(language) + (workspaceContext ? `\n\nWORKSPACE:\n${workspaceContext}` : '');
        if (!this._history.length)
            this._history.push({ role: 'system', content: sysPrompt });
        this._history.push({ role: 'user', content: task });
        client_1.oogLogger.appendLine(`\n🎯 ЗАВДАННЯ: ${task}`);
        for (let step = 1; step <= maxSteps; step++) {
            if (signal.aborted)
                break;
            this.emit({ type: 'step', content: '', step, totalSteps: maxSteps });
            client_1.oogLogger.appendLine(`\n--- Крок ${step} / ${maxSteps} ---`);
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
            client_1.oogLogger.appendLine(`[Agent] ВИКЛИК: ${tool.name}`);
            this.emit({ type: 'tool_call', content: `Calling: ${tool.name}`, toolName: tool.name, toolArgs: tool.args });
            const res = await this.executeTool(tool.name, tool.args);
            client_1.oogLogger.appendLine(`[Agent] РЕЗУЛЬТАТ: ${res.ok ? 'OK' : 'FAIL'}`);
            this.emit({ type: 'tool_result', content: res.output, toolName: tool.name, ok: res.ok });
            this._history.push({ role: 'assistant', content: output });
            this._history.push({ role: 'user', content: `<tool_result>\n<name>${tool.name}</name>\n<ok>${res.ok}</ok>\n<output>${res.output}</output>\n</tool_result>` });
        }
        this.running = false;
        this.emit({ type: 'done', content: 'Done' });
    }
    async _streamWithTimeout(step, totalSteps, signal) {
        const timeoutSec = vscode.workspace.getConfiguration('openollamagravity').get('firstTokenTimeoutSec', 180);
        return new Promise((resolve, reject) => {
            let first = false;
            const h = setTimeout(() => { if (!first)
                reject(new Error(`Ollama не відповіла за ${timeoutSec}с.`)); }, timeoutSec * 1000);
            this._ollama.chatStream(this._history, t => {
                if (!first) {
                    first = true;
                    clearTimeout(h);
                }
                this.emit({ type: 'thinking', content: t, step, totalSteps });
            }, signal, this.model).then(resolve).catch(reject);
        });
    }
    async executeTool(name, args) {
        const confirm = async (l) => (await vscode.window.showWarningMessage(`OOG: ${l}`, 'Allow', 'Deny')) === 'Allow';
        switch (name) {
            case 'read_file': return Tools.readFile(args);
            case 'write_file': return Tools.writeFile(args, p => confirm(`Write ${p}`));
            case 'list_files': return Tools.listFiles(args);
            case 'run_terminal': return Tools.runTerminal(args, c => confirm(`Run ${c}`));
            case 'create_directory': return Tools.createDirectory(args);
            case 'list_skills': return Tools.listSkills();
            case 'read_skill': return Tools.readSkill(args);
            default: return { ok: false, output: `Tool ${name} not found.` };
        }
    }
}
exports.AgentLoop = AgentLoop;
