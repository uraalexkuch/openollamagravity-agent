// Copyright (c) 2026 Юрій Кучеренко. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root for full license information.

import * as vscode from 'vscode';
import { OllamaClient } from '../ollama/client';
import { AgentLoop, AgentEvent } from '../agent/agentLoop';
import { gatherContext } from '../workspace/context';
import * as Tools from '../agent/tools';
import * as fs from 'fs';

interface WebviewMessage {
  type: string;
  text?: string;
  lang?: string;
  model?: string;
  selectedSkills?: string[];
}

export class AgentPanel {
  static panels: AgentPanel[] = [];
  private readonly _panel: vscode.WebviewPanel;
  private _loop: AgentLoop;
  private _disposables: vscode.Disposable[] = [];
  private _agentListener: ((ev: AgentEvent) => void) | null = null;

  static show(extensionUri: vscode.Uri, ollama: OllamaClient, forceNew = false) {
    if (!forceNew && AgentPanel.panels.length > 0) {
      AgentPanel.panels[AgentPanel.panels.length - 1]._panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
        'openollamagravity.agent',
        '⚡ OpenOllamaGravity',
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'resources')],
        }
    );
    const newPanel = new AgentPanel(panel, ollama, extensionUri);
    AgentPanel.panels.push(newPanel);
  }

  private constructor(panel: vscode.WebviewPanel, ollama: OllamaClient, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._loop = new AgentLoop(ollama);

    const iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'icon.svg');
    const iconUri = panel.webview.asWebviewUri(iconPath);

    this._panel.webview.html = this._getHtml(extensionUri, iconUri);

    this._agentListener = (ev: AgentEvent) => {
      this._post({ type: 'agent_event', event: ev });
    };
    this._loop.on(this._agentListener);

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
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
            const activeModel = vscode.workspace.getConfiguration('openollamagravity').get<string>('model') || 'unknown';
            
            this._post({
              type: 'models_list',
              models: models.map(m => m.name),
              current: this._loop.model || activeModel,
              skills: skillsResult.map(s => ({ name: s.name, folderName: s.folderName, description: s.description }))
            });
          } catch { /* */ }
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

  private _post(msg: object) {
    try {
      this._panel.webview.postMessage(msg).then(null, console.error);
    } catch {
      // panel may already be disposed
    }
  }

  private async _runTask(task: string, language: string = 'Ukrainian', selectedSkills: string[] = []) {
    if (this._loop.running) {
      vscode.window.showWarningMessage('OpenOllamaGravity: agent is already running. Stop it first.');
      return;
    }

    const workspaceCtx = vscode.workspace.getConfiguration('openollamagravity').get('workspaceContext', true)
        ? gatherContext()
        : '';

    this._post({ type: 'task_start', text: task });

    vscode.commands.executeCommand('setContext', 'openollamagravity.running', true).then(null, console.error);
    await this._loop.run(task, [], workspaceCtx, language, '', selectedSkills);
    vscode.commands.executeCommand('setContext', 'openollamagravity.running', false).then(null, console.error);
  }

  private async _saveMarkdown(content: string) {
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
      } catch (err: any) {
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
    while (this._disposables.length) this._disposables.pop()?.dispose();

    if (AgentPanel.panels.length === 0) {
      vscode.commands.executeCommand('setContext', 'openollamagravity.panelOpen', false).then(null, console.error);
    }
    vscode.commands.executeCommand('setContext', 'openollamagravity.running', false).then(null, console.error);
  }

  private _getHtml(extensionUri: vscode.Uri, iconUri: vscode.Uri): string {
    const htmlPath = vscode.Uri.joinPath(extensionUri, 'resources', 'agentPanel.html').fsPath;
    let html = fs.readFileSync(htmlPath, 'utf8');
    return html.replace(/\${iconUri}/g, iconUri.toString());
  }
}
