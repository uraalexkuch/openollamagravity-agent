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
exports.autoLoadSkillsForTask = autoLoadSkillsForTask;
exports.discoverSkillsFromContext = discoverSkillsFromContext;
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
// ── HELPERS ───────────────────────────────────────────────────────────────────
function getSkillsPath() {
    return vscode.workspace.getConfiguration('openollamagravity').get('skillsPath', '');
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
function scanSkillFolders(skillsPath) {
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
    // Якщо є хоча б один SKILL.md — повертаємо лише їх (стандартна структура).
    // Інакше падаємо на legacy .md (старі репо без agentskills.io структури).
    return skillMd.length > 0 ? skillMd : legacyMd;
}
/**
 * Зчитує перші 2 KB SKILL.md і витягує YAML між першими "---" ... "---".
 * ~30-50 токенів — достатньо для визначення релевантності.
 */
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
/** Мінімальний парсер YAML: "key: value" і "key: [a, b, c]" */
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
// ── SCORING ───────────────────────────────────────────────────────────────────
const STOP = new Set([
    'the', 'a', 'an', 'in', 'on', 'at', 'to', 'of', 'and', 'or', 'for', 'is', 'it', 'be',
    'use', 'using', 'get', 'set', 'run', 'make', 'how', 'do', 'with',
    'що', 'як', 'для', 'та', 'і', 'або', 'з', 'у', 'в', 'це', 'на', 'до', 'по', 'при',
    'цей', 'цього', 'цьому', 'цим', 'ця', 'цієї', 'цю', 'цієї',
    'який', 'яка', 'яке', 'які', 'якого', 'якій', 'яким',
    'мені', 'мене', 'мій', 'моя', 'моє', 'мої', 'мого',
]);
/**
 * Словник перекладу UA→EN для частих слів у задачах.
 * Забезпечує збіг українських запитів з англійськими тегами скілів.
 */
const UA_EN = {
    // Загальні дії
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
    // Структура та архітектура
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
    // Технології
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
/** Розширює масив токенів англійськими перекладами для UA слів */
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
// ─────────────────────────────────────────────────────────────────────────────
// ЄДИНИЙ АЛГОРИТМ ПОШУКУ СКІЛІВ  (IDF-зважений, розділяє задачу і контекст)
//
// Проблема «106 релевантних»:
//   minScore=1 + generic токени (project, key, deps, compression) → майже кожен
//   скіл в базі отримує score ≥ 1 через загальні слова.
//
// Рішення — двоетапне:
//   1. extractTaskTokens(task) — ТІЛЬКИ текст задачі, без package.json/deps
//      extractContextTokens(ctx) — ТІЛЬКИ контекст workspace (нижча вага)
//
//   2. IDF (Inverse Document Frequency):
//      скануємо frontmatter всіх скілів один раз, рахуємо в скількох скілах
//      зустрічається кожен токен. Токени що є у >30% скілів → вага ×0.2
//      (вони загальні і не дають корисного сигналу).
//
//   3. Фінальний score:
//        taskToken   → base weight × idf_weight   (повна вага)
//        contextToken→ base weight × idf_weight × 0.4   (знижена вага)
//      де base: tags×3, description×2, name/folder×1
//
//   4. minScore для першого запиту підвищено до 4 (замість 1)
//      minScore для динамічного пошуку — 3 (замість 2)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Кеш IDF-ваг токенів — будується один раз за сесію для всіх скілів.
 * { token → idfWeight }  де idfWeight ∈ (0, 1]
 */
let _idfCache = null;
let _idfSkillsPath = '';
/** Будує IDF-кеш: для кожного токена з frontmatter — частка скілів де він є */
function buildIdfCache(skillsPath) {
    if (_idfCache && _idfSkillsPath === skillsPath)
        return _idfCache;
    const files = scanSkillFolders(skillsPath);
    if (files.length === 0)
        return new Map();
    const docFreq = new Map(); // token → скільки скілів містять
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
        // Токени в >50% скілів — майже нульова вага (дуже загальні)
        // Токени в 10-50% — середня вага
        // Токени в <10% — повна вага
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
/** Повертає IDF-вагу токена (1.0 якщо токен унікальний / невідомий) */
function idfWeight(token, idf) {
    return idf.get(token) ?? 1.0;
}
/**
 * Розділяємо вхідний текст на ЗАДАЧУ і КОНТЕКСТ.
 *
 * Задача — перший рядок / те що написав користувач напряму.
 * Контекст — package.json deps, активний файл, workspace info тощо.
 *
 * Токени задачі мають повну вагу в scoring.
 * Токени контексту — знижену (×0.4), щоб залежності типу "compression"
 * або "cors" не тягнули нерелевантні скіли.
 */
function splitTaskAndContext(combined) {
    const lines = combined.split('\n');
    // Перші рядки до першого "Key deps:" / "Project:" / "Scripts:" — це задача
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
    // Розширюємо тільки токени задачі UA→EN перекладами
    const taskExpanded = expandWithTranslations(taskRaw);
    // Контекстні токени: виключаємо ті що вже є в задачі (нема сенсу дублювати)
    const contextUnique = contextRaw.filter(t => !taskExpanded.includes(t));
    return { taskTokens: taskExpanded, contextTokens: contextUnique };
}
/**
 * Рахує IDF-зважений score скіла.
 *
 * @param meta          метадані скіла
 * @param taskTokens    токени задачі (повна вага)
 * @param contextTokens токени контексту (знижена вага ×0.4)
 * @param idf           IDF-кеш
 */
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
    // Токени задачі — повна вага × IDF
    for (const tw of taskTokens) {
        const base = baseScore(tw);
        if (base > 0)
            score += base * idfWeight(tw, idf);
    }
    // Токени контексту — знижена вага (×0.4) × IDF
    for (const tw of contextTokens) {
        const base = baseScore(tw);
        if (base > 0)
            score += base * idfWeight(tw, idf) * 0.4;
    }
    return score;
}
// Залишаємо старий scoreSkill як fallback (використовується в _discoverSkillsFromResult)
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
/**
 * Очищає текст від шуму і повертає унікальні значущі токени.
 * Використовується для tool_result у динамічному пошуку.
 */
function extractQueryTokens(text) {
    const cleaned = text
        .slice(0, 4096)
        .replace(/[A-Za-z]:\\[\w\\.\ \-]*/g, ' ') // Windows-шляхи
        .replace(/\/[\w\/.\-]+/g, ' ') // Unix-шляхи
        .replace(/https?:\/\/\S+/g, ' ') // URL
        .replace(/\b\d{2,}\b/g, ' ') // числа 2+ цифри
        .replace(/[^\w\s]/g, ' '); // спецсимволи
    return [...new Set(tokenize(cleaned))];
}
/**
 * Сканує ВСІ SKILL.md з IDF-зваженим скорингом.
 * Розділяє задачу і контекст для точнішого підбору.
 *
 * @param combined      повний текст (задача + контекст workspace)
 * @param alreadyLoaded папки вже завантажених скілів
 * @param minScore      мінімальний score (вищий = суворіший фільтр)
 */
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
// Стара scanAndScoreAllSkills — залишається для discoverSkillsFromContext
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
/** Завантажує ПОВНИЙ текст для топ-N скілів зі списку. */
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
// ── PHASE 1: підбір скілів для першого запиту ────────────────────────────────
/**
 * Викликається ПЕРЕД запуском агента.
 * Використовує IDF-зважений scoring з розділенням задачі і контексту.
 *
 * @param task             текст задачі від користувача
 * @param workspaceContext додатковий контекст (package.json, активний файл тощо)
 * @param maxSkills        максимум скілів у системному промпті (default: 3)
 */
async function autoLoadSkillsForTask(task, workspaceContext = '', maxSkills = 3) {
    const combined = [task, workspaceContext].filter(Boolean).join('\n');
    if (!combined.trim())
        return [];
    // IDF-зважений пошук, minScore=4 — суворіший фільтр ніж раніше
    // Це запобігає ситуації "106 релевантних" через generic токени
    const allScored = scanAndScoreAllSkillsIdf(combined, new Set(), 4);
    if (allScored.length === 0) {
        // Fallback: знижуємо поріг до 2 якщо нічого не знайдено при суворому фільтрі
        client_1.oogLogger.appendLine('[Skills] minScore=4 нічого не дав → fallback minScore=2');
        const fallback = scanAndScoreAllSkillsIdf(combined, new Set(), 2);
        client_1.oogLogger.appendLine(`[Skills] Fallback знайшов: ${fallback.length}` +
            (fallback.length > 0 ? `, топ: ${fallback.slice(0, 3).map(s => `${s.folderName}(${s.score.toFixed(1)})`).join(', ')}` : ''));
        return loadTopSkills(fallback, maxSkills);
    }
    client_1.oogLogger.appendLine(`[Skills] Знайдено: ${allScored.length} (minScore≥4)` +
        `, топ: ${allScored.slice(0, 5).map(s => `${s.folderName}(${s.score.toFixed(1)})`).join(', ')}`);
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
async function discoverSkillsFromContext(toolName, content, alreadyLoaded, maxNew = 2, minScore = 3) {
    const empty = { skills: [], contextTokens: [] };
    const validTools = ['read_file', 'list_files', 'run_terminal', 'search_files', 'get_diagnostics', 'get_file_outline'];
    if (!validTools.includes(toolName))
        return empty;
    if (!content || content.length < 20)
        return empty;
    // Вилучаємо базові токени з тексту
    let contextTokens = extractQueryTokens(content);
    // Аналізуємо розширення файлів для виявлення мови
    const exts = new Set();
    const extRegex = /\.([a-zA-Z0-9]+)\b/g;
    let match;
    while ((match = extRegex.exec(content)) !== null) {
        exts.add(match[1].toLowerCase());
    }
    // Маппінг розширень у ключові слова мов програмування
    const extToLang = {
        'ts': ['typescript', 'node', 'react', 'frontend', 'javascript'],
        'js': ['javascript', 'node', 'react', 'frontend'],
        'jsx': ['react', 'javascript', 'frontend'],
        'tsx': ['react', 'typescript', 'frontend'],
        'py': ['python', 'django', 'fastapi', 'flask'],
        'go': ['golang', 'go'],
        'rs': ['rust', 'cargo'],
        'java': ['java', 'spring'],
        'cs': ['csharp', 'dotnet'],
        'cpp': ['cpp', 'cplusplus'],
        'c': ['c'],
        'php': ['php', 'laravel'],
        'rb': ['ruby', 'rails'],
        'swift': ['swift', 'ios'],
        'kt': ['kotlin', 'android'],
        'html': ['html', 'frontend'],
        'css': ['css', 'frontend', 'tailwind'],
        'scss': ['css', 'frontend', 'tailwind'],
        'sql': ['sql', 'database', 'postgres', 'mysql'],
        'sh': ['bash', 'shell'],
        'yaml': ['yaml', 'docker', 'kubernetes', 'ci'],
        'yml': ['yaml', 'docker', 'kubernetes', 'ci'],
        'json': ['json']
    };
    const extraTokens = [];
    for (const ext of exts) {
        if (extToLang[ext]) {
            extraTokens.push(...extToLang[ext]);
        }
    }
    // Об'єднуємо токени, щоб підсилити пошук за мовою
    contextTokens = [...new Set([...contextTokens, ...extraTokens])];
    if (contextTokens.length < 3)
        return empty;
    client_1.oogLogger.appendLine(`[Skills] Контекст з ${toolName}: tokens=[${contextTokens.slice(0, 10).join(', ')}]`);
    const newScored = scanAndScoreAllSkills(contextTokens, alreadyLoaded, minScore);
    if (newScored.length > 0) {
        client_1.oogLogger.appendLine(`[Skills] Контекст знайшов: ${newScored.length} нових` +
            `, топ: ${newScored.slice(0, 3).map(s => `${s.folderName}(${s.score})`).join(', ')}`);
    }
    return { skills: loadTopSkills(newScored, maxNew), contextTokens };
}
function getPerplexicaUrl() {
    return vscode.workspace
        .getConfiguration('openollamagravity')
        .get('perplexicaUrl', 'http://localhost:3001');
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
async function webSearch(args) {
    const query = String(args?.query || '').trim();
    if (!query)
        return { ok: false, output: 'web_search: вкажіть "query".' };
    const baseUrl = getPerplexicaUrl().replace(/\/$/, '');
    const focusMode = String(args?.focus || 'webSearch');
    const maxResults = Math.min(Number(args?.maxResults) || 5, 10);
    client_1.oogLogger.appendLine(`[WebSearch] Запит: "${query}" (focus=${focusMode})`);
    try {
        // Перевіряємо чи Perplexica запущена
        const isAvailable = await checkPerplexica(baseUrl);
        if (!isAvailable) {
            return {
                ok: false,
                output: `Perplexica недоступна за адресою ${baseUrl}.\n` +
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
        const data = JSON.parse(res);
        // Формуємо стислий вивід: топ-N результатів
        const sources = (data.sources || []).slice(0, maxResults);
        const lines = [];
        if (data.message) {
            lines.push(`📋 Відповідь Perplexica:\n${data.message}\n`);
        }
        if (sources.length > 0) {
            lines.push(`🔗 Джерела (${sources.length}):`);
            sources.forEach((s, i) => {
                const title = s.metadata?.title || 'Без назви';
                const url = s.metadata?.url || '';
                const snippet = (s.pageContent || '').slice(0, 300).replace(/\n+/g, ' ');
                lines.push(`${i + 1}. ${title}\n   ${url}\n   ${snippet}`);
            });
        }
        if (lines.length === 0) {
            return { ok: false, output: `web_search: порожній результат для "${query}".` };
        }
        const output = lines.join('\n\n');
        client_1.oogLogger.appendLine(`[WebSearch] Отримано ${sources.length} джерел для "${query}"`);
        return { ok: true, output };
    }
    catch (e) {
        client_1.oogLogger.appendLine(`[WebSearch] Помилка: ${e.message}`);
        return {
            ok: false,
            output: `web_search помилка: ${e.message}. Perplexica запущена? (${baseUrl})`,
        };
    }
}
/** Перевіряє доступність Perplexica за /api/config або / */
async function checkPerplexica(baseUrl) {
    return new Promise(resolve => {
        const url = new URL('/api/config', baseUrl);
        const lib = url.protocol === 'https:' ? https : http;
        const req = lib.get({ hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 3001), path: url.pathname, timeout: 3000 }, (res) => { resolve(res.statusCode < 500); });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
    });
}
/** HTTP POST helper (http/https) */
function httpPost(urlStr, body) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlStr);
        const lib = url.protocol === 'https:' ? https : http;
        const req = lib.request({
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 3001),
            path: url.pathname + (url.search || ''),
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            timeout: 30000,
        }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c.toString(); });
            res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Perplexica timeout')); });
        req.write(body);
        req.end();
    });
}
// ── PATH RESOLVER ─────────────────────────────────────────────────────────────
function resolvePath(p) {
    if (!p)
        throw new Error('Path is required but received undefined.');
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    return path.isAbsolute(p) ? p : path.join(root, p);
}
// ── FILE TOOLS ────────────────────────────────────────────────────────────────
const READ_FILE_MAX_BYTES = 100 * 1024; // 100 KB — захист від переповнення контексту LLM
async function readFile(args) {
    try {
        const abs = resolvePath(args.path);
        const stat = fs.statSync(abs);
        if (stat.size > READ_FILE_MAX_BYTES) {
            const fd = fs.openSync(abs, 'r');
            const buf = Buffer.alloc(READ_FILE_MAX_BYTES);
            const n = fs.readSync(fd, buf, 0, READ_FILE_MAX_BYTES, 0);
            fs.closeSync(fd);
            const preview = buf.subarray(0, n).toString('utf8');
            return {
                ok: true,
                output: preview +
                    `\n\n[FILE TRUNCATED — file is ${Math.round(stat.size / 1024)}KB, showing first 100KB.` +
                    ` Use specific line ranges if you need more.]`,
            };
        }
        return { ok: true, output: fs.readFileSync(abs, 'utf8') };
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
// Директорії, які пропускаємо при переліку — зазвичай велика кількість файлів без корисного сигналу
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
                    continue; // приховані файли крім важливих
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
                    // Деякі команди повертають ненульовий код але пишуть корисний stdout (npm test тощо)
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
        // Create diff preview
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
        const base = resolvePath(args.path || '.');
        if (!fs.existsSync(base))
            return { ok: false, output: 'Path not found.' };
        const fileExt = args.file_pattern ? args.file_pattern.replace(/\*/g, '') : '';
        const regex = new RegExp(args.pattern, 'i'); // case-insensitive search
        const results = [];
        function walk(dir, depth) {
            if (depth > 6 || results.length > 50)
                return; // limit depth and results
            let entries;
            try {
                entries = fs.readdirSync(dir);
            }
            catch {
                return;
            }
            for (const e of entries) {
                if (SKIP_DIRS.has(e) || e.startsWith('.'))
                    continue;
                const full = path.join(dir, e);
                try {
                    const stat = fs.statSync(full);
                    if (stat.isDirectory()) {
                        walk(full, depth + 1);
                    }
                    else {
                        if (fileExt && !e.includes(fileExt))
                            continue;
                        if (stat.size > 2 * 1024 * 1024)
                            continue; // skip >2mb files
                        const content = fs.readFileSync(full, 'utf8');
                        const lines = content.split('\n');
                        for (let i = 0; i < lines.length; i++) {
                            if (regex.test(lines[i])) {
                                const rel = path.relative(resolvePath('.'), full);
                                results.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
                                if (results.length > 50)
                                    break;
                            }
                        }
                    }
                }
                catch { }
            }
        }
        walk(base, 1);
        const msg = results.length > 50 ? '\n[Truncated to 50 results]' : '';
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
                result.push(`[${severity}] Line ${d.range.start.line + 1}: ${d.message} (${d.source || 'uknown'})`);
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
        const uri = vscode.Uri.file(abs);
        // We execute the built-in VSCode document symbol provider
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
async function getWorkspaceInfo() {
    try {
        // Re-use context.ts logic or a lightweight version
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root)
            return { ok: false, output: 'No active workspace.' };
        const pkgPath = path.join(root, 'package.json');
        let out = `Workspace root: ${root}\n`;
        if (fs.existsSync(pkgPath)) {
            try {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                out += `Project: ${pkg.name || 'Unknown'}\n`;
                out += `Scripts: ${Object.keys(pkg.scripts || {}).join(', ')}\n`;
                out += `Deps: ${Object.keys(pkg.dependencies || {}).join(', ')}\n`;
                out += `DevDeps: ${Object.keys(pkg.devDependencies || {}).join(', ')}\n`;
            }
            catch { }
        }
        out += `\nTo list initial files, use list_files.`;
        return { ok: true, output: out };
    }
    catch (e) {
        return { ok: false, output: e.message };
    }
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
        output: `# SKILLS INDEX — ${entries.length} skills (frontmatter only)\n` +
            `# Load full skill: read_skill {"name": "<skill_path>"}\n\n` +
            entries.join('\n\n'),
    };
}
/**
 * read_skill — завантажує ПОВНИЙ текст скіла.
 * args.name = folderName, напр. "10-andruia-skill-smith"
 */
async function readSkill(args) {
    if (!args.name)
        return { ok: false, output: 'Вкажіть "name" (назву папки скіла).' };
    const sp = getSkillsPath();
    if (!sp)
        return { ok: false, output: 'Skills path not configured.' };
    // Пряме звернення — підтримує як "10-andruia-skill-smith" так і "cybersecurity/volatility3"
    const directPath = path.join(sp, args.name, 'SKILL.md');
    if (fs.existsSync(directPath)) {
        try {
            return { ok: true, output: fs.readFileSync(directPath, 'utf8') };
        }
        catch (e) {
            return { ok: false, output: e.message };
        }
    }
    // Fallback: шукаємо по всіх знайдених скілах — часткове співпадіння відносного шляху
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
