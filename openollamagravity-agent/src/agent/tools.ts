// Copyright (c) 2026 Юрій Кучеренко.
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import { oogLogger } from '../ollama/client';

export interface ToolResult { ok: boolean; output: string; }

// ─────────────────────────────────────────────────────────────────────────────
// СТРУКТУРА РЕПОЗИТОРІЮ (реальна):
//
//   skills\
//     10-andruia-skill-smith\
//       SKILL.md          ← кожен скіл = папка + SKILL.md всередині
//     another-skill-name\
//       SKILL.md
//     ...
//
// PROGRESSIVE DISCLOSURE (agentskills.io):
//   1. Читаємо лише перші 2 KB кожного SKILL.md (YAML frontmatter)
//   2. Скоруємо кожен скіл відносно тексту задачі
//   3. Завантажуємо ПОВНИЙ текст лише для топ-N релевантних скілів
//   4. Вставляємо їх у системний промпт агента
//   Решта скілів — жодного токена не витрачається.
// ─────────────────────────────────────────────────────────────────────────────

export interface SkillMeta {
  filePath:    string;  // абсолютний шлях: ...skills\10-andruia-skill-smith\SKILL.md
  folderName:  string;  // ім'я папки:       10-andruia-skill-smith
  name:        string;  // з YAML: name:
  description: string;  // з YAML: description:
  domain:      string;  // з YAML: domain:
  subdomain:   string;  // з YAML: subdomain:
  tags:        string[]; // з YAML: tags:
  score:       number;
}

export interface LoadedSkill extends SkillMeta {
  content: string;  // повний текст SKILL.md
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function getSkillsPath(): string {
  return vscode.workspace.getConfiguration('openollamagravity').get<string>('skillsPath', '');
}

/**
 * Рекурсивно сканує всю папку skillsPath і знаходить кожен SKILL.md
 * на будь-якій глибині вкладеності:
 *
 *   skills\10-andruia-skill-smith\SKILL.md           ← перший рівень
 *   skills\cybersecurity\volatility3\SKILL.md        ← другий рівень
 *   skills\web\xss\advanced\SKILL.md                 ← третій рівень тощо
 *
 * Також підтримує legacy .md файли (якщо SKILL.md не знайдено взагалі).
 */
function scanSkillFolders(skillsPath: string): string[] {
  const skillMd: string[] = [];
  const legacyMd: string[] = [];

  function walk(dir: string) {
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const full = path.join(dir, entry);
      try {
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          walk(full);
        } else if (entry === 'SKILL.md') {
          skillMd.push(full);
        } else if (entry.endsWith('.md')) {
          legacyMd.push(full);
        }
      } catch {}
    }
  }

  walk(skillsPath);
  // Якщо є хоча б один SKILL.md — повертаємо лише їх (стандартна структура).
  // Інакше падаємо на legacy .md (старі репо без agentskills.io структури).
  return skillMd.length > 0 ? skillMd : legacyMd;
}

/**
 * Зчитує перші 2 KB SKILL.md і витягує YAML між першими "---" ... "---".
 * ~30-50 токенів — достатньо для визначення релевантності.
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

/** Мінімальний парсер YAML: "key: value" і "key: [a, b, c]" */
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

// ── SCORING ───────────────────────────────────────────────────────────────────

const STOP = new Set([
  'the','a','an','in','on','at','to','of','and','or','for','is','it','be',
  'use','using','get','set','run','make','how','do','with',
  'що','як','для','та','і','або','з','у','в','це','на','до','по','при',
]);

