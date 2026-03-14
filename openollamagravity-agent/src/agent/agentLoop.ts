// Copyright (c) 2026 Юрій Кучеренко.
import * as vscode from 'vscode';
import { OllamaClient, OllamaMessage, oogLogger } from '../ollama/client';
import * as Tools from './tools';

export type AgentEventType = 'thinking' | 'tool_call' | 'tool_result' | 'answer' | 'error' | 'done' | 'step';
export interface AgentEvent { type: AgentEventType; content: string; toolName?: string; toolArgs?: any; ok?: boolean; step?: number; totalSteps?: number; }

// ── ПОВЕРТАЄМО ЖОРСТКИЙ ШАБЛОН ІНСТРУМЕНТІВ ──
const getToolsSchema = (language: string, actualSkillsPath: string) => `
You are an autonomous coding agent. 
CRITICAL: To call a tool, you MUST use exactly this XML format:
<tool_call>
<name>TOOL_NAME</name>
<args>{"arg": "val"}</args>
</tool_call>

If no arguments are needed, use: <args>{}</args>
DO NOT write Python, Node.js, or any other code to call tools. ONLY use the XML <tool_call> format. Do not ask for permission, just call the tool.

AVAILABLE TOOLS:
1. list_files({"path": "...", "depth": 3})
2. read_file({"path": "..."})
3. write_file({"path": "...", "content": "..."})
4. run_terminal({"command": "...", "cwd": "..."})
5. create_directory({"path": "..."})
6. list_skills({})
7. read_skill({"name": "..."})

RULES:
1. Reply in ${language}.
2. For user projects, use absolute paths like "D:\\\\web_project\\\\...".
3. YOUR SKILLS BASE is strictly located at: "${actualSkillsPath}".
4. ALWAYS use list_skills({}) and read_skill({"name": "..."}) to access instructions. Do NOT invent alternative paths.
`.trim();

function parseToolCall(text: string): { name: string; args: any } | null {
  const nameMatch = text.match(/<name>\s*([\w_]+)\s*<\/name>/i) || text.match(/"?name"?\s*:\s*"?([\w_]+)"?/i);
  if (!nameMatch) return null;
  const name = nameMatch[1].trim();

  let argsText = '';
  const argsMatch = text.match(/<args>([\s\S]*?)<\/args>/i) || text.match(/\{[\s\S]*\}/);
  if (argsMatch) argsText = (Array.isArray(argsMatch) ? (argsMatch[1] || argsMatch[0]) : argsMatch).trim();

  if (!argsText || argsText === '{}' || !argsText.includes('{')) return { name, args: {} };

  try {
    const fixed = argsText.replace(/"(path|cwd)"\s*:\s*"([^"]+)"/g, (m, k, v) => `"${k}": "${v.replace(/\\/g, '\\\\').replace(/\\\\\\\\/g, '\\\\')}"`);
    return { name, args: JSON.parse(fixed) };
  } catch { return { name, args: {} }; }
}

export class AgentLoop {
  private _history: OllamaMessage[] = [];
  private _listeners: ((ev: AgentEvent) => void)[] = [];
  private _abortCtrl?: AbortController;
  public running = false;
  public model?: string;

  constructor(private _ollama: OllamaClient) {}

  on(fn: (ev: AgentEvent) => void) { this._listeners.push(fn); }
  off(fn: (ev: AgentEvent) => void) { this._listeners = this._listeners.filter(l => l !== fn); }
  private emit(ev: AgentEvent) { this._listeners.forEach(l => l(ev)); }

  stop() { this._abortCtrl?.abort(); this.running = false; }
  clearHistory() { this._history = []; oogLogger.appendLine('[Agent] Історію очищено.'); }

  async run(task: string, contextMessages: OllamaMessage[] = [], workspaceContext = '', language = 'Ukrainian') {
    this.running = true;
    this._abortCtrl = new AbortController();
    const signal = this._abortCtrl.signal;
    const cfg = vscode.workspace.getConfiguration('openollamagravity');
    const maxSteps = cfg.get('maxAgentSteps', 25);

    // Отримуємо РЕАЛЬНИЙ шлях до скілів
    const actualSkillsPath = cfg.get<string>('skillsPath', '').replace(/\\/g, '\\\\');

    let finalTask = task;
    try {
      const skills = await Tools.listSkills();
      if (skills.ok) {
        const matches = skills.output.split('\n').filter(s => s.endsWith('.md') && new RegExp(`\\b${s.replace('.md','')}\\b`, 'i').test(task));
        if (matches.length) finalTask += `\n\n[SYSTEM HINT]: Спершу обов'язково прочитай ці інструкції зі своєї бази знань:\n${matches.map(m => `- read_skill({"name": "${m}"})`).join('\n')}`;
      }
    } catch {}

    if (this._history.length === 0) {
      // Використовуємо функцію для генерації повного промпту
      const sysPrompt = getToolsSchema(language, actualSkillsPath);

      this._history.push({ role: 'system', content: sysPrompt });
      if (contextMessages.length > 0) this._history.push(...contextMessages);
    }
    this._history.push({ role: 'user', content: finalTask });

    for (let step = 1; step <= maxSteps; step++) {
      if (signal.aborted) break;
      this.emit({ type: 'step', content: '', step, totalSteps: maxSteps });

      let output = '';
      try {
        output = await this._streamWithTimeout(step, maxSteps, signal);
      } catch (err: any) {
        this.emit({ type: 'error', content: err.message });
        break;
      }

      const tool = parseToolCall(output);
      if (!tool) { this.emit({ type: 'answer', content: output }); break; }

      this.emit({ type: 'tool_call', content: `Calling: ${tool.name}`, toolName: tool.name, toolArgs: tool.args });
      const res = await this.executeTool(tool.name, tool.args);
      this.emit({ type: 'tool_result', content: res.output, toolName: tool.name, ok: res.ok });

      this._history.push({ role: 'assistant', content: output });
      this._history.push({ role: 'user', content: `<tool_result><name>${tool.name}</name><ok>${res.ok}</ok><output>${res.output}</output></tool_result>` });
    }
    this.running = false;
    this.emit({ type: 'done', content: '' });
  }

  private async _streamWithTimeout(step: number, total: number, signal: AbortSignal): Promise<string> {
    const timeout = vscode.workspace.getConfiguration('openollamagravity').get<number>('firstTokenTimeoutSec', 180) * 1000;
    return new Promise((res, rej) => {
      let started = false;
      const h = setTimeout(() => { if (!started) rej(new Error('Ollama не відповіла за таймаутом. Спробуйте меншу модель.')); }, timeout);
      this._ollama.chatStream(this._history, t => { started = true; clearTimeout(h); this.emit({ type: 'thinking', content: t, step, totalSteps: total }); }, signal, this.model).then(res).catch(rej);
    });
  }

  private async executeTool(name: string, args: any): Promise<Tools.ToolResult> {
    const conf = async (m: string) => (await vscode.window.showWarningMessage(`OOG: ${m}`, 'Allow', 'Deny')) === 'Allow';
    switch (name) {
      case 'read_file': return Tools.readFile(args);
      case 'write_file': return Tools.writeFile(args, p => conf(`Записати у ${p}`));
      case 'list_files': return Tools.listFiles(args);
      case 'run_terminal': return Tools.runTerminal(args, c => conf(`Запустити ${c}`));
      case 'create_directory': return Tools.createDirectory(args);
      case 'list_skills': return Tools.listSkills();
      case 'read_skill': return Tools.readSkill(args);
      default: return { ok: false, output: `Tool ${name} not found.` };
    }
  }
}