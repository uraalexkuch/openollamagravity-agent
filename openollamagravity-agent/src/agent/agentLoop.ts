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
1. XML Format ONLY: You MUST wrap every tool call inside <tool_call> tags. NEVER write tool calls as plain text or javascript functions.
2. Example of a CORRECT tool call for reading/listing:
<tool_call>
<name>list_files</name>
<args>{"path": ".", "depth": 1}</args>
</tool_call>

Example of a CORRECT tool call for writing/editing (use <content>):
<tool_call>
<name>write_file</name>
<args>{"path": "docs/README.md"}</args>
<content>
# Documentation
Put your multi-line content here without escaping quotes or newlines.
</content>
</tool_call>
3. Language & Translation: The user may provide tasks in various languages. You MUST internally translate the user's request into English to plan your actions and use tools accurately. You MUST conduct all planning, reasoning, and thinking inside <thought> tags (preferably in English). However, you MUST ALWAYS provide your final explanations, narrations, and direct answers to the user in ${language}. Every part of your output that is NOT inside a tag MUST be in ${language}.
4. Windows Paths: Use double backslashes in JSON args: "C:\\\\path\\\\to\\\\file".
5. Workflow: TRANSLATE REQUEST TO ENGLISH -> THINK -> CALL TOOL -> GET RESULT -> NARRATE -> CONTINUE until done.
6. NO HALLUCINATIONS: Base your answers STRICTLY on the facts obtained through tools (e.g., read_file, list_files, get_workspace_info). DO NOT guess, assume, or invent file contents, dependencies, code snippets, or project architecture.
7. FACT-BASED ANALYSIS: If asked to analyze or explain a project, you MUST use tools to read the actual project files (package.json, source code) BEFORE generating a response. Talk ONLY about the specific technologies and code present in this repository. If you don't know something, use a tool to find out or admit you don't know.
8. FILE CREATION: You have FULL PERMISSION to create, modify, and delete project files (including .html, .css, .js, .ts, etc.). If the user asks for a file, DO NOT say you cannot create it. Use the write_file tool immediately to perform the task.
9. NARRATION & THOUGHTS:
   Example of a CORRECT response with thinking:
   <thought>
   I need to create documentation. I'll check the current project structure first.
   </thought>
   Я перевірю структуру проекту перед початком...
   <tool_call>
   <name>list_files</name>
   <args>{"path": "."}</args>
   </tool_call>

