"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.managePlan = managePlan;
exports.getAllSkills = getAllSkills;
exports.getSkillsPath = getSkillsPath;
exports.scanAndScoreAllSkillsIdf = scanAndScoreAllSkillsIdf;
exports.loadTopSkills = loadTopSkills;
exports.autoLoadSkillsForTask = autoLoadSkillsForTask;
exports.discoverSkillsFromContext = discoverSkillsFromContext;
exports.saveSkill = saveSkill;
exports.webSearch = webSearch;
exports.readFile = readFile;
exports.writeFile = writeFile;
exports.listFiles = listFiles;
exports.runTerminal = runTerminal;
exports.createDirectory = createDirectory;
exports.deleteFile = deleteFile;
exports.editFile = editFile;
exports.searchFiles = searchFiles;
exports.getDiagnostics = getDiagnostics;
exports.getFileOutline = getFileOutline;
exports.getWorkspaceInfo = getWorkspaceInfo;
exports.listSkills = listSkills;
exports.readSkill = readSkill;
// Copyright (c) 2026 Юрій Кучеренко.
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const cp = __importStar(require("child_process"));
const client_1 = require("../ollama/client");
const http = __importStar(require("http"));
const https = __importStar(require("https"));
let currentPlan = [];
let _planIdCounter = 0;
function managePlan(args) {
    const { action, task, id } = args;
    if (action === 'clear') {
        currentPlan = [];
        _planIdCounter = 0;
        return { ok: true, output: 'Plan cleared.' };
    }
    if (action === 'create' && task) {
        _planIdCounter++;
        currentPlan.push({ id: _planIdCounter, task, status: 'open' });
        return { ok: true, output: `Task added.\n${formatPlan()}` };
    }
    if (action === 'complete' && id !== undefined) {
        const t = currentPlan.find(p => p.id === Number(id));
        if (t) {
            t.status = 'done';
            return { ok: true, output: `Task ${id} completed.\n${formatPlan()}` };
        }
        return { ok: false, output: `Task ID ${id} not found.` };
    }
    if (action === 'view') {
        return { ok: true, output: formatPlan() };
    }
    return { ok: false, output: 'Invalid action. Use create, complete, view, or clear.' };
}
function formatPlan() {
    if (currentPlan.length === 0)
        return 'The plan is empty. Use "create" to add tasks.';
    return 'CURRENT PLAN:\n' + currentPlan.map(p => `[${p.status === 'done' ? 'X' : ' '}] ${p.id}. ${p.task}`).join('\n');
}
// -----------------------------------------
async function getAllSkills() {
    const skillsPath = getSkillsPath();
    if (!skillsPath || !fs.existsSync(skillsPath))
        return [];
    const files = scanSkillFolders(skillsPath);
    const result = [];
    for (const filePath of files) {
        const folderName = path.relative(skillsPath, path.dirname(filePath)).replace(/\\/g, '/');
        const yaml = readFrontmatter(filePath);
        if (yaml) {
            const p = parseYaml(yaml);
            result.push({
                filePath, folderName,
                name: String(p['name'] || folderName),
                description: String(p['description'] || ''),
                domain: String(p['domain'] || ''),
                subdomain: String(p['subdomain'] || ''),
                tags: Array.isArray(p['tags']) ? p['tags'] : [],
                score: 0,
            });
        }
        else {
            result.push({
                filePath, folderName,
                name: folderName, description: '', domain: '', subdomain: '',
                tags: [], score: 0
            });
        }
    }
    return result;
}
function getSkillsPath() {
    return vscode.workspace.getConfiguration('openollamagravity').get('skillsPath', '');
}
const _skillsCache = new Map();
const SKILLS_CACHE_TTL = 30000;
function scanSkillFolders(skillsPath) {
    const cached = _skillsCache.get(skillsPath);
    if (cached && (Date.now() - cached.ts) < SKILLS_CACHE_TTL) {
        return cached.files;
    }
    const skillMd = [];
    const legacyMd = [];
    function walk(dir) {
        let entries;
        try {
            entries = fs.readdirSync(dir);
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (entry.startsWith('.'))
                continue;
            const full = path.join(dir, entry);
            try {
                const stat = fs.statSync(full);
                if (stat.isDirectory()) {
                    walk(full);
                }
                else if (entry === 'SKILL.md') {
                    skillMd.push(full);
                }
                else if (entry.endsWith('.md')) {
                    legacyMd.push(full);
                }
            }
            catch { }
        }
    }
    walk(skillsPath);
    const files = skillMd.length > 0 ? skillMd : legacyMd;
    _skillsCache.set(skillsPath, { files, ts: Date.now() });
    return files;
}
function readFrontmatter(filePath) {
    try {
        const fd = fs.openSync(filePath, 'r');
        const buf = Buffer.alloc(2048);
        const n = fs.readSync(fd, buf, 0, 2048, 0);
        fs.closeSync(fd);
        const text = buf.subarray(0, n).toString('utf8');
        if (!text.startsWith('---'))
            return null;
        const end = text.indexOf('\n---', 3);
        return end === -1 ? null : text.slice(4, end).trim();
    }
    catch {
        return null;
    }
}
function parseYaml(yaml) {
    const out = {};
    for (const line of yaml.split('\n')) {
        const m = line.match(/^([\w-]+):\s*(.+)$/);
        if (!m)
            continue;
        const [, key, raw] = m;
        const v = raw.trim();
        if (v.startsWith('[') && v.endsWith(']')) {
            out[key] = v.slice(1, -1)
                .split(',')
                .map(s => s.trim().replace(/^['"]|['"]$/g, '').toLowerCase())
                .filter(Boolean);
        }
        else {
            out[key] = v.replace(/^['"]|['"]$/g, '');
        }
    }
    return out;
}
const STOP = new Set([
    'the', 'a', 'an', 'in', 'on', 'at', 'to', 'of', 'and', 'or', 'for', 'is', 'it', 'be',
    'use', 'using', 'get', 'set', 'run', 'make', 'how', 'do', 'with',
    'що', 'як', 'для', 'та', 'і', 'або', 'з', 'у', 'в', 'це', 'на', 'до', 'по', 'при',
    'цей', 'цього', 'цьому', 'цим', 'ця', 'цієї', 'цю', 'цієї',
    'який', 'яка', 'яке', 'які', 'якого', 'якій', 'яким',
    'мені', 'мене', 'мій', 'моя', 'моє', 'мої', 'мого',
]);
const UA_EN = {
    'поясни': ['explain', 'describe', 'overview'],
    'поясніть': ['explain', 'describe'],
    'опиши': ['describe', 'overview', 'explain'],
    'опишіть': ['describe', 'overview'],
    'проаналізуй': ['analyze', 'analysis', 'review'],
    'перевір': ['check', 'verify', 'validate', 'review'],
    'виправ': ['fix', 'debug', 'repair'],
    'налагодь': ['debug', 'troubleshoot'],
    'оптимізуй': ['optimize', 'performance', 'refactor'],
    'рефактор': ['refactor', 'clean', 'restructure'],
    'задокументуй': ['document', 'documentation', 'docs'],
    'документацію': ['documentation', 'docs', 'readme'],
    'напиши': ['write', 'create', 'implement'],
    'створи': ['create', 'build', 'implement'],
    'додай': ['add', 'implement', 'create'],
    'видали': ['delete', 'remove'],
    'встанови': ['install', 'setup', 'configure'],
    'налаштуй': ['configure', 'setup', 'settings'],
    'запусти': ['run', 'execute', 'start'],
    'розгорни': ['deploy', 'deployment'],
    'протестуй': ['test', 'testing'],
    'відлагодь': ['debug', 'troubleshoot'],
    'структуру': ['structure', 'architecture', 'overview', 'project'],
    'структура': ['structure', 'architecture', 'project'],
    'архітектуру': ['architecture', 'structure', 'design'],
    'архітектура': ['architecture', 'design'],
    'проєкту': ['project', 'codebase', 'repository'],
    'проект': ['project', 'codebase'],
    'проекту': ['project', 'codebase', 'repository'],
    'код': ['code', 'source'],
    'кодову': ['codebase', 'code'],
    'базу': ['database', 'base'],
    'бази': ['database'],
    'сервер': ['server', 'backend'],
    'сервера': ['server', 'backend'],
    'бекенд': ['backend', 'server', 'api'],
    'фронтенд': ['frontend', 'client', 'ui'],
    'апі': ['api', 'rest', 'endpoint'],
    'ендпоінти': ['endpoint', 'api', 'routes'],
    'маршрути': ['routes', 'routing', 'endpoint'],
    'модулі': ['modules', 'components'],
    'компоненти': ['components', 'modules'],
    'безпека': ['security', 'auth', 'authentication'],
    'авторизація': ['authorization', 'auth', 'access'],
    'автентифікація': ['authentication', 'auth', 'login'],
    'тести': ['tests', 'testing', 'unit-test'],
    'логи': ['logs', 'logging', 'monitoring'],
    'деплой': ['deploy', 'deployment', 'ci-cd'],
    'конфігурація': ['configuration', 'config', 'settings'],
    'залежності': ['dependencies', 'packages', 'requirements'],
    'помилки': ['errors', 'exceptions', 'debugging'],
    'помилка': ['error', 'bug', 'exception'],
};
function expandWithTranslations(tokens) {
    const expanded = new Set(tokens);
    for (const token of tokens) {
        const translations = UA_EN[token];
        if (translations) {
            translations.forEach(t => expanded.add(t));
        }
    }
    return Array.from(expanded);
}
function tokenize(text) {
    return text
        .toLowerCase()
        .replace(/[-_]/g, ' ')
        .split(/[\s,;:.!?()\[\]{}<>|"'`]+/)
        .filter(w => w.length > 2 && !STOP.has(w));
}
let _idfCache = null;
let _idfSkillsPath = '';
function buildIdfCache(skillsPath) {
    if (_idfCache && _idfSkillsPath === skillsPath)
        return _idfCache;
    const files = scanSkillFolders(skillsPath);
    if (files.length === 0)
        return new Map();
    const docFreq = new Map();
    for (const filePath of files) {
        const yaml = readFrontmatter(filePath);
        if (!yaml)
            continue;
        const p = parseYaml(yaml);
        const words = new Set([
            ...tokenize(String(p['name'] || '')),
            ...tokenize(String(p['description'] || '')),
            ...tokenize(String(p['domain'] || '')),
            ...(Array.isArray(p['tags']) ? p['tags'].flatMap((t) => tokenize(t)) : []),
        ]);
        words.forEach(w => docFreq.set(w, (docFreq.get(w) ?? 0) + 1));
    }
    const N = files.length;
    const cache = new Map();
    docFreq.forEach((df, token) => {
        const ratio = df / N;
        if (ratio > 0.5)
            cache.set(token, 0.1);
        else if (ratio > 0.3)
            cache.set(token, 0.3);
        else if (ratio > 0.1)
            cache.set(token, 0.6);
        else
            cache.set(token, 1.0);
    });
    _idfCache = cache;
    _idfSkillsPath = skillsPath;
    client_1.oogLogger.appendLine(`[Skills] IDF побудовано: ${N} скілів, ${cache.size} унікальних токенів`);
    return cache;
}
function idfWeight(token, idf) {
    return idf.get(token) ?? 1.0;
}
function splitTaskAndContext(combined) {
    const lines = combined.split('\n');
    const ctxMarkers = ['Key deps:', 'key deps:', 'Project:', 'Scripts:', 'Active file:',
        'Selected code:', 'WORKSPACE', 'deps:', 'dependencies:'];
    let ctxStart = lines.length;
    for (let i = 0; i < lines.length; i++) {
        if (ctxMarkers.some(m => lines[i].startsWith(m))) {
            ctxStart = i;
            break;
        }
    }
    const taskText = lines.slice(0, ctxStart).join('\n');
    const contextText = lines.slice(ctxStart).join('\n');
    const taskRaw = extractQueryTokens(taskText);
    const contextRaw = extractQueryTokens(contextText);
    const taskExpanded = expandWithTranslations(taskRaw);
    const contextUnique = contextRaw.filter(t => !taskExpanded.includes(t));
    return { taskTokens: taskExpanded, contextTokens: contextUnique };
}
function scoreSkillIdf(meta, taskTokens, contextTokens, idf) {
    const nameT = tokenize(meta.name + ' ' + meta.folderName);
    const descT = tokenize(meta.description);
    const domainT = tokenize(meta.domain + ' ' + meta.subdomain);
    function baseScore(tw) {
        if (meta.tags.some(t => t === tw || t.includes(tw) || tw.includes(t)))
            return 3;
        if (descT.some(d => d === tw || d.includes(tw) || tw.includes(d)))
            return 2;
        if (nameT.some(n => n === tw || n.includes(tw) || tw.includes(n)))
            return 1;
        if (domainT.some(d => d.length > 2 && (d.includes(tw) || tw.includes(d))))
            return 1;
        return 0;
    }
    let score = 0;
    for (const tw of taskTokens) {
        const base = baseScore(tw);
        if (base > 0)
            score += base * idfWeight(tw, idf);
    }
    for (const tw of contextTokens) {
        const base = baseScore(tw);
        if (base > 0)
            score += base * idfWeight(tw, idf) * 0.4;
    }
    return score;
}
function scoreSkill(meta, taskTokens) {
    if (taskTokens.length === 0)
        return 0;
    const queryTokens = expandWithTranslations(taskTokens);
    const nameT = tokenize(meta.name + ' ' + meta.folderName);
    const descT = tokenize(meta.description);
    const domainT = tokenize(meta.domain + ' ' + meta.subdomain);
    let score = 0;
    for (const tw of queryTokens) {
        if (meta.tags.some(t => t === tw || t.includes(tw) || tw.includes(t)))
            score += 3;
        else if (descT.some(d => d === tw || d.includes(tw) || tw.includes(d)))
            score += 2;
        else if (nameT.some(n => n === tw || n.includes(tw) || tw.includes(n)))
            score += 1;
        else if (domainT.some(d => d.length > 2 && (d.includes(tw) || tw.includes(d))))
            score += 1;
    }
    return score;
}
function extractQueryTokens(text) {
    const cleaned = text
        .slice(0, 4096)
        .replace(/[A-Za-z]:\\[\w\\.\ \-]*/g, ' ')
        .replace(/\/[\w\/.\-]+/g, ' ')
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/\b\d{2,}\b/g, ' ')
        .replace(/[^\w\s]/g, ' ');
    return [...new Set(tokenize(cleaned))];
}
function scanAndScoreAllSkillsIdf(combined, alreadyLoaded = new Set(), minScore = 4) {
    const skillsPath = getSkillsPath();
    if (!skillsPath || !fs.existsSync(skillsPath))
        return [];
    const files = scanSkillFolders(skillsPath);
    if (files.length === 0)
        return [];
    const idf = buildIdfCache(skillsPath);
    const { taskTokens, contextTokens } = splitTaskAndContext(combined);
    if (taskTokens.length === 0 && contextTokens.length === 0)
        return [];
    client_1.oogLogger.appendLine(`[Skills] Task tokens: [${taskTokens.slice(0, 10).join(', ')}]` +
        (contextTokens.length > 0 ? `  Context tokens: [${contextTokens.slice(0, 8).join(', ')}]` : ''));
    const scored = [];
    for (const filePath of files) {
        const folderName = path.relative(skillsPath, path.dirname(filePath)).replace(/\\/g, '/');
        if (alreadyLoaded.has(folderName))
            continue;
        const yaml = readFrontmatter(filePath);
        let meta;
        if (yaml) {
            const p = parseYaml(yaml);
            meta = {
                filePath, folderName,
                name: String(p['name'] || folderName),
                description: String(p['description'] || ''),
                domain: String(p['domain'] || ''),
                subdomain: String(p['subdomain'] || ''),
                tags: Array.isArray(p['tags']) ? p['tags'] : tokenize(folderName),
                score: 0,
            };
        }
        else {
            meta = {
                filePath, folderName,
                name: folderName, description: '', domain: '', subdomain: '',
                tags: tokenize(folderName), score: 0,
            };
        }
        meta.score = scoreSkillIdf(meta, taskTokens, contextTokens, idf);
        if (meta.score >= minScore)
            scored.push(meta);
    }
    scored.sort((a, b) => b.score - a.score);
    return scored;
}
function scanAndScoreAllSkills(queryTokens, alreadyLoaded = new Set(), minScore = 1) {
    const skillsPath = getSkillsPath();
    if (!skillsPath || !fs.existsSync(skillsPath))
        return [];
    const files = scanSkillFolders(skillsPath);
    const scored = [];
    for (const filePath of files) {
        const folderName = path.relative(skillsPath, path.dirname(filePath)).replace(/\\/g, '/');
        if (alreadyLoaded.has(folderName))
            continue;
        const yaml = readFrontmatter(filePath);
        let meta;
        if (yaml) {
            const p = parseYaml(yaml);
            meta = {
                filePath, folderName,
                name: String(p['name'] || folderName),
                description: String(p['description'] || ''),
                domain: String(p['domain'] || ''),
                subdomain: String(p['subdomain'] || ''),
                tags: Array.isArray(p['tags']) ? p['tags'] : tokenize(folderName),
                score: 0,
            };
        }
        else {
            meta = {
                filePath, folderName,
                name: folderName, description: '', domain: '', subdomain: '',
                tags: tokenize(folderName), score: 0,
            };
        }
        meta.score = scoreSkill(meta, queryTokens);
        if (meta.score >= minScore)
            scored.push(meta);
    }
    scored.sort((a, b) => b.score - a.score);
    return scored;
}
function loadTopSkills(scored, maxSkills) {
    const loaded = [];
    for (const meta of scored.slice(0, maxSkills)) {
        try {
            const content = fs.readFileSync(meta.filePath, 'utf8');
            loaded.push({ ...meta, content });
            client_1.oogLogger.appendLine(`[Skills] ✅ "${meta.name}"  folder=${meta.folderName}  score=${meta.score.toFixed(2)}`);
        }
        catch (e) {
            client_1.oogLogger.appendLine(`[Skills] ⚠️  ${meta.folderName}: ${e.message}`);
        }
    }
    return loaded;
}
async function autoLoadSkillsForTask(task, workspaceContext = '', maxSkills = 3) {
    const combined = [task, workspaceContext].filter(Boolean).join('\n');
    if (!combined.trim())
        return [];
    const allScored = scanAndScoreAllSkillsIdf(combined, new Set(), 4);
    if (allScored.length === 0) {
        client_1.oogLogger.appendLine('[Skills] minScore=4 нічого не дав → fallback minScore=2');
        const fallback = scanAndScoreAllSkillsIdf(combined, new Set(), 2);
        return loadTopSkills(fallback, maxSkills);
    }
    return loadTopSkills(allScored, maxSkills);
}
async function discoverSkillsFromContext(toolName, content, alreadyLoaded, maxNew = 2, minScore = 3) {
    const empty = { skills: [], contextTokens: [] };
    const validTools = ['read_file', 'list_files', 'run_terminal', 'search_files', 'get_diagnostics', 'get_file_outline'];
    if (!validTools.includes(toolName))
        return empty;
    if (!content || content.length < 20)
        return empty;
    let contextTokens = extractQueryTokens(content);
    if (contextTokens.length < 3)
        return empty;
    client_1.oogLogger.appendLine(`[Skills] Контекст з ${toolName}: tokens=[${contextTokens.slice(0, 10).join(', ')}]`);
    const newScored = scanAndScoreAllSkills(contextTokens, alreadyLoaded, minScore);
    return { skills: loadTopSkills(newScored, maxNew), contextTokens };
}
// --- DEEP AGENTS: Auto-Skill Generation (Reflection) ---
async function saveSkill(args, onConfirm) {
    try {
        const { name, description, content } = args;
        if (!name || !content)
            return { ok: false, output: 'Missing "name" or "content".' };
        const sp = getSkillsPath();
        if (!sp || !fs.existsSync(sp))
            return { ok: false, output: 'Skills path not configured or not found.' };
        const folderName = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
        const skillDir = path.join(sp, folderName);
        const fileContent = `---\nname: ${name}\ndescription: ${description || ''}\ntags: [auto-generated]\n---\n\n${content}`;
        if (!await onConfirm(name, fileContent)) {
            return { ok: false, output: 'User rejected saving the skill.' };
        }
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(path.join(skillDir, 'SKILL.md'), fileContent, 'utf8');
        return { ok: true, output: `Skill "${name}" saved successfully to ${folderName}/SKILL.md in the knowledge base!` };
    }
    catch (e) {
        return { ok: false, output: `Failed to save skill: ${e.message}` };
    }
}
// -------------------------------------------------------
function getPerplexicaUrl() {
    return vscode.workspace
        .getConfiguration('openollamagravity')
        .get('perplexicaUrl', 'http://localhost:3030');
}
let _providersCache = null;
let _providersCacheTs = 0;
const PROVIDERS_TTL_MS = 5 * 60 * 1000; // 5 хвилин
function httpGet(url) {
    return new Promise((resolve, reject) => {
        const lib = url.protocol === 'https:' ? https : http;
        const req = lib.get({ hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80), path: url.pathname + url.search, timeout: 5000 }, (res) => {
            let d = '';
            res.on('data', (c) => { d += c.toString(); });
            res.on('end', () => resolve(d));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}
async function fetchPerplexicaProviders(baseUrl) {
    const now = Date.now();
    if (_providersCache && (now - _providersCacheTs) < PROVIDERS_TTL_MS) {
        return _providersCache;
    }
    try {
        const raw = await httpGet(new URL('/api/providers', baseUrl));
        const json = JSON.parse(raw);
        // Підтримка обох форматів: { providers: [...] } або [...] напряму
        const list = Array.isArray(json) ? json : (json.providers || []);
        _providersCache = list;
        _providersCacheTs = now;
        client_1.oogLogger.appendLine(`[WebSearch] Providers fetched: ${list.map((p) => p.name).join(', ')}`);
        return list;
    }
    catch (e) {
        client_1.oogLogger.appendLine(`[WebSearch] Could not fetch providers: ${e.message}`);
        return [];
    }
}
/**
 * Будує об'єкти chatModel і embeddingModel для Perplexica ≥ 1.8.
 *
 * Перевага порядку:
 *   1. UUID-формат  { providerId, key }  — якщо провайдер має UUID (рядок з дефісами).
 *   2. Name-формат  { provider, name }   — для старих версій або якщо UUID відсутній.
 *
 * Налаштування (openollamagravity):
 *   perplexicaChatProvider       — назва провайдера (case-insensitive), default "ollama"
 *   perplexicaChatModel          — ключ моделі,  default — поточна модель Ollama
 *   perplexicaEmbeddingProvider  — default "ollama"
 *   perplexicaEmbeddingModel     — default "nomic-embed-text"
 */
async function buildModelFields(baseUrl) {
    const cfg = vscode.workspace.getConfiguration('openollamagravity');
    const chatProviderName = cfg.get('perplexicaChatProvider', 'ollama').toLowerCase();
    const chatModelKey = cfg.get('perplexicaChatModel', cfg.get('model', 'llama3.1:latest'));
    const embedProviderName = cfg.get('perplexicaEmbeddingProvider', 'ollama').toLowerCase();
    const embedModelKey = cfg.get('perplexicaEmbeddingModel', 'nomic-embed-text');
    const providers = await fetchPerplexicaProviders(baseUrl);
    function findProvider(name) {
        return providers.find(p => p.name.toLowerCase() === name || p.id?.toLowerCase() === name);
    }
    function isUuid(s) {
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
    }
    function makeModelObj(providerName, modelKey, field) {
        const p = findProvider(providerName);
        if (p && isUuid(p.id)) {
            // v1.8+ UUID format — офіційно задокументовано
            const modelEntry = p[field]?.find((m) => m.key === modelKey || m.name === modelKey);
            return { providerId: p.id, key: modelEntry?.key ?? modelKey };
        }
        // Fallback: name-based format (pre-UUID versions або якщо /api/providers недоступний)
        return { provider: providerName, name: modelKey };
    }
    return {
        chatModel: makeModelObj(chatProviderName, chatModelKey, 'chatModels'),
        embeddingModel: makeModelObj(embedProviderName, embedModelKey, 'embeddingModels'),
    };
}
// ── WEB SEARCH ────────────────────────────────────────────────────────────────
/** 🌐 WEB SEARCH через Perplexica 1.12.1+ */
async function webSearch(args) {
    let query = String(args?.query || '').trim();
    // Очищення запиту від спецсимволів
    query = query.replace(/[@#$]/g, ' ');
    let website = args?.website || args?.domain;
    if (website) {
        website = String(website).replace(/^https?:\/\//i, '').split('/')[0];
        query += ` site:${website}`;
    }
    if (!query)
        return { ok: false, output: 'web_search: вкажіть "query".' };
    const perplexicaUrl = getPerplexicaUrl();
    client_1.oogLogger.appendLine(`[WebSearch] "${query}"`);
    // Отримуємо chatModel / embeddingModel (з кешем провайдерів)
    const { chatModel, embeddingModel } = await buildModelFields(perplexicaUrl);
    client_1.oogLogger.appendLine(`[WebSearch] chatModel=${JSON.stringify(chatModel)}  embeddingModel=${JSON.stringify(embeddingModel)}`);
    return new Promise((promiseResolve) => {
        try {
            const url = new URL('/api/search', perplexicaUrl);
            const lib = url.protocol === 'https:' ? https : http;
            // СТРОГИЙ PAYLOAD ДЛЯ PERPLEXICA 1.12.1+
            const bodyData = JSON.stringify({
                query: query,
                sources: ["web"], // focusMode повністю видалено у 1.12.x
                chatModel,
                embeddingModel,
                optimizationMode: args.optimizationMode || "speed",
                history: []
            });
            const req = lib.request(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(bodyData),
                },
                timeout: 30000, // Perplexica може відповідати повільно (LLM + web)
            }, (res) => {
                let buf = '';
                res.on('data', (d) => { buf += d.toString(); });
                res.on('end', () => {
                    client_1.oogLogger.appendLine(`[WebSearch] HTTP ${res.statusCode}, body length=${buf.length}`);
                    if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
                        client_1.oogLogger.appendLine(`[WebSearch] ERROR body: ${buf.slice(0, 500)}`);
                        promiseResolve({
                            ok: false,
                            output: `Search failed: HTTP ${res.statusCode}.\n${buf.slice(0, 400)}`,
                        });
                        return;
                    }
                    try {
                        const data = JSON.parse(buf);
                        if (!data.message && (!data.sources || data.sources.length === 0)) {
                            promiseResolve({ ok: true, output: 'No results found.' });
                            return;
                        }
                        let output = `Search Results for "${query}":\n\n`;
                        output += `Summary: ${data.message || data.text || 'No summary available'}\n\n`;
                        if (data.sources && data.sources.length > 0) {
                            output += 'Sources:\n';
                            data.sources.slice(0, 5).forEach((s, i) => {
                                const title = s.metadata?.title || s.title || 'Без назви';
                                const sUrl = s.metadata?.url || s.url || '';
                                const snippet = (s.pageContent || s.snippet || '').slice(0, 300).replace(/\n+/g, ' ');
                                output += `[${i + 1}] ${title}\nURL: ${sUrl}\n${snippet}\n\n`;
                            });
                        }
                        promiseResolve({ ok: true, output: output.slice(0, 4000).trim() });
                    }
                    catch (e) {
                        promiseResolve({ ok: false, output: `Failed to parse response: ${e.message}\nRaw: ${buf.slice(0, 300)}` });
                    }
                });
            });
            req.on('timeout', () => {
                req.destroy();
                client_1.oogLogger.appendLine('[WebSearch] Request timed out after 30s');
                promiseResolve({ ok: false, output: 'Perplexica request timed out (30s). The model may still be loading.' });
            });
            req.on('error', (err) => {
                client_1.oogLogger.appendLine(`[WebSearch] Error: ${err.message}`);
                promiseResolve({ ok: false, output: `Perplexica connection error: ${err.message}. URL: ${perplexicaUrl}` });
            });
            req.write(bodyData);
            req.end();
        }
        catch (err) {
            promiseResolve({ ok: false, output: `Error: ${err.message}` });
        }
    });
}
function resolvePath(p) {
    if (!p)
        throw new Error('Path is required but received undefined.');
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    return path.isAbsolute(p) ? p : path.join(root, p);
}
const READ_FILE_MAX_BYTES = 100 * 1024;
async function readFile(args) {
    try {
        const abs = resolvePath(args.path);
        if (!fs.existsSync(abs))
            return { ok: false, output: `File not found: ${args.path}` };
        const stat = fs.statSync(abs);
        const content = fs.readFileSync(abs, 'utf8');
        if (args.start_line !== undefined || args.end_line !== undefined) {
            const lines = content.split('\n');
            const start = Math.max(0, (args.start_line || 1) - 1);
            const end = Math.min(lines.length, args.end_line || lines.length);
            const slice = lines.slice(start, end);
            return {
                ok: true,
                output: slice.join('\n') || '[Nothing in this line range]'
            };
        }
        if (stat.size > READ_FILE_MAX_BYTES) {
            return {
                ok: true,
                output: content.slice(0, READ_FILE_MAX_BYTES) +
                    `\n\n[FILE TRUNCATED — file is ${Math.round(stat.size / 1024)}KB, showing first 100KB.` +
                    ` Use specific line ranges if you need more.]`,
            };
        }
        return { ok: true, output: content };
    }
    catch (e) {
        return { ok: false, output: e.message };
    }
}
async function writeFile(args, onConfirm) {
    try {
        if (!args.path)
            return { ok: false, output: 'Помилка: вкажіть "path".' };
        const abs = resolvePath(args.path);
        if (!await onConfirm(args.path))
            return { ok: false, output: 'Rejected.' };
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, args.content || '', 'utf8');
        return { ok: true, output: `Saved: ${args.path}` };
    }
    catch (e) {
        return { ok: false, output: e.message };
    }
}
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '__pycache__', '.venv', 'venv', '.next', '.nuxt', 'coverage']);
async function listFiles(args) {
    try {
        const base = resolvePath(args.path || '.');
        if (!fs.existsSync(base))
            return { ok: false, output: 'Path not found.' };
        const depth = Math.min(Number(args.depth) || 1, 4);
        function walk(dir, d) {
            if (d > depth)
                return [];
            const pad = '  '.repeat(d - 1);
            const out = [];
            let entries;
            try {
                entries = fs.readdirSync(dir);
            }
            catch {
                return [];
            }
            for (const e of entries.slice(0, 150)) {
                if (e.startsWith('.') && e !== '.env' && e !== '.gitignore')
                    continue;
                const full = path.join(dir, e);
                try {
                    const isDir = fs.statSync(full).isDirectory();
                    if (isDir && SKIP_DIRS.has(e)) {
                        out.push(`${pad}📁 ${e}/ [skipped — heavy directory]`);
                        continue;
                    }
                    out.push(`${pad}${isDir ? '📁' : '📄'} ${e}${isDir ? '/' : ''}`);
                    if (isDir && d < depth)
                        out.push(...walk(full, d + 1));
                }
                catch { }
            }
            return out;
        }
        return { ok: true, output: walk(base, 1).join('\n') || '(empty)' };
    }
    catch (e) {
        return { ok: false, output: e.message };
    }
}
async function runTerminal(args, onConfirm) {
    try {
        if (!args.command)
            return { ok: false, output: 'No command.' };
        if (!await onConfirm(args.command))
            return { ok: false, output: 'Rejected.' };
        const cwd = args.cwd
            ? resolvePath(args.cwd)
            : (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '');
        return new Promise((resolve) => {
            cp.exec(args.command, { cwd, timeout: 60000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
                if (err) {
                    const out = (stdout || '') + (stderr ? `\n[stderr]:\n${stderr}` : '');
                    resolve({ ok: false, output: out || err.message });
                }
                else {
                    const out = stdout + (stderr ? `\n[stderr]:\n${stderr}` : '');
                    resolve({ ok: true, output: out || '(no output)' });
                }
            });
        });
    }
    catch (e) {
        return { ok: false, output: e.message };
    }
}
async function createDirectory(args) {
    try {
        if (!args.path)
            return { ok: false, output: 'Помилка: вкажіть "path".' };
        fs.mkdirSync(resolvePath(args.path), { recursive: true });
        return { ok: true, output: `Created directory: ${args.path}` };
    }
    catch (e) {
        return { ok: false, output: e.message };
    }
}
async function deleteFile(args, onConfirm) {
    try {
        if (!args.path)
            return { ok: false, output: 'Помилка: вкажіть "path".' };
        const abs = resolvePath(args.path);
        if (!fs.existsSync(abs))
            return { ok: false, output: 'File not found.' };
        if (!await onConfirm(args.path))
            return { ok: false, output: 'Rejected.' };
        fs.unlinkSync(abs);
        return { ok: true, output: `Deleted: ${args.path}` };
    }
    catch (e) {
        return { ok: false, output: e.message };
    }
}
async function editFile(args, onConfirm) {
    try {
        if (!args.path || args.start_line === undefined || args.end_line === undefined || args.new_content === undefined) {
            return { ok: false, output: 'Missing path, start_line, end_line, or new_content' };
        }
        const abs = resolvePath(args.path);
        if (!fs.existsSync(abs))
            return { ok: false, output: 'File not found.' };
        const content = fs.readFileSync(abs, 'utf8');
        const lines = content.split('\n');
        const start = Math.max(1, Number(args.start_line)) - 1;
        const end = Math.min(lines.length, Number(args.end_line));
        const oldLines = lines.slice(start, end).join('\n');
        const diff = `--- OLD\n+++ NEW\n-${oldLines}\n+${args.new_content}`;
        if (!await onConfirm(args.path, diff))
            return { ok: false, output: 'Rejected.' };
        lines.splice(start, end - start, args.new_content);
        fs.writeFileSync(abs, lines.join('\n'), 'utf8');
        return { ok: true, output: `Edited ${args.path} lines ${start + 1}-${end}` };
    }
    catch (e) {
        return { ok: false, output: e.message };
    }
}
async function searchFiles(args) {
    try {
        if (!args.pattern)
            return { ok: false, output: 'Missing pattern.' };
        const rootFolder = vscode.workspace.workspaceFolders?.[0];
        if (!rootFolder)
            return { ok: false, output: 'No workspace opened.' };
        const searchBase = args.path ? resolvePath(args.path) : rootFolder.uri.fsPath;
        const searchBaseUri = vscode.Uri.file(searchBase);
        const fileExt = args.file_pattern ? args.file_pattern.replace(/\*/g, '') : '';
        const pattern = fileExt ? `**/*${fileExt}` : '**/*';
        const relativePattern = new vscode.RelativePattern(searchBaseUri, pattern);
        const files = await vscode.workspace.findFiles(relativePattern, '**/node_modules/**', 500);
        let regex;
        try {
            regex = new RegExp(args.pattern, 'i');
        }
        catch (e) {
            return { ok: false, output: `Invalid regex pattern: ${e.message}` };
        }
        const results = [];
        const rootFsPath = rootFolder.uri.fsPath;
        for (const uri of files) {
            if (results.length >= 50)
                break;
            const stat = await vscode.workspace.fs.stat(uri);
            if (stat.size > 2 * 1024 * 1024)
                continue; // Ігноруємо файли > 2МБ
            const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (regex.test(lines[i])) {
                    const rel = path.relative(rootFsPath, uri.fsPath);
                    results.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
                    if (results.length >= 50)
                        break;
                }
            }
        }
        const msg = results.length >= 50 ? '\n[Truncated to 50 results]' : '';
        return { ok: true, output: results.join('\n') + msg || 'No matches found.' };
    }
    catch (e) {
        return { ok: false, output: e.message };
    }
}
async function getDiagnostics(args) {
    try {
        const filterPath = args.path ? resolvePath(args.path) : undefined;
        const diags = vscode.languages.getDiagnostics();
        const result = [];
        for (const [uri, fileDiags] of diags) {
            if (fileDiags.length === 0)
                continue;
            if (filterPath && uri.fsPath !== filterPath)
                continue;
            const relPath = path.relative(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', uri.fsPath);
            result.push(`=== ${relPath} ===`);
            for (const d of fileDiags) {
                const severity = d.severity === vscode.DiagnosticSeverity.Error ? 'ERROR' :
                    d.severity === vscode.DiagnosticSeverity.Warning ? 'WARN' : 'INFO';
                result.push(`[${severity}] Line ${d.range.start.line + 1}: ${d.message} (${d.source || 'unknown'})`);
            }
        }
        return { ok: true, output: result.length > 0 ? result.join('\n') : 'No diagnostics found. Everything looks clean!' };
    }
    catch (e) {
        return { ok: false, output: e.message };
    }
}
async function getFileOutline(args) {
    try {
        if (!args.path)
            return { ok: false, output: 'Missing path.' };
        const abs = resolvePath(args.path);
        if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
            return {
                ok: false,
                output: `CRITICAL ERROR: "${args.path}" is a DIRECTORY. You CANNOT use get_file_outline on directories! FIX: Use the "list_files" tool first to find specific .ts/.js files, and then call "get_file_outline" on those specific files.`
            };
        }
        const uri = vscode.Uri.file(abs);
        const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri);
        if (!symbols || symbols.length === 0) {
            return { ok: true, output: 'No Document Symbols found or not supported for this file type yet.' };
        }
        const lines = [];
        function printSymbols(syms, indent) {
            for (const s of syms) {
                const kind = vscode.SymbolKind[s.kind] || 'Unknown';
                lines.push(`${indent}[${kind}] ${s.name} (Lines ${s.range.start.line + 1}-${s.range.end.line + 1})`);
                if (s.children && s.children.length > 0) {
                    printSymbols(s.children, indent + '  ');
                }
            }
        }
        printSymbols(symbols, '');
        return { ok: true, output: lines.join('\n') };
    }
    catch (e) {
        return { ok: false, output: e.message };
    }
}
async function getWorkspaceInfo(args) {
    try {
        const root = args?.path
            ? path.resolve(args.path)
            : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root)
            return { ok: false, output: 'No path specified and no active workspace.' };
        const pkgPath = path.join(root, 'package.json');
        let out = `Resolved path: ${root}\n`;
        if (fs.existsSync(pkgPath)) {
            try {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                out += `Project: ${pkg.name || 'Unknown'}\n`;
                out += `Scripts: ${Object.keys(pkg.scripts || {}).join(', ')}\n`;
                const deps = Object.keys(pkg.dependencies || {});
                const devDeps = Object.keys(pkg.devDependencies || {});
                out += `Deps: ${deps.slice(0, 15).join(', ')}${deps.length > 15 ? '...' : ''}\n`;
                out += `DevDeps: ${devDeps.slice(0, 15).join(', ')}${devDeps.length > 15 ? '...' : ''}\n`;
            }
            catch (e) {
                out += `[Warning] Found package.json but failed to parse: ${e.message}\n`;
            }
        }
        else {
            out += `[Warning] No package.json found at this path.\n`;
        }
        out += `\nTo see directory structure, use list_files.`;
        return { ok: true, output: out };
    }
    catch (e) {
        return { ok: false, output: e.message };
    }
}
async function listSkills() {
    const sp = getSkillsPath();
    if (!sp || !fs.existsSync(sp)) {
        return { ok: false, output: 'Skills path not found. Check openollamagravity.skillsPath.' };
    }
    const files = scanSkillFolders(sp);
    if (files.length === 0) {
        return { ok: false, output: 'No SKILL.md files found. Run: openollamagravity.syncSkills' };
    }
    const entries = [];
    for (const file of files) {
        const folderName = path.relative(sp, path.dirname(file)).replace(/\\/g, '/');
        const yaml = readFrontmatter(file);
        const body = yaml
            ? `${yaml}\nskill_path: ${folderName}`
            : `name: ${folderName}\nskill_path: ${folderName}`;
        entries.push(`---\n${body}\n---`);
    }
    return {
        ok: true,
        output: `# SKILLS INDEX — ${entries.length} skills (frontmatter only)\n` +
            `# Load full skill: read_skill {"name": "<skill_path>"}\n\n` +
            entries.join('\n\n'),
    };
}
async function readSkill(args) {
    if (!args.name)
        return { ok: false, output: 'Вкажіть "name" (назву папки скіла).' };
    const sp = getSkillsPath();
    if (!sp)
        return { ok: false, output: 'Skills path not configured.' };
    const directPath = path.join(sp, args.name, 'SKILL.md');
    if (fs.existsSync(directPath)) {
        try {
            return { ok: true, output: fs.readFileSync(directPath, 'utf8') };
        }
        catch (e) {
            return { ok: false, output: e.message };
        }
    }
    const files = scanSkillFolders(sp);
    const needle = String(args.name).toLowerCase().replace(/\\/g, '/');
    const match = files.find(f => {
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
    }
    catch (e) {
        return { ok: false, output: e.message };
    }
}
