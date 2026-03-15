// Copyright (c) 2026 Юрій Кучеренко.
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import { oogLogger } from '../ollama/client';
import * as http from 'http';
import * as https from 'https';

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
  'цей','цього','цьому','цим','ця','цієї','цю','цієї',
  'який','яка','яке','які','якого','якій','яким',
  'мені','мене','мій','моя','моє','мої','мого',
]);

/**
 * Словник перекладу UA→EN для частих слів у задачах.
 * Забезпечує збіг українських запитів з англійськими тегами скілів.
 */
const UA_EN: Record<string, string[]> = {
  // Загальні дії
  'поясни':     ['explain', 'describe', 'overview'],
  'поясніть':   ['explain', 'describe'],
  'опиши':      ['describe', 'overview', 'explain'],
  'опишіть':    ['describe', 'overview'],
  'проаналізуй':['analyze', 'analysis', 'review'],
  'перевір':    ['check', 'verify', 'validate', 'review'],
  'виправ':     ['fix', 'debug', 'repair'],
  'налагодь':   ['debug', 'troubleshoot'],
  'оптимізуй':  ['optimize', 'performance', 'refactor'],
  'рефактор':   ['refactor', 'clean', 'restructure'],
  'задокументуй':['document', 'documentation', 'docs'],
  'документацію':['documentation', 'docs', 'readme'],
  'напиши':     ['write', 'create', 'implement'],
  'створи':     ['create', 'build', 'implement'],
  'додай':      ['add', 'implement', 'create'],
  'видали':     ['delete', 'remove'],
  'встанови':   ['install', 'setup', 'configure'],
  'налаштуй':   ['configure', 'setup', 'settings'],
  'запусти':    ['run', 'execute', 'start'],
  'розгорни':   ['deploy', 'deployment'],
  'протестуй':  ['test', 'testing'],
  'відлагодь':  ['debug', 'troubleshoot'],
  // Структура та архітектура
  'структуру':  ['structure', 'architecture', 'overview', 'project'],
  'структура':  ['structure', 'architecture', 'project'],
  'архітектуру':['architecture', 'structure', 'design'],
  'архітектура':['architecture', 'design'],
  'проєкту':    ['project', 'codebase', 'repository'],
  'проект':     ['project', 'codebase'],
  'проекту':    ['project', 'codebase', 'repository'],
  'код':        ['code', 'source'],
  'кодову':     ['codebase', 'code'],
  'базу':       ['database', 'base'],
  'бази':       ['database'],
  'сервер':     ['server', 'backend'],
  'сервера':    ['server', 'backend'],
  'бекенд':     ['backend', 'server', 'api'],
  'фронтенд':   ['frontend', 'client', 'ui'],
  'апі':        ['api', 'rest', 'endpoint'],
  'ендпоінти':  ['endpoint', 'api', 'routes'],
  'маршрути':   ['routes', 'routing', 'endpoint'],
  'модулі':     ['modules', 'components'],
  'компоненти': ['components', 'modules'],
  // Технології
  'безпека':    ['security', 'auth', 'authentication'],
  'авторизація':['authorization', 'auth', 'access'],
  'автентифікація':['authentication', 'auth', 'login'],
  'тести':      ['tests', 'testing', 'unit-test'],
  'логи':       ['logs', 'logging', 'monitoring'],
  'деплой':     ['deploy', 'deployment', 'ci-cd'],
  'конфігурація':['configuration', 'config', 'settings'],
  'залежності': ['dependencies', 'packages', 'requirements'],
  'помилки':    ['errors', 'exceptions', 'debugging'],
  'помилка':    ['error', 'bug', 'exception'],
};

/** Розширює масив токенів англійськими перекладами для UA слів */
function expandWithTranslations(tokens: string[]): string[] {
  const expanded = new Set(tokens);
  for (const token of tokens) {
    const translations = UA_EN[token];
    if (translations) {
      translations.forEach(t => expanded.add(t));
    }
  }
  return Array.from(expanded);
}

