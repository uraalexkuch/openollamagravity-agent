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
    | 'skills_loaded';   // ← нова подія: які скіли підібрані для задачі

export interface AgentEvent {
  type:        AgentEventType;
  content:     string;
  toolName?:   string;
  toolArgs?:   any;
  ok?:         boolean;
  step?:       number;
  totalSteps?: number;
  skills?:     Array<{ name: string; description: string; score: number }>; // для skills_loaded
}

// ─────────────────────────────────────────────────────────────────────────────
// СИСТЕМНИЙ ПРОМПТ
// ─────────────────────────────────────────────────────────────────────────────

function buildSystemPrompt(language: string, loadedSkills: LoadedSkill[]): string {
  // ── Блок знань: лише завантажені релевантні скіли ──────────────────────────
  const skillsBlock = loadedSkills.length === 0
      ? ''
      : [
        '━━━ RELEVANT SKILLS FOR THIS TASK ━━━',
        'The following skills were automatically selected based on your task.',
        'Apply their workflows, commands, and verification steps.',
        '',
        ...loadedSkills.map(s =>
            `### SKILL: ${s.name}\n${s.content}`
        ),
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

function parseToolCall(text: string): { name: string; args: any } | null {
  const block = text.match(/<tool_call>([\s\S]*?)<\/tool_call>/i);
  if (!block) return null;

  const inner     = block[1];
  const nameMatch = inner.match(/<n>\s*([\w_]+)\s*<\/n>/i)
      || inner.match(/<name>\s*([\w_]+)\s*<\/name>/i);
  if (!nameMatch) return null;
  const name = nameMatch[1].trim();

  const argsMatch = inner.match(/<args>([\s\S]*?)<\/args>/i);
  if (!argsMatch) return { name, args: {} };

  const raw = argsMatch[1].trim();
  if (!raw || raw === '{}') return { name, args: {} };

  try {
    const fixed = raw.replace(
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
  private _history:   OllamaMessage[] = [];
  private _listeners: ((ev: AgentEvent) => void)[] = [];
  private _abortCtrl?: AbortController;
  public running = false;
  public model?:  string;

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
    this.running     = true;
    this._abortCtrl  = new AbortController();
    const signal     = this._abortCtrl.signal;

    const cfg      = vscode.workspace.getConfiguration('openollamagravity');
    const maxSteps = cfg.get<number>('maxAgentSteps', 25);

    // ── PROGRESSIVE DISCLOSURE: автоматичний підбір скілів до запуску агента ──
    //
    // Система сама читає frontmatter (~30-50 токенів) кожного SKILL.md,
    // порівнює з текстом задачі і завантажує ПОВНИЙ текст лише релевантних.
    // Агент отримує їх вже готовими у системному промпті.
    // Жодного зайвого токена на нерелевантні скіли зі 600+ бази.

    let loadedSkills: LoadedSkill[] = [];
    try {
      loadedSkills = await Tools.autoLoadSkillsForTask(task, 3);

      if (loadedSkills.length > 0) {
        // Показуємо користувачу які скіли були підібрані та завантажені
        this.emit({
          type:    'skills_loaded',
          content: `Підібрано ${loadedSkills.length} скіл(и) для задачі`,
          skills:  loadedSkills.map(s => ({
            name:        s.name,
            description: s.description,
            score:       s.score,
          })),
        });

        oogLogger.appendLine(
            `[Agent] Скіли для задачі:\n` +
            loadedSkills.map(s => `  • ${s.name} (score=${s.score})`).join('\n')
        );
      } else {
        oogLogger.appendLine('[Agent] Релевантних скілів не знайдено — агент працює без скілів.');
      }
    } catch (e: any) {
      oogLogger.appendLine(`[Agent] Помилка підбору скілів: ${e.message}`);
    }

    // ── Ініціалізуємо системний промпт з вже вбудованими скілами ──────────────
    if (this._history.length === 0) {
      const sysPrompt = buildSystemPrompt(language, loadedSkills);
      this._history.push({ role: 'system', content: sysPrompt });
      if (contextMessages.length > 0) this._history.push(...contextMessages);
    }

    this._history.push({ role: 'user', content: task });

    // ── Основний цикл агента ──────────────────────────────────────────────────
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

      this.emit({
        type:     'tool_call',
        content:  `Calling: ${tool.name}`,
        toolName: tool.name,
        toolArgs: tool.args,
      });

      const res = await this._executeTool(tool.name, tool.args);

      this.emit({
        type:     'tool_result',
        content:  res.output,
        toolName: tool.name,
        ok:       res.ok,
      });

      this._history.push({ role: 'assistant', content: output });
      this._history.push({
        role:    'user',
        content: `<tool_result><n>${tool.name}</n><ok>${res.ok}</ok><o>${res.output}</o></tool_result>`,
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
        if (!started) reject(new Error('Ollama не відповіла за таймаутом. Спробуйте меншу модель.'));
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
      case 'list_files':       return Tools.listFiles(args);
      case 'run_terminal':     return Tools.runTerminal(args, c => confirm(`Запустити: ${c}`));
      case 'create_directory': return Tools.createDirectory(args);
        // Fallback: агент може запросити скіл вручну якщо авто-підбір не вистачив
      case 'list_skills':      return Tools.listSkills();
      case 'read_skill':       return Tools.readSkill(args);
      default:
        return {
          ok:     false,
          output: `CRITICAL ERROR: Tool "${name}" does not exist! ` +
              `Valid: read_file, write_file, list_files, run_terminal, ` +
              `create_directory, list_skills, read_skill.`,
        };
    }
  }
}