// Copyright (c) 2026 Юрій Кучеренко. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root for full license information.

import * as vscode from 'vscode';
import { OllamaClient, OllamaMessage } from '../ollama/client';
import * as Tools from './tools';

export type AgentEventType =
    | 'thinking'
    | 'tool_call'
    | 'tool_result'
    | 'answer'
    | 'error'
    | 'done'
    | 'step';

export interface AgentEvent {
  type: AgentEventType;
  content: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  ok?: boolean;
  step?: number;
  totalSteps?: number;
}

type EventListener = (ev: AgentEvent) => void;

// ── Tool schema descriptions ────────────────────────────────────────────────
const getToolsSchema = (language: string) => `
You are an autonomous coding agent with access to the following tools.
Call them by wrapping your tool call in <tool_call> XML tags.

TOOLS:
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
11. get_workspace_info()
    - Get project type, name, dependencies
12. web_search(query)
    - Search the internet/documentation for solutions or info (via Perplexica)
13. list_skills()
    - List available skill files and guides from the repository
14. read_skill(name)
    - Read a specific skill file to learn best practices and instructions

HOW TO CALL A TOOL:
<tool_call>
<name>TOOL_NAME</name>
<args>{"arg1": "value1", "arg2": "value2"}</args>
</tool_call>

RULES:
- ALWAYS communicate, explain, and write your final answers in ${language}. This is a strict requirement.
- Think step by step. Before writing code, read the relevant files first.
- Only call ONE tool per response turn.
- After the tool result, continue reasoning or call another tool.
- When you have a final answer or completed the task, write it normally without a tool_call.
- Prefer small targeted edits (edit_file) over full rewrites when possible.
- CROSS-PROJECT ACCESS: You can access files, read, edit, and run commands in ANY project on the user's computer by using absolute paths (e.g., "D:\\\\web_project\\\\intern50\\\\backend") in tool arguments (path, cwd).
- SELF-TESTING: You MUST verify your changes! Use "run_terminal" to run builds (e.g., "npm run start:dev", "npm run build", "tsc") or tests in the target project's directory (using the 'cwd' argument) to ensure everything compiles and works without errors.

WORKFLOW RULES FOR PROJECTS & LARGE TASKS:
0. SKILLS CHECK: Whenever you receive a new task, ALWAYS use list_skills() and read_skill(name) to check for standard instructions.
1. PLANNING: Before making any file changes, you MUST output a structured plan in the chat using exactly this format:
   ### Proposed Changes
   - [Module/Component Name]: Explain the logic changes and list files to modify.
   ### Verification Plan
   - Explain how you will test these changes (e.g., what terminal commands you will run, what manual steps are required).
2. EXECUTION: Execute your plan using tools (edit_file, write_file). Use absolute paths if working on external projects.
3. VERIFICATION: Use "run_terminal" to build/test the project and verify your changes. Fix any errors that arise.
4. REPORTING: When the task is fully complete and verified, provide a final report in the chat using exactly this format:
   ### Walkthrough
   - Briefly explain what was done.
   ### Changes Made
   - [Project/Folder Name]: Detailed list of modifications.
   ### Verification Results
   - Provide the output of your self-tests, terminal commands, or explain how it was verified. Include any "NOTE" sections if manual intervention (like DB migrations) is needed.
`.trim();

// ── Parse tool call from model output ───────────────────────────────────────
function parseToolCall(text: string): { name: string; args: Record<string, unknown> } | null {
  // Дозволяємо пропущені або зламані теги
  const match = text.match(/(?:<)?tool_call>?\s*<name>([\w_]+)<\/name>\s*<args>([\s\S]*?)<\/args>/i)
      || text.match(/<name>([\w_]+)<\/name>\s*<args>([\s\S]*?)<\/args>/i);

  if (!match) return null;

  const name = match[1].trim();
  let argsText = match[2].trim();

  if (argsText) {
    // 1. Бронебійне виправлення Windows шляхів (D:\web_project).
    argsText = argsText.replace(/"(path|cwd|file_pattern)"\s*:\s*"([^"]+)"/g, (m, key, val) => {
      return `"${key}": "${val.replace(/\\/g, '\\\\').replace(/\\\\\\\\/g, '\\\\')}"`;
    });
    argsText = argsText.replace(/(path|cwd|file_pattern)\s*:\s*"([^"]+)"/g, (m, key, val) => {
      return `"${key}": "${val.replace(/\\/g, '\\\\').replace(/\\\\\\\\/g, '\\\\')}"`;
    });

    // 2. Виправлення ключів без подвійних лапок
    argsText = argsText.replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":');
    // 3. Заміна одинарних лапок на подвійні
    argsText = argsText.replace(/'([^']*)'/g, '"$1"');
    // 4. Видалення зайвих ком у кінці JSON
    argsText = argsText.replace(/,\s*}/g, '}');
  }

  try {
    return { name, args: JSON.parse(argsText || '{}') };
  } catch (err) {
    console.warn('[Agent] Failed to parse args after repairs:', argsText);
    return null;
  }
}

// ── Main agent loop ──────────────────────────────────────────────────────────
export class AgentLoop {
  private _ollama: OllamaClient;
  private _abortCtrl?: AbortController;
  private _listeners: EventListener[] = [];
  private _history: OllamaMessage[] = [];
  public running = false;
  public model?: string;

  constructor(ollama: OllamaClient) {
    this._ollama = ollama;
  }

  on(fn: EventListener) { this._listeners.push(fn); }
  off(fn: EventListener) { this._listeners = this._listeners.filter(l => l !== fn); }

  private emit(ev: AgentEvent) {
    this._listeners.forEach(l => l(ev));
  }

