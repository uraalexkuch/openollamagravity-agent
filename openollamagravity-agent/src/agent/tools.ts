// Copyright (c) 2026 Юрій Кучеренко.
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import { oogLogger } from '../ollama/client';
import * as http from 'http';
import * as https from 'https';

export interface ToolResult { ok: boolean; output: string; }

// --- СТРУКТУРА СЛОВНИКІВ І ТИПІВ СКІЛІВ ЗАЛИШАЄТЬСЯ ТІЄЮ Ж ---
export interface SkillMeta { filePath: string; folderName: string; name: string; description: string; domain: string; subdomain: string; tags: string[]; score: number; }
export interface LoadedSkill extends SkillMeta { content: string; }

export async function getAllSkills(): Promise<SkillMeta[]> {
  const skillsPath = getSkillsPath();
  if (!skillsPath || !fs.existsSync(skillsPath)) return [];
  const files = scanSkillFolders(skillsPath);
  const result: SkillMeta[] = [];
  for (const filePath of files) {
    const folderName = path.relative(skillsPath, path.dirname(filePath)).replace(/\\/g, '/');
    const yaml = readFrontmatter(filePath);
    if (yaml) {
      const p = parseYaml(yaml);
      result.push({ filePath, folderName, name: String(p['name'] || folderName), description: String(p['description'] || ''), domain: String(p['domain'] || ''), subdomain: String(p['subdomain'] || ''), tags: Array.isArray(p['tags']) ? p['tags'] : [], score: 0 });
    } else {
      result.push({ filePath, folderName, name: folderName, description: '', domain: '', subdomain: '', tags: [], score: 0 });
    }
  }
  return result;
}

export function getSkillsPath(): string { return vscode.workspace.getConfiguration('openollamagravity').get<string>('skillsPath', ''); }

function scanSkillFolders(skillsPath: string): string[] {
  const skillMd: string[] = []; const legacyMd: string[] = [];
  function walk(dir: string) {
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const full = path.join(dir, entry);
      try {
        const stat = fs.statSync(full);
        if (stat.isDirectory()) walk(full);
        else if (entry === 'SKILL.md') skillMd.push(full);
        else if (entry.endsWith('.md')) legacyMd.push(full);
      } catch {}
    }
  }
  walk(skillsPath);
  return skillMd.length > 0 ? skillMd : legacyMd;
}

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

function parseYaml(yaml: string): Record<string, any> {
  const out: Record<string, any> = {};
  for (const line of yaml.split('\n')) {
    const m = line.match(/^([\w-]+):\s*(.+)$/);
    if (!m) continue;
    const [, key, raw] = m;
    const v = raw.trim();
    if (v.startsWith('[') && v.endsWith(']')) {
      out[key] = v.slice(1, -1).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '').toLowerCase()).filter(Boolean);
    } else {
      out[key] = v.replace(/^['"]|['"]$/g, '');
    }
  }
  return out;
}

const STOP = new Set(['the','a','an','in','on','at','to','of','and','or','for','is','it','be','use','using','get','set','run','make','how','do','with','що','як','для','та','і','або','з','у','в','це','на','до','по','при','цей','цього','цьому','цим','ця','цієї','цю','цієї','який','яка','яке','які','якого','якій','яким','мені','мене','мій','моя','моє','мої','мого']);
const UA_EN: Record<string, string[]> = {
  'поясни':['explain', 'describe', 'overview'], 'опиши':['describe', 'overview', 'explain'], 'проаналізуй':['analyze', 'analysis', 'review'], 'перевір':['check', 'verify', 'validate', 'review'], 'виправ':['fix', 'debug', 'repair'], 'налагодь':['debug', 'troubleshoot'], 'оптимізуй':['optimize', 'performance', 'refactor'], 'рефактор':['refactor', 'clean', 'restructure'], 'задокументуй':['document', 'documentation', 'docs'], 'документацію':['documentation', 'docs', 'readme'], 'напиши':['write', 'create', 'implement'], 'створи':['create', 'build', 'implement'], 'додай':['add', 'implement', 'create'], 'видали':['delete', 'remove'], 'встанови':['install', 'setup', 'configure'], 'налаштуй':['configure', 'setup', 'settings'], 'запусти':['run', 'execute', 'start'], 'розгорни':['deploy', 'deployment'], 'протестуй':['test', 'testing'], 'структуру':['structure', 'architecture', 'overview', 'project'], 'архітектуру':['architecture', 'structure', 'design'], 'проєкту':['project', 'codebase', 'repository'], 'код':['code', 'source'], 'базу':['database', 'base'], 'сервер':['server', 'backend'], 'бекенд':['backend', 'server', 'api'], 'фронтенд':['frontend', 'client', 'ui'], 'апі':['api', 'rest', 'endpoint'], 'безпека':['security', 'auth', 'authentication'], 'тести':['tests', 'testing', 'unit-test'], 'логи':['logs', 'logging', 'monitoring'], 'помилка':['error', 'bug', 'exception'],
};

