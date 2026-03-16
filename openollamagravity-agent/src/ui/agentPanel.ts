// Copyright (c) 2026 Юрій Кучеренко. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root for full license information.

import * as vscode from 'vscode';
import * as fs     from 'fs';
import * as path   from 'path';
import { OllamaClient } from '../ollama/client';
import { AgentLoop, AgentEvent } from '../agent/agentLoop';
import { gatherContext } from '../workspace/context';
import * as Tools from '../agent/tools';

interface WebviewMessage {
  type:            string;
  text?:           string;
  lang?:           string;
  model?:          string;
  selectedSkills?: string[];
}

export class AgentPanel {
  static panels: AgentPanel[] = [];
  private readonly _panel:        vscode.WebviewPanel;
  private          _loop:         AgentLoop;
  private          _disposables:  vscode.Disposable[] = [];
  private          _agentListener: ((ev: AgentEvent) => void) | null = null;
  private          _ollama:       OllamaClient;

  // ── Static API ──────────────────────────────────────────────────

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
          enableScripts:          true,
          retainContextWhenHidden: true,
          localResourceRoots:     [vscode.Uri.joinPath(extensionUri, 'resources')],
        },
    );
    AgentPanel.panels.push(new AgentPanel(panel, ollama, extensionUri));
  }

  static sendTask(extensionUri: vscode.Uri, ollama: OllamaClient, task: string) {
    if (AgentPanel.panels.length === 0) AgentPanel.show(extensionUri, ollama);
    AgentPanel.panels[AgentPanel.panels.length - 1]?._runTask(task);
  }

  // ── Constructor ─────────────────────────────────────────────────

  private constructor(
      panel:        vscode.WebviewPanel,
      ollama:       OllamaClient,
      extensionUri: vscode.Uri,
  ) {
    this._panel  = panel;
    this._loop   = new AgentLoop(ollama);
    this._ollama = ollama;

    const iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'icon.svg');
    const iconUri  = panel.webview.asWebviewUri(iconPath);

    this._panel.webview.html = this._getHtml(extensionUri, iconUri);

    this._agentListener = (ev: AgentEvent) => this._post({ type: 'agent_event', event: ev });
    this._loop.on(this._agentListener);

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
      switch (msg.type) {

        case 'run_task':
          if (msg.text) await this._runTask(msg.text, msg.lang ?? 'Ukrainian', msg.selectedSkills ?? []);
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
            const skills = await Tools.getAllSkills();
            this._post({
              type:    'models_list',
              models:  models.map(m => m.name),
              current: this._loop.model || this._configuredModel(),
              skills:  skills.map(s => ({ name: s.name, folderName: s.folderName, description: s.description })),
            });
          } catch { /* server may be offline */ }
          break;

        case 'set_model':
          this._loop.model = msg.model;
          break;

        case 'save_markdown':
          if (msg.text) await this._saveMarkdown(msg.text);
          break;

        case 'auto_select_model':
          try {
            const optimal = await this._ollama.findOptimalModel();
            if (optimal) {
              await vscode.workspace.getConfiguration('openollamagravity')
                  .update('model', optimal, vscode.ConfigurationTarget.Global);
              this._loop.model = optimal;
              vscode.window.showInformationMessage(`🤖 OOG: Автоматично обрано оптимальну модель: ${optimal}`);
              const models = await this._ollama.listModels();
              const skills = await Tools.getAllSkills();
              this._post({
                type:    'models_list',
                models:  models.map(m => m.name),
                current: optimal,
                skills:  skills.map(s => ({ name: s.name, folderName: s.folderName, description: s.description })),
              });
            } else {
              vscode.window.showErrorMessage('OOG: Моделі не знайдено на сервері Ollama.');
            }
          } catch (e: any) {
            vscode.window.showErrorMessage(`OOG: Помилка автовибору: ${e.message}`);
          }
          break;

        case 'run_chatdev': {
          const targetDir = await vscode.window.showInputBox({
            prompt:      'Введіть шлях до папки для результатів ChatDev',
            value:       './chatdev-feature',
            placeHolder: 'Наприклад: ./src/components/NewFeature',
          });
          if (!targetDir) {
            vscode.window.showInformationMessage('OOG: Запуск ChatDev скасовано (не вказано папку).');
            return;
          }

          const forcedPrompt =
              `[DIRECTIVE]: Execute the ChatDev virtual team process.\n` +
              `Task: ${msg.text}\n\n` +
              `CRITICAL INSTRUCTION: You MUST immediately and ONLY output a <tool_call> for "run_chatdev_team".\n` +
              `Set the "task" parameter to the user's task described above.\n` +
              `Set the "output_dir" parameter strictly to: "${targetDir}".\n` +
              `Do not write any other text or explanations before calling the tool.`;

          const displayMsg = `🏢 **ChatDev Task:** ${msg.text}\n📂 **Target Folder:** \`${targetDir}\``;
          this._post({ type: 'task_start', text: displayMsg });
          await this._runTask(forcedPrompt, msg.lang ?? 'Ukrainian', msg.selectedSkills ?? []);
          break;
        }
      }
    }, null, this._disposables);

    vscode.commands.executeCommand('setContext', 'openollamagravity.panelOpen', true);
  }

  // ── Private helpers ──────────────────────────────────────────────

  private _post(msg: object) {
    try { this._panel.webview.postMessage(msg); } catch { /* panel disposed */ }
  }

  private async _runTask(task: string, language = 'Ukrainian', selectedSkills: string[] = []) {
    if (this._loop.running) {
      vscode.window.showWarningMessage('OpenOllamaGravity: agent is already running. Stop it first.');
      return;
    }

    const workspaceCtx = vscode.workspace.getConfiguration('openollamagravity').get('workspaceContext', true)
        ? await gatherContext()
        : '';

    // Only post task_start for regular tasks; ChatDev posts it itself
    if (!task.startsWith('[DIRECTIVE]: Execute the ChatDev')) {
      this._post({ type: 'task_start', text: task });
    }

    vscode.commands.executeCommand('setContext', 'openollamagravity.running', true);
    await this._loop.run(task, [], workspaceCtx, language, '', selectedSkills);
    vscode.commands.executeCommand('setContext', 'openollamagravity.running', false);
  }

  private async _saveMarkdown(content: string) {
    const defaultUri = vscode.workspace.workspaceFolders?.[0]?.uri
        ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'report.md')
        : undefined;

    const uri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { 'Markdown Files': ['md'], 'All Files': ['*'] },
      title:   'Save Report / Documentation',
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

  /** Read the model name that is currently saved in VS Code settings. */
  private _configuredModel(): string {
    return vscode.workspace.getConfiguration('openollamagravity').get<string>('model', '');
  }

  /**
   * Load agentPanel.html from disk and substitute the icon URI placeholder.
   * Using a separate HTML file avoids duplicating a large template literal here
   * and keeps the HTML editable without touching TypeScript.
   */
  private _getHtml(extensionUri: vscode.Uri, iconUri: vscode.Uri): string {
    const htmlPath = path.join(extensionUri.fsPath, 'resources', 'agentPanel.html');
    const raw      = fs.readFileSync(htmlPath, 'utf8');
    // Replace the {{ICON_URI}} placeholder inserted in agentPanel.html
    return raw.replace('{{ICON_URI}}', iconUri.toString());
  }

  // ── Dispose ──────────────────────────────────────────────────────

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
      vscode.commands.executeCommand('setContext', 'openollamagravity.panelOpen', false);
    }
    vscode.commands.executeCommand('setContext', 'openollamagravity.running', false);
  }
}