function tokenize(text: string): string[] {
  return text
      .toLowerCase()
      .replace(/[-_]/g, ' ')
      .split(/[\s,;:.!?()\[\]{}<>|"'`]+/)
      .filter(w => w.length > 2 && !STOP.has(w));
}

/**
 * Рахує score скіла відносно токенів задачі.
 * Токени задачі автоматично розширюються англійськими перекладами UA-слів.
 *   tags       → ×3
 *   description→ ×2
 *   name/folder→ ×1
 *   domain     → ×1
 */
function scoreSkill(meta: SkillMeta, taskTokens: string[]): number {
  if (taskTokens.length === 0) return 0;

  // Розширюємо токени задачі перекладами — щоб "структуру" знаходила "structure"
  const queryTokens = expandWithTranslations(taskTokens);

  const nameT   = tokenize(meta.name + ' ' + meta.folderName);
  const descT   = tokenize(meta.description);
  const domainT = tokenize(meta.domain + ' ' + meta.subdomain);

  let score = 0;
  for (const tw of queryTokens) {
    if (meta.tags.some(t => t === tw || t.includes(tw) || tw.includes(t)))           score += 3;
    else if (descT.some(d => d === tw || d.includes(tw) || tw.includes(d)))          score += 2;
    else if (nameT.some(n => n === tw || n.includes(tw) || tw.includes(n)))          score += 1;
    else if (domainT.some(d => d.length > 2 && (d.includes(tw) || tw.includes(d))))  score += 1;
  }
  return score;
}

// ─────────────────────────────────────────────────────────────────────────────
// ЄДИНИЙ АЛГОРИТМ ПОШУКУ СКІЛІВ
//
// Один і той самий pipeline для першого запиту і динамічного пошуку:
//
//   extractQueryTokens(text) → очищаємо шум, токенізуємо
//         ↓
//   scanAndScoreAllSkills(tokens, alreadyLoaded, minScore)
//       • читає frontmatter (~2 KB) кожного SKILL.md
//       • scoreSkill(): tags×3, description×2, name/folder×1
//       • повертає ВСІ скіли з score ≥ minScore, відсортовані DESC
//         ↓
//   loadTopSkills(scored, maxN) → завантажуємо ПОВНИЙ текст топ-N
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Очищає текст від шуму і повертає унікальні значущі токени.
 * Використовується і для задачі користувача, і для tool_result.
 */
function extractQueryTokens(text: string): string[] {
  const cleaned = text
      .slice(0, 4096)
      .replace(/[A-Za-z]:\\[\w\\.\ \-]*/g, ' ')  // Windows-шляхи
      .replace(/\/[\w\/.\-]+/g, ' ')              // Unix-шляхи
      .replace(/https?:\/\/\S+/g, ' ')            // URL
      .replace(/\b\d{2,}\b/g, ' ')               // числа 2+ цифри
      .replace(/[^\w\s]/g, ' ');                 // спецсимволи
  return [...new Set(tokenize(cleaned))];
}

/**
 * Сканує ВСІ SKILL.md, скорує кожен проти наданих токенів,
 * повертає відсортований список (DESC score).
 */
function scanAndScoreAllSkills(
    queryTokens:   string[],
    alreadyLoaded: Set<string> = new Set(),
    minScore       = 1,
): SkillMeta[] {
  const skillsPath = getSkillsPath();
  if (!skillsPath || !fs.existsSync(skillsPath)) return [];

  const files   = scanSkillFolders(skillsPath);
  const scored: SkillMeta[] = [];

  for (const filePath of files) {
    const folderName = path.relative(skillsPath, path.dirname(filePath)).replace(/\\/g, '/');
    if (alreadyLoaded.has(folderName)) continue;

    const yaml = readFrontmatter(filePath);
    let meta: SkillMeta;

    if (yaml) {
      const p = parseYaml(yaml);
      meta = {
        filePath, folderName,
        name:        String(p['name']        || folderName),
        description: String(p['description'] || ''),
        domain:      String(p['domain']      || ''),
        subdomain:   String(p['subdomain']   || ''),
        tags:        Array.isArray(p['tags']) ? p['tags'] : tokenize(folderName),
        score:       0,
      };
    } else {
      meta = {
        filePath, folderName,
        name: folderName, description: '', domain: '', subdomain: '',
        tags: tokenize(folderName), score: 0,
      };
    }

    meta.score = scoreSkill(meta, queryTokens);
    if (meta.score >= minScore) scored.push(meta);
  }

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/** Завантажує ПОВНИЙ текст для топ-N скілів зі списку. */
function loadTopSkills(scored: SkillMeta[], maxSkills: number): LoadedSkill[] {
  const loaded: LoadedSkill[] = [];
  for (const meta of scored.slice(0, maxSkills)) {
    try {
      const content = fs.readFileSync(meta.filePath, 'utf8');
      loaded.push({ ...meta, content });
      oogLogger.appendLine(`[Skills] ✅ "${meta.name}"  folder=${meta.folderName}  score=${meta.score}`);
    } catch (e: any) {
      oogLogger.appendLine(`[Skills] ⚠️  ${meta.folderName}: ${e.message}`);
    }
  }
  return loaded;
}

// ── PHASE 1: підбір скілів для першого запиту ────────────────────────────────

/**
 * Викликається ПЕРЕД запуском агента.
 * Перевіряє ВСІ скіли і завантажує топ-N найрелевантніших.
 *
 * @param task             текст задачі від користувача
 * @param workspaceContext додатковий контекст (package.json, активний файл тощо)
 * @param maxSkills        максимум скілів у системному промпті (default: 3)
 */
export async function autoLoadSkillsForTask(
    task: string,
    workspaceContext = '',
    maxSkills = 3,
): Promise<LoadedSkill[]> {
  // Об'єднуємо задачу і контекст workspace — разом дають повнішу картину.
  // Наприклад: задача "Поясни структуру" + контекст "Project: deep-search-backend, deps: fastapi, sqlalchemy"
  // → токени ['deep', 'search', 'backend', 'fastapi', 'sqlalchemy'] → знаходять релевантні скіли
  const combined    = [task, workspaceContext].filter(Boolean).join('\n');
  const queryTokens = extractQueryTokens(combined);
  if (queryTokens.length === 0) return [];

  oogLogger.appendLine(`[Skills] Аналіз задачі: tokens=[${queryTokens.slice(0, 15).join(', ')}]`);

  const allScored = scanAndScoreAllSkills(queryTokens, new Set(), 1);

  oogLogger.appendLine(
      `[Skills] Знайдено: ${allScored.length} релевантних` +
      (allScored.length > 0
          ? `, топ: ${allScored.slice(0, 5).map(s => `${s.folderName}(${s.score})`).join(', ')}`
          : '')
  );

  return loadTopSkills(allScored, maxSkills);
}

// ── PHASE 2: динамічний пошук під час роботи ─────────────────────────────────

/**
 * Аналізує вміст tool_result і знаходить нові скіли напряму по тексту.
 * Жодних хардкодованих патернів — контент сам є пошуковим запитом.
 *
 * @param toolName      назва інструменту (фільтр)
 * @param content       текст відповіді інструменту
 * @param alreadyLoaded множина folderName вже завантажених скілів
 * @param maxNew        максимум нових скілів (default: 2)
 * @param minScore      мінімальний score (default: 2 — суворіше ніж при старті)
 */
export async function discoverSkillsFromContext(
    toolName:      string,
    content:       string,
    alreadyLoaded: Set<string>,
    maxNew   = 2,
    minScore = 2,
): Promise<{ skills: LoadedSkill[]; contextTokens: string[] }> {
  const empty = { skills: [], contextTokens: [] };

  if (!['read_file', 'list_files', 'run_terminal'].includes(toolName)) return empty;
  if (!content || content.length < 20) return empty;

  const contextTokens = extractQueryTokens(content);
  if (contextTokens.length < 3) return empty;

  oogLogger.appendLine(`[Skills] Контекст з ${toolName}: tokens=[${contextTokens.slice(0, 10).join(', ')}]`);

  const newScored = scanAndScoreAllSkills(contextTokens, alreadyLoaded, minScore);

  if (newScored.length > 0) {
    oogLogger.appendLine(
        `[Skills] Контекст знайшов: ${newScored.length} нових` +
        `, топ: ${newScored.slice(0, 3).map(s => `${s.folderName}(${s.score})`).join(', ')}`
    );
  }

  return { skills: loadTopSkills(newScored, maxNew), contextTokens };
}

// ── WEB SEARCH — Perplexica ──────────────────────────────────────────────────
//
// Perplexica — self-hosted AI search engine (https://github.com/ItzCrazyKns/Perplexica)
// Налаштування: openollamagravity.perplexicaUrl (default: http://localhost:3001)
//
// Агент може викликати web_search коли задача потребує актуальних даних:
//   - документація бібліотек
//   - новини, релізи, CVE
//   - вирішення помилок яких немає в скілах
//
// Перевіряємо доступність Perplexica перед викликом — якщо недоступний,
// повертаємо чіткий опис помилки щоб агент не застрягав.

export interface WebSearchResult {
  title:   string;
  url:     string;
  snippet: string;
}

function getPerplexicaUrl(): string {
  return vscode.workspace
      .getConfiguration('openollamagravity')
      .get<string>('perplexicaUrl', 'http://localhost:3001');
}

/**
 * Виконує пошук через Perplexica API.
 *
 * Perplexica /api/search приймає:
 *   { query, focusMode, optimizationMode }
 *   focusMode: "webSearch" | "academicSearch" | "writingAssistant" | "wolframAlphaSearch"
 *
 * Повертає стислий текст результатів (title + snippet + url)
 * — не повний HTML, щоб не переповнювати контекст LLM.
 */
export async function webSearch(args: any): Promise<ToolResult> {
  const query = String(args?.query || '').trim();
  if (!query) return { ok: false, output: 'web_search: вкажіть "query".' };

  const baseUrl    = getPerplexicaUrl().replace(/\/$/, '');
  const focusMode  = String(args?.focus  || 'webSearch');
  const maxResults = Math.min(Number(args?.maxResults) || 5, 10);

  oogLogger.appendLine(`[WebSearch] Запит: "${query}" (focus=${focusMode})`);

  try {
    // Перевіряємо чи Perplexica запущена
    const isAvailable = await checkPerplexica(baseUrl);
    if (!isAvailable) {
      return {
        ok: false,
        output:
            `Perplexica недоступна за адресою ${baseUrl}.\n` +
            `Щоб увімкнути web_search:\n` +
            `1. Запустіть Perplexica: https://github.com/ItzCrazyKns/Perplexica\n` +
            `2. Або змініть адресу: openollamagravity.perplexicaUrl у налаштуваннях VSCode.\n` +
            `Продовжую без web_search — використовую наявні знання.`,
      };
    }

    const body = JSON.stringify({
      query,
      focusMode,
      optimizationMode: 'speed',
    });

    const res = await httpPost(`${baseUrl}/api/search`, body);
    const data = JSON.parse(res) as {
      message?: string;
      sources?: Array<{ metadata?: { title?: string; url?: string }; pageContent?: string }>;
    };

    // Формуємо стислий вивід: топ-N результатів
    const sources = (data.sources || []).slice(0, maxResults);
    const lines: string[] = [];

    if (data.message) {
      lines.push(`📋 Відповідь Perplexica:\n${data.message}\n`);
    }

    if (sources.length > 0) {
      lines.push(`🔗 Джерела (${sources.length}):`);
      sources.forEach((s, i) => {
        const title   = s.metadata?.title   || 'Без назви';
        const url     = s.metadata?.url     || '';
        const snippet = (s.pageContent || '').slice(0, 300).replace(/\n+/g, ' ');
        lines.push(`${i + 1}. ${title}\n   ${url}\n   ${snippet}`);
      });
    }

    if (lines.length === 0) {
      return { ok: false, output: `web_search: порожній результат для "${query}".` };
    }

    const output = lines.join('\n\n');
    oogLogger.appendLine(`[WebSearch] Отримано ${sources.length} джерел для "${query}"`);
    return { ok: true, output };

  } catch (e: any) {
    oogLogger.appendLine(`[WebSearch] Помилка: ${e.message}`);
    return {
      ok: false,
      output: `web_search помилка: ${e.message}. Perplexica запущена? (${baseUrl})`,
    };
  }
}

/** Перевіряє доступність Perplexica за /api/config або / */
async function checkPerplexica(baseUrl: string): Promise<boolean> {
  return new Promise(resolve => {
    const url = new URL('/api/config', baseUrl);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get(
        { hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 3001), path: url.pathname, timeout: 3000 },
        (res: any) => { resolve(res.statusCode < 500); }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** HTTP POST helper (http/https) */
function httpPost(urlStr: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
        {
          hostname: url.hostname,
          port:     url.port || (url.protocol === 'https:' ? 443 : 3001),
          path:     url.pathname + (url.search || ''),
          method:   'POST',
          headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          timeout:  30_000,
        },
        (res: any) => {
          let data = '';
          res.on('data', (c: Buffer) => { data += c.toString(); });
          res.on('end', () => resolve(data));
        }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Perplexica timeout')); });
    req.write(body);
    req.end();
  });
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