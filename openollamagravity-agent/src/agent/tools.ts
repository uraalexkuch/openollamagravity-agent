// Copyright (c) 2026 Юрій Кучеренко.
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';

export interface ToolResult { ok: boolean; output: string; }

function resolvePath(p: string): string {
  if (!p) throw new Error('Path is required but received undefined.');
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  return path.isAbsolute(p) ? p : path.join(root, p);
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

export async function listFiles(args: any): Promise<ToolResult> {
  try {
    const base = resolvePath(args.path || '.');
    if (!fs.existsSync(base)) return { ok: false, output: 'Path not found.' };
    const items = fs.readdirSync(base).slice(0, 100);
    return { ok: true, output: items.map(i => fs.statSync(path.join(base, i)).isDirectory() ? `📁 ${i}/` : `📄 ${i}`).join('\n') };
  } catch (e: any) { return { ok: false, output: e.message }; }
}

export async function runTerminal(args: any, onConfirm: (c: string) => Promise<boolean>): Promise<ToolResult> {
  try {
    if (!args.command) return { ok: false, output: 'No command.' };
    if (!await onConfirm(args.command)) return { ok: false, output: 'Rejected.' };
    const res = cp.execSync(args.command, { cwd: args.cwd ? resolvePath(args.cwd) : (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '') });
    return { ok: true, output: res.toString() };
  } catch (e: any) { return { ok: false, output: e.message }; }
}

export async function listSkills(): Promise<ToolResult> {
  const p = vscode.workspace.getConfiguration('openollamagravity').get<string>('skillsPath', '');
  if (!p || !fs.existsSync(p)) return { ok: false, output: 'Skills not found.' };
  return { ok: true, output: fs.readdirSync(p, { recursive: true }).filter(f => (f as string).endsWith('.md')).join('\n') };
}

export async function readSkill(args: any): Promise<ToolResult> {
  const p = vscode.workspace.getConfiguration('openollamagravity').get<string>('skillsPath', '');
  return { ok: true, output: fs.readFileSync(path.join(p, args.name), 'utf8') };
}

export async function createDirectory(args: any): Promise<ToolResult> {
  try {
    fs.mkdirSync(resolvePath(args.path), { recursive: true });
    return { ok: true, output: `Created: ${args.path}` };
  } catch (e: any) { return { ok: false, output: e.message }; }
}

export async function readFile(args: any): Promise<ToolResult> {
  try {
    return { ok: true, output: fs.readFileSync(resolvePath(args.path), 'utf8') };
  } catch (e: any) { return { ok: false, output: e.message }; }
}