function expandWithTranslations(tokens: string[]): string[] {
  const expanded = new Set(tokens);
  for (const token of tokens) if (UA_EN[token]) UA_EN[token].forEach(t => expanded.add(t));
  return Array.from(expanded);
}

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[-_]/g, ' ').split(/[\s,;:.!?()\[\]{}<>|"'`]+/).filter(w => w.length > 2 && !STOP.has(w));
}

let _idfCache: Map<string, number> | null = null;
let _idfSkillsPath = '';

function buildIdfCache(skillsPath: string): Map<string, number> {
  if (_idfCache && _idfSkillsPath === skillsPath) return _idfCache;
  const files = scanSkillFolders(skillsPath);
  if (files.length === 0) return new Map();
  const docFreq = new Map<string, number>();
  for (const filePath of files) {
    const yaml = readFrontmatter(filePath);
    if (!yaml) continue;
    const p = parseYaml(yaml);
    const words = new Set<string>([...tokenize(String(p['name']||'')), ...tokenize(String(p['description']||'')), ...tokenize(String(p['domain']||'')), ...(Array.isArray(p['tags']) ? p['tags'].flatMap((t: string) => tokenize(t)) : [])]);
    words.forEach(w => docFreq.set(w, (docFreq.get(w) ?? 0) + 1));
  }
  const N = files.length; const cache = new Map<string, number>();
  docFreq.forEach((df, token) => {
    const ratio = df / N;
    if (ratio > 0.5) cache.set(token, 0.1);
    else if (ratio > 0.3) cache.set(token, 0.3);
    else if (ratio > 0.1) cache.set(token, 0.6);
    else cache.set(token, 1.0);
  });
  _idfCache = cache; _idfSkillsPath = skillsPath;
  return cache;
}

function idfWeight(token: string, idf: Map<string, number>): number { return idf.get(token) ?? 1.0; }

function splitTaskAndContext(combined: string): { taskTokens: string[]; contextTokens: string[] } {
  const lines = combined.split('\n');
  const ctxMarkers = ['Key deps:', 'Project:', 'Scripts:', 'Active file:', 'Selected code:', 'WORKSPACE'];
  let ctxStart = lines.length;
  for (let i = 0; i < lines.length; i++) if (ctxMarkers.some(m => lines[i].startsWith(m))) { ctxStart = i; break; }
  const taskText = lines.slice(0, ctxStart).join('\n');
  const contextText = lines.slice(ctxStart).join('\n');
  const taskRaw = extractQueryTokens(taskText);
  const contextRaw = extractQueryTokens(contextText);
  const taskExpanded = expandWithTranslations(taskRaw);
  const contextUnique = contextRaw.filter(t => !taskExpanded.includes(t));
  return { taskTokens: taskExpanded, contextTokens: contextUnique };
}

function scoreSkillIdf(meta: SkillMeta, taskTokens: string[], contextTokens: string[], idf: Map<string, number>): number {
  const nameT = tokenize(meta.name + ' ' + meta.folderName);
  const descT = tokenize(meta.description);
  const domainT = tokenize(meta.domain + ' ' + meta.subdomain);
  function baseScore(tw: string): number {
    if (meta.tags.some(t => t === tw || t.includes(tw) || tw.includes(t))) return 3;
    if (descT.some(d => d === tw || d.includes(tw) || tw.includes(d))) return 2;
    if (nameT.some(n => n === tw || n.includes(tw) || tw.includes(n))) return 1;
    if (domainT.some(d => d.length > 2 && (d.includes(tw) || tw.includes(d)))) return 1;
    return 0;
  }
  let score = 0;
  for (const tw of taskTokens) { const base = baseScore(tw); if (base > 0) score += base * idfWeight(tw, idf); }
  for (const tw of contextTokens) { const base = baseScore(tw); if (base > 0) score += base * idfWeight(tw, idf) * 0.4; }
  return score;
}

function scoreSkill(meta: SkillMeta, taskTokens: string[]): number {
  if (taskTokens.length === 0) return 0;
  const queryTokens = expandWithTranslations(taskTokens);
  const nameT = tokenize(meta.name + ' ' + meta.folderName);
  const descT = tokenize(meta.description);
  const domainT = tokenize(meta.domain + ' ' + meta.subdomain);
  let score = 0;
  for (const tw of queryTokens) {
    if (meta.tags.some(t => t === tw || t.includes(tw) || tw.includes(t))) score += 3;
    else if (descT.some(d => d === tw || d.includes(tw) || tw.includes(d))) score += 2;
    else if (nameT.some(n => n === tw || n.includes(tw) || tw.includes(n))) score += 1;
    else if (domainT.some(d => d.length > 2 && (d.includes(tw) || tw.includes(d)))) score += 1;
  }
  return score;
}

function extractQueryTokens(text: string): string[] {
  const cleaned = text.slice(0, 4096).replace(/[A-Za-z]:\\[\w\\.\ \-]*/g, ' ').replace(/\/[\w\/.\-]+/g, ' ').replace(/https?:\/\/\S+/g, ' ').replace(/\b\d{2,}\b/g, ' ').replace(/[^\w\s]/g, ' ');
  return [...new Set(tokenize(cleaned))];
}

export function scanAndScoreAllSkillsIdf(combined: string, alreadyLoaded: Set<string> = new Set(), minScore = 4): SkillMeta[] {
  const skillsPath = getSkillsPath();
  if (!skillsPath || !fs.existsSync(skillsPath)) return [];
  const files = scanSkillFolders(skillsPath);
  if (files.length === 0) return [];
  const idf = buildIdfCache(skillsPath);
  const { taskTokens, contextTokens } = splitTaskAndContext(combined);
  if (taskTokens.length === 0 && contextTokens.length === 0) return [];
  const scored: SkillMeta[] = [];
  for (const filePath of files) {
    const folderName = path.relative(skillsPath, path.dirname(filePath)).replace(/\\/g, '/');
    if (alreadyLoaded.has(folderName)) continue;
    const yaml = readFrontmatter(filePath);
    let meta: SkillMeta;
    if (yaml) {
      const p = parseYaml(yaml);
      meta = { filePath, folderName, name: String(p['name'] || folderName), description: String(p['description'] || ''), domain: String(p['domain'] || ''), subdomain: String(p['subdomain'] || ''), tags: Array.isArray(p['tags']) ? p['tags'] : tokenize(folderName), score: 0 };
    } else {
      meta = { filePath, folderName, name: folderName, description: '', domain: '', subdomain: '', tags: tokenize(folderName), score: 0 };
    }
    meta.score = scoreSkillIdf(meta, taskTokens, contextTokens, idf);
    if (meta.score >= minScore) scored.push(meta);
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

function scanAndScoreAllSkills(queryTokens: string[], alreadyLoaded: Set<string> = new Set(), minScore = 1): SkillMeta[] {
  const skillsPath = getSkillsPath();
  if (!skillsPath || !fs.existsSync(skillsPath)) return [];
  const files = scanSkillFolders(skillsPath);
  const scored: SkillMeta[] = [];
  for (const filePath of files) {
    const folderName = path.relative(skillsPath, path.dirname(filePath)).replace(/\\/g, '/');
    if (alreadyLoaded.has(folderName)) continue;
    const yaml = readFrontmatter(filePath);
    let meta: SkillMeta;
    if (yaml) {
      const p = parseYaml(yaml);
      meta = { filePath, folderName, name: String(p['name'] || folderName), description: String(p['description'] || ''), domain: String(p['domain'] || ''), subdomain: String(p['subdomain'] || ''), tags: Array.isArray(p['tags']) ? p['tags'] : tokenize(folderName), score: 0 };
    } else {
      meta = { filePath, folderName, name: folderName, description: '', domain: '', subdomain: '', tags: tokenize(folderName), score: 0 };
    }
    meta.score = scoreSkill(meta, queryTokens);
    if (meta.score >= minScore) scored.push(meta);
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

export function loadTopSkills(scored: SkillMeta[], maxSkills: number): LoadedSkill[] {
  const loaded: LoadedSkill[] = [];
  for (const meta of scored.slice(0, maxSkills)) {
    try {
      const content = fs.readFileSync(meta.filePath, 'utf8');
      loaded.push({ ...meta, content });
    } catch (e: any) { oogLogger.appendLine(`[Skills] ⚠️  ${meta.folderName}: ${e.message}`); }
  }
  return loaded;
}

export async function autoLoadSkillsForTask(task: string, workspaceContext = '', maxSkills = 3): Promise<LoadedSkill[]> {
  const combined = [task, workspaceContext].filter(Boolean).join('\n');
  if (!combined.trim()) return [];
  const allScored = scanAndScoreAllSkillsIdf(combined, new Set(), 4);
  if (allScored.length === 0) {
    const fallback = scanAndScoreAllSkillsIdf(combined, new Set(), 2);
    return loadTopSkills(fallback, maxSkills);
  }
  return loadTopSkills(allScored, maxSkills);
}

export async function discoverSkillsFromContext(toolName: string, content: string, alreadyLoaded: Set<string>, maxNew = 2, minScore = 3): Promise<{ skills: LoadedSkill[]; contextTokens: string[] }> {
  const empty = { skills: [], contextTokens: [] };
  const validTools = ['read_file', 'list_files', 'run_terminal', 'search_files', 'get_diagnostics', 'get_file_outline'];
  if (!validTools.includes(toolName)) return empty;
  if (!content || content.length < 20) return empty;
  let contextTokens = extractQueryTokens(content);
  if (contextTokens.length < 3) return empty;
  const newScored = scanAndScoreAllSkills(contextTokens, alreadyLoaded, minScore);
  return { skills: loadTopSkills(newScored, maxNew), contextTokens };
}

function getPerplexicaUrl(): string {
  return vscode.workspace.getConfiguration('openollamagravity').get<string>('perplexicaUrl', 'http://10.1.0.138:3030');
}

/** 🌐 WEB SEARCH через Perplexica */
export async function webSearch(args: any): Promise<ToolResult> {
  let query = String(args?.query || '').trim();
  const website = args?.website || args?.domain;
  if (website) query += ` site:${website}`;
  if (!query) return { ok: false, output: 'web_search: вкажіть "query".' };

  const perplexicaUrl = getPerplexicaUrl();
  oogLogger.appendLine(`[WebSearch] "${query}"`);

  return new Promise((promiseResolve) => {
    try {
      const url      = new URL('/api/search', perplexicaUrl);
      const lib      = url.protocol === 'https:' ? https : http;
      const bodyData = JSON.stringify({ query, focusMode: 'webSearch' });

      const req = lib.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyData),
        },
      }, (res: any) => {
        let buf = '';
        res.on('data', (d: Buffer) => { buf += d.toString(); });
        res.on('end', () => {
          if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
            promiseResolve({ ok: false, output: `Search failed: HTTP ${res.statusCode}\n${buf.slice(0, 300)}` });
            return;
          }
          try {
            const data = JSON.parse(buf) as any;
            if (!data.message && (!data.sources || data.sources.length === 0)) {
              promiseResolve({ ok: true, output: 'No results found.' });
              return;
            }
            let output = `Search Results for "${query}":\n\n`;
            output += `Summary: ${data.message || data.text || 'No summary available'}\n\n`;
            if (data.sources && data.sources.length > 0) {
              output += 'Sources:\n';
              data.sources.slice(0, 5).forEach((s: any, i: number) => {
                const title   = s.metadata?.title || s.title || 'Без назви';
                const sUrl    = s.metadata?.url   || s.url   || '';
                const snippet = (s.pageContent || s.snippet || '').slice(0, 300).replace(/\n+/g, ' ');
                output += `[${i + 1}] ${title}\nURL: ${sUrl}\n${snippet}\n\n`;
              });
            }
            promiseResolve({ ok: true, output: output.slice(0, 4000).trim() });
          } catch (e: any) {
            promiseResolve({ ok: false, output: `Failed to parse response: ${e.message}\nRaw: ${buf.slice(0, 300)}` });
          }
        });
      });

      req.on('error', (err: Error) => {
        oogLogger.appendLine(`[WebSearch] Error: ${err.message}`);
        promiseResolve({ ok: false, output: `Perplexica connection error: ${err.message}. URL: ${perplexicaUrl}` });
      });
      req.write(bodyData);
      req.end();
    } catch (err: any) {
      promiseResolve({ ok: false, output: `Error: ${err.message}` });
    }
  });
}


