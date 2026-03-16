// Copyright (c) 2026 Юрій Кучеренко. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root for full license information.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as os from 'os';
import * as http from 'http';
import * as https from 'https';
import { OllamaClient } from './ollama/client';
import { AgentPanel } from './ui/agentPanel';
import { InlineCompletionProvider } from './inlineCompletion';

let statusBar: vscode.StatusBarItem;

/** Повертає папку Документи незалежно від ОС */
function getDocumentsPath(): string {
  return path.join(os.homedir(), 'Documents');
}

/** Рекурсивно рахує кількість .md файлів у папці */
function countSkillFiles(dir: string): number {
  let count = 0;
  try {
    for (const entry of fs.readdirSync(dir)) {
      if (entry.startsWith('.')) { continue; }
      const full = path.join(dir, entry);
      if (fs.statSync(full).isDirectory()) {
        count += countSkillFiles(full);
      } else if (entry.toLowerCase().endsWith('.md')) {
        count++;
      }
    }
  } catch { /* ignore permission errors */ }
  return count;
}

/** Українське закінчення для слова "скіл" */
function pluralUk(n: number): string {
  if (n % 10 === 1 && n % 100 !== 11) { return ''; }
  if (n % 10 >= 2 && n % 10 <= 4 && !(n % 100 >= 12 && n % 100 <= 14)) { return 'и'; }
  return 'ів';
}

async function syncSkills(
    repoPath: string,
    skillsPath: string,
    context: vscode.ExtensionContext
): Promise<void> {
  return new Promise<void>((resolve) => {
    cp.exec('git --version', (gitCheckErr) => {
      if (gitCheckErr) {
        vscode.window.showWarningMessage('OOG: git не знайдено — скіли не можуть бути завантажені.');
        resolve();
        return;
      }

      const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true' };
      const needsClone = !fs.existsSync(repoPath);
      const title = needsClone ? 'OOG: Завантаження скілів...' : 'OOG: Оновлення скілів...';

      vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title },
          () =>
              new Promise<void>((done) => {
                const cmd = needsClone
                    ? `git clone https://github.com/sickn33/antigravity-awesome-skills.git "${repoPath}"`
                    : `git -C "${repoPath}" pull`;

                cp.exec(cmd, { env }, (err, stdout) => {
                  if (err) {
                    console.error('[OOG] skills sync error:', err.message);
                    vscode.window.showErrorMessage(`OOG: Помилка синхронізації скілів — ${err.message}`);
                    done();
                    resolve();
                    return;
                  }

                  context.globalState.update('oog.skills_initialized', true);

                  // Рахуємо скіли з підпапки /skills
                  const count = fs.existsSync(skillsPath) ? countSkillFiles(skillsPath) : 0;
                  const shortPath = skillsPath.replace(os.homedir(), '~');

                  const alreadyUpToDate =
                      !needsClone &&
                      (stdout.includes('Already up to date') || stdout.includes('Already up-to-date'));

                  if (!alreadyUpToDate) {
                    const action = needsClone ? 'Завантажено' : 'Оновлено';
                    vscode.window
                        .showInformationMessage(
                            `OOG Skills: ${action} ${count} скіл${pluralUk(count)} 📚\n📁 ${shortPath}`,
                            'Показати папку'
                        )
                        .then((choice) => {
                          if (choice === 'Показати папку') {
                            vscode.commands.executeCommand(
                                'revealFileInOS',
                                vscode.Uri.file(skillsPath)
                            );
                          }
                        });
                  }

                  if (statusBar) {
                    statusBar.tooltip = `Skills: ${count} файлів\n📁 ${shortPath}`;
                  }

                  done();
                  resolve();
                });
              })
      );
    });
  });
}

