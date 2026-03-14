"use strict";
// Copyright (c) 2026 Юрій Кучеренко. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root for full license information.
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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const cp = __importStar(require("child_process"));
const os = __importStar(require("os"));
const client_1 = require("./ollama/client");
const agentPanel_1 = require("./ui/agentPanel");
const inlineCompletion_1 = require("./inlineCompletion");
let statusBar;
/** Повертає папку Документи незалежно від ОС */
function getDocumentsPath() {
    return path.join(os.homedir(), 'Documents');
}
/** Рекурсивно рахує кількість .md файлів у папці */
function countSkillFiles(dir) {
    let count = 0;
    try {
        for (const entry of fs.readdirSync(dir)) {
            if (entry.startsWith('.')) {
                continue;
            }
            const full = path.join(dir, entry);
            if (fs.statSync(full).isDirectory()) {
                count += countSkillFiles(full);
            }
            else if (entry.toLowerCase().endsWith('.md')) {
                count++;
            }
        }
    }
    catch { /* ignore permission errors */ }
    return count;
}
/** Українське закінчення для слова "скіл" */
function pluralUk(n) {
    if (n % 10 === 1 && n % 100 !== 11) {
        return '';
    }
    if (n % 10 >= 2 && n % 10 <= 4 && !(n % 100 >= 12 && n % 100 <= 14)) {
        return 'и';
    }
    return 'ів';
}
async function syncSkills(repoPath, skillsPath, isFirstRun, context) {
    return new Promise((resolve) => {
        cp.exec('git --version', (gitCheckErr) => {
            if (gitCheckErr) {
                vscode.window.showWarningMessage('OOG: git не знайдено — скіли не можуть бути завантажені.');
                resolve();
                return;
            }
            const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true' };
            const needsClone = !fs.existsSync(repoPath);
            const title = needsClone ? 'OOG: Завантаження скілів...' : 'OOG: Оновлення скілів...';
            vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, () => new Promise((done) => {
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
                    const alreadyUpToDate = !needsClone &&
                        (stdout.includes('Already up to date') || stdout.includes('Already up-to-date'));
                    if (!alreadyUpToDate) {
                        const action = needsClone ? 'Завантажено' : 'Оновлено';
                        vscode.window
                            .showInformationMessage(`OOG Skills: ${action} ${count} скіл${pluralUk(count)} 📚\n📁 ${shortPath}`, 'Показати папку')
                            .then((choice) => {
                            if (choice === 'Показати папку') {
                                vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(skillsPath));
                            }
                        });
                    }
                    if (statusBar) {
                        statusBar.tooltip = `Skills: ${count} файлів\n📁 ${shortPath}`;
                    }
                    done();
                    resolve();
                });
            }));
        });
    });
}
async function activate(context) {
    const documentsPath = getDocumentsPath();
    // Репозиторій цілком
    const repoPath = path.join(documentsPath, 'antigravity-awesome-skills');
    // Підпапка з реальними скілами
    const skillsPath = path.join(repoPath, 'skills');
    if (!fs.existsSync(documentsPath)) {
        fs.mkdirSync(documentsPath, { recursive: true });
    }
    // Зберігаємо шлях до підпапки /skills — саме його використовують list_skills / read_skill
    await vscode.workspace
        .getConfiguration('openollamagravity')
        .update('skillsPath', skillsPath, vscode.ConfigurationTarget.Global);
    const isFirstRun = !context.globalState.get('oog.skills_initialized', false);
    syncSkills(repoPath, skillsPath, isFirstRun, context).catch(console.error);
    const ollama = new client_1.OllamaClient();
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
    context.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, new inlineCompletion_1.InlineCompletionProvider(ollama)));
    reg(context, 'openollamagravity.openAgent', () => agentPanel_1.AgentPanel.show(context.extensionUri, ollama));
    reg(context, 'openollamagravity.newTask', () => agentPanel_1.AgentPanel.show(context.extensionUri, ollama, true));
    reg(context, 'openollamagravity.stopAgent', () => [...agentPanel_1.AgentPanel.panels].forEach(p => p.dispose()));
    reg(context, 'openollamagravity.selectModel', async () => {
        let models = [];
        try {
            const list = await ollama.listModels();
            models = list.map(m => m.name);
        }
        catch {
            return;
        }
        const items = models.map(name => ({
            label: name === ollama.model ? `$(check) ${name}` : name,
        }));
        const picked = await vscode.window.showQuickPick(items, { title: 'Оберіть модель' });
        if (picked) {
            const name = picked.label.replace(/^\$\(check\) /, '');
            await vscode.workspace
                .getConfiguration('openollamagravity')
                .update('model', name, vscode.ConfigurationTarget.Global);
            refreshStatus(ollama);
        }
    });
}
function reg(ctx, id, fn) {
    ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
}
async function refreshStatus(ollama) {
    const up = await ollama.isAvailable();
    statusBar.text = up ? `⚡ ${ollama.model}` : `⚡ Ollama offline`;
    statusBar.show();
}
function deactivate() { statusBar?.dispose(); }
