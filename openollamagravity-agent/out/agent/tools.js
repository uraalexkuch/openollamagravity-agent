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
exports.editFile = editFile;
exports.listFiles = listFiles;
exports.runTerminal = runTerminal;
exports.listSkills = listSkills;
exports.readSkill = readSkill;
exports.getDiagnostics = getDiagnostics;
exports.getWorkspaceInfo = getWorkspaceInfo;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const cp = __importStar(require("child_process"));
function root() {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
}
function resolvePath(p) {
    return path.isAbsolute(p) ? p : path.join(root(), p);
}
// ─────────────────────────────────────────────────────────
//  TOOL: read_file
// ─────────────────────────────────────────────────────────
async function readFile(args) {
    try {
        const abs = resolvePath(args.path);
        if (!fs.existsSync(abs)) {
            return { ok: false, output: `File not found: ${args.path}` };
        }
        const content = fs.readFileSync(abs, 'utf8');
        const lines = content.split('\n');
        const s = (args.start_line ?? 1) - 1;
        const e = args.end_line ?? lines.length;
        return { ok: true, output: `\`\`\`\n${lines.slice(s, e).join('\n')}\n\`\`\`` };
    }
    catch (err) {
        return { ok: false, output: err.message };
    }
}
// ─────────────────────────────────────────────────────────
//  TOOL: write_file
// ─────────────────────────────────────────────────────────
async function writeFile(args, onConfirm) {
    try {
        const abs = resolvePath(args.path);
        const auto = vscode.workspace.getConfiguration('openollamagravity').get('autoApplyEdits', false);
        if (!auto) {
            const ok = await onConfirm(args.path, args.content);
            if (!ok) {
                return { ok: false, output: 'User rejected file write.' };
            }
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        if (args.mode === 'append') {
            fs.appendFileSync(abs, args.content, 'utf8');
        }
        else {
            fs.writeFileSync(abs, args.content, 'utf8');
        }
        if (!auto) {
            const doc = await vscode.workspace.openTextDocument(abs);
            await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
        }
        return { ok: true, output: `Written ${args.path} (${args.content.split('\n').length} lines)` };
    }
    catch (err) {
        return { ok: false, output: err.message };
    }
}
// ─────────────────────────────────────────────────────────
//  TOOL: edit_file
// ─────────────────────────────────────────────────────────
async function editFile(args, onConfirm) {
    try {
        const abs = resolvePath(args.path);
        if (!fs.existsSync(abs)) {
            return { ok: false, output: `File not found: ${args.path}` };
        }
        const lines = fs.readFileSync(abs, 'utf8').split('\n');
        const newLines = args.new_content.split('\n');
        const diff = `Lines ${args.start_line}–${args.end_line} → ${newLines.length} lines`;
        const auto = vscode.workspace.getConfiguration('openollamagravity').get('autoApplyEdits', false);
        if (!auto) {
            const ok = await onConfirm(args.path, diff);
            if (!ok) {
                return { ok: false, output: 'User rejected edit.' };
            }
        }
        lines.splice(args.start_line - 1, args.end_line - args.start_line + 1, ...newLines);
        fs.writeFileSync(abs, lines.join('\n'), 'utf8');
        if (!auto) {
            const doc = await vscode.workspace.openTextDocument(abs);
            await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
        }
        return { ok: true, output: `Edited ${args.path}: ${diff}` };
    }
    catch (err) {
        return { ok: false, output: err.message };
    }
}
// ─────────────────────────────────────────────────────────
//  TOOL: list_files
// ─────────────────────────────────────────────────────────
async function listFiles(args) {
    try {
        const base = resolvePath(args.path ?? '.');
        const maxDepth = args.depth ?? 3;
        function walk(dir, depth, prefix = '') {
            if (depth === 0) {
                return [];
            }
            const IGNORE = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', '__pycache__', '.venv', 'target']);
            const entries = [];
            try {
                const items = fs.readdirSync(dir).sort((a, b) => {
                    const aIsDir = fs.statSync(path.join(dir, a)).isDirectory();
                    const bIsDir = fs.statSync(path.join(dir, b)).isDirectory();
                    if (aIsDir !== bIsDir) {
                        return aIsDir ? -1 : 1;
                    }
                    return a.localeCompare(b);
                });
                for (const item of items) {
                    if (IGNORE.has(item) || item.startsWith('.')) {
                        continue;
                    }
                    const full = path.join(dir, item);
                    const stat = fs.statSync(full);
                    if (stat.isDirectory()) {
                        entries.push(`${prefix}📁 ${item}/`);
                        entries.push(...walk(full, depth - 1, prefix + '  '));
                    }
                    else {
                        const size = stat.size < 1024 ? `${stat.size}b` : `${(stat.size / 1024).toFixed(1)}kb`;
                        entries.push(`${prefix}📄 ${item} (${size})`);
                    }
                }
            }
            catch { /* ignore */ }
            return entries;
        }
        const tree = walk(base, maxDepth);
        return { ok: true, output: tree.length === 0 ? 'Empty directory.' : tree.join('\n') };
    }
    catch (err) {
        return { ok: false, output: err.message };
    }
}
// ─────────────────────────────────────────────────────────
//  TOOL: run_terminal
// ─────────────────────────────────────────────────────────
async function runTerminal(args, onConfirm) {
    const cfg = vscode.workspace.getConfiguration('openollamagravity');
    if (!cfg.get('terminalEnabled', true)) {
        return { ok: false, output: 'Terminal execution is disabled.' };
    }
    const allowed = cfg.get('allowedShellCmds', ['npm', 'npx', 'node', 'python', 'git', 'tsc', 'ng', 'nest']);
    const cmdBase = args.command.trim().split(/\s+/)[0];
    if (!allowed.includes(cmdBase)) {
        return { ok: false, output: `Command "${cmdBase}" is not allowed. Add it to openollamagravity.allowedShellCmds.` };
    }
    const ok = await onConfirm(args.command);
    if (!ok) {
        return { ok: false, output: 'User rejected terminal command.' };
    }
    const cwd = args.cwd ? resolvePath(args.cwd) : root();
    return new Promise((resolve) => {
        cp.exec(args.command, { cwd, timeout: 120000, maxBuffer: 512 * 1024 }, (err, stdout, stderr) => {
            const out = [stdout, stderr].filter(Boolean).join('\n').trim();
            if (err && !out) {
                resolve({ ok: false, output: `Exit ${err.code}: ${err.message}` });
            }
            else {
                resolve({ ok: !err, output: out || '(no output)' });
            }
        });
    });
}
// ─────────────────────────────────────────────────────────
//  TOOL: list_skills
//  Показує лише .md файли з підпапки /skills репозиторію
// ─────────────────────────────────────────────────────────
async function listSkills() {
    const skillsPath = vscode.workspace.getConfiguration('openollamagravity').get('skillsPath', '');
    if (!skillsPath) {
        return { ok: false, output: 'Skills path not configured. Reload VS Code window.' };
    }
    if (!fs.existsSync(skillsPath)) {
        return { ok: false, output: `Skills folder not found: ${skillsPath}\nTry reloading the window — skills may still be downloading.` };
    }
    try {
        function walk(dir, prefix = '') {
            const results = [];
            for (const file of fs.readdirSync(dir)) {
                if (file.startsWith('.')) {
                    continue;
                }
                const full = path.join(dir, file);
                if (fs.statSync(full).isDirectory()) {
                    results.push(...walk(full, prefix + file + '/'));
                }
                else if (file.toLowerCase().endsWith('.md')) {
                    results.push(prefix + file);
                }
            }
            return results;
        }
        const tree = walk(skillsPath);
        if (tree.length === 0) {
            return { ok: false, output: `No .md skill files found in: ${skillsPath}` };
        }
        return {
            ok: true,
            output: [
                `Available skills (${tree.length} files)`,
                `📁 ${skillsPath}`,
                '',
                ...tree,
            ].join('\n'),
        };
    }
    catch (err) {
        return { ok: false, output: err.message };
    }
}
// ─────────────────────────────────────────────────────────
//  TOOL: read_skill
// ─────────────────────────────────────────────────────────
async function readSkill(args) {
    const skillsPath = vscode.workspace.getConfiguration('openollamagravity').get('skillsPath', '');
    if (!skillsPath) {
        return { ok: false, output: 'Skills path not configured.' };
    }
    const target = path.resolve(skillsPath, args.name);
    // Захист від path traversal
    if (!target.startsWith(path.resolve(skillsPath))) {
        return { ok: false, output: 'Invalid skill path.' };
    }
    if (!fs.existsSync(target)) {
        return { ok: false, output: `Skill file not found: ${args.name}\nAvailable skills are in: ${skillsPath}` };
    }
    try {
        const content = fs.readFileSync(target, 'utf8');
        return { ok: true, output: content };
    }
    catch (err) {
        return { ok: false, output: err.message };
    }
}
// ─────────────────────────────────────────────────────────
//  TOOL: get_diagnostics
// ─────────────────────────────────────────────────────────
async function getDiagnostics(args) {
    const all = vscode.languages.getDiagnostics();
    const lines = [];
    const filterPath = args.path ? resolvePath(args.path) : null;
    for (const [uri, diags] of all) {
        if (filterPath && uri.fsPath !== filterPath) {
            continue;
        }
        if (diags.length === 0) {
            continue;
        }
        const rel = path.relative(root(), uri.fsPath);
        for (const d of diags) {
            const sev = ['Error', 'Warning', 'Info', 'Hint'][d.severity];
            lines.push(`${rel}:${d.range.start.line + 1} [${sev}] ${d.message}`);
        }
    }
    return { ok: true, output: lines.length === 0 ? 'No diagnostics. ✅' : lines.join('\n') };
}
// ─────────────────────────────────────────────────────────
//  TOOL: get_workspace_info
// ─────────────────────────────────────────────────────────
async function getWorkspaceInfo() {
    const r = root();
    if (!r) {
        return { ok: false, output: 'No workspace open.' };
    }
    const info = { root: r };
    const pkgPath = path.join(r, 'package.json');
    if (fs.existsSync(pkgPath)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            info.type = 'Node.js/JS';
            info.name = pkg.name ?? 'unknown';
            info.version = pkg.version ?? '0.0.0';
        }
        catch { /* skip */ }
    }
    // Показуємо також шлях до скілів
    const skillsPath = vscode.workspace.getConfiguration('openollamagravity').get('skillsPath', '');
    if (skillsPath) {
        info.skillsPath = skillsPath;
    }
    return { ok: true, output: Object.entries(info).map(([k, v]) => `${k}: ${v}`).join('\n') };
}