function tokenize(text: string): string[] {
  return text
      .toLowerCase()
      .replace(/[-_]/g, ' ')          // дефіси → пробіли (для "skill-smith" → "skill smith")
      .split(/[\s,;:.!?()\[\]{}<>|"'`]+/)
      .filter(w => w.length > 2 && !STOP.has(w));
}

/**
 * Рахує score скіла відносно токенів задачі.
 *   tags       → ×3  (найточніший сигнал)
 *   description→ ×2
 *   name/folder→ ×1
 *   domain     → ×1
 */
function scoreSkill(meta: SkillMeta, taskTokens: string[]): number {
  if (taskTokens.length === 0) return 0;
  const nameT   = tokenize(meta.name + ' ' + meta.folderName);
  const descT   = tokenize(meta.description);
  const domainT = tokenize(meta.domain + ' ' + meta.subdomain);

  let score = 0;
  for (const tw of taskTokens) {
    if (meta.tags.some(t => t === tw || t.includes(tw) || tw.includes(t)))          score += 3;
    else if (descT.some(d => d === tw || d.includes(tw) || tw.includes(d)))         score += 2;
    else if (nameT.some(n => n === tw || n.includes(tw) || tw.includes(n)))         score += 1;
    else if (domainT.some(d => d.length > 2 && (d.includes(tw) || tw.includes(d)))) score += 1;
  }
  return score;
}

// ── PUBLIC: автоматичний підбір скілів ────────────────────────────────────────

/**
 * Викликається ПЕРЕД запуском агента.
 * Аналізує задачу, читає frontmatter кожного скіла (~2 KB),
 * повертає топ-N скілів з ПОВНИМ текстом.
 *
 * @param task      текст задачі / промпт користувача
 * @param maxSkills максимальна кількість скілів у промпті (default: 3)
 */
export async function autoLoadSkillsForTask(
    task: string,
    maxSkills = 3
): Promise<LoadedSkill[]> {
  const skillsPath = getSkillsPath();
  if (!skillsPath || !fs.existsSync(skillsPath)) return [];

  const files = scanSkillFolders(skillsPath);
  if (files.length === 0) return [];

  const taskTokens = tokenize(task);
  const scored: SkillMeta[] = [];

  for (const filePath of files) {
    // Для пласкої структури: "10-andruia-skill-smith"
    // Для вкладеної:         "cybersecurity/volatility3"
    const folderName = path.relative(skillsPath, path.dirname(filePath)).replace(/\\/g, '/');
    const yaml = readFrontmatter(filePath);

    let meta: SkillMeta;
    if (yaml) {
      const p = parseYaml(yaml);
      meta = {
        filePath,
        folderName,
        name:        String(p['name']        || folderName),
        description: String(p['description'] || ''),
        domain:      String(p['domain']      || ''),
        subdomain:   String(p['subdomain']   || ''),
        tags:        Array.isArray(p['tags']) ? p['tags'] : tokenize(folderName),
        score:       0,
      };
    } else {
      // SKILL.md без frontmatter — токенізуємо назву папки як теги
      meta = {
        filePath, folderName,
        name: folderName, description: '', domain: '', subdomain: '',
        tags: tokenize(folderName), score: 0,
      };
    }

    meta.score = scoreSkill(meta, taskTokens);
    if (meta.score > 0) scored.push(meta);
  }

  // Сортуємо за score DESC
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, maxSkills);

  // Завантажуємо ПОВНИЙ текст лише обраних
  const loaded: LoadedSkill[] = [];
  for (const meta of top) {
    try {
      const content = fs.readFileSync(meta.filePath, 'utf8');
      loaded.push({ ...meta, content });
      oogLogger.appendLine(`[Skills] ✅ ${meta.folderName} (score=${meta.score})`);
    } catch (e: any) {
      oogLogger.appendLine(`[Skills] ⚠️  ${meta.folderName}: ${e.message}`);
    }
  }

  return loaded;
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

// ── SKILLS TOOLS (fallback — агент викликає вручну якщо потрібно) ─────────────

/**
 * list_skills — повертає YAML frontmatter всіх скілів.
 * Агент використовує якщо потребує скіла поза авто-підбором.
 *
 * Формат кожного запису:
 *   ---
 *   name: ...
 *   description: ...
 *   tags: [...]
 *   skill_path: 10-andruia-skill-smith
 *   ---
 */
export async function listSkills(): Promise<ToolResult> {
  const sp = getSkillsPath();
  if (!sp || !fs.existsSync(sp)) {
    return { ok: false, output: 'Skills path not found. Check openollamagravity.skillsPath.' };
  }
  const files = scanSkillFolders(sp);
  if (files.length === 0) {
    return { ok: false, output: 'No SKILL.md files found. Run: openollamagravity.syncSkills' };
  }

  const entries: string[] = [];
  for (const file of files) {
    // Відносний шлях від skillsPath: "10-skill" або "cybersecurity/volatility3"
    const folderName = path.relative(sp, path.dirname(file)).replace(/\\/g, '/');
    const yaml = readFrontmatter(file);
    const body = yaml
        ? `${yaml}\nskill_path: ${folderName}`
        : `name: ${folderName}\nskill_path: ${folderName}`;
    entries.push(`---\n${body}\n---`);
  }

  return {
    ok: true,
    output:
        `# SKILLS INDEX — ${entries.length} skills (frontmatter only)\n` +
        `# Load full skill: read_skill {"name": "<skill_path>"}\n\n` +
        entries.join('\n\n'),
  };
}

/**
 * read_skill — завантажує ПОВНИЙ текст скіла.
 * args.name = folderName, напр. "10-andruia-skill-smith"
 */
export async function readSkill(args: any): Promise<ToolResult> {
  if (!args.name) return { ok: false, output: 'Вкажіть "name" (назву папки скіла).' };
  const sp = getSkillsPath();
  if (!sp) return { ok: false, output: 'Skills path not configured.' };

  // Пряме звернення — підтримує як "10-andruia-skill-smith" так і "cybersecurity/volatility3"
  const directPath = path.join(sp, args.name, 'SKILL.md');
  if (fs.existsSync(directPath)) {
    try {
      return { ok: true, output: fs.readFileSync(directPath, 'utf8') };
    } catch (e: any) { return { ok: false, output: e.message }; }
  }

  // Fallback: шукаємо по всіх знайдених скілах — часткове співпадіння відносного шляху
  const files  = scanSkillFolders(sp);
  const needle = String(args.name).toLowerCase().replace(/\\/g, '/');
  const match  = files.find(f => {
    const rel = path.relative(sp, path.dirname(f)).replace(/\\/g, '/').toLowerCase();
    return rel === needle || rel.includes(needle) || path.basename(rel).includes(needle);
  });
  if (!match) {
    return {
      ok: false,
      output: `Skill "${args.name}" not found. Use list_skills to see available skill_path values.`,
    };
  }
  try {
    return { ok: true, output: fs.readFileSync(match, 'utf8') };
  } catch (e: any) { return { ok: false, output: e.message }; }
}