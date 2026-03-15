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
// ─────────────────────────────────────────────────────────────────────────────
// PROGRESSIVE DISCLOSURE — agentskills.io pattern
//
//  PHASE 1 — list_skills:
//    Агент отримує лише YAML-заголовок (~30-50 токенів) кожного скіла:
//      name / description / domain / subdomain / tags
//    На основі цього він вирішує, чи релевантний скіл до поточного завдання.
//
//  PHASE 2 — read_skill:
//    Тільки для підтверджено релевантних скілів агент завантажує
//    повний текст: кроки workflow, prerequisites, команди, верифікацію.
//
// Це відповідає стандарту agentskills.io і запобігає витраті токенів
// на нерелевантні навички зі 600+ бази.
// ─────────────────────────────────────────────────────────────────────────────
/** Зчитує лише YAML-блок із початку SKILL.md (між першими двома "---").
 *  Читаємо максимум 2 KB — достатньо для 30-50 токенів frontmatter. */
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
        return end === -1 ? null : text.slice(0, end + 4); // включаємо закриваючий "---"
    }
    catch {
        return null;
    }
}
/** Рекурсивно знаходить усі SKILL.md у директорії skillsPath */
function findAllSkillFiles(skillsPath) {
    const results = [];
    function walk(dir) {
        let entries;
        try {
            entries = fs.readdirSync(dir);
        }
        catch {
            return;
        }
        for (const e of entries) {
            if (e.startsWith('.'))
                continue;
            const full = path.join(dir, e);
            try {
                if (fs.statSync(full).isDirectory()) {
                    walk(full);
                }
                else if (e === 'SKILL.md') {
                    results.push(full);
                }
            }
            catch { }
        }
    }
    walk(skillsPath);
    return results;
}
function getSkillsPath() {
    return vscode.workspace.getConfiguration('openollamagravity').get('skillsPath', '');
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
            cwd: args.cwd ? resolvePath(args.cwd) : (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || ''),
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
// ── SKILLS TOOLS — PROGRESSIVE DISCLOSURE ────────────────────────────────────
/**
 * PHASE 1 — list_skills
 *
 * Повертає лише YAML frontmatter кожного SKILL.md (~30-50 токенів на скіл).
 * Агент читає цей список і визначає релевантні скіли БЕЗ завантаження
 * повного тексту. Формат відповідає стандарту agentskills.io:
 *
 *   ---
 *   name: performing-memory-forensics-with-volatility3
 *   description: Analyze memory dumps...
 *   domain: cybersecurity
 *   subdomain: digital-forensics
 *   tags: [forensics, memory-analysis, volatility3, incident-response]
 *   skill_path: cybersecurity/performing-memory-forensics-with-volatility3
 *   ---
 *
 * Після аналізу агент викликає read_skill лише для підходящих скілів.
 */
async function listSkills() {
    const p = getSkillsPath();
    if (!p || !fs.existsSync(p)) {
        return { ok: false, output: 'Skills path not found. Check openollamagravity.skillsPath setting.' };
    }
    const files = findAllSkillFiles(p);
    if (files.length === 0) {
        return { ok: false, output: 'No SKILL.md files found. Run: openollamagravity.syncSkills' };
    }
    const entries = [];
    for (const file of files) {
        const fm = readFrontmatter(file);
        if (!fm)
            continue;
        // Додаємо skill_path щоб агент знав як викликати read_skill
        const skillPath = path.relative(p, path.dirname(file)).replace(/\\/g, '/');
        // Вставляємо skill_path перед закриваючим ---
        const withPath = fm.replace(/\n---\s*$/, `\nskill_path: ${skillPath}\n---`);
        entries.push(withPath);
    }
    if (entries.length === 0) {
        return { ok: false, output: 'No valid SKILL.md frontmatters found.' };
    }
    return {
        ok: true,
        output: `# SKILLS INDEX — ${entries.length} skills (frontmatter only)\n` +
            `# To load full skill: read_skill {"name": "<skill_path>"}\n\n` +
            entries.join('\n\n'),
    };
}
/**
 * PHASE 2 — read_skill
 *
 * Завантажує ПОВНИЙ текст скіла: workflow steps, prerequisites,
 * tool commands, verification checks.
 *
 * args.name — відносний шлях до папки скіла або до SKILL.md
 * Приклади:
 *   {"name": "cybersecurity/performing-memory-forensics-with-volatility3"}
 *   {"name": "cybersecurity/performing-memory-forensics-with-volatility3/SKILL.md"}
 */
async function readSkill(args) {
    if (!args.name)
        return { ok: false, output: 'Вкажіть "name" — шлях до папки скіла.' };
    const p = getSkillsPath();
    if (!p)
        return { ok: false, output: 'Skills path not configured.' };
    const skillFile = resolveSkillFile(p, args.name);
    if (!skillFile) {
        return {
            ok: false,
            output: `Skill not found: "${args.name}". Use list_skills to see available skill_path values.`,
        };
    }
    try {
        const content = fs.readFileSync(skillFile, 'utf8');
        return { ok: true, output: content };
    }
    catch (e) {
        return { ok: false, output: e.message };
    }
}
/** Розбирає name у абсолютний шлях до SKILL.md */
function resolveSkillFile(skillsPath, name) {
    const candidates = [
        path.join(skillsPath, name), // точний шлях до файлу
        path.join(skillsPath, name, 'SKILL.md'), // папка → SKILL.md
        path.join(skillsPath, name.replace(/\/SKILL\.md$/i, ''), 'SKILL.md'), // з суфіксом
    ];
    for (const c of candidates) {
        try {
            if (fs.statSync(c).isFile())
                return c;
        }
        catch { }
    }
    // Fallback: пошук за назвою папки по всьому дереву
    const target = path.basename(name.replace(/\/SKILL\.md$/i, ''));
    return findByFolderName(skillsPath, target);
}
function findByFolderName(dir, target) {
    let entries;
    try {
        entries = fs.readdirSync(dir);
    }
    catch {
        return null;
    }
    for (const e of entries) {
        if (e.startsWith('.'))
            continue;
        const full = path.join(dir, e);
        try {
            if (!fs.statSync(full).isDirectory())
                continue;
            if (e === target) {
                const f = path.join(full, 'SKILL.md');
                try {
                    if (fs.statSync(f).isFile())
                        return f;
                }
                catch { }
            }
            const found = findByFolderName(full, target);
            if (found)
                return found;
        }
        catch { }
    }
    return null;
}
