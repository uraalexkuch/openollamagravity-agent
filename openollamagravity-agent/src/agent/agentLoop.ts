// Copyright (c) 2026 Юрій Кучеренко.
import * as vscode from 'vscode';
import { OllamaClient, OllamaMessage, oogLogger } from '../ollama/client';
import * as Tools from './tools';

export type AgentEventType = 'thinking' | 'tool_call' | 'tool_result' | 'answer' | 'error' | 'done' | 'step';
export interface AgentEvent {
  type: AgentEventType;
  content: string;
  toolName?: string;
  toolArgs?: any;
  ok?: boolean;
  step?: number;
  totalSteps?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// СИСТЕМНИЙ ПРОМПТ — Progressive Disclosure (agentskills.io)
// ─────────────────────────────────────────────────────────────────────────────

const getToolsSchema = (language: string, actualSkillsPath: string) => `
You are an advanced autonomous coding and cybersecurity agent.

CRITICAL INSTRUCTION:
To interact with the system, output ONLY the raw XML block below. No prose, no markdown.

<tool_call>
<name>tool_name_here</name>
<args>{"key": "value"}</args>
</tool_call>

AVAILABLE TOOLS:
- name: list_files        args: {"path": "...", "depth": 3}
- name: read_file         args: {"path": "..."}
- name: write_file        args: {"path": "...", "content": "..."}
- name: run_terminal      args: {"command": "...", "cwd": "..."}
- name: create_directory  args: {"path": "..."}
- name: list_skills       args: {}
- name: read_skill        args: {"name": "skill_path_from_index"}

RULES:
1. ONE <tool_call> per response. Nothing before or after it.
2. Final answer (no more tool calls needed) → reply in ${language}, no XML.
3. Absolute paths for user projects: "D:\\\\project\\\\...".
4. Skills base location: "${actualSkillsPath}".
5. Use ONLY exact tool names above. Never invent names.

━━━ PROGRESSIVE DISCLOSURE — HOW TO USE SKILLS ━━━

The skills base has 600+ cybersecurity skills following the agentskills.io standard.
Each SKILL.md starts with a YAML frontmatter (~30-50 tokens):

  ---
  name: performing-memory-forensics-with-volatility3
  description: Analyze memory dumps to extract processes, network connections...
  domain: cybersecurity
  subdomain: digital-forensics
  tags: [forensics, memory-analysis, volatility3, incident-response]
  skill_path: cybersecurity/performing-memory-forensics-with-volatility3
  ---

MANDATORY 2-PHASE WORKFLOW:

  PHASE 1 — Discovery (ALWAYS first):
    Call list_skills → you receive ONLY the YAML frontmatter of every skill.
    Read name / description / tags to decide which skills match your task.
    DO NOT load full skills yet. This saves tokens for 600+ skills.

  PHASE 2 — Load (ONLY confirmed relevant skills):
    For each relevant skill from Phase 1, call:
      read_skill {"name": "<skill_path>"}
    where skill_path comes from the "skill_path:" field in the frontmatter.
    You get the FULL skill: workflow steps, prerequisites, tool commands, verification.

EXAMPLE — task: "analyze memory dump for malware":
  Step 1: list_skills
  Step 2: scan frontmatters → find skill_path: cybersecurity/performing-memory-forensics-with-volatility3
  Step 3: read_skill {"name": "cybersecurity/performing-memory-forensics-with-volatility3"}
  Step 4: follow the full workflow from the loaded skill

NEVER call read_skill for a skill whose frontmatter tags/description don't match the task.
`.trim();

// ── TOOL CALL PARSER ──────────────────────────────────────────────────────────

function parseToolCall(text: string): { name: string; args: any } | null {
  // Шукаємо <tool_call>...</tool_call>
  const block = text.match(/<tool_call>([\s\S]*?)<\/tool_call>/i);
  if (!block) return null;

  const inner = block[1];
  const nameMatch = inner.match(/<name>\s*([\w_]+)\s*<\/name>/i);
  if (!nameMatch) return null;
  const name = nameMatch[1].trim();

  const argsMatch = inner.match(/<args>([\s\S]*?)<\/args>/i);
  if (!argsMatch) return { name, args: {} };

  const argsText = argsMatch[1].trim();
  if (!argsText || argsText === '{}') return { name, args: {} };

  try {
    // Нормалізуємо зворотні слеші у path/cwd/name
    const fixed = argsText.replace(
        /"(path|cwd|name|command)"\s*:\s*"([^"]*)"/g,
        (_, k, v) => `"${k}": "${v.replace(/(?<!\\)\\/g, '\\\\').replace(/\\\\\\\\/g, '\\\\')}"`
    );
    return { name, args: JSON.parse(fixed) };
  } catch {
    return { name, args: {} };
  }
}

