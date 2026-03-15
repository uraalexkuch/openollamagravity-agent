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
exports.readFile = readFile;
exports.writeFile = writeFile;
exports.listFiles = listFiles;
exports.runTerminal = runTerminal;
exports.createDirectory = createDirectory;
exports.listSkills = listSkills;
exports.readSkill = readSkill;
// Copyright (c) 2026 Юрій Кучеренко.
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const cp = __importStar(require("child_process"));
const client_1 = require("../ollama/client");
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
]);
function tokenize(text) {
    return text
        .toLowerCase()
        .replace(/[-_]/g, ' ') // дефіси → пробіли (для "skill-smith" → "skill smith")
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
function scoreSkill(meta, taskTokens) {
    if (taskTokens.length === 0)
        return 0;
    const nameT = tokenize(meta.name + ' ' + meta.folderName);
    const descT = tokenize(meta.description);
    const domainT = tokenize(meta.domain + ' ' + meta.subdomain);
    let score = 0;
    for (const tw of taskTokens) {
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
 * Сканує ВСІ SKILL.md, скорує кожен проти наданих токенів,
 * повертає відсортований список (DESC score).
 */
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
            client_1.oogLogger.appendLine(`[Skills] ✅ "${meta.name}"  folder=${meta.folderName}  score=${meta.score}`);
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
 * Перевіряє ВСІ скіли і завантажує топ-N найрелевантніших.
 * Той самий pipeline що й discoverSkillsFromContext.
 *
 * @param task      текст задачі від користувача
 * @param maxSkills максимум скілів у системному промпті (default: 3)
 */
async function autoLoadSkillsForTask(task, maxSkills = 3) {
    const queryTokens = extractQueryTokens(task);
    if (queryTokens.length === 0)
        return [];
    client_1.oogLogger.appendLine(`[Skills] Аналіз задачі: tokens=[${queryTokens.slice(0, 12).join(', ')}]`);
    const allScored = scanAndScoreAllSkills(queryTokens, new Set(), 1);
    client_1.oogLogger.appendLine(`[Skills] Знайдено: ${allScored.length} релевантних` +
        (allScored.length > 0
            ? `, топ: ${allScored.slice(0, 5).map(s => `${s.folderName}(${s.score})`).join(', ')}`
            : ''));
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
async function discoverSkillsFromContext(toolName, content, alreadyLoaded, maxNew = 2, minScore = 2) {
    const empty = { skills: [], contextTokens: [] };
    if (!['read_file', 'list_files', 'run_terminal'].includes(toolName))
        return empty;
    if (!content || content.length < 20)
        return empty;
    const contextTokens = extractQueryTokens(content);
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
// ── PATH RESOLVER ─────────────────────────────────────────────────────────────
function resolvePath(p) {
    if (!p)
        throw new Error('Path is required but received undefined.');
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    return path.isAbsolute(p) ? p : path.join(root, p);
}
// ── FILE TOOLS ────────────────────────────────────────────────────────────────
async function readFile(args) {
    try {
        return { ok: true, output: fs.readFileSync(resolvePath(args.path), 'utf8') };
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
            for (const e of entries.slice(0, 100)) {
                const full = path.join(dir, e);
                try {
                    const isDir = fs.statSync(full).isDirectory();
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
        const res = cp.execSync(args.command, {
            cwd: args.cwd
                ? resolvePath(args.cwd)
                : (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || ''),
            timeout: 60000,
        });
        return { ok: true, output: res.toString() };
    }
    catch (e) {
        return { ok: false, output: e.message };
    }
}
async function createDirectory(args) {
    try {
        fs.mkdirSync(resolvePath(args.path), { recursive: true });
        return { ok: true, output: `Created: ${args.path}` };
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
