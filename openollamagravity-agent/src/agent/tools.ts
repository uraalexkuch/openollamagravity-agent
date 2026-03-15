// Copyright (c) 2026 Юрій Кучеренко.
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';

export interface ToolResult { ok: boolean; output: string; }

// ─────────────────────────────────────────────────────────────────────────────
// PROGRESSIVE DISCLOSURE — agentskills.io
//
// Принцип: скіли НЕ завантажуються всі підряд.
// До запуску агента система сама:
//   1. Читає лише YAML frontmatter кожного SKILL.md (~2 KB, ~30-50 токенів)
//   2. Порівнює з текстом задачі (ключові слова, теги, домени)
//   3. Завантажує ПОВНИЙ текст лише для скілів з score > 0
//   4. Повертає їх для вставки у промпт агента
//
// Агент бачить тільки потрібні скіли — жодного токена на нерелевантні.
// ─────────────────────────────────────────────────────────────────────────────

export interface SkillMeta {
  filePath:    string;   // абсолютний шлях до SKILL.md
  skillPath:   string;   // відносний шлях від skillsPath (для read_skill)
  name:        string;
  description: string;
  domain:      string;
  subdomain:   string;
  tags:        string[];
  score:       number;   // релевантність до поточної задачі
}

export interface LoadedSkill extends SkillMeta {
  content: string;  // повний текст SKILL.md
}

// ── FRONTMATTER ───────────────────────────────────────────────────────────────

/**
 * Зчитує перші 2 KB файлу і витягує YAML між першими "---".
 * Достатньо для ~30-50 токенів frontmatter за стандартом agentskills.io.
 */
function readFrontmatter(filePath: string): string | null {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(2048);
    const n = fs.readSync(fd, buf, 0, 2048, 0);
    fs.closeSync(fd);
    const text = buf.subarray(0, n).toString('utf8');
    if (!text.startsWith('---')) return null;
    const end = text.indexOf('\n---', 3);
    return end === -1 ? null : text.slice(4, end).trim();
  } catch { return null; }
}

