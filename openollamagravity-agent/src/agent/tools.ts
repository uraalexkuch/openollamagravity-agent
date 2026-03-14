// Copyright (c) 2026 Юрій Кучеренко. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root for full license information.

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';

export interface ToolResult {
  ok: boolean;
  output: string;
}

function root(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
}

function resolvePath(p: string): string {
  return path.isAbsolute(p) ? p : path.join(root(), p);
}

// ─────────────────────────────────────────────────────────
//  TOOL: read_file
// ─────────────────────────────────────────────────────────
export async function readFile(args: { path: string; start_line?: number; end_line?: number }): Promise<ToolResult> {
  try {
    const abs = resolvePath(args.path);
    if (!fs.existsSync(abs)) { return { ok: false, output: `File not found: ${args.path}` }; }
    const content = fs.readFileSync(abs, 'utf8');
    const lines = content.split('\n');
    const s = (args.start_line ?? 1) - 1;
    const e = args.end_line ?? lines.length;
    return { ok: true, output: `\`\`\`\n${lines.slice(s, e).join('\n')}\n\`\`\`` };
  } catch (err: any) {
    return { ok: false, output: err.message };
  }
}

// ─────────────────────────────────────────────────────────
//  TOOL: write_file
// ─────────────────────────────────────────────────────────
export async function writeFile(
    args: { path: string; content: string; mode?: 'overwrite' | 'append' },
    onConfirm: (path: string, content: string) => Promise<boolean>
): Promise<ToolResult> {
  try {
    const abs = resolvePath(args.path);
    const auto = vscode.workspace.getConfiguration('openollamagravity').get('autoApplyEdits', false);
    if (!auto) {
      const ok = await onConfirm(args.path, args.content);
      if (!ok) { return { ok: false, output: 'User rejected file write.' }; }
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (args.mode === 'append') {
      fs.appendFileSync(abs, args.content, 'utf8');
    } else {
      fs.writeFileSync(abs, args.content, 'utf8');
    }
    if (!auto) {
      const doc = await vscode.workspace.openTextDocument(abs);
      await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
    }
    return { ok: true, output: `Written ${args.path} (${args.content.split('\n').length} lines)` };
  } catch (err: any) {
    return { ok: false, output: err.message };
  }
}

// ─────────────────────────────────────────────────────────
//  TOOL: edit_file
// ─────────────────────────────────────────────────────────
export async function editFile(
    args: { path: string; start_line: number; end_line: number; new_content: string },
    onConfirm: (path: string, diff: string) => Promise<boolean>
): Promise<ToolResult> {
  try {
    const abs = resolvePath(args.path);
    if (!fs.existsSync(abs)) { return { ok: false, output: `File not found: ${args.path}` }; }
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    const newLines = args.new_content.split('\n');
    const diff = `Lines ${args.start_line}–${args.end_line} → ${newLines.length} lines`;
    const auto = vscode.workspace.getConfiguration('openollamagravity').get('autoApplyEdits', false);
    if (!auto) {
      const ok = await onConfirm(args.path, diff);
      if (!ok) { return { ok: false, output: 'User rejected edit.' }; }
    }
    lines.splice(args.start_line - 1, args.end_line - args.start_line + 1, ...newLines);
    fs.writeFileSync(abs, lines.join('\n'), 'utf8');
    if (!auto) {
      const doc = await vscode.workspace.openTextDocument(abs);
      await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
    }
    return { ok: true, output: `Edited ${args.path}: ${diff}` };
  } catch (err: any) {
    return { ok: false, output: err.message };
  }
}

// ─────────────────────────────────────────────────────────
//  TOOL: list_files
// ─────────────────────────────────────────────────────────
export async function listFiles(args: { path?: string; depth?: number }): Promise<ToolResult> {
  try {
    const base = resolvePath(args.path ?? '.');
    const maxDepth = args.depth ?? 3;

    function walk(dir: string, depth: number, prefix = ''): string[] {
      if (depth === 0) { return []; }
      const IGNORE = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', '__pycache__', '.venv', 'target']);
      const entries: string[] = [];
      try {
        const items = fs.readdirSync(dir).sort((a, b) => {
          const aIsDir = fs.statSync(path.join(dir, a)).isDirectory();
          const bIsDir = fs.statSync(path.join(dir, b)).isDirectory();
          if (aIsDir !== bIsDir) { return aIsDir ? -1 : 1; }
          return a.localeCompare(b);
        });
        for (const item of items) {
          if (IGNORE.has(item) || item.startsWith('.')) { continue; }
          const full = path.join(dir, item);
          const stat = fs.statSync(full);
          if (stat.isDirectory()) {
            entries.push(`${prefix}📁 ${item}/`);
            entries.push(...walk(full, depth - 1, prefix + '  '));
          } else {
            const size = stat.size < 1024 ? `${stat.size}b` : `${(stat.size / 1024).toFixed(1)}kb`;
            entries.push(`${prefix}📄 ${item} (${size})`);
          }
        }
      } catch { /* ignore */ }
      return entries;
    }

    const tree = walk(base, maxDepth);
    return { ok: true, output: tree.length === 0 ? 'Empty directory.' : tree.join('\n') };
  } catch (err: any) {
    return { ok: false, output: err.message };
  }
}

// ─────────────────────────────────────────────────────────
//  TOOL: run_terminal
// ─────────────────────────────────────────────────────────
export async function runTerminal(
    args: { command: string; cwd?: string },
    onConfirm: (cmd: string) => Promise<boolean>
): Promise<ToolResult> {
  const cfg = vscode.workspace.getConfiguration('openollamagravity');
  if (!cfg.get('terminalEnabled', true)) { return { ok: false, output: 'Terminal execution is disabled.' }; }

  const allowed: string[] = cfg.get('allowedShellCmds', ['npm', 'npx', 'node', 'python', 'git', 'tsc', 'ng', 'nest']);
  const cmdBase = args.command.trim().split(/\s+/)[0];
  if (!allowed.includes(cmdBase)) {
    return { ok: false, output: `Command "${cmdBase}" is not allowed. Add it to openollamagravity.allowedShellCmds.` };
  }

  const ok = await onConfirm(args.command);
  if (!ok) { return { ok: false, output: 'User rejected terminal command.' }; }

  const cwd = args.cwd ? resolvePath(args.cwd) : root();

  return new Promise((resolve) => {
    cp.exec(args.command, { cwd, timeout: 120_000, maxBuffer: 512 * 1024 }, (err, stdout, stderr) => {
      const out = [stdout, stderr].filter(Boolean).join('\n').trim();
      if (err && !out) {
        resolve({ ok: false, output: `Exit ${err.code}: ${err.message}` });
      } else {
        resolve({ ok: !err, output: out || '(no output)' });
      }
    });
  });
}

// ─────────────────────────────────────────────────────────
//  TOOL: list_skills
//  Показує лише .md файли з підпапки /skills репозиторію
// ─────────────────────────────────────────────────────────
export async function listSkills(): Promise<ToolResult> {
  const skillsPath = vscode.workspace.getConfiguration('openollamagravity').get<string>('skillsPath', '');

  if (!skillsPath) {
    return { ok: false, output: 'Skills path not configured. Reload VS Code window.' };
  }
  if (!fs.existsSync(skillsPath)) {
    return { ok: false, output: `Skills folder not found: ${skillsPath}\nTry reloading the window — skills may still be downloading.` };
  }

  try {
    function walk(dir: string, prefix = ''): string[] {
      const results: string[] = [];
      for (const file of fs.readdirSync(dir)) {
        if (file.startsWith('.')) { continue; }
        const full = path.join(dir, file);
        if (fs.statSync(full).isDirectory()) {
          results.push(...walk(full, prefix + file + '/'));
        } else if (file.toLowerCase().endsWith('.md')) {
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
  } catch (err: any) {
    return { ok: false, output: err.message };
  }
}

// ─────────────────────────────────────────────────────────
//  TOOL: read_skill
// ─────────────────────────────────────────────────────────
export async function readSkill(args: { name: string }): Promise<ToolResult> {
  const skillsPath = vscode.workspace.getConfiguration('openollamagravity').get<string>('skillsPath', '');
  if (!skillsPath) { return { ok: false, output: 'Skills path not configured.' }; }

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
  } catch (err: any) {
    return { ok: false, output: err.message };
  }
}

// ─────────────────────────────────────────────────────────
//  TOOL: get_diagnostics
// ─────────────────────────────────────────────────────────
export async function getDiagnostics(args: { path?: string }): Promise<ToolResult> {
  const all = vscode.languages.getDiagnostics();
  const lines: string[] = [];
  const filterPath = args.path ? resolvePath(args.path) : null;

  for (const [uri, diags] of all) {
    if (filterPath && uri.fsPath !== filterPath) { continue; }
    if (diags.length === 0) { continue; }
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
export async function getWorkspaceInfo(): Promise<ToolResult> {
  const r = root();
  if (!r) { return { ok: false, output: 'No workspace open.' }; }
  const info: Record<string, string> = { root: r };
  const pkgPath = path.join(r, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      info.type    = 'Node.js/JS';
      info.name    = pkg.name ?? 'unknown';
      info.version = pkg.version ?? '0.0.0';
    } catch { /* skip */ }
  }

  // Показуємо також шлях до скілів
  const skillsPath = vscode.workspace.getConfiguration('openollamagravity').get<string>('skillsPath', '');
  if (skillsPath) { info.skillsPath = skillsPath; }

  return { ok: true, output: Object.entries(info).map(([k, v]) => `${k}: ${v}`).join('\n') };
}