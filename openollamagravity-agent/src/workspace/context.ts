// Copyright (c) 2026 Юрій Кучеренко. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root for full license information.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/** Gather compact workspace context: project type, key files, open file, selection */
export function gatherContext(): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return '';

  const lines: string[] = [];

  // Project metadata
  const pkgPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      lines.push(`Project: ${pkg.name ?? 'unknown'} (${pkg.version ?? '?'})`);
      const deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
      if (deps.length) lines.push(`Key deps: ${deps.slice(0, 12).join(', ')}`);
      if (pkg.scripts) {
        const scripts = Object.keys(pkg.scripts).slice(0, 8).join(', ');
        lines.push(`Scripts: ${scripts}`);
      }
    } catch { /* */ }
  }

  // Active file
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const rel = path.relative(root, editor.document.fileName);
    lines.push(`Active file: ${rel} (${editor.document.languageId})`);

    const sel = editor.selection;
    if (!sel.isEmpty) {
      const selText = editor.document.getText(sel);
      const preview = selText.slice(0, 400);
      lines.push(`Selected code:\n\`\`\`\n${preview}${selText.length > 400 ? '\n…' : ''}\n\`\`\``);
    }
  }

  return lines.join('\n');
}

/** Get currently open file content (capped at 200 lines) */
export function getActiveFileContent(): string {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return '';
  const doc = editor.document;
  const content = doc.getText();
  const lines = content.split('\n');
  const capped = lines.slice(0, 200);
  const suffix = lines.length > 200 ? `\n…(${lines.length - 200} more lines)` : '';
  return `\`\`\`${doc.languageId}\n${capped.join('\n')}${suffix}\n\`\`\``;
}