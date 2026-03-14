// Copyright (c) 2026 Юрій Кучеренко. All rights reserved.

import * as vscode from 'vscode';
import { OllamaClient, OllamaMessage, oogLogger } from '../ollama/client';
import * as Tools from './tools';

export type AgentEventType = 'thinking' | 'tool_call' | 'tool_result' | 'answer' | 'error' | 'done' | 'step';

export interface AgentEvent {
  type: AgentEventType;
  content: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  ok?: boolean;
  step?: number;
  totalSteps?: number;
}

const getToolsSchema = (language: string) => `
You are an autonomous coding agent. Use <tool_call> tags.
CRITICAL: For 'path' or 'cwd', ALWAYS use absolute Windows paths like "D:\\\\web_project\\\\...".

TOOLS:
1. list_files({"path": "...", "depth": 3})
2. read_file({"path": "..."})
3. write_file({"path": "...", "content": "..."})
4. edit_file({"path": "...", "start_line": N, "end_line": N, "new_content": "..."})
5. run_terminal({"command": "...", "cwd": "..."})
6. list_skills({})
7. read_skill({"name": "..."})

RULES:
- Reply in ${language}.
- Use valid JSON for arguments.
- Call only ONE tool per turn.
`.trim();

function parseToolCall(text: string): { name: string; args: Record<string, unknown> } | null {
  const nameMatch = text.match(/<name>\s*([\w_]+)\s*<\/name>/i) || text.match(/"?name"?\s*:\s*"?([\w_]+)"?/i);
  if (!nameMatch) return null;
  const name = nameMatch[1].trim();

  let argsText = '';
  const argsMatch = text.match(/<args>([\s\S]*?)<\/args>/i) || text.match(/\{[\s\S]*\}/);
  if (argsMatch) argsText = (Array.isArray(argsMatch) ? argsMatch[1] || argsMatch[0] : argsMatch).trim();

  if (!argsText || argsText === '{}') return { name, args: {} };

  try {
    // Автоматичне виправлення бекслешів у Windows шляхах перед JSON.parse
    argsText = argsText.replace(/"(path|cwd|file_pattern)"\s*:\s*"([^"]+)"/g, (m, k, v) =>
        `"${k}": "${v.replace(/\\/g, '\\\\').replace(/\\\\\\\\/g, '\\\\')}"`);
    return { name, args: JSON.parse(argsText) };
  } catch {
    return { name, args: {} };
  }
}

export class AgentLoop {
  private _ollama: OllamaClient;
  private _abortCtrl?: AbortController;
  private _listeners: ((ev: AgentEvent) => void)[] = [];
  private _history: OllamaMessage[] = [];
  public running = false;
  public model?: string;

  constructor(ollama: OllamaClient) { this._ollama = ollama; }
  on(fn: any) { this._listeners.push(fn); }
  off(fn: any) { this._listeners = this._listeners.filter(l => l !== fn); }
  private emit(ev: AgentEvent) { this._listeners.forEach(l => l(ev)); }

  stop() { this._abortCtrl?.abort(); this.running = false; }
  clearHistory() { this._history = []; }

  async run(task: string, contextMessages: OllamaMessage[] = [], workspaceContext = '', language: string = 'Ukrainian') {
    this.running = true;
    this._abortCtrl = new AbortController();
    const signal = this._abortCtrl.signal;
    const maxSteps = vscode.workspace.getConfiguration('openollamagravity').get('maxAgentSteps', 25);

    // Auto-matching skills
    let finalTask = task;
    try {
      const skillsRes = await Tools.listSkills();
      if (skillsRes.ok) {
        const matches = skillsRes.output.split('\n')
            .filter(s => s.endsWith('.md') && new RegExp(`\\b${s.split('/').pop()?.replace('.md','')}\\b`, 'i').test(task));
        if (matches.length) finalTask += `\n\n[SYSTEM HINT]: Read these skills first:\n${matches.map(m => `- read_skill({"name": "${m}"})`).join('\n')}`;
      }
    } catch {}

    const sysPrompt = getToolsSchema(language) + (workspaceContext ? `\n\nWORKSPACE:\n${workspaceContext}` : '');
    if (!this._history.length) this._history.push({ role: 'system', content: sysPrompt });
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
      if (!tool) {
        this.emit({ type: 'answer', content: output });
        break;
      }

      this.emit({ type: 'tool_call', content: `Calling: ${tool.name}`, toolName: tool.name, toolArgs: tool.args });
      const res = await this.executeTool(tool.name, tool.args);
      this.emit({ type: 'tool_result', content: res.output, toolName: tool.name, ok: res.ok });

      this._history.push({ role: 'assistant', content: output });
      this._history.push({ role: 'user', content: `<tool_result><name>${tool.name}</name><ok>${res.ok}</ok><output>${res.output}</output></tool_result>` });
    }
    this.running = false;
  }

  private async _streamWithTimeout(step: number, totalSteps: number, signal: AbortSignal): Promise<string> {
    const timeoutSec = vscode.workspace.getConfiguration('openollamagravity').get<number>('firstTokenTimeoutSec', 180);
    return new Promise<string>((resolve, reject) => {
      let first = false;
      const h = setTimeout(() => { if (!first) reject(new Error(`Ollama timeout (> ${timeoutSec}s).`)); }, timeoutSec * 1000);
      this._ollama.chatStream(this._history, t => {
        if (!first) { first = true; clearTimeout(h); }
        this.emit({ type: 'thinking', content: t, step, totalSteps });
      }, signal, this.model).then(resolve).catch(reject);
    });
  }

  private async executeTool(name: string, args: any): Promise<Tools.ToolResult> {
    const confirm = async (l: string) => (await vscode.window.showWarningMessage(`OOG: ${l}`, 'Allow', 'Deny')) === 'Allow';
    switch (name) {
      case 'read_file': return Tools.readFile(args);
      case 'write_file': return Tools.writeFile(args, p => confirm(`Write ${p}`));
      case 'edit_file': return Tools.editFile(args, p => confirm(`Edit ${p}`));
      case 'list_files': return Tools.listFiles(args);
      case 'run_terminal': return Tools.runTerminal(args, c => confirm(`Run ${c}`));
      case 'list_skills': return Tools.listSkills();
      case 'read_skill': return Tools.readSkill(args);
      default: return { ok: false, output: `Tool ${name} not found.` };
    }
  }
}