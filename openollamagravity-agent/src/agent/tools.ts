// Copyright (c) 2026 Юрій Кучеренко. All rights reserved.

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';

export interface ToolResult { ok: boolean; output: string; }

function root() { return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ''; }

function resolvePath(p: string): string {
  if (!p) throw new Error('Path is required but received undefined.');
  return path.isAbsolute(p) ? p : path.join(root(), p);
}

export async function writeFile(args: any, onConfirm: (p: string) => Promise<boolean>): Promise<ToolResult> {
  try {
    if (!args.path) return { ok: false, output: 'Error: "path" argument is missing.' };
    const abs = resolvePath(args.path);
    if (!await onConfirm(args.path)) return { ok: false, output: 'Rejected.' };
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, args.content || '', 'utf8');
    return { ok: true, output: `Successfully written to ${args.path}` };
  } catch (err: any) { return { ok: false, output: err.message }; }
}

export async function listFiles(args: any): Promise<ToolResult> {
  try {
    const base = resolvePath(args.path || '.');
    const items = fs.readdirSync(base).slice(0, 100);
    return { ok: true, output: items.map(i => fs.statSync(path.join(base, i)).isDirectory() ? `📁 ${i}/` : `📄 ${i}`).join('\n') };
  } catch (err: any) { return { ok: false, output: err.message }; }
}

export async function readFile(args: any): Promise<ToolResult> {
  try {
    const abs = resolvePath(args.path);
    return { ok: true, output: fs.readFileSync(abs, 'utf8') };
  } catch (err: any) { return { ok: false, output: err.message }; }
}

export async function runTerminal(args: any, onConfirm: (c: string) => Promise<boolean>): Promise<ToolResult> {
  try {
    if (!await onConfirm(args.command)) return { ok: false, output: 'Rejected.' };
    const res = cp.execSync(args.command, { cwd: args.cwd ? resolvePath(args.cwd) : root() });
    return { ok: true, output: res.toString() };
  } catch (err: any) { return { ok: false, output: err.message }; }
}

export async function listSkills(): Promise<ToolResult> {
  const p = vscode.workspace.getConfiguration('openollamagravity').get<string>('skillsPath', '');
  if (!p || !fs.existsSync(p)) return { ok: false, output: 'Skills not found.' };
  return { ok: true, output: fs.readdirSync(p).join('\n') };
}

export async function readSkill(args: any): Promise<ToolResult> {
  const p = vscode.workspace.getConfiguration('openollamagravity').get<string>('skillsPath', '');
  return { ok: true, output: fs.readFileSync(path.join(p, args.name), 'utf8') };
}

export async function editFile(args: any, onConfirm: (p: string) => Promise<boolean>): Promise<ToolResult> {
  try {
    const abs = resolvePath(args.path);
    if (!await onConfirm(args.path)) return { ok: false, output: 'Rejected.' };
    const content = fs.readFileSync(abs, 'utf8').split('\n');
    content.splice(args.start_line - 1, args.end_line - args.start_line + 1, args.new_content);
    fs.writeFileSync(abs, content.join('\n'), 'utf8');
    return { ok: true, output: 'Edited.' };
  } catch (err: any) { return { ok: false, output: err.message }; }
}