async function checkPerplexica(baseUrl: string): Promise<boolean> {
  return new Promise(resolve => {
    const url = new URL('/api/config', baseUrl);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get({ hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 3030), path: url.pathname, timeout: 3000 }, (res: any) => { resolve(res.statusCode < 500); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function httpPost(urlStr: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({ hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 3030), path: url.pathname + (url.search || ''), method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 30_000 }, (res: any) => {
      let data = ''; res.on('data', (c: Buffer) => { data += c.toString(); }); res.on('end', () => resolve(data));
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('Perplexica timeout')); });
    req.write(body); req.end();
  });
}

function resolvePath(p: string): string {
  if (!p) throw new Error('Path is required but received undefined.');
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  return path.isAbsolute(p) ? p : path.join(root, p);
}

const READ_FILE_MAX_BYTES = 100 * 1024;

export async function readFile(args: any): Promise<ToolResult> {
  try {
    const abs = resolvePath(args.path);
    const stat = fs.statSync(abs);
    if (stat.size > READ_FILE_MAX_BYTES) {
      const fd = fs.openSync(abs, 'r'); const buf = Buffer.alloc(READ_FILE_MAX_BYTES); const n = fs.readSync(fd, buf, 0, READ_FILE_MAX_BYTES, 0); fs.closeSync(fd);
      const preview = buf.subarray(0, n).toString('utf8');
      return { ok: true, output: preview + `\n\n[FILE TRUNCATED — file is ${Math.round(stat.size / 1024)}KB, showing first 100KB. Use specific line ranges if you need more.]` };
    }
    return { ok: true, output: fs.readFileSync(abs, 'utf8') };
  } catch (e: any) { return { ok: false, output: e.message }; }
}