/** Парсить YAML рядки "key: value" і "key: [a, b, c]" */
function parseYaml(yaml: string): Record<string, any> {
  const out: Record<string, any> = {};
  for (const line of yaml.split('\n')) {
    const m = line.match(/^([\w-]+):\s*(.+)$/);
    if (!m) continue;
    const [, key, raw] = m;
    const v = raw.trim();
    if (v.startsWith('[') && v.endsWith(']')) {
      out[key] = v.slice(1, -1)
          .split(',')
          .map(s => s.trim().replace(/^['"]|['"]$/g, '').toLowerCase())
          .filter(Boolean);
    } else {
      out[key] = v.replace(/^['"]|['"]$/g, '');
    }
  }
  return out;
}

// ── FILE SCANNER ──────────────────────────────────────────────────────────────

/** Рекурсивно знаходить усі SKILL.md або .md у skillsPath */
function findAllSkillFiles(skillsPath: string): string[] {
  const results: string[] = [];
  function walk(dir: string) {
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (e.startsWith('.')) continue;
      const full = path.join(dir, e);
      try {
        if (fs.statSync(full).isDirectory()) { walk(full); }
        else if (e === 'SKILL.md' || (results.length === 0 && e.endsWith('.md'))) {
          results.push(full);
        }
      } catch {}
    }
  }
  walk(skillsPath);

  // Якщо немає SKILL.md — шукаємо всі .md (legacy репо без agentskills.io структури)
  if (results.length === 0) {
    function walkMd(dir: string) {
      let entries: string[];
      try { entries = fs.readdirSync(dir); } catch { return; }
      for (const e of entries) {
        if (e.startsWith('.')) continue;
        const full = path.join(dir, e);
        try {
          if (fs.statSync(full).isDirectory()) { walkMd(full); }
          else if (e.endsWith('.md')) { results.push(full); }
        } catch {}
      }
    }
    walkMd(skillsPath);
  }

  return results;
}

function getSkillsPath(): string {
  return vscode.workspace.getConfiguration('openollamagravity').get<string>('skillsPath', '');
}

// ── SCORING — відповідність задачі ───────────────────────────────────────────

const STOP_WORDS = new Set([
  'the','a','an','in','on','at','to','of','and','or','for','is','it',
  'with','how','do','i','be','use','using','get','set','run','make',
  'що','як','для','та','і','або','з','у','в','це','на','до','по',
]);

function tokenize(text: string): string[] {
  return text
      .toLowerCase()
      .split(/[\s,;:.!?()\[\]{}<>\-_\/\\|"'`]+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

/**
 * Обчислює score релевантності скіла до задачі.
 * Враховує: збіг тегів (×3), опис (×2), назву та домен (×1).
 */
function scoreSkill(meta: SkillMeta, taskTokens: string[]): number {
  if (taskTokens.length === 0) return 0;

  const nameTokens    = tokenize(meta.name);
  const descTokens    = tokenize(meta.description);
  const domainTokens  = tokenize(`${meta.domain} ${meta.subdomain}`);
  const tagTokens     = meta.tags; // теги вже lowercase

  let score = 0;
  for (const tw of taskTokens) {
    if (tagTokens.some(t => t === tw || t.includes(tw) || tw.includes(t)))       score += 3;
    else if (descTokens.some(d => d === tw || d.includes(tw) || tw.includes(d))) score += 2;
    else if (nameTokens.some(n => n === tw || n.includes(tw) || tw.includes(n))) score += 1;
    else if (domainTokens.some(d => d.includes(tw) || tw.includes(d)))           score += 1;
  }
  return score;
}

// ── PUBLIC API ────────────────────────────────────────────────────────────────

/**
 * Аналізує задачу і повертає лише релевантні скіли з повним текстом.
 *
 * Виклик відбувається АВТОМАТИЧНО до запуску агента — не через tool_call.
 * Агент отримує готові скіли вже у системному промпті.
 *
 * @param task  текст задачі або промпту від користувача
 * @param maxSkills  максимальна кількість скілів (default: 3)
 */
export async function autoLoadSkillsForTask(
    task: string,
    maxSkills = 3
): Promise<LoadedSkill[]> {
  const skillsPath = getSkillsPath();
  if (!skillsPath || !fs.existsSync(skillsPath)) return [];

  const files = findAllSkillFiles(skillsPath);
  if (files.length === 0) return [];

  const taskTokens = tokenize(task);
  const scored: SkillMeta[] = [];

  for (const file of files) {
    const yaml = readFrontmatter(file);
    // Для legacy .md без frontmatter — використовуємо ім'я файлу як назву
    const meta: SkillMeta = yaml
        ? (() => {
          const p = parseYaml(yaml);
          return {
            filePath:    file,
            skillPath:   path.relative(skillsPath, path.dirname(file)).replace(/\\/g, '/'),
            name:        String(p['name'] || path.basename(path.dirname(file))),
            description: String(p['description'] || ''),
            domain:      String(p['domain'] || ''),
            subdomain:   String(p['subdomain'] || ''),
            tags:        Array.isArray(p['tags']) ? p['tags'] : [],
            score:       0,
          };
        })()
        : {
          filePath:    file,
          skillPath:   path.relative(skillsPath, file).replace(/\\/g, '/'),
          name:        path.basename(file, '.md'),
          description: '',
          domain:      '',
          subdomain:   '',
          tags:        tokenize(path.basename(file, '.md')), // теги з назви файлу
          score:       0,
        };

    meta.score = scoreSkill(meta, taskTokens);
    if (meta.score > 0) scored.push(meta);
  }

  // Сортуємо за score DESC, беремо топ N
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, maxSkills);

  // Завантажуємо ПОВНИЙ текст лише обраних скілів
  const loaded: LoadedSkill[] = [];
  for (const meta of top) {
    try {
      const content = fs.readFileSync(meta.filePath, 'utf8');
      loaded.push({ ...meta, content });
      oogLogger_log(`[Skills] ✅ Завантажено: "${meta.name}" (score=${meta.score})`);
    } catch (e: any) {
      oogLogger_log(`[Skills] ⚠️ Не вдалось прочитати: ${meta.filePath} — ${e.message}`);
    }
  }

  return loaded;
}

// Lazy reference до oogLogger щоб уникнути циклічного імпорту
function oogLogger_log(msg: string) {
  try {
    const { oogLogger } = require('../ollama/client');
    oogLogger.appendLine(msg);
  } catch {}
}

// ── PATH RESOLVER ─────────────────────────────────────────────────────────────

function resolvePath(p: string): string {
  if (!p) throw new Error('Path is required but received undefined.');
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  return path.isAbsolute(p) ? p : path.join(root, p);
}

// ── FILE TOOLS ────────────────────────────────────────────────────────────────

export async function readFile(args: any): Promise<ToolResult> {
  try {
    return { ok: true, output: fs.readFileSync(resolvePath(args.path), 'utf8') };
  } catch (e: any) { return { ok: false, output: e.message }; }
}

export async function writeFile(
    args: any,
    onConfirm: (p: string) => Promise<boolean>
): Promise<ToolResult> {
  try {
    if (!args.path) return { ok: false, output: 'Помилка: вкажіть "path".' };
    const abs = resolvePath(args.path);
    if (!await onConfirm(args.path)) return { ok: false, output: 'Rejected.' };
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, args.content || '', 'utf8');
    return { ok: true, output: `Saved: ${args.path}` };
  } catch (e: any) { return { ok: false, output: e.message }; }
}

export async function listFiles(args: any): Promise<ToolResult> {
  try {
    const base = resolvePath(args.path || '.');
    if (!fs.existsSync(base)) return { ok: false, output: 'Path not found.' };
    const depth = Math.min(Number(args.depth) || 1, 4);

    function walk(dir: string, d: number): string[] {
      if (d > depth) return [];
      const pad = '  '.repeat(d - 1);
      const out: string[] = [];
      let entries: string[];
      try { entries = fs.readdirSync(dir); } catch { return []; }
      for (const e of entries.slice(0, 100)) {
        const full = path.join(dir, e);
        try {
          const isDir = fs.statSync(full).isDirectory();
          out.push(`${pad}${isDir ? '📁' : '📄'} ${e}${isDir ? '/' : ''}`);
          if (isDir && d < depth) out.push(...walk(full, d + 1));
        } catch {}
      }
      return out;
    }
    return { ok: true, output: walk(base, 1).join('\n') || '(empty)' };
  } catch (e: any) { return { ok: false, output: e.message }; }
}

export async function runTerminal(
    args: any,
    onConfirm: (c: string) => Promise<boolean>
): Promise<ToolResult> {
  try {
    if (!args.command) return { ok: false, output: 'No command.' };
    if (!await onConfirm(args.command)) return { ok: false, output: 'Rejected.' };
    const res = cp.execSync(args.command, {
      cwd: args.cwd
          ? resolvePath(args.cwd)
          : (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || ''),
      timeout: 60_000,
    });
    return { ok: true, output: res.toString() };
  } catch (e: any) { return { ok: false, output: e.message }; }
}

export async function createDirectory(args: any): Promise<ToolResult> {
  try {
    fs.mkdirSync(resolvePath(args.path), { recursive: true });
    return { ok: true, output: `Created: ${args.path}` };
  } catch (e: any) { return { ok: false, output: e.message }; }
}

// ── SKILLS TOOLS (fallback — агент може викликати вручну) ────────────────────

/**
 * list_skills — повертає лише YAML frontmatter всіх скілів.
 * Агент використовує це як fallback, якщо авто-підбір не спрацював.
 */
export async function listSkills(): Promise<ToolResult> {
  const p = getSkillsPath();
  if (!p || !fs.existsSync(p)) {
    return { ok: false, output: 'Skills path not found. Check openollamagravity.skillsPath.' };
  }
  const files = findAllSkillFiles(p);
  if (files.length === 0) {
    return { ok: false, output: 'No skill files found. Run: openollamagravity.syncSkills' };
  }

  const entries: string[] = [];
  for (const file of files) {
    const yaml = readFrontmatter(file);
    if (!yaml) {
      // Legacy .md без frontmatter — показуємо просто ім'я
      const rel = path.relative(p, file).replace(/\\/g, '/');
      entries.push(`---\nname: ${path.basename(file, '.md')}\nskill_path: ${rel}\n---`);
      continue;
    }
    const skillPath = path.relative(p, path.dirname(file)).replace(/\\/g, '/');
    entries.push(`---\n${yaml}\nskill_path: ${skillPath}\n---`);
  }

  return {
    ok: true,
    output:
        `# SKILLS INDEX — ${entries.length} skills (frontmatter only)\n` +
        `# To load full skill: read_skill {"name": "<skill_path>"}\n\n` +
        entries.join('\n\n'),
  };
}

/**
 * read_skill — завантажує ПОВНИЙ текст конкретного скіла.
 * args.name — skill_path з frontmatter або ім'я файлу.
 */
export async function readSkill(args: any): Promise<ToolResult> {
  if (!args.name) return { ok: false, output: 'Вкажіть "name".' };
  const p = getSkillsPath();
  if (!p) return { ok: false, output: 'Skills path not configured.' };

  const file = resolveSkillFile(p, args.name);
  if (!file) {
    return {
      ok: false,
      output: `Skill not found: "${args.name}". Use list_skills to find skill_path values.`,
    };
  }
  try {
    return { ok: true, output: fs.readFileSync(file, 'utf8') };
  } catch (e: any) { return { ok: false, output: e.message }; }
}

function resolveSkillFile(skillsPath: string, name: string): string | null {
  const candidates = [
    path.join(skillsPath, name),
    path.join(skillsPath, name, 'SKILL.md'),
    path.join(skillsPath, name.replace(/\/SKILL\.md$/i, ''), 'SKILL.md'),
  ];
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch {}
  }
  const target = path.basename(name.replace(/\/SKILL\.md$/i, '').replace(/\.md$/i, ''));
  return findByName(skillsPath, target);
}

function findByName(dir: string, target: string): string | null {
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return null; }
  for (const e of entries) {
    if (e.startsWith('.')) continue;
    const full = path.join(dir, e);
    try {
      if (fs.statSync(full).isDirectory()) {
        if (e === target) {
          const f = path.join(full, 'SKILL.md');
          try { if (fs.statSync(f).isFile()) return f; } catch {}
        }
        const found = findByName(full, target);
        if (found) return found;
      } else if (
          e.endsWith('.md') &&
          (e === target + '.md' || path.basename(e, '.md') === target)
      ) {
        return full;
      }
    } catch {}
  }
  return null;
}