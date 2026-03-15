// Copyright (c) 2026 Юрій Кучеренко.
import * as vscode from 'vscode';
import { OllamaClient, OllamaMessage, oogLogger } from '../ollama/client';
import * as Tools from './tools';
import type { LoadedSkill } from './tools';

export type AgentEventType =
    | 'thinking'
    | 'tool_call'
    | 'tool_result'
    | 'answer'
    | 'error'
    | 'done'
    | 'step'
    | 'narration'
    | 'skills_loaded'
    | 'skills_discovered';

export interface AgentEvent {
  type:        AgentEventType;
  content:     string;
  toolName?:   string;
  toolArgs?:   any;
  ok?:         boolean;
  step?:       number;
  totalSteps?: number;
  skills?:     Array<{ name: string; folderName: string; description: string; score: number }>;
  signals?:    string[];
}

function buildSystemPrompt(
    language:         string,
    skills:           LoadedSkill[],
    workspaceContext: string,
    workspacePath:    string,
    workspaceRoot:    string,
): string {

  const skillsBlock = skills.length === 0 ? '' : `\n\n### SKILLS:\n` + skills.map(s => `#### ${s.name}\n${s.content}`).join('\n');
  const wsBlock = workspaceContext ? `\n\n### WORKSPACE CONTEXT:\n${workspaceContext}` : '';
  const rootPath = workspaceRoot || workspacePath;
  const rootBlock = rootPath ? `\n\n### WORKSPACE ROOT: ${rootPath}\nCross-project access: Use absolute paths to access any files on this computer.` : '';

  return `
### MISSION:
You are an expert AI software engineer. Complete the task efficiently using the tools below.

### CRITICAL CONSTRAINTS (READ CAREFULLY):
1. XML Format ONLY: You MUST use the exact XML structure below to call a tool. NEVER write tool calls as plain text or javascript functions.
<tool_call>
<name>TOOL_NAME</name>
<args>{"arg": "val"}</args>
</tool_call>

2. Example of a CORRECT tool call:
<tool_call>
<name>web_search</name>
<args>{"query": "latest axios version"}</args>
</tool_call>

3. Language: Always respond in ${language}.
4. JSON Escaping: ALWAYS escape double quotes inside JSON strings using double backslashes: \\"text\\". 
5. Windows Paths: Use double backslashes: "C:\\\\path\\\\to\\\\file".
6. Workflow: THINK -> CALL TOOL -> GET RESULT -> CONTINUE until done. No complex planning needed.

### TOOLS:
- read_file(path, start_line?, end_line?): Read file content.
- write_file(path, content): Create/Overwrite file.
- edit_file(path, start_line, end_line, new_content): Replace lines.
- list_files(path?, depth?): List directories.
- search_files(pattern, path?): Grep-like search.
- run_terminal(command, cwd?): Run shell commands. CRITICAL: NEVER run blocking server commands (like "npm start" or "dev"). Only run tasks that finish and exit.
- get_diagnostics(path?): Get IDE errors.
- get_file_outline(path): List functions/classes.
- create_directory(path): Create folders.
- delete_file(path): Delete file.
- get_workspace_info(path?): Project metadata (deps, scripts).
- web_search(query, website?): Internet search.
- list_skills(), read_skill(name): View best practices.
${skillsBlock}${wsBlock}${rootBlock}`.trim();
}

function repairJson(raw: string): string {
  // 1. Remove trailing commas (e.g., {"a": 1, })
  let json = raw.replace(/,\s*([}\]])/g, '$1');

  // 2. Fix unclosed strings and single backslashes in paths
  let result = '';
  let inString = false;
  let i = 0;

  while (i < json.length) {
    const ch = json[i];
    
    // Toggle string state, ignoring escaped quotes
    if (ch === '"') {
      const prev = json[i - 1] ?? '';
      if (prev !== '\\') {
        inString = !inString;
      }
    }

    if (inString && ch === '\\') {
      const next = json[i + 1] ?? '';
      // If it's not a valid JSON escape sequence, it's likely a Windows path backslash
      if (!/["\\\/bfnrtu]/.test(next)) {
        result += '\\\\';
        i++;
        continue;
      }
    }

    result += ch;
    i++;
  }

  // 3. Auto-close string if it was left open
  if (inString) {
    result += '"';
  }

  // 4. Balance braces and brackets
  const openBraces = (result.match(/{/g) || []).length;
  const closeBraces = (result.match(/}/g) || []).length;
  for (let j = 0; j < openBraces - closeBraces; j++) {
    result += '}';
  }

  const openBrackets = (result.match(/\[/g) || []).length;
  const closeBrackets = (result.match(/\]/g) || []).length;
  for (let j = 0; j < openBrackets - closeBrackets; j++) {
    result += ']';
  }

  return result;
}