export async function writeFile(args: any, onConfirm: (p: string) => Promise<boolean>): Promise<ToolResult> {
  try {
    if (!args.path) return { ok: false, output: 'Помилка: вкажіть "path".' };
    const abs = resolvePath(args.path);
    if (!await onConfirm(args.path)) return { ok: false, output: 'Rejected.' };
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, args.content || '', 'utf8');
    return { ok: true, output: `Saved: ${args.path}` };
  } catch (e: any) { return { ok: false, output: e.message }; }
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '__pycache__', '.venv', 'venv', '.next', '.nuxt', 'coverage']);

export async function listFiles(args: any): Promise<ToolResult> {
  try {
    const base = resolvePath(args.path || '.');
    if (!fs.existsSync(base)) return { ok: false, output: 'Path not found.' };
    const depth = Math.min(Number(args.depth) || 1, 4);
    function walk(dir: string, d: number): string[] {
      if (d > depth) return [];
      const pad = '  '.repeat(d - 1); const out: string[] = []; let entries: string[];
      try { entries = fs.readdirSync(dir); } catch { return []; }
      for (const e of entries.slice(0, 150)) {
        if (e.startsWith('.') && e !== '.env' && e !== '.gitignore') continue;
        const full = path.join(dir, e);
        try {
          const isDir = fs.statSync(full).isDirectory();
          if (isDir && SKIP_DIRS.has(e)) { out.push(`${pad}📁 ${e}/ [skipped — heavy directory]`); continue; }
          out.push(`${pad}${isDir ? '📁' : '📄'} ${e}${isDir ? '/' : ''}`);
          if (isDir && d < depth) out.push(...walk(full, d + 1));
        } catch {}
      }
      return out;
    }
    return { ok: true, output: walk(base, 1).join('\n') || '(empty)' };
  } catch (e: any) { return { ok: false, output: e.message }; }
}

