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
exports.writeFile = writeFile;
exports.listFiles = listFiles;
exports.runTerminal = runTerminal;
exports.listSkills = listSkills;
exports.readSkill = readSkill;
exports.createDirectory = createDirectory;
exports.readFile = readFile;
// Copyright (c) 2026 Юрій Кучеренко.
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const cp = __importStar(require("child_process"));
function resolvePath(p) {
    if (!p)
        throw new Error('Path is required but received undefined.');
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    return path.isAbsolute(p) ? p : path.join(root, p);
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
        const items = fs.readdirSync(base).slice(0, 100);
        return { ok: true, output: items.map(i => fs.statSync(path.join(base, i)).isDirectory() ? `📁 ${i}/` : `📄 ${i}`).join('\n') };
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
        const res = cp.execSync(args.command, { cwd: args.cwd ? resolvePath(args.cwd) : (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '') });
        return { ok: true, output: res.toString() };
    }
    catch (e) {
        return { ok: false, output: e.message };
    }
}
async function listSkills() {
    const p = vscode.workspace.getConfiguration('openollamagravity').get('skillsPath', '');
    if (!p || !fs.existsSync(p))
        return { ok: false, output: 'Skills not found.' };
    return { ok: true, output: fs.readdirSync(p, { recursive: true }).filter(f => f.endsWith('.md')).join('\n') };
}
async function readSkill(args) {
    const p = vscode.workspace.getConfiguration('openollamagravity').get('skillsPath', '');
    return { ok: true, output: fs.readFileSync(path.join(p, args.name), 'utf8') };
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
async function readFile(args) {
    try {
        return { ok: true, output: fs.readFileSync(resolvePath(args.path), 'utf8') };
    }
    catch (e) {
        return { ok: false, output: e.message };
    }
}