function parseToolCall(text: string): {
  name:        string;
  args:        any;
  narration:   string;
  parseError?: string;
} | null {
  const block = text.match(/<tool_call>([\s\S]*?)<\/tool_call>/i);
  if (!block) return null;

  const blockStart = text.indexOf('<tool_call>');
  const narration  = text.slice(0, blockStart).trim();

  const inner = block[1];

  const nameMatch =
      inner.match(/<name>\s*([\w_]+)\s*<\/name>/i) ||
      inner.match(/<n>\s*([\w_]+)\s*<\/n>/i) ||
      inner.match(/<n>\s*([\w_]+)\s*<\/name>/i);
  if (!nameMatch) return null;
  const name = nameMatch[1].trim();

  const argsMatch = inner.match(/<args>([\s\S]*?)<\/args>/i);
  if (!argsMatch) return { name, narration, args: {} };

  let raw = argsMatch[1].trim();
  if (!raw || raw === '{}') return { name, narration, args: {} };

  raw = raw.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();

  try { return { name, narration, args: JSON.parse(raw) }; } catch { /* next */ }

  try {
    const args = JSON.parse(repairJson(raw));
    oogLogger.appendLine(`[Agent] JSON auto-repaired for "${name}"`);
    return { name, narration, args };
  } catch (e: any) {
    const preview = raw.slice(0, 120).replace(/\n/g, ' ');
    const msg = `JSON parse error: ${e.message} | raw: ${preview}`;
    oogLogger.appendLine(`[Agent] ⚠️  ${msg}`);
    return { name, narration, args: {}, parseError: msg };
  }
}

export class AgentLoop {
  private _history:        OllamaMessage[] = [];
  private _listeners:      ((ev: AgentEvent) => void)[] = [];
  private _abortCtrl?:     AbortController;
  private _loadedFolders:  Set<string> = new Set();
  public running = false;
  public model?:  string;

  constructor(private _ollama: OllamaClient) {}

  on(fn: (ev: AgentEvent) => void)  { this._listeners.push(fn); }
  off(fn: (ev: AgentEvent) => void) { this._listeners = this._listeners.filter(l => l !== fn); }
  private emit(ev: AgentEvent)      { this._listeners.forEach(l => l(ev)); }

  stop()         { this._abortCtrl?.abort(); this.running = false; }
  clearHistory() {
    this._history = [];
    this._loadedFolders.clear();
    oogLogger.appendLine('[Agent] Історію очищено.');
  }

  async run(
      task: string,
      contextMessages: OllamaMessage[] = [],
      workspaceContext = '',
      language = 'Ukrainian',
      workspaceRoot = '',
      selectedSkillFolders: string[] = []
  ) {
    this.running    = true;
    this._abortCtrl = new AbortController();
    const signal    = this._abortCtrl.signal;
    const maxSteps  = vscode.workspace
        .getConfiguration('openollamagravity')
        .get<number>('maxAgentSteps', 25);

    const resolvedRoot = workspaceRoot
        || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
        || '';

    let loadedSkills: LoadedSkill[] = [];

    if (this._history.length === 0) {
      const taskContext = [task, workspaceContext, resolvedRoot].filter(Boolean).join('\n');

      if (selectedSkillFolders.length > 0) {
        try {
          const allScored = Tools.scanAndScoreAllSkillsIdf(taskContext, new Set(), 0);
          const toLoad = allScored.filter(s => selectedSkillFolders.includes(s.folderName));
          loadedSkills = Tools.loadTopSkills(toLoad, 10);
        } catch (e: any) {
          oogLogger.appendLine(`[Agent] Manual skills load error: ${e.message}`);
        }
      }

      if (loadedSkills.length > 0) {
        this.emit({
          type:    'skills_loaded',
          content: `Підібрано ${loadedSkills.length} скіл(и) для задачі`,
          skills:  loadedSkills.map(s => ({
            name:        s.name,
            folderName:  s.folderName,
            description: s.description,
            score:       s.score,
          })),
        });
      }

      const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
      const sysPrompt = buildSystemPrompt(language, loadedSkills, workspaceContext, workspacePath, resolvedRoot);

      loadedSkills.forEach(s => this._loadedFolders.add(s.folderName));

      this._history.push({ role: 'system', content: sysPrompt });
      if (contextMessages.length > 0) this._history.push(...contextMessages);
    }

    this._history.push({ role: 'user', content: task });

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
        const isBrokenTags = output.includes('<tool_call>');
        const toolNames = [
          'read_file', 'write_file', 'edit_file', 'list_files', 'search_files',
          'run_terminal', 'get_diagnostics', 'get_file_outline', 'create_directory',
          'delete_file', 'get_workspace_info', 'web_search', 'list_skills', 'read_skill'
        ];

        const forgottenTool = toolNames.find(tn => output.includes(tn));

        if (isBrokenTags || (forgottenTool && output.length < 500)) {
          const reason = isBrokenTags
              ? `malformed <tool_call> structure`
              : `missing <tool_call> tags for ${forgottenTool}`;

          this.emit({ type: 'narration', content: `⚠️ Виявлено помилку у форматі (${reason}). Прошу агента виправити...` });
          this._history.push({ role: 'assistant', content: output });

          this._history.push({
            role: 'user',
            content: `ERROR: Your tool call is malformed or missing XML tags.\n` +
                `You tried to use "${forgottenTool || 'a tool'}" but didn't wrap it correctly.\n` +
                `FIX: You MUST use this exact XML format:\n` +
                `<tool_call>\n<name>${forgottenTool || 'TOOL_NAME'}</name>\n<args>{"your": "json args"}</args>\n</tool_call>\n` +
                `Please retry.`
          });
          continue;
        }

        this.emit({ type: 'answer', content: output });
        break;
      }