export async function runTerminal(args: any, onConfirm: (c: string) => Promise<boolean>): Promise<ToolResult> {
  try {
    if (!args.command) return { ok: false, output: 'No command.' };
    if (!await onConfirm(args.command)) return { ok: false, output: 'Rejected.' };
    const cwd = args.cwd ? resolvePath(args.cwd) : (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '');
    return new Promise((resolve) => {
      cp.exec(args.command, { cwd, timeout: 60_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        const out = (stdout || '') + (stderr ? `\n[stderr]:\n${stderr}` : '');
        resolve({ ok: !err, output: out || (err ? err.message : '(no output)') });
      });
    });
  } catch (e: any) { return { ok: false, output: e.message }; }
}

export async function createDirectory(args: any): Promise<ToolResult> {
  try {
    if (!args.path) return { ok: false, output: 'Помилка: вкажіть "path".' };
    fs.mkdirSync(resolvePath(args.path), { recursive: true });
    return { ok: true, output: `Created directory: ${args.path}` };
  } catch (e: any) { return { ok: false, output: e.message }; }
}

export async function deleteFile(args: any, onConfirm: (p: string) => Promise<boolean>): Promise<ToolResult> {
  try {
    if (!args.path) return { ok: false, output: 'Помилка: вкажіть "path".' };
    const abs = resolvePath(args.path);
    if (!fs.existsSync(abs)) return { ok: false, output: 'File not found.' };
    if (!await onConfirm(args.path)) return { ok: false, output: 'Rejected.' };
    fs.unlinkSync(abs);
    return { ok: true, output: `Deleted: ${args.path}` };
  } catch (e: any) { return { ok: false, output: e.message }; }
}

