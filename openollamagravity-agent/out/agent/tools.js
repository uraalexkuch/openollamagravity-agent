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
exports.writeFile = writeFile;
exports.listFiles = listFiles;
exports.readFile = readFile;
exports.runTerminal = runTerminal;
exports.listSkills = listSkills;
exports.readSkill = readSkill;
exports.editFile = editFile;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const cp = __importStar(require("child_process"));
function root() { return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ''; }
function resolvePath(p) {
    if (!p)
        throw new Error('Path is required but received undefined.');
    return path.isAbsolute(p) ? p : path.join(root(), p);
}
async function writeFile(args, onConfirm) {
    try {
        if (!args.path)
            return { ok: false, output: 'Error: "path" argument is missing.' };
        const abs = resolvePath(args.path);
        if (!await onConfirm(args.path))
            return { ok: false, output: 'Rejected.' };
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, args.content || '', 'utf8');
        return { ok: true, output: `Successfully written to ${args.path}` };
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
async function readFile(args) {
    try {
        const abs = resolvePath(args.path);
        return { ok: true, output: fs.readFileSync(abs, 'utf8') };
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
async function listSkills() {
    const p = vscode.workspace.getConfiguration('openollamagravity').get('skillsPath', '');
    if (!p || !fs.existsSync(p))
        return { ok: false, output: 'Skills not found.' };
    return { ok: true, output: fs.readdirSync(p).join('\n') };
}
async function readSkill(args) {
    const p = vscode.workspace.getConfiguration('openollamagravity').get('skillsPath', '');
    return { ok: true, output: fs.readFileSync(path.join(p, args.name), 'utf8') };
}
async function editFile(args, onConfirm) {
    try {
        const abs = resolvePath(args.path);
        if (!await onConfirm(args.path))
            return { ok: false, output: 'Rejected.' };
        const content = fs.readFileSync(abs, 'utf8').split('\n');
        content.splice(args.start_line - 1, args.end_line - args.start_line + 1, args.new_content);
        fs.writeFileSync(abs, content.join('\n'), 'utf8');
        return { ok: true, output: 'Edited.' };
    }
    catch (err) {
        return { ok: false, output: err.message };
    }
}
