// Copyright (c) 2026 Юрій Кучеренко. All rights reserved.

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';

export interface ToolResult { ok: boolean; output: string; }

function root() { return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ''; }

function resolvePath(p: string): string {
  if (!p) throw new Error('Path argument is missing.');
  return path.isAbsolute(p) ? p : path.join(root(), p);
}

export async function listSkills(): Promise<ToolResult> {
  try {
    const p = vscode.workspace.getConfiguration('openollamagravity').get<string>('skillsPath', '');
    if (!p || !fs.existsSync(p)) return { ok: false, output: 'Skills repository not found.' };

    // Рекурсивний пошук .md файлів у папці скілів
    const files = fs.readdirSync(p, { recursive: true })
        .filter(f => typeof f === 'string' && f.endsWith('.md'));

    return { ok: true, output: files.length > 0 ? files.join('\n') : 'No .md skills found.' };
  } catch (err: any) { return { ok: false, output: err.message }; }
}

export async function writeFile(args: any, onConfirm: (p: string) => Promise<boolean>): Promise<ToolResult> {
  try {
    if (!args.path) return { ok: false, output: 'Error: Path is required.' };
    const abs = resolvePath(args.path);
    if (!await onConfirm(args.path)) return { ok: false, output: 'User denied write.' };
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, args.content || '', 'utf8');
    return { ok: true, output: `Saved: ${args.path}` };
  } catch (err: any) { return { ok: false, output: err.message }; }
}

export async function createDirectory(args: any): Promise<ToolResult> {
  try {
    if (!args.path) return { ok: false, output: 'Error: Path is required.' };
    fs.mkdirSync(resolvePath(args.path), { recursive: true });
    return { ok: true, output: `Created directory: ${args.path}` };
  } catch (err: any) { return { ok: false, output: err.message }; }
}

export async function readFile(args: any): Promise<ToolResult> {
  try {
    const abs = resolvePath(args.path);
    return { ok: true, output: fs.readFileSync(abs, 'utf8') };
  } catch (err: any) { return { ok: false, output: err.message }; }
}

export async function listFiles(args: any): Promise<ToolResult> {
  try {
    const base = resolvePath(args.path || '.');
    const items = fs.readdirSync(base).slice(0, 100);
    return { ok: true, output: items.map(i => fs.statSync(path.join(base, i)).isDirectory() ? `📁 ${i}/` : `📄 ${i}`).join('\n') };
  } catch (err: any) { return { ok: false, output: err.message }; }
}

export async function runTerminal(args: any, onConfirm: (c: string) => Promise<boolean>): Promise<ToolResult> {
  try {
    if (!await onConfirm(args.command)) return { ok: false, output: 'Rejected.' };
    const res = cp.execSync(args.command, { cwd: args.cwd ? resolvePath(args.cwd) : root() });
    return { ok: true, output: res.toString() };
  } catch (err: any) { return { ok: false, output: err.message }; }
}

export async function readSkill(args: any): Promise<ToolResult> {
  try {
    const p = vscode.workspace.getConfiguration('openollamagravity').get<string>('skillsPath', '');
    const target = path.join(p, args.name);
    return { ok: true, output: fs.readFileSync(target, 'utf8') };
  } catch (err: any) { return { ok: false, output: err.message }; }
}