export async function editFile(args: any, onConfirm: (p: string, diff: string) => Promise<boolean>): Promise<ToolResult> {
  try {
    if (!args.path || args.start_line === undefined || args.end_line === undefined || args.new_content === undefined) return { ok: false, output: 'Missing arguments.' };
    const abs = resolvePath(args.path);
    if (!fs.existsSync(abs)) return { ok: false, output: 'File not found.' };
    const content = fs.readFileSync(abs, 'utf8'); const lines = content.split('\n');
    const start = Math.max(1, Number(args.start_line)) - 1; const end = Math.min(lines.length, Number(args.end_line));
    const diff = `--- OLD\n+++ NEW\n-${lines.slice(start, end).join('\n')}\n+${args.new_content}`;
    if (!await onConfirm(args.path, diff)) return { ok: false, output: 'Rejected.' };
    lines.splice(start, end - start, args.new_content);
    fs.writeFileSync(abs, lines.join('\n'), 'utf8');
    return { ok: true, output: `Edited ${args.path} lines ${start + 1}-${end}` };
  } catch (e: any) { return { ok: false, output: e.message }; }
}

/** ⚡ ОНОВЛЕНИЙ ШВИДКИЙ ПОШУК — Не блокує редактор, використовує Native API */
export async function searchFiles(args: any): Promise<ToolResult> {
  try {
    if (!args.pattern) return { ok: false, output: 'Missing pattern.' };

    const rootFolder = vscode.workspace.workspaceFolders?.[0];
    if (!rootFolder) return { ok: false, output: 'No workspace opened.' };

    const searchBase = args.path ? resolvePath(args.path) : rootFolder.uri.fsPath;
    const searchBaseUri = vscode.Uri.file(searchBase);

    const fileExt = args.file_pattern ? args.file_pattern.replace(/\*/g, '') : '';
    const pattern = fileExt ? `**/*${fileExt}` : '**/*';

    const relativePattern = new vscode.RelativePattern(searchBaseUri, pattern);
    const files = await vscode.workspace.findFiles(relativePattern, '**/node_modules/**', 500);

    const regex = new RegExp(args.pattern, 'i');
    const results: string[] = [];
    const rootFsPath = rootFolder.uri.fsPath;

    for (const uri of files) {
      if (results.length >= 50) break;

      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > 2 * 1024 * 1024) continue; // Ігноруємо файли > 2МБ

      const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          const rel = path.relative(rootFsPath, uri.fsPath);
          results.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
          if (results.length >= 50) break;
        }
      }
    }

    const msg = results.length >= 50 ? '\n[Truncated to 50 results]' : '';
    return { ok: true, output: results.join('\n') + msg || 'No matches found.' };
  } catch (e: any) { return { ok: false, output: e.message }; }
}

