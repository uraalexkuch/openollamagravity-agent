"use strict";
// Copyright (c) 2026 Юрій Кучеренко. All rights reserved.
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
exports.listSkills = listSkills;
exports.writeFile = writeFile;
exports.createDirectory = createDirectory;
exports.readFile = readFile;
exports.listFiles = listFiles;
exports.runTerminal = runTerminal;
exports.readSkill = readSkill;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const cp = __importStar(require("child_process"));
function root() { return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ''; }
function resolvePath(p) {
    if (!p)
        throw new Error('Path argument is missing.');
    return path.isAbsolute(p) ? p : path.join(root(), p);
}
async function listSkills() {
    try {
        const p = vscode.workspace.getConfiguration('openollamagravity').get('skillsPath', '');
        if (!p || !fs.existsSync(p))
            return { ok: false, output: 'Skills repository not found.' };
        // Рекурсивний пошук .md файлів у папці скілів
        const files = fs.readdirSync(p, { recursive: true })
            .filter(f => typeof f === 'string' && f.endsWith('.md'));
        return { ok: true, output: files.length > 0 ? files.join('\n') : 'No .md skills found.' };
    }
    catch (err) {
        return { ok: false, output: err.message };
    }
}
async function writeFile(args, onConfirm) {
    try {
        if (!args.path)
            return { ok: false, output: 'Error: Path is required.' };
        const abs = resolvePath(args.path);
        if (!await onConfirm(args.path))
            return { ok: false, output: 'User denied write.' };
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, args.content || '', 'utf8');
        return { ok: true, output: `Saved: ${args.path}` };
    }
    catch (err) {
        return { ok: false, output: err.message };
    }
}
async function createDirectory(args) {
    try {
        if (!args.path)
            return { ok: false, output: 'Error: Path is required.' };
        fs.mkdirSync(resolvePath(args.path), { recursive: true });
        return { ok: true, output: `Created directory: ${args.path}` };
    }
    catch (err) {
        return { ok: false, output: err.message };
    }
}
async function readFile(args) {
    try {
        const abs = resolvePath(args.path);
        return { ok: true, output: fs.readFileSync(abs, 'utf8') };
    }
    catch (err) {
        return { ok: false, output: err.message };
    }
}
async function listFiles(args) {
    try {
        const base = resolvePath(args.path || '.');
        const items = fs.readdirSync(base).slice(0, 100);
        return { ok: true, output: items.map(i => fs.statSync(path.join(base, i)).isDirectory() ? `📁 ${i}/` : `📄 ${i}`).join('\n') };
    }
    catch (err) {
        return { ok: false, output: err.message };
    }
}
async function runTerminal(args, onConfirm) {
    try {
        if (!await onConfirm(args.command))
            return { ok: false, output: 'Rejected.' };
        const res = cp.execSync(args.command, { cwd: args.cwd ? resolvePath(args.cwd) : root() });
        return { ok: true, output: res.toString() };
    }
    catch (err) {
        return { ok: false, output: err.message };
    }
}
async function readSkill(args) {
    try {
        const p = vscode.workspace.getConfiguration('openollamagravity').get('skillsPath', '');
        const target = path.join(p, args.name);
        return { ok: true, output: fs.readFileSync(target, 'utf8') };
    }
    catch (err) {
        return { ok: false, output: err.message };
    }
}
