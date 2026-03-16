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
const http = __importStar(require("http"));
const https = __importStar(require("https"));
const client_1 = require("./ollama/client");
const agentPanel_1 = require("./ui/agentPanel");
const inlineCompletion_1 = require("./inlineCompletion");
const context_1 = require("./workspace/context");
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
async function syncSkills(repoPath, skillsPath, context) {
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
    syncSkills(repoPath, skillsPath, context).catch(console.error);
    const ollamaUrl = vscode.workspace.getConfiguration('openollamagravity').get('ollamaUrl', 'http://127.0.0.1:11434');
    const ollama = new client_1.OllamaClient(ollamaUrl);
    // Намагаємося підтягнути оптимальну модель або дефолтну з налаштувань
    ollama.findOptimalModel().then(async (optimalModel) => {
        const activeModel = vscode.workspace.getConfiguration('openollamagravity').get('model');
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
    context.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, new inlineCompletion_1.InlineCompletionProvider(ollama)));
    reg(context, 'openollamagravity.openAgent', () => agentPanel_1.AgentPanel.show(context.extensionUri, ollama));
    reg(context, 'openollamagravity.newTask', () => agentPanel_1.AgentPanel.show(context.extensionUri, ollama, true));
    reg(context, 'openollamagravity.stopAgent', () => [...agentPanel_1.AgentPanel.panels].forEach(p => p.dispose()));
    reg(context, 'openollamagravity.explainFile', () => {
        const ctx = (0, context_1.gatherContext)();
        const content = (0, context_1.getActiveFileContent)();
        const prompt = `Поясни структуру та логіку цього файлу:\n\n${content}\n\nКонтекст:\n${ctx}`;
        agentPanel_1.AgentPanel.show(context.extensionUri, ollama, false, prompt);
    });
    reg(context, 'openollamagravity.fixSelection', () => {
        const ctx = (0, context_1.gatherContext)();
        const prompt = `Знайди та виправ помилки у виділеному коді. Поясни, що було не так і як ти це виправив.\n\nКонтекст:\n${ctx}`;
        agentPanel_1.AgentPanel.show(context.extensionUri, ollama, false, prompt);
    });
    reg(context, 'openollamagravity.refactor', () => {
        const ctx = (0, context_1.gatherContext)();
        const prompt = `Зроби рефакторинг виділеного коду: покращи читабельність, оптимізуй логіку, дотримуйся чистих паттернів (Clean Code).\n\nКонтекст:\n${ctx}`;
        agentPanel_1.AgentPanel.show(context.extensionUri, ollama, false, prompt);
    });
    reg(context, 'openollamagravity.writeTests', () => {
        const ctx = (0, context_1.gatherContext)();
        const prompt = `Напиши Unit-тести для виділеного коду (використовуй Jest або Mocha, якщо не вказано інше).\n\nКонтекст:\n${ctx}`;
        agentPanel_1.AgentPanel.show(context.extensionUri, ollama, false, prompt);
    });
    reg(context, 'openollamagravity.implement', () => {
        const ctx = (0, context_1.gatherContext)();
        const prompt = `Реалізуй функціонал на основі коментарів або стабів у виділеному коді.\n\nКонтекст:\n${ctx}`;
        agentPanel_1.AgentPanel.show(context.extensionUri, ollama, false, prompt);
    });
    reg(context, 'openollamagravity.syncSkills', () => {
        syncSkills(repoPath, skillsPath, context).catch(console.error);
    });
    reg(context, 'openollamagravity.selectModel', async () => {
        let models = [];
        try {
            const list = await ollama.listModels();
            models = list.map((m) => m.name);
        }
        catch {
            return;
        }
        const activeModel = vscode.workspace.getConfiguration('openollamagravity').get('model');
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
function reg(ctx, id, fn) {
    ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
}
async function refreshStatus(ollama) {
    let up = false;
    try {
        const list = await ollama.listModels();
        up = list.length > 0;
    }
    catch (e) {
        up = false;
    }
    const activeModel = vscode.workspace.getConfiguration('openollamagravity').get('model') || 'unknown model';
    // Перевіряємо Perplexica (web_search) без блокування
    const perplexicaUrl = vscode.workspace
        .getConfiguration('openollamagravity')
        .get('perplexicaUrl', 'http://localhost:3030');
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
function checkPerplexicaAvailable(baseUrl) {
    return new Promise(resolve => {
        try {
            const url = new URL('/api/config', baseUrl);
            const lib = url.protocol === 'https:' ? https : http;
            const req = lib.get({ hostname: url.hostname, port: url.port || 3030, path: url.pathname, timeout: 2000 }, (res) => resolve(res.statusCode < 500));
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
        }
        catch {
            resolve(false);
        }
    });
}
function deactivate() { statusBar?.dispose(); }
