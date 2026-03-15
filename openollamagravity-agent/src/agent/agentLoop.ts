// Copyright (c) 2026 Юрій Кучеренко.
import * as vscode from 'vscode';
import { OllamaClient, OllamaMessage, oogLogger } from '../ollama/client';
import * as Tools from './tools';

export type AgentEventType = 'thinking' | 'tool_call' | 'tool_result' | 'answer' | 'error' | 'done' | 'step';
export interface AgentEvent { type: AgentEventType; content: string; toolName?: string; toolArgs?: any; ok?: boolean; step?: number; totalSteps?: number; }

// ── ПОВЕРТАЄМО ЖОРСТКИЙ ШАБЛОН ІНСТРУМЕНТІВ ──
const getToolsSchema = (language: string, actualSkillsPath: string) => `
You are an advanced autonomous coding agent. 

CRITICAL INSTRUCTION:
To interact with the system, you MUST use the EXACT XML format below. 
DO NOT output conversational text, explanations, or markdown code blocks (like \`\`\`xml) when calling a tool. 
Output ONLY the raw XML block.

Example of a correct tool call:
<tool_call>
<name>read_file</name>
<args>{"path": "package.json"}</args>
</tool_call>

AVAILABLE TOOLS (USE EXACT NAMES ONLY):
- name: list_files
  args: {"path": "...", "depth": 3}
- name: read_file
  args: {"path": "..."}
- name: write_file
  args: {"path": "...", "content": "..."}
- name: run_terminal
  args: {"command": "...", "cwd": "..."}
- name: create_directory
  args: {"path": "..."}
- name: list_skills
  args: {}
- name: read_skill
  args: {"name": "..."}

RULES:
1. If you need to perform an action, your ENTIRE response must be just ONE <tool_call> block. No text before or after.
2. If you have finished the task and have a final answer for the user, reply in ${language} WITHOUT any <tool_call>.
3. For user projects, use absolute paths like "D:\\\\web_project\\\\...".
4. YOUR SKILLS BASE is strictly located at: "${actualSkillsPath}".
5. CRITICAL ANTI-HALLUCINATION RULE: Use ONLY the exact tool names listed above. Use "run_terminal", NEVER "run_termiinal".
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
      default:
        // Повертаємо детальну помилку, щоб агент міг виправити свій синтаксис
        return {
          ok: false,
          output: `CRITICAL ERROR: Tool '${name}' does not exist! Stop inventing tool names. You MUST use EXACTLY one of the following: read_file, write_file, list_files, run_terminal, create_directory, list_skills, read_skill. Please correct your tool call.`
        };
    }
  }
}