export async function getDiagnostics(args: any): Promise<ToolResult> {
  try {
    const filterPath = args.path ? resolvePath(args.path) : undefined;
    const diags = vscode.languages.getDiagnostics();
    const result: string[] = [];
    for (const [uri, fileDiags] of diags) {
      if (fileDiags.length === 0 || (filterPath && uri.fsPath !== filterPath)) continue;
      const relPath = path.relative(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', uri.fsPath);
      result.push(`=== ${relPath} ===`);
      for (const d of fileDiags) {
        const severity = d.severity === vscode.DiagnosticSeverity.Error ? 'ERROR' : d.severity === vscode.DiagnosticSeverity.Warning ? 'WARN' : 'INFO';
        result.push(`[${severity}] Line ${d.range.start.line + 1}: ${d.message} (${d.source || 'uknown'})`);
      }
    }
    return { ok: true, output: result.length > 0 ? result.join('\n') : 'No diagnostics found.' };
  } catch (e: any) { return { ok: false, output: e.message }; }
}

export async function getFileOutline(args: any): Promise<ToolResult> {
  try {
    if (!args.path) return { ok: false, output: 'Missing path.' };
    const uri = vscode.Uri.file(resolvePath(args.path));
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', uri);
    if (!symbols || symbols.length === 0) return { ok: true, output: 'No Document Symbols found.' };
    const lines: string[] = [];
    function printSymbols(syms: vscode.DocumentSymbol[], indent: string) {
      for (const s of syms) {
        lines.push(`${indent}[${vscode.SymbolKind[s.kind] || 'Unknown'}] ${s.name} (Lines ${s.range.start.line + 1}-${s.range.end.line + 1})`);
        if (s.children && s.children.length > 0) printSymbols(s.children, indent + '  ');
      }
    }
    printSymbols(symbols, '');
    return { ok: true, output: lines.join('\n') };
  } catch (e: any) { return { ok: false, output: e.message }; }
}

export async function getWorkspaceInfo(args?: { path?: string }): Promise<ToolResult> {
  try {
    const root = args?.path ? path.resolve(args.path) : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return { ok: false, output: 'No workspace opened.' };
    const pkgPath = path.join(root, 'package.json');
    let out = `Resolved path: ${root}\n`;
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        out += `Project: ${pkg.name || 'Unknown'}\nScripts: ${Object.keys(pkg.scripts || {}).join(', ')}\n`;
        const deps = Object.keys(pkg.dependencies || {}); const devDeps = Object.keys(pkg.devDependencies || {});
        out += `Deps: ${deps.slice(0, 15).join(', ')}${deps.length > 15 ? '...' : ''}\nDevDeps: ${devDeps.slice(0, 15).join(', ')}${devDeps.length > 15 ? '...' : ''}\n`;
      } catch (e: any) { out += `[Warning] parse failed: ${e.message}\n`; }
    } else out += `[Warning] No package.json found.\n`;
    return { ok: true, output: out + `\nTo see directory structure, use list_files.` };
  } catch (e: any) { return { ok: false, output: e.message }; }
}

export async function listSkills(): Promise<ToolResult> {
  const sp = getSkillsPath();
  if (!sp || !fs.existsSync(sp)) return { ok: false, output: 'Skills path not found.' };
  const files = scanSkillFolders(sp);
  if (files.length === 0) return { ok: false, output: 'No SKILL.md files found.' };
  const entries: string[] = [];
  for (const file of files) {
    const folderName = path.relative(sp, path.dirname(file)).replace(/\\/g, '/');
    const yaml = readFrontmatter(file);
    entries.push(`---\n${yaml ? `${yaml}\nskill_path: ${folderName}` : `name: ${folderName}\nskill_path: ${folderName}`}\n---`);
  }
  return { ok: true, output: `# SKILLS INDEX\n# Load full skill: read_skill {"name": "<skill_path>"}\n\n${entries.join('\n\n')}` };
}

export async function readSkill(args: any): Promise<ToolResult> {
  if (!args.name) return { ok: false, output: 'Вкажіть "name".' };
  const sp = getSkillsPath();
  if (!sp) return { ok: false, output: 'Skills path not configured.' };
  const directPath = path.join(sp, args.name, 'SKILL.md');
  if (fs.existsSync(directPath)) {
    try { return { ok: true, output: fs.readFileSync(directPath, 'utf8') }; } catch (e: any) { return { ok: false, output: e.message }; }
  }
  const files = scanSkillFolders(sp);
  const needle = String(args.name).toLowerCase().replace(/\\/g, '/');
  const match = files.find(f => {
    const rel = path.relative(sp, path.dirname(f)).replace(/\\/g, '/').toLowerCase();
    return rel === needle || rel.includes(needle) || path.basename(rel).includes(needle);
  });
  if (!match) return { ok: false, output: `Skill "${args.name}" not found.` };
  try { return { ok: true, output: fs.readFileSync(match, 'utf8') }; } catch (e: any) { return { ok: false, output: e.message }; }
}