// ── AGENT LOOP ────────────────────────────────────────────────────────────────

export class AgentLoop {
  private _history: OllamaMessage[] = [];
  private _listeners: ((ev: AgentEvent) => void)[] = [];
  private _abortCtrl?: AbortController;
  public running = false;
  public model?: string;

  constructor(private _ollama: OllamaClient) {}

  on(fn: (ev: AgentEvent) => void)  { this._listeners.push(fn); }
  off(fn: (ev: AgentEvent) => void) { this._listeners = this._listeners.filter(l => l !== fn); }
  private emit(ev: AgentEvent)      { this._listeners.forEach(l => l(ev)); }

  stop()         { this._abortCtrl?.abort(); this.running = false; }
  clearHistory() { this._history = []; oogLogger.appendLine('[Agent] Історію очищено.'); }

  async run(
      task: string,
      contextMessages: OllamaMessage[] = [],
      workspaceContext = '',
      language = 'Ukrainian'
  ) {
    this.running = true;
    this._abortCtrl = new AbortController();
    const signal = this._abortCtrl.signal;

    const cfg = vscode.workspace.getConfiguration('openollamagravity');
    const maxSteps      = cfg.get<number>('maxAgentSteps', 25);
    const actualSkillsPath = cfg.get<string>('skillsPath', '').replace(/\\/g, '\\\\');

    // Ініціалізуємо системний промпт лише один раз на сесію
    if (this._history.length === 0) {
      this._history.push({ role: 'system', content: getToolsSchema(language, actualSkillsPath) });
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
        // Немає tool_call — це фінальна відповідь агента
        this.emit({ type: 'answer', content: output });
        break;
      }

      this.emit({ type: 'tool_call', content: `Calling: ${tool.name}`, toolName: tool.name, toolArgs: tool.args });

      const res = await this._executeTool(tool.name, tool.args);

      this.emit({ type: 'tool_result', content: res.output, toolName: tool.name, ok: res.ok });

      this._history.push({ role: 'assistant', content: output });
      this._history.push({
        role: 'user',
        content: `<tool_result><name>${tool.name}</name><ok>${res.ok}</ok><output>${res.output}</output></tool_result>`,
      });
    }

    this.running = false;
    this.emit({ type: 'done', content: '' });
  }

  private async _streamWithTimeout(step: number, total: number, signal: AbortSignal): Promise<string> {
    const timeoutMs = vscode.workspace
        .getConfiguration('openollamagravity')
        .get<number>('firstTokenTimeoutSec', 180) * 1000;

    return new Promise((resolve, reject) => {
      let started = false;
      const timer = setTimeout(() => {
        if (!started) reject(new Error('Ollama не відповіла за таймаутом. Спробуйте меншу модель.'));
      }, timeoutMs);

      this._ollama
          .chatStream(
              this._history,
              chunk => { started = true; clearTimeout(timer); this.emit({ type: 'thinking', content: chunk, step, totalSteps: total }); },
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
      case 'list_files':       return Tools.listFiles(args);
      case 'run_terminal':     return Tools.runTerminal(args, c => confirm(`Запустити: ${c}`));
      case 'create_directory': return Tools.createDirectory(args);
        // ── Progressive Disclosure ──
      case 'list_skills':      return Tools.listSkills();       // Phase 1: лише YAML frontmatter
      case 'read_skill':       return Tools.readSkill(args);    // Phase 2: повний текст скіла
      default:
        return {
          ok: false,
          output:
              `CRITICAL ERROR: Tool "${name}" does not exist! ` +
              `Valid tools: read_file, write_file, list_files, run_terminal, ` +
              `create_directory, list_skills, read_skill. Fix your tool call.`,
        };
    }
  }
}