export async function activate(context: vscode.ExtensionContext) {
  const documentsPath = getDocumentsPath();

  // Репозиторій цілком
  const repoPath   = path.join(documentsPath, 'antigravity-awesome-skills');
  // Підпапка з реальними скілами
  const skillsPath = path.join(repoPath, 'skills');

  if (!fs.existsSync(documentsPath)) {
    fs.mkdirSync(documentsPath, { recursive: true });
  }

  // Зберігаємо шлях до підпапки /skills — саме його використовують list_skills / read_skill
  await vscode.workspace
      .getConfiguration('openollamagravity')
      .update('skillsPath', skillsPath, vscode.ConfigurationTarget.Global);

  syncSkills(repoPath, skillsPath, context).catch(console.error);

  const ollamaUrl = vscode.workspace.getConfiguration('openollamagravity').get<string>('ollamaUrl', 'http://127.0.0.1:11434');
  const ollama = new OllamaClient(ollamaUrl);
  
  // Намагаємося підтягнути оптимальну модель або дефолтну з налаштувань
  ollama.findOptimalModel().then(async optimalModel => {
    const activeModel = vscode.workspace.getConfiguration('openollamagravity').get<string>('model');
    if (!activeModel && optimalModel) {
        await vscode.workspace.getConfiguration('openollamagravity').update('model', optimalModel, vscode.ConfigurationTarget.Global);
    }
  });


  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'openollamagravity.selectModel';

  // Одразу показуємо тултіп якщо скіли вже є
  if (fs.existsSync(skillsPath)) {
    const count = countSkillFiles(skillsPath);
    const shortPath = skillsPath.replace(os.homedir(), '~');
    statusBar.tooltip = `Skills: ${count} файлів\n📁 ${shortPath}`;
  }

  context.subscriptions.push(statusBar);
  refreshStatus(ollama).catch(console.error);

  context.subscriptions.push(
      vscode.languages.registerInlineCompletionItemProvider(
          { pattern: '**' },
          new InlineCompletionProvider(ollama)
      )
  );

  reg(context, 'openollamagravity.openAgent', () => AgentPanel.show(context.extensionUri, ollama));
  reg(context, 'openollamagravity.newTask',   () => AgentPanel.show(context.extensionUri, ollama, true));
  reg(context, 'openollamagravity.stopAgent', () => [...AgentPanel.panels].forEach(p => p.dispose()));

  reg(context, 'openollamagravity.selectModel', async () => {
    let models: string[] = [];
    try {
      const list = await ollama.listModels();
      models = list.map((m: any) => m.name);
    } catch { return; }
    
    const activeModel = vscode.workspace.getConfiguration('openollamagravity').get<string>('model');

    const items = models.map(name => ({
      label: name === activeModel ? `$(check) ${name}` : name,
    }));
    const picked = await vscode.window.showQuickPick(items, { title: 'Оберіть модель' });
    if (picked) {
      const name = picked.label.replace(/^\$\(check\) /, '');
      await vscode.workspace
          .getConfiguration('openollamagravity')
          .update('model', name, vscode.ConfigurationTarget.Global);
      refreshStatus(ollama).catch(console.error);
    }
  });
}

function reg(ctx: vscode.ExtensionContext, id: string, fn: () => unknown) {
  ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
}

async function refreshStatus(ollama: OllamaClient) {
  let up = false;
  try {
     const list = await ollama.listModels();
     up = list.length > 0;
  } catch (e) {
      up = false;
  }
  
  const activeModel = vscode.workspace.getConfiguration('openollamagravity').get<string>('model') || 'unknown model';

  // Перевіряємо Perplexica (web_search) без блокування
  const perplexicaUrl = vscode.workspace
      .getConfiguration('openollamagravity')
      .get<string>('perplexicaUrl', 'http://localhost:3030');

  // Спочатку показуємо базовий статус (до відповіді Perplexica)
  statusBar.text = up ? `⚡ ${activeModel}` : `⚡ Ollama offline`;
  statusBar.show();

  // Після отримання статусу Perplexica — оновлюємо один раз
  checkPerplexicaAvailable(perplexicaUrl).then(perplexicaUp => {
    const webIcon = perplexicaUp ? ' 🌐' : '';
    statusBar.text = up ? `⚡ ${activeModel}${webIcon}` : `⚡ Ollama offline`;
    if (statusBar.tooltip && perplexicaUp) {
      statusBar.tooltip += `\nPerplexica: ${perplexicaUrl}`;
    }
  });
}

function checkPerplexicaAvailable(baseUrl: string): Promise<boolean> {
  return new Promise(resolve => {
    try {
      const url = new URL('/api/config', baseUrl);
      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.get(
          { hostname: url.hostname, port: url.port || 3030, path: url.pathname, timeout: 2000 },
          (res: any) => resolve(res.statusCode < 500)
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    } catch { resolve(false); }
  });
}

export function deactivate() { statusBar?.dispose(); }