      if (tool.narration) {
        this.emit({ type: 'narration', content: tool.narration });
      }

      if (tool.parseError) {
        this.emit({
          type: 'tool_call', content: `Parse error: ${tool.name}`,
          toolName: tool.name, toolArgs: {},
        });
        const errMsg =
            `TOOL CALL FAILED — could not parse your <args> JSON.\n` +
            `Error: ${tool.parseError}\n\n` +
            `REQUIRED FIX:\n` +
            `1. Use double backslashes in Windows paths: "D:\\\\web_project\\\\file.txt"\n` +
            `2. Escape all special chars in JSON strings\n` +
            `3. Do NOT use single backslash \\ inside JSON strings\n` +
            `Retry your tool call with correct JSON.`;
        this.emit({ type: 'tool_result', content: errMsg, toolName: tool.name, ok: false });
        this._history.push({
          role: 'user',
          content:
              `<tool_result>\n<name>${tool.name}</name>\n<ok>false</ok>\n` +
              `<output>${errMsg}</output>\n</tool_result>`,
        });
        continue;
      }

      this.emit({
        type: 'tool_call', content: `Calling: ${tool.name}`,
        toolName: tool.name, toolArgs: tool.args,
      });

      const res = await this._executeTool(tool.name, tool.args);

      this.emit({
        type: 'tool_result', content: res.output,
        toolName: tool.name, ok: res.ok,
      });

      let historyOutput = res.output;
      if (historyOutput.length > 8000) {
        historyOutput = historyOutput.slice(0, 4000) +
            `\n\n...[TRUNCATED IN HISTORY. You read this in step ${step}]...\n\n` +
            historyOutput.slice(-4000);
      }

      this._history.push({ role: 'assistant', content: output });
      this._history.push({
        role: 'user',
        content:
            `<tool_result>\n` +
            `<name>${tool.name}</name>\n` +
            `<ok>${res.ok}</ok>\n` +
            `<output>${historyOutput}</output>\n` +
            `</tool_result>`,
      });
    }

    this.running = false;
    this.emit({ type: 'done', content: '' });
  }

  private async _streamWithTimeout(
      step: number,
      total: number,
      signal: AbortSignal
  ): Promise<string> {
    const ms = vscode.workspace
        .getConfiguration('openollamagravity')
        .get<number>('firstTokenTimeoutSec', 180) * 1000;

    return new Promise((resolve, reject) => {
      let started = false;
      const timer = setTimeout(() => {
        if (!started) {
          reject(new Error('Ollama не відповіла за таймаутом. Спробуйте меншу модель.'));
        }
      }, ms);

      this._ollama
          .chatStream(
              this._history,
              chunk => {
                started = true;
                clearTimeout(timer);
                this.emit({ type: 'thinking', content: chunk, step, totalSteps: total });
              },
              signal,
              this.model
          )
          .then(resolve)
          .catch(reject);
    });
  }

  private async _executeTool(name: string, args: any): Promise<Tools.ToolResult> {
    const confirm = async (msg: string) =>
        (await vscode.window.showWarningMessage(`OOG: ${msg}`, 'Allow', 'Deny')) === 'Allow';

    switch (name) {
      case 'read_file':        return Tools.readFile(args);
      case 'write_file':       return Tools.writeFile(args, p => confirm(`Записати у ${p}`));
      case 'edit_file':        return Tools.editFile(args, (p, d) => confirm(`Редагувати ${p}:\n${d}`));
      case 'list_files':       return Tools.listFiles(args);
      case 'search_files':     return Tools.searchFiles(args);
      case 'run_terminal':     return Tools.runTerminal(args, c => confirm(`Запустити: ${c}`));
      case 'get_diagnostics':  return Tools.getDiagnostics(args);
      case 'get_file_outline': return Tools.getFileOutline(args);
      case 'create_directory': return Tools.createDirectory(args);
      case 'delete_file':      return Tools.deleteFile(args, p => confirm(`Видалити файл ${p}?`));
      case 'get_workspace_info': return Tools.getWorkspaceInfo(args);
      case 'list_skills':      return Tools.listSkills();
      case 'read_skill':       return Tools.readSkill(args);
      case 'web_search':       return Tools.webSearch(args);
      default:
        return {
          ok: false,
          output:
              `CRITICAL ERROR: Unknown tool "${name}". ` +
              `Valid tools: read_file, write_file, edit_file, list_files, search_files, run_terminal, ` +
              `get_diagnostics, get_file_outline, create_directory, delete_file, get_workspace_info, list_skills, read_skill, web_search. ` +
              `Fix your <tool_call> and use an exact tool name from the list.`,
        };
    }
  }
}