  stop() {
    this._abortCtrl?.abort();
    this.running = false;
  }

  clearHistory() {
    this._history = [];
  }

  // ТУТ ВИПРАВЛЕНО СИГНАТУРУ — ТЕПЕР 4 АРГУМЕНТИ!
  async run(
      task: string,
      contextMessages: OllamaMessage[] = [],
      workspaceContext = '',
      language: string = 'Ukrainian'
  ) {
    this.running = true;
    this._abortCtrl = new AbortController();
    const signal = this._abortCtrl.signal;

    const maxSteps = vscode.workspace.getConfiguration('openollamagravity').get('maxAgentSteps', 20);

    const sysPrompt = getToolsSchema(language) + (workspaceContext ? `\n\nWORKSPACE:\n${workspaceContext}` : '');

    if (this._history.length === 0) {
      this._history.push({ role: 'system', content: sysPrompt });
      if (contextMessages.length > 0) this._history.push(...contextMessages);
    } else {
      this._history[0] = { role: 'system', content: sysPrompt };
    }

    this._history.push({ role: 'user', content: task });

    this.emit({ type: 'step', content: 'Starting task…', step: 0, totalSteps: maxSteps });

    for (let step = 1; step <= maxSteps; step++) {
      if (signal.aborted) {
        this.emit({ type: 'done', content: 'Stopped by user.' });
        this.running = false;
        return;
      }

      this.emit({ type: 'thinking', content: '', step, totalSteps: maxSteps });

      let modelOutput = '';
      try {
        // Використовуємо таймаут 60 сек
        modelOutput = await this._streamWithTimeout(step, maxSteps, signal);
      } catch (err: any) {
        this.emit({ type: 'error', content: err.message ?? 'Ollama error' });
        this.running = false;
        return;
      }

      const toolCall = parseToolCall(modelOutput);

      if (!toolCall) {
        this.emit({ type: 'answer', content: modelOutput });
        this.emit({ type: 'done', content: 'Task complete.' });
        this.running = false;
        return;
      }

      this.emit({
        type: 'tool_call',
        content: `Calling: ${toolCall.name}`,
        toolName: toolCall.name,
        toolArgs: toolCall.args,
      });

      const result = await this.executeTool(toolCall.name, toolCall.args as any);

      this.emit({
        type: 'tool_result',
        content: result.output,
        toolName: toolCall.name,
        ok: result.ok,
      });

      this._history.push({ role: 'assistant', content: modelOutput });
      this._history.push({
        role: 'user',
        content: `<tool_result>\n<name>${toolCall.name}</name>\n<ok>${result.ok}</ok>\n<output>${result.output}</output>\n</tool_result>`,
      });
    }

    this.emit({ type: 'error', content: `Reached max steps (${maxSteps}). Task may be incomplete.` });
    this.running = false;
  }

  private async _streamWithTimeout(step: number, totalSteps: number, signal: AbortSignal): Promise<string> {
    const firstTokenTimeoutMs = 60000;

    return new Promise<string>((resolve, reject) => {
      let firstTokenReceived = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

      const timeoutError = () => {
        reject(new Error(`Ollama зависла (немає відповіді 60с). Спробуйте обрати меншу модель або очистити чат.`));
      };

      timeoutHandle = setTimeout(timeoutError, firstTokenTimeoutMs);

      this._ollama.chatStream(
          this._history,
          (tok: string) => {
            if (!firstTokenReceived) {
              firstTokenReceived = true;
              clearTimeout(timeoutHandle);
              timeoutHandle = undefined;
            }
            this.emit({ type: 'thinking', content: tok, step, totalSteps });
          },
          signal,
          this.model
      ).then((fullOutput) => {
        clearTimeout(timeoutHandle);
        resolve(fullOutput);
      }).catch((err) => {
        clearTimeout(timeoutHandle);
        reject(err);
      });
    });
  }

  // ── Route tool name to implementation ──────────────────────────────────────
  private async executeTool(
      name: string,
      args: Record<string, unknown>
  ): Promise<Tools.ToolResult> {
    const confirm = async (label: string, detail: string): Promise<boolean> => {
      const pick = await vscode.window.showWarningMessage(
          `OpenOllamaGravity wants to: ${label}`,
          { detail, modal: false },
          'Allow', 'Deny'
      );
      return pick === 'Allow';
    };

    switch (name) {
      case 'read_file': return Tools.readFile(args as any);
      case 'write_file': return Tools.writeFile(args as any, async (p, content) => confirm(`Write file: ${p}`, `${content.split('\n').length} lines will be written.`));
      case 'edit_file': return Tools.editFile(args as any, async (p, diff) => confirm(`Edit file: ${p}`, diff));
      case 'list_files': return Tools.listFiles(args as any);
      case 'search_files': return Tools.searchFiles(args as any);
      case 'run_terminal': return Tools.runTerminal(args as any, async (cmd) => confirm(`Run: ${cmd}`, 'This command will be executed in your workspace.'));
      case 'get_diagnostics': return Tools.getDiagnostics(args as any);
      case 'get_file_outline': return Tools.getFileOutline(args as any);
      case 'create_directory': return Tools.createDirectory(args as any);
      case 'delete_file': return Tools.deleteFile(args as any, async (p) => confirm(`Delete file: ${p}`, 'This will permanently delete the file.'));
      case 'get_workspace_info': return Tools.getWorkspaceInfo();
      case 'web_search': return Tools.webSearch(args as any);
      case 'list_skills': return Tools.listSkills();
      case 'read_skill': return Tools.readSkill(args as any);
      default: return { ok: false, output: `Unknown tool: ${name}` };
    }
  }
}