### TOOLS:
- manage_plan(action, task?, id?): Manage your multi-step plan. Actions: "create", "complete", "delete", "view", "clear". CRITICAL: Always create a plan before complex coding!
- delegate_to_expert(role, question, context?): Spawn an isolated AI sub-agent (e.g., "Architecture Reviewer", "Python Expert") to solve a specific problem and report back.
- save_skill(name, description): Save a pattern/best-practice/guide for FUTURE TASKS. CRITICAL: NEVER use this for project-specific docs. Put the skill text INSIDE a <content> block.
- read_file(path, start_line?, end_line?): Read file content.
- write_file(path): Create/Overwrite project files (code, README, docs/...). CRITICAL: Put the file text INSIDE a <content>...</content> block AFTER <args>. Do NOT put content inside the JSON.
- edit_file(path, start_line, end_line): Replace lines. CRITICAL: Put the new_content INSIDE a <content>...</content> block AFTER <args>. Do NOT put new_content inside the JSON.
- list_files(path?, depth?): List directories.
- search_files(pattern, path?): Grep-like search.
- run_terminal(command, cwd?): Run shell commands. CRITICAL: NEVER run blocking server commands (like "npm start" or "dev"). Only run tasks that finish and exit.
- get_diagnostics(path?): Get IDE errors.
- get_file_outline(path): List functions/classes in a SPECIFIC FILE. (NEVER pass a directory/folder).
- create_directory(path): Create folders.
- delete_file(path): Delete file.
- get_workspace_info(path?): Project metadata (deps, scripts).
- web_search(query, website?): Internet search.
- list_skills(), read_skill(name): View best practices.
${skillsBlock}${wsBlock}${rootBlock}`.trim();
}

function repairJson(raw: string): string {
  // 1. Ensure it's wrapped in braces if it looks like a key-value list but isn't wrapped
  let result = raw.trim();
  if (result && !result.startsWith('{') && result.includes(':')) {
    result = '{' + result + '}';
  }

  // 2. Fix unquoted keys or keys with single quotes
  result = result.replace(/([{,]\s*)(['"]?)([a-zA-Z0-9_$-]+)\2\s*:/g, '$1"$3":');

  // 3. Fix values with single quotes
  result = result.replace(/:\s*'([^']*)'/g, (_, inner) => ': "' + inner.replace(/"/g, '\\"') + '"');
  result = result.replace(/,\s*'([^']*)'/g, (_, inner) => ', "' + inner.replace(/"/g, '\\"') + '"');

  // 4. Handle Windows paths and control characters inside strings
  let finalResult = '';
  let inString = false;
  let i = 0;

  while (i < result.length) {
    const ch = result[i];

    if (!inString) {
      if (ch === '"') { inString = true; }
      finalResult += ch;
      i++;
      continue;
    }

    if (ch === '\n') {
      finalResult += '\\n';
      i++;
      continue;
    }
    if (ch === '\r') {
      i++;
      continue;
    }
    if (ch === '\t') {
      finalResult += '\\t';
      i++;
      continue;
    }

    if (ch === '\\') {
      const next = result[i + 1] ?? '';
      if (/["\\\/bfnrtu]/.test(next)) {
        finalResult += ch + next;
        i += 2;
      } else if (next === 'u') {
        finalResult += ch + result.slice(i + 1, i + 6);
        i += 6;
      } else {
        finalResult += '\\\\';
        i++;
      }
      continue;
    }

    if (ch === '"') {
      inString = false;
    }
    finalResult += ch;
    i++;
  }

  return finalResult;
}

function parseToolCall(text: string): {
  name:        string;
  args:        any;
  narration:   string;
  thought?:    string;
  parseError?: string;
} | null {
  const block = text.match(/<tool_call>([\s\S]*?)<\/tool_call>/i);
  if (!block) return null;

  const blockStart = text.indexOf('<tool_call>');
  let narration    = text.slice(0, blockStart === -1 ? undefined : blockStart).trim();
  let thought      = '';

  const thoughtBlock = narration.match(/<thought>([\s\S]*?)<\/thought>/i);
  if (thoughtBlock) {
    thought = thoughtBlock[1].trim();
    narration = narration.replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim();
  }

  if (blockStart === -1) {
    return narration || thought ? { name: '', args: {}, narration, thought } : null;
  }

  const inner = block[1];

  const nameMatch =
      inner.match(/<n>\s*([\w_]+)\s*<\/n>/i) ||
      inner.match(/<name>\s*([\w_]+)\s*<\/name>/i); // true fallback
  if (!nameMatch) return null;
  const name = nameMatch[1].trim();

  // 1. Витягуємо вміст з <content>...</content>, якщо він є
  const contentMatch = inner.match(/<content>([\s\S]*?)<\/content>/i) || inner.match(/<content>([\s\S]*)/i);
  const extractedContent = contentMatch ? contentMatch[1].trim() : null;

  // 2. Витягуємо JSON з <args>
  let raw = '';
  const argsMatch = inner.match(/<args>([\s\S]*?)<\/args>/i);

  if (argsMatch) {
    raw = argsMatch[1].trim();
  } else {
    const fallbackMatch = inner.match(/<args>([\s\S]*)/i);
    if (fallbackMatch) {
      raw = fallbackMatch[1].trim();
      // Очищаємо JSON від випадково захопленого <content> блоку
      raw = raw.replace(/<content>[\s\S]*/i, '').trim();
    } else {
      raw = '{}';
    }
  }

  let args: any = {};
  if (raw && raw !== '{}') {
    raw = raw.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
    try {
      args = JSON.parse(raw);
    } catch {
      try {
        args = JSON.parse(repairJson(raw));
        oogLogger.appendLine(`[Agent] JSON auto-repaired for "${name}"`);
      } catch (e: any) {
        const preview = raw.slice(0, 120).replace(/\n/g, ' ');
        const msg = `JSON parse error: ${e.message} | raw: ${preview}`;
        oogLogger.appendLine(`[Agent] ⚠️  ${msg}`);
        return { name, narration, args: {}, parseError: msg };
      }
    }
  }

  // 3. Додаємо витягнутий контент до аргументів для відповідних інструментів
  if (extractedContent !== null) {
    if (name === 'write_file' || name === 'save_skill') {
      args.content = extractedContent;
    } else if (name === 'edit_file') {
      args.new_content = extractedContent;
    }
  }

  return { name, narration, args };
}

export class AgentLoop {
  private _history:        OllamaMessage[] = [];
  private _listeners:      ((ev: AgentEvent) => void)[] = [];
  private _abortCtrl?:     AbortController;
  private _loadedFolders:  Set<string> = new Set();
  private _planState:      Tools.PlanState = { currentPlan: [], planIdCounter: 0 };
  public running = false;
  public model?:  string;

  constructor(private _ollama: OllamaClient) {}

  on(fn: (ev: AgentEvent) => void)  { this._listeners.push(fn); }
  off(fn: (ev: AgentEvent) => void) { this._listeners = this._listeners.filter(l => l !== fn); }
  private emit(ev: AgentEvent)      {
    if (this._listeners.length > 20) {
      oogLogger.appendLine(`[Agent] ⚠️ Too many listeners (${this._listeners.length}). Possible memory leak.`);
    }
    this._listeners.forEach(l => l(ev));
  }

  stop()         { this._abortCtrl?.abort(); this.running = false; }
  clearHistory() {
    this._history = [];
    this._loadedFolders.clear();
    this._planState = { currentPlan: [], planIdCounter: 0 };
    oogLogger.appendLine('[Agent] Історію та план очищено.');
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
    try {
      this._abortCtrl = new AbortController();
      const signal    = this._abortCtrl.signal;
      const config    = vscode.workspace.getConfiguration('openollamagravity');
      const maxSteps  = config.get<number>('maxAgentSteps', 25);
      const timeoutMs = config.get<number>('firstTokenTimeoutSec', 180) * 1000;

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
          output = await this._streamWithTimeout(step, maxSteps, timeoutMs, signal);
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
            'delete_file', 'get_workspace_info', 'web_search', 'list_skills', 'read_skill',
            'manage_plan', 'delegate_to_expert', 'save_skill'
          ];

          const forgottenTool = toolNames.find(tn => output.includes(tn));

          if (isBrokenTags || (forgottenTool && output.length < 500)) {
            const reason = isBrokenTags
                ? `malformed <tool_call> structure`
                : `missing <tool_call> tags for ${forgottenTool}`;

            this.emit({ type: 'narration', content: `⚠️ Виявлено помилку у форматі (${reason}). Прошу агента виправити...` });
            this._history.push({ role: 'assistant', content: output });

            const actualTool = forgottenTool || 'list_files';
            this._history.push({
              role: 'user',
              content: `ERROR: Your tool call is malformed or missing XML tags.\n` +
                  `You tried to use a tool but didn't wrap it correctly.\n` +
                  `FIX: You MUST use this exact XML format:\n` +
                  `<tool_call>\n<name>${actualTool}</name>\n<args>{"path": "."}</args>\n</tool_call>\n` +
                  `Please retry.`
            });
            continue;
          }

          this._history.push({ role: 'assistant', content: output });
          this.emit({ type: 'answer', content: output });
          break;
        }

        if (tool.thought) {
          this.emit({ type: 'thinking', content: tool.thought });
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
              `4. If writing/editing files, put the text INSIDE <content>...</content> block AFTER <args>, NOT in the JSON.\n` +
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
        this._trimHistory();
      }

    } finally {
      this.running = false;
      this.emit({ type: 'done', content: '' });
    }
  }

  private _trimHistory() {
    // Keep system prompt + last 10 pairs (20 messages)
    if (this._history.length > 22) {
      const sys = this._history[0];
      const recent = this._history.slice(-20);
      this._history = [sys, ...recent];
      oogLogger.appendLine(`[Agent] History trimmed to ${this._history.length} messages.`);
    }
  }

  private async _streamWithTimeout(
      step: number,
      total: number,
      initialMs: number,
      signal: AbortSignal
  ): Promise<string> {
    const chunkTimeoutMs = 30000; // Watchdog: 30s between chunks

    return new Promise((resolve, reject) => {
      let started = false;
      let watchdog: NodeJS.Timeout | undefined;

      const resetWatchdog = () => {
        if (watchdog) clearTimeout(watchdog);
        watchdog = setTimeout(() => {
          reject(new Error('Streaming stalled: No chunks received for 30s.'));
        }, chunkTimeoutMs);
      };

      const initialTimer = setTimeout(() => {
        if (!started) {
          this._abortCtrl?.abort();
          reject(new Error('Ollama не відповіла за таймаутом. Спробуйте меншу модель.'));
        }
      }, initialMs);

      this._ollama
          .chatStream(
              this._history,
              chunk => {
                if (!started) {
                  started = true;
                  clearTimeout(initialTimer);
                }
                resetWatchdog();
                this.emit({ type: 'thinking', content: chunk, step, totalSteps: total });
              },
              signal,
              this.model
          )
          .then(res => {
            if (watchdog) clearTimeout(watchdog);
            resolve(res);
          })
          .catch(err => {
            if (watchdog) clearTimeout(watchdog);
            reject(err);
          });
    });
  }

  private async _executeTool(name: string, args: any): Promise<Tools.ToolResult> {
    const config = vscode.workspace.getConfiguration('openollamagravity');
    const autoApply = config.get<boolean>('autoApplyEdits', false);

    const confirm = async (msg: string, bypass: boolean) => {
      if (bypass) return true;
      return (await vscode.window.showWarningMessage(`OOG: ${msg}`, 'Allow', 'Deny')) === 'Allow';
    };

    switch (name) {
      case 'read_file':        return Tools.readFile(args);
      case 'write_file':       return Tools.writeFile(args, p => confirm(`Записати у ${p}`, autoApply));
      case 'edit_file':        return Tools.editFile(args, (p, d) => confirm(`Редагувати ${p}:\n${d}`, autoApply));
      case 'list_files':       return Tools.listFiles(args);
      case 'search_files':     return Tools.searchFiles(args);
      case 'run_terminal':     return Tools.runTerminal(args, c => confirm(`Запустити: ${c}`, false)); 
      case 'get_diagnostics':  return Tools.getDiagnostics(args);
      case 'get_file_outline': return Tools.getFileOutline(args);
      case 'create_directory': return Tools.createDirectory(args);
      case 'delete_file':      return Tools.deleteFile(args, p => confirm(`Видалити файл ${p}?`, autoApply));
      case 'get_workspace_info': return Tools.getWorkspaceInfo(args);
      case 'list_skills':      return Tools.listSkills();
      case 'read_skill':       return Tools.readSkill(args);
      case 'web_search':       return Tools.webSearch(args);

      case 'manage_plan': {
        return Tools.managePlan(args, this._planState);
      }

      case 'save_skill': {
        return Tools.saveSkill(args, (n, c) => confirm(`Зберегти новий скіл "${n}"?\n\n${c.substring(0, 300)}...`, false));
      }

      case 'delegate_to_expert': {
        if (!args.role || !args.question) return { ok: false, output: 'Missing role or question' };

        this.emit({ type: 'narration', content: `👥 Swarm: Звертаюсь до субагента [${args.role}]...` });

        const subPrompt = `You are an expert AI sub-agent with the role: ${args.role}. 
Your goal is to answer the following request from the Main Agent.
CONTEXT: ${args.context || 'None provided'}
QUESTION: ${args.question}`;

        const subAbort = new AbortController();
        const subTimer = setTimeout(() => subAbort.abort(), 60_000);

        try {
          const answer = await this._ollama.chatStream(
              [{ role: 'user', content: subPrompt }],
              chunk => {
                // Пряме прокидання "думання" субагента в основний потік не робимо,
                // щоб не плутати користувача, але можна додати логування.
              },
              subAbort.signal
          );
          clearTimeout(subTimer);
          return { ok: true, output: `Expert [${args.role}] replied:\n\n${answer}` };
        } catch (e: any) {
          clearTimeout(subTimer);
          return { ok: false, output: `Expert failed: ${e.message}` };
        }
      }

      default: {
        return {
          ok: false,
          output:
              `CRITICAL ERROR: Unknown tool "${name}". ` +
              `Valid tools: read_file, write_file, edit_file, list_files, search_files, run_terminal, ` +
              `get_diagnostics, get_file_outline, create_directory, delete_file, get_workspace_info, list_skills, read_skill, web_search, manage_plan, delegate_to_expert, save_skill. ` +
              `Fix your <tool_call> and use an exact tool name from the list.`,
        };
      }
    }
  }
}