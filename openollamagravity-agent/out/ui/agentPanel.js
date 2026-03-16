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
exports.AgentPanel = void 0;
const vscode = __importStar(require("vscode"));
const agentLoop_1 = require("../agent/agentLoop");
const context_1 = require("../workspace/context");
const Tools = __importStar(require("../agent/tools"));
const fs = __importStar(require("fs"));
class AgentPanel {
    static show(extensionUri, ollama, forceNew = false, initialTask) {
        if (!forceNew && AgentPanel.panels.length > 0) {
            const p = AgentPanel.panels[AgentPanel.panels.length - 1];
            if (initialTask) {
                p._initialTask = initialTask;
                p._panel.reveal(vscode.ViewColumn.Beside);
                p._post({ type: 'ready' }); // Trigger re-read of skills/models and potential initial task
            }
            else {
                p._panel.reveal(vscode.ViewColumn.Beside);
            }
            return;
        }
        const panel = vscode.window.createWebviewPanel('openollamagravity.agent', '⚡ OpenOllamaGravity', vscode.ViewColumn.Beside, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'resources')],
        });
        const newPanel = new AgentPanel(panel, ollama, extensionUri, initialTask);
        AgentPanel.panels.push(newPanel);
    }
    constructor(panel, ollama, extensionUri, initialTask) {
        this._disposables = [];
        this._agentListener = null;
        this._panel = panel;
        this._loop = new agentLoop_1.AgentLoop(ollama);
        this._initialTask = initialTask;
        const iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'icon.svg');
        const iconUri = panel.webview.asWebviewUri(iconPath);
        this._panel.webview.html = this._getHtml(extensionUri, iconUri);
        this._agentListener = (ev) => {
            this._post({ type: 'agent_event', event: ev });
        };
        this._loop.on(this._agentListener);
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case 'run_task':
                    if (msg.text) {
                        await this._runTask(msg.text, msg.lang || 'Ukrainian', msg.selectedSkills || []);
                    }
                    break;
                case 'stop':
                    this._loop.stop();
                    this._post({ type: 'stopped' });
                    break;
                case 'clear':
                    this._loop.clearHistory();
                    break;
                case 'ready':
                    try {
                        const models = await ollama.listModels();
                        const skillsResult = await Tools.getAllSkills();
                        // FALLBACK TO ACTIVE MODEL IN SETTINGS
                        const activeModel = vscode.workspace.getConfiguration('openollamagravity').get('model') || 'unknown';
                        this._post({
                            type: 'models_list',
                            models: models.map(m => m.name),
                            current: this._loop.model || activeModel,
                            skills: skillsResult.map(s => ({ name: s.name, folderName: s.folderName, description: s.description }))
                        });
                        if (this._initialTask) {
                            const task = this._initialTask;
                            this._initialTask = undefined;
                            await this._runTask(task);
                        }
                    }
                    catch { /* */ }
                    break;
                case 'set_model':
                    this._loop.model = msg.model;
                    break;
                case 'save_markdown':
                    if (msg.text) {
                        await this._saveMarkdown(msg.text);
                    }
                    break;
            }
        }, null, this._disposables);
        vscode.commands.executeCommand('setContext', 'openollamagravity.panelOpen', true).then(null, console.error);
    }
    _post(msg) {
        try {
            this._panel.webview.postMessage(msg).then(null, console.error);
        }
        catch {
            // panel may already be disposed
        }
    }
    async _runTask(task, language = 'Ukrainian', selectedSkills = []) {
        if (this._loop.running) {
            vscode.window.showWarningMessage('OpenOllamaGravity: agent is already running. Stop it first.');
            return;
        }
        const workspaceCtx = vscode.workspace.getConfiguration('openollamagravity').get('workspaceContext', true)
            ? (0, context_1.gatherContext)()
            : '';
        this._post({ type: 'task_start', text: task });
        vscode.commands.executeCommand('setContext', 'openollamagravity.running', true).then(null, console.error);
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        await this._loop.run(task, [], workspaceCtx, language, workspaceRoot, selectedSkills);
        vscode.commands.executeCommand('setContext', 'openollamagravity.running', false).then(null, console.error);
    }
    async _saveMarkdown(content) {
        const defaultUri = vscode.workspace.workspaceFolders?.[0]?.uri
            ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'report.md')
            : undefined;
        const uri = await vscode.window.showSaveDialog({
            defaultUri,
            filters: { 'Markdown Files': ['md'], 'All Files': ['*'] },
            title: 'Save Report / Documentation'
        });
        if (uri) {
            try {
                await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
                vscode.window.showInformationMessage('Markdown файл успішно збережено!');
            }
            catch (err) {
                vscode.window.showErrorMessage('Помилка при збереженні файлу: ' + err.message);
            }
        }
    }
    dispose() {
        if (this._agentListener) {
            this._loop.off(this._agentListener);
            this._agentListener = null;
        }
        this._loop.stop();
        AgentPanel.panels = AgentPanel.panels.filter(p => p !== this);
        this._panel.dispose();
        while (this._disposables.length)
            this._disposables.pop()?.dispose();
        if (AgentPanel.panels.length === 0) {
            vscode.commands.executeCommand('setContext', 'openollamagravity.panelOpen', false).then(null, console.error);
        }
        vscode.commands.executeCommand('setContext', 'openollamagravity.running', false).then(null, console.error);
    }
    _getHtml(extensionUri, iconUri) {
        const htmlPath = vscode.Uri.joinPath(extensionUri, 'resources', 'agentPanel.html').fsPath;
        let html = fs.readFileSync(htmlPath, 'utf8');
        return html.replace(/\${iconUri}/g, iconUri.toString());
    }
}
exports.AgentPanel = AgentPanel;
AgentPanel.panels = [];
