"use strict";
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
class AgentPanel {
    static show(extensionUri, ollama, forceNew = false) {
        if (!forceNew && AgentPanel.panels.length > 0) {
            AgentPanel.panels[AgentPanel.panels.length - 1]._panel.reveal(vscode.ViewColumn.Beside);
            return;
        }
        const panel = vscode.window.createWebviewPanel('openollamagravity.agent', '⚡ OpenOllamaGravity', vscode.ViewColumn.Beside, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'resources')],
        });
        const newPanel = new AgentPanel(panel, ollama, extensionUri);
        AgentPanel.panels.push(newPanel);
    }
    static sendTask(extensionUri, ollama, task) {
        if (AgentPanel.panels.length === 0) {
            AgentPanel.show(extensionUri, ollama);
        }
        AgentPanel.panels[AgentPanel.panels.length - 1]?._runTask(task);
    }
    constructor(panel, ollama, extensionUri) {
        this._disposables = [];
        this._agentListener = null;
        this._panel = panel;
        this._loop = new agentLoop_1.AgentLoop(ollama);
        const iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'icon.svg');
        const iconUri = panel.webview.asWebviewUri(iconPath);
        this._panel.webview.html = this._getHtml(iconUri);
        this._agentListener = (ev) => {
            this._post({ type: 'agent_event', event: ev });
        };
        this._loop.on(this._agentListener);
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case 'task':
                    if (msg.text && msg.text.trim()) {
                        await this._runTask(msg.text.trim(), msg.lang || 'Ukrainian');
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
                        this._post({
                            type: 'models_list',
                            models: models.map(m => m.name),
                            current: this._loop.model || ollama.model
                        });
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
        vscode.commands.executeCommand('setContext', 'openollamagravity.panelOpen', true);
    }
    _post(msg) {
        try {
            this._panel.webview.postMessage(msg);
        }
        catch {
            // panel may already be disposed
        }
    }
    async _runTask(task, language = 'Ukrainian') {
        if (this._loop.running) {
            vscode.window.showWarningMessage('OpenOllamaGravity: agent is already running. Stop it first.');
            return;
        }
        const workspaceCtx = vscode.workspace.getConfiguration('openollamagravity').get('workspaceContext', true)
            ? await (0, context_1.gatherContext)()
            : '';
        this._post({ type: 'task_start', text: task });
        vscode.commands.executeCommand('setContext', 'openollamagravity.running', true);
        await this._loop.run(task, [], workspaceCtx, language);
        vscode.commands.executeCommand('setContext', 'openollamagravity.running', false);
    }
    // ── Збереження Markdown у файл ──
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
            vscode.commands.executeCommand('setContext', 'openollamagravity.panelOpen', false);
        }
        vscode.commands.executeCommand('setContext', 'openollamagravity.running', false);
    }
    _getHtml(iconUri) {
        return /* html */ `<!DOCTYPE html>
<html lang="uk">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src vscode-webview-resource: https:; style-src 'unsafe-inline'; font-src https://fonts.gstatic.com; connect-src 'none'; script-src 'unsafe-inline';">
<title>OpenOllamaGravity Agent</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }

  html, body {
    height: 100%;
    background: #0d0f12;
    color: #e2e8f0;
    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
    font-size: 13px;
    line-height: 1.6;
    overflow: hidden;
  }

  #app { display: flex; flex-direction: column; height: 100vh; }

  /* ── Header ── */
  #header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 16px;
    background: #131618;
    border-bottom: 1px solid #2a2d33;
    flex-shrink: 0;
  }
  #header-title {
    font-family: 'Courier New', Courier, monospace;
    font-weight: 700;
    font-size: 13px;
    color: #00e5ff;
    letter-spacing: .05em;
    flex: 1;
  }
  
  /* ── Selects ── */
  #model-select, #lang-select {
    font-family: 'Courier New', Courier, monospace;
    font-size: 11px;
    color: #94a3b8;
    background: #1a1d21;
    border: 1px solid #2a2d33;
    border-radius: 4px;
    padding: 2px 20px 2px 8px;
    cursor: pointer;
    outline: none;
    appearance: none;
    -webkit-appearance: none;
  }
  #model-select:hover, #lang-select:hover { border-color: #00e5ff; color: #00e5ff; }
  #model-select option, #lang-select option { background: #1a1d21; color: #e2e8f0; }
  .select-wrapper { position: relative; display: flex; align-items: center; }
  .select-arrow { position: absolute; right: 6px; pointer-events: none; font-size: 8px; color: #64748b; }

  #btn-clear {
    background: none;
    border: 1px solid #2a2d33;
    border-radius: 6px;
    color: #64748b;
    cursor: pointer;
    padding: 4px 10px;
    font-size: 11px;
    font-family: inherit;
    transition: all .15s;
  }
  #btn-clear:hover { border-color: #353940; color: #94a3b8; }

  /* ── Progress ── */
  #progress-wrap { height: 3px; background: #131618; flex-shrink: 0; display: none; }
  #progress-bar {
    height: 100%;
    width: 0%;
    background: #00e5ff;
    transition: width .4s ease;
  }

  /* ── Chat ── */
  #chat {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  #chat::-webkit-scrollbar { width: 5px; }
  #chat::-webkit-scrollbar-track { background: transparent; }
  #chat::-webkit-scrollbar-thumb { background: #353940; border-radius: 3px; }

  /* ── Empty state ── */
  #empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    color: #64748b;
    text-align: center;
    padding: 40px;
  }
  #empty .big   { font-size: 36px; line-height: 1; margin-bottom: 8px; }
  #empty .title { font-size: 15px; color: #94a3b8; font-weight: 600; }
  #empty .sub   { font-size: 12px; line-height: 1.7; max-width: 280px; }
  #empty .hints { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; width: 100%; max-width: 340px; }
  #empty .hint {
    font-family: 'Courier New', Courier, monospace;
    font-size: 11px;
    background: #1a1d21;
    border: 1px solid #2a2d33;
    border-radius: 6px;
    padding: 7px 12px;
    cursor: pointer;
    color: #94a3b8;
    transition: all .15s;
    text-align: left;
  }
  #empty .hint:hover { border-color: #00e5ff; color: #00e5ff; background: #0d1a1e; }

  /* ── Messages ── */
  .msg { display: flex; flex-direction: column; gap: 4px; animation: fadeIn .18s ease; }
  @keyframes fadeIn { from { opacity:0; transform:translateY(5px); } to { opacity:1; transform:none; } }

  .msg-label {
    font-family: 'Courier New', Courier, monospace;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: .1em;
    text-transform: uppercase;
    display: flex;
    align-items: center;
    gap: 6px;
    user-select: none;
  }
  .dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; }

  .msg-body {
    border-radius: 8px;
    padding: 11px 14px;
    line-height: 1.7;
    word-break: break-word;
    overflow-wrap: anywhere;
    border-left: 3px solid transparent;
  }

  .msg-user .msg-label { color: #6b8cff; }
  .msg-user .msg-body  { background: #1e2433; border-left-color: #3b4cca; }

  .msg-answer .msg-label { color: #22c55e; }
  .msg-answer .msg-body  { background: #141a14; border-left-color: #22c55e; white-space: pre-wrap; }

  /* ── Actions bar for saved messages ── */
  .msg-actions {
    display: flex;
    justify-content: flex-end;
    margin-top: 4px;
    padding-right: 4px;
  }
  .btn-action {
    background: #1a1d21;
    border: 1px solid #2a2d33;
    border-radius: 4px;
    color: #94a3b8;
    cursor: pointer;
    font-family: 'Courier New', Courier, monospace;
    font-size: 10px;
    font-weight: bold;
    padding: 4px 10px;
    transition: all .15s;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .btn-action:hover {
    background: #00e5ff;
    color: #000;
    border-color: #00e5ff;
  }

  .msg-thinking .msg-label { color: #7c3aed; cursor: pointer; }
  .msg-thinking .msg-label::after { content: '▾'; font-size: 10px; opacity: .7; }
  .msg-thinking.collapsed .msg-label::after { content: '▸'; }
  .msg-thinking .msg-body {
    background: #12121a;
    border-left-color: #7c3aed;
    color: #64748b;
    font-family: 'Courier New', Courier, monospace;
    font-size: 11px;
    white-space: pre-wrap;
    max-height: 240px;
    overflow-y: auto;
  }
  .msg-thinking.collapsed .msg-body { display: none; }

  .msg-tool .msg-label { color: #f59e0b; }
  .msg-tool .msg-body  { background: #1a1510; border-left-color: #f59e0b; }
  .tool-name { font-family: 'Courier New', Courier, monospace; font-size: 12px; font-weight: 700; color: #f59e0b; margin-bottom: 4px; }
  .tool-args { font-family: 'Courier New', Courier, monospace; font-size: 11px; color: #64748b; white-space: pre-wrap; word-break: break-all; }

  .msg-result .msg-label { color: #475569; }
  .msg-result .msg-body  {
    background: #131618;
    border-left-color: #2a2d33;
    font-family: 'Courier New', Courier, monospace;
    font-size: 11px;
    color: #94a3b8;
    white-space: pre-wrap;
    max-height: 240px;
    overflow-y: auto;
  }
  .msg-result.err .msg-label { color: #ef4444; }
  .msg-result.err .msg-body  { border-left-color: #ef4444; color: #fca5a5; }

  .msg-status .msg-body { background: transparent; border: none; padding: 0 2px; font-size: 11px; color: #64748b; }

  .msg-body pre {
    background: #0a0c10;
    border: 1px solid #2a2d33;
    border-radius: 6px;
    padding: 10px 12px;
    margin: 8px 0;
    overflow-x: auto;
    font-family: 'Courier New', Courier, monospace;
    font-size: 11px;
    line-height: 1.6;
    white-space: pre;
  }
  .msg-body code {
    font-family: 'Courier New', Courier, monospace;
    font-size: 11px;
    background: rgba(255,255,255,.06);
    border-radius: 3px;
    padding: 1px 5px;
    color: #00e5ff;
  }
  .msg-body pre code { background: none; padding: 0; color: #94a3b8; }
  .msg-body::-webkit-scrollbar { width: 4px; }
  .msg-body::-webkit-scrollbar-thumb { background: #353940; border-radius: 2px; }

  /* ── Live thinking indicator ── */
  #thinking-live {
    display: none;
    align-items: center;
    gap: 8px;
    padding: 6px 16px;
    color: #7c3aed;
    font-size: 11px;
    font-family: 'Courier New', Courier, monospace;
    flex-shrink: 0;
  }
  .pulse { display: flex; gap: 3px; }
  .pulse span {
    width: 5px; height: 5px;
    background: #7c3aed;
    border-radius: 50%;
    animation: pulse 1s ease-in-out infinite;
  }
  .pulse span:nth-child(2) { animation-delay: .2s; }
  .pulse span:nth-child(3) { animation-delay: .4s; }
  @keyframes pulse {
    0%,100% { opacity:.3; transform:scale(.8); }
    50%      { opacity:1;  transform:scale(1);  }
  }

  /* ── Input area ── */
  #input-wrap {
    border-top: 1px solid #2a2d33;
    background: #131618;
    padding: 12px;
    flex-shrink: 0;
  }
  #input-row { display: flex; gap: 8px; align-items: flex-end; }

  #input {
    flex: 1;
    background: #1a1d21;
    border: 1px solid #2a2d33;
    border-radius: 8px;
    color: #e2e8f0;
    font-family: inherit;
    font-size: 13px;
    line-height: 1.5;
    padding: 9px 12px;
    resize: none;
    min-height: 40px;
    max-height: 180px;
    outline: none;
    transition: border-color .15s;
    overflow-y: auto;
  }
  #input:focus { border-color: #00e5ff; }
  #input::placeholder { color: #475569; }

  #btn-send, #btn-stop {
    width: 40px; height: 40px;
    border-radius: 8px;
    border: none;
    cursor: pointer;
    font-size: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all .15s;
    flex-shrink: 0;
    line-height: 1;
  }
  #btn-send { background: #00e5ff; color: #000; font-weight: bold; }
  #btn-send:hover:not(:disabled) { background: #33eaff; transform: scale(1.05); }
  #btn-send:disabled { background: #2a2d33; color: #475569; cursor: not-allowed; transform: none; }
  #btn-stop { background: #ef4444; color: #fff; display: none; }
  #btn-stop:hover { background: #f87171; }

  #input-hint { font-size: 10px; color: #475569; margin-top: 6px; padding: 0 2px; }
</style>
</head>
<body>
<div id="app">

  <div id="header">
    <img src="${iconUri}" alt="OOG" style="width: 20px; height: 20px; border-radius: 4px; object-fit: cover; box-shadow: 0 0 5px rgba(0,229,255,0.3);">
    <span id="header-title">OPENOLLAMAGRAVITY</span>
    
    <div class="select-wrapper">
      <select id="lang-select" title="Мова відповідей / Language">
        <option value="Ukrainian" selected>UK</option>
        <option value="English">EN</option>
        <option value="German">DE</option>
        <option value="Spanish">ES</option>
        <option value="French">FR</option>
      </select>
      <span class="select-arrow">▼</span>
    </div>

    <div class="select-wrapper">
      <select id="model-select" title="Обрати модель"></select>
      <span class="select-arrow">▼</span>
    </div>
    
    <button id="btn-clear">&#x2715; Очистити</button>
  </div>

  <div id="progress-wrap"><div id="progress-bar"></div></div>

  <div id="chat">
    <div id="empty">
      <div class="big">&#x26A1;</div>
      <div class="title" id="empty-title">OpenOllamaGravity Agent</div>
      <div class="sub" id="empty-sub">Автономний агент на базі Ollama.<br>Планує, читає, пише, запускає — офлайн.</div>
      <div class="hints">
        <div class="hint" id="hint1" data-hint="Поясни структуру цього проєкту">📁 Поясни структуру цього проєкту</div>
        <div class="hint" id="hint2" data-hint="Знайди та виправ баги у відкритому файлі">🐛 Знайди та виправ баги у відкритому файлі</div>
        <div class="hint" id="hint3" data-hint="Напиши unit-тести для виділеного коду">✅ Напиши unit-тести для виділеного коду</div>
        <div class="hint" id="hint4" data-hint="Надай список доступних скілів">📋 Надай список доступних скілів</div>
      </div>
    </div>
  </div>

  <div id="thinking-live">
    <div class="pulse"><span></span><span></span><span></span></div>
    <span id="thinking-step">Думаємо…</span>
  </div>

  <div id="input-wrap">
    <div id="input-row">
      <textarea id="input" rows="1" placeholder="Постав завдання агенту…"></textarea>
      <button id="btn-send" title="Надіслати (Enter)">&#x2191;</button>
      <button id="btn-stop" title="Зупинити агента">&#x25A0;</button>
    </div>
    <div id="input-hint">Enter — надіслати &nbsp;·&nbsp; Shift+Enter — новий рядок</div>
  </div>

</div>
<script>
(function() {
  'use strict';

  var vscode    = acquireVsCodeApi();
  var chatEl    = document.getElementById('chat');
  var emptyEl   = document.getElementById('empty');
  var inputEl   = document.getElementById('input');
  var btnSend   = document.getElementById('btn-send');
  var btnStop   = document.getElementById('btn-stop');
  var btnClear  = document.getElementById('btn-clear');
  var progWrap  = document.getElementById('progress-wrap');
  var progBar   = document.getElementById('progress-bar');
  var thinkLive = document.getElementById('thinking-live');
  var thinkStep = document.getElementById('thinking-step');
  var modelSelect = document.getElementById('model-select');
  var langSelect  = document.getElementById('lang-select');

  var isRunning      = false;
  var currentThinkEl = null;

  var i18n = {
    Ukrainian: {
      clear: "&#x2715; Очистити",
      emptySub: "Автономний агент на базі Ollama.<br>Планує, читає, пише, запускає — офлайн.",
      h1: "📁 Поясни структуру цього проєкту", h1v: "Поясни структуру цього проєкту",
      h2: "🐛 Знайди та виправ баги у відкритому файлі", h2v: "Знайди та виправ баги у відкритому файлі",
      h3: "✅ Напиши unit-тести для виділеного коду", h3v: "Напиши unit-тести для виділеного коду",
      h4: "📋 Надай список доступних скілів", h4v: "Надай список доступних скілів",
      placeholder: "Постав завдання агенту…",
      inputHint: "Enter — надіслати &nbsp;·&nbsp; Shift+Enter — новий рядок",
      think: "Думаємо…", step: "Крок",
      lUser: "ВИ", lThink: "ДУМАЮ", lTool: "ІНСТРУМЕНТ", lRes: "РЕЗУЛЬТАТ", lAgent: "АГЕНТ", lErr: "ПОМИЛКА", lStop: "Зупинено.", lOk: "РЕЗУЛЬТАТ",
      btnSave: "Зберегти .md"
    },
    English: {
      clear: "&#x2715; Clear",
      emptySub: "Autonomous Ollama-based agent.<br>Plans, reads, writes, executes — offline.",
      h1: "📁 Explain the structure of this project", h1v: "Explain the structure of this project",
      h2: "🐛 Find and fix bugs in the open file", h2v: "Find and fix bugs in the open file",
      h3: "✅ Write unit tests for the selected code", h3v: "Write unit tests for the selected code",
      h4: "📋 List available skills", h4v: "List available skills",
      placeholder: "Give a task to the agent...",
      inputHint: "Enter — send &nbsp;·&nbsp; Shift+Enter — new line",
      think: "Thinking...", step: "Step",
      lUser: "YOU", lThink: "THINKING", lTool: "TOOL", lRes: "RESULT", lAgent: "AGENT", lErr: "ERROR", lStop: "Stopped.", lOk: "RESULT",
      btnSave: "Save .md"
    },
    German: {
      clear: "&#x2715; Löschen",
      emptySub: "Autonomer Ollama-basierter Agent.<br>Plant, liest, schreibt, führt aus — offline.",
      h1: "📁 Erkläre die Struktur dieses Projekts", h1v: "Erkläre die Struktur dieses Projekts",
      h2: "🐛 Finde und behebe Fehler in der offenen Datei", h2v: "Finde und behebe Fehler in der offenen Datei",
      h3: "✅ Schreibe Unit-Tests für den ausgewählten Code", h3v: "Schreibe Unit-Tests für den ausgewählten Code",
      h4: "📋 Liste verfügbare Skills auf", h4v: "Liste verfügbare Skills auf",
      placeholder: "Gib dem Agenten eine Aufgabe...",
      inputHint: "Enter — senden &nbsp;·&nbsp; Shift+Enter — neue Zeile",
      think: "Denke nach...", step: "Schritt",
      lUser: "DU", lThink: "DENKEN", lTool: "WERKZEUG", lRes: "ERGEBNIS", lAgent: "AGENT", lErr: "FEHLER", lStop: "Gestoppt.", lOk: "ERGEBNIS",
      btnSave: "Speichern .md"
    },
    Spanish: {
      clear: "&#x2715; Borrar",
      emptySub: "Agente autónomo basado en Ollama.<br>Planifica, lee, escribe, ejecuta — sin conexión.",
      h1: "📁 Explica la estructura de este proyecto", h1v: "Explica la estructura de este proyecto",
      h2: "🐛 Encuentra y corrige errores en el archivo abierto", h2v: "Encuentra y corrige errores en el archivo abierto",
      h3: "✅ Escribe pruebas unitarias para el código seleccionado", h3v: "Escribe pruebas unitarias para el código seleccionado",
      h4: "📋 Enumera las habilidades disponibles", h4v: "Enumera las habilidades disponibles",
      placeholder: "Dale una tarea al agente...",
      inputHint: "Enter — enviar &nbsp;·&nbsp; Shift+Enter — nueva línea",
      think: "Pensando...", step: "Paso",
      lUser: "TÚ", lThink: "PENSANDO", lTool: "HERRAMIENTA", lRes: "RESULTADO", lAgent: "AGENTE", lErr: "ERROR", lStop: "Detenido.", lOk: "RESULTADO",
      btnSave: "Guardar .md"
    },
    French: {
      clear: "&#x2715; Effacer",
      emptySub: "Agent autonome basé sur Ollama.<br>Planifie, lit, écrit, exécute — hors ligne.",
      h1: "📁 Explique la structure de ce projet", h1v: "Explique la structure de ce projet",
      h2: "🐛 Trouve et corrige les bugs dans le fichier ouvert", h2v: "Trouve et corrige les bugs dans le fichier ouvert",
      h3: "✅ Écris des tests unitaires pour le code sélectionné", h3v: "Écris des tests unitaires pour le code sélectionné",
      h4: "📋 Liste les compétences disponibles", h4v: "Liste les compétences disponibles",
      placeholder: "Donnez une tâche à l'agent...",
      inputHint: "Enter — envoyer &nbsp;·&nbsp; Shift+Enter — nouvelle ligne",
      think: "Réflexion...", step: "Étape",
      lUser: "VOUS", lThink: "RÉFLEXION", lTool: "OUTIL", lRes: "RÉSULTAT", lAgent: "AGENT", lErr: "ERREUR", lStop: "Arrêté.", lOk: "RÉSULTAT",
      btnSave: "Enregistrer .md"
    }
  };

  var currentLang = 'Ukrainian';

  function updateUI() {
    currentLang = langSelect.value;
    var t = i18n[currentLang];
    
    btnClear.innerHTML = t.clear;
    document.getElementById('empty-sub').innerHTML = t.emptySub;
    
    var h1 = document.getElementById('hint1'); h1.textContent = t.h1; h1.setAttribute('data-hint', t.h1v);
    var h2 = document.getElementById('hint2'); h2.textContent = t.h2; h2.setAttribute('data-hint', t.h2v);
    var h3 = document.getElementById('hint3'); h3.textContent = t.h3; h3.setAttribute('data-hint', t.h3v);
    var h4 = document.getElementById('hint4'); h4.textContent = t.h4; h4.setAttribute('data-hint', t.h4v);
    
    inputEl.placeholder = t.placeholder;
    document.getElementById('input-hint').innerHTML = t.inputHint;
    if (!thinkStep.textContent.includes('/')) {
      thinkStep.textContent = t.think;
    }
  }

  langSelect.addEventListener('change', updateUI);
  modelSelect.addEventListener('change', function() {
    vscode.postMessage({ type: 'set_model', model: modelSelect.value });
  });

  document.querySelectorAll('.hint').forEach(function(el) {
    el.addEventListener('click', function() {
      var hint = el.getAttribute('data-hint');
      if (hint) {
        inputEl.value = hint;
        autoResize();
        send();
      }
    });
  });

  function autoResize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px';
  }
  inputEl.addEventListener('input', autoResize);

  inputEl.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  btnSend.addEventListener('click', function() { send(); });
  btnStop.addEventListener('click', function() {
    vscode.postMessage({ type: 'stop' });
  });
  btnClear.addEventListener('click', function() {
    currentThinkEl = null;
    while (chatEl.firstChild) chatEl.removeChild(chatEl.firstChild);
    chatEl.appendChild(emptyEl);
    emptyEl.style.display = '';
    vscode.postMessage({ type: 'clear' });
  });

  function send() {
    var text = inputEl.value.trim();
    if (!text || isRunning) return;
    inputEl.value = '';
    inputEl.style.height = 'auto';
    vscode.postMessage({ type: 'task', text: text, lang: currentLang });
  }

  function hideEmpty() {
    emptyEl.style.display = 'none';
  }

  function escHtml(s) {
    var str = String(s == null ? '' : s);
    var out = '';
    for (var i = 0; i < str.length; i++) {
      var c = str.charAt(i);
      if      (c === '&')  out += '&amp;';
      else if (c === '<')  out += '&lt;';
      else if (c === '>')  out += '&gt;';
      else                 out += c;
    }
    return out;
  }

  function scrollBottom() {
    chatEl.scrollTop = chatEl.scrollHeight;
  }

  function renderMarkdown(text) {
    if (!text) return '';
    var bt = String.fromCharCode(96);
    var nl = String.fromCharCode(10);
    var triple = bt + bt + bt;

    // Fenced code blocks
    var fenceParts = text.split(triple);
    if (fenceParts.length > 1) {
      var rebuilt = '';
      for (var i = 0; i < fenceParts.length; i++) {
        if (i % 2 === 0) {
          rebuilt += fenceParts[i];
        } else {
          var code = fenceParts[i].replace(new RegExp('^[a-zA-Z0-9_+#-]*' + nl), '');
          rebuilt += '<pre><code>' + escHtml(code.trim()) + '</code></pre>';
        }
      }
      text = rebuilt;
    }

    // Inline code
    var inlineParts = text.split(bt);
    if (inlineParts.length > 1) {
      var rebuilt2 = '';
      for (var j = 0; j < inlineParts.length; j++) {
        if (j % 2 === 0) rebuilt2 += inlineParts[j];
        else rebuilt2 += '<code>' + escHtml(inlineParts[j]) + '</code>';
      }
      text = rebuilt2;
    }

    // Bold
    var boldParts = text.split('**');
    if (boldParts.length > 1) {
      var rebuilt3 = '';
      for (var k = 0; k < boldParts.length; k++) {
        if (k % 2 === 0) rebuilt3 += boldParts[k];
        else rebuilt3 += '<strong>' + boldParts[k] + '</strong>';
      }
      text = rebuilt3;
    }

    // Process line-by-line: headers and list items
    var resultLines = [];
    var rawLines = text.split(nl);
    for (var li = 0; li < rawLines.length; li++) {
      var line = rawLines[li];
      if (/^### /.test(line)) {
        resultLines.push('<strong style="color:#94a3b8;font-size:12px">' + line.slice(4) + '</strong>');
      } else if (/^## /.test(line)) {
        resultLines.push('<strong style="color:#b0bec5;font-size:13px">' + line.slice(3) + '</strong>');
      } else if (/^# /.test(line)) {
        resultLines.push('<strong style="color:#cdd5df;font-size:14px">' + line.slice(2) + '</strong>');
      } else if (/^[-*] /.test(line)) {
        resultLines.push('&nbsp;&nbsp;• ' + line.slice(2));
      } else if (/^\d+\. /.test(line)) {
        resultLines.push('&nbsp;&nbsp;' + line);
      } else {
        resultLines.push(line);
      }
    }
    return resultLines.join('<br>');
  }

  function addMsg(cssClass, labelHtml, bodyHtml, extraClass, rawText) {
    var wrap  = document.createElement('div');
    wrap.className = 'msg ' + cssClass + (extraClass ? ' ' + extraClass : '');

    var label = document.createElement('div');
    label.className = 'msg-label';
    label.innerHTML = labelHtml;

    var body = document.createElement('div');
    body.className = 'msg-body';
    body.innerHTML = bodyHtml;

    if (cssClass === 'msg-thinking') {
      wrap.classList.add('collapsed');
      label.addEventListener('click', function() {
        wrap.classList.toggle('collapsed');
      });
    }

    wrap.appendChild(label);
    wrap.appendChild(body);

    // Додаємо кнопку збереження, якщо це відповідь агента
    if (cssClass === 'msg-answer' && rawText) {
      var actions = document.createElement('div');
      actions.className = 'msg-actions';
      var btnSave = document.createElement('button');
      btnSave.className = 'btn-action';
      btnSave.innerHTML = '💾 ' + i18n[currentLang].btnSave;
      btnSave.onclick = function() {
        vscode.postMessage({ type: 'save_markdown', text: rawText });
      };
      actions.appendChild(btnSave);
      wrap.appendChild(actions);
    }

    chatEl.appendChild(wrap);
    scrollBottom();
    return body;
  }

  function setRunning() {
    isRunning = true;
    currentThinkEl = null;
    btnSend.disabled = true;
    btnSend.style.display = 'none';
    btnStop.style.display = 'flex';
    progWrap.style.display = 'block';
    progBar.style.width = '5%';
  }

  function setIdle() {
    isRunning = false;
    currentThinkEl = null;
    btnSend.disabled = false;
    btnSend.style.display = 'flex';
    btnStop.style.display = 'none';
    thinkLive.style.display = 'none';
  }

  window.addEventListener('message', function(e) {
    var data = e.data;
    if (!data || !data.type) return;

    var t = i18n[currentLang];

    if (data.type === 'models_list') {
      modelSelect.innerHTML = '';
      data.models.forEach(function(m) {
        var opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        if (m === data.current) opt.selected = true;
        modelSelect.appendChild(opt);
      });
      return;
    }

    if (data.type === 'task_start') {
      hideEmpty();
      setRunning();
      addMsg('msg-user',
        '<span class="dot" style="background:#6b8cff"></span> ' + t.lUser,
        escHtml(data.text),
        ''
      );
      return;
    }

    if (data.type === 'stopped') {
      setIdle();
      addMsg('msg-status', '', '⏹ ' + t.lStop, '');
      return;
    }

    if (data.type !== 'agent_event') return;
    var ev = data.event;
    if (!ev) return;

    switch (ev.type) {

      case 'step':
        if (ev.totalSteps) {
          progBar.style.width = Math.round((ev.step / ev.totalSteps) * 100) + '%';
          thinkStep.textContent = t.step + ' ' + ev.step + ' / ' + ev.totalSteps;
        }
        thinkLive.style.display = 'flex';
        break;

      case 'narration':
        // Текст-пояснення агента перед кожним tool_call
        if (ev.content && ev.content.trim()) {
          addMsg('msg-status', '', '<em style="color:#64748b">' + escHtml(ev.content) + '</em>', '');
        }
        break;

      case 'skills_loaded':
      case 'skills_discovered':
        if (ev.skills && ev.skills.length > 0) {
          var skillsHtml = ev.skills.map(function(s) {
            return '<span style="background:#1a1d21;border:1px solid #2a2d33;border-radius:3px;padding:1px 6px;margin-right:4px;font-family:monospace;font-size:10px;color:#94a3b8">' +
              escHtml(s.name) + ' <span style="color:#475569">[' + s.score.toFixed(1) + ']</span></span>';
          }).join('');
          var icon = ev.type === 'skills_loaded' ? '📚' : '🔍';
          addMsg('msg-status', '', icon + ' ' + skillsHtml, '');
        }
        break;

      case 'thinking':
        thinkLive.style.display = 'flex';
        if (!currentThinkEl) {
          currentThinkEl = addMsg('msg-thinking',
            '<span class="dot" style="background:#7c3aed"></span> ' + t.lThink,
            '',
            ''
          );
        }
        currentThinkEl.textContent += (ev.content || '');
        currentThinkEl.scrollTop = currentThinkEl.scrollHeight;
        break;

      case 'tool_call':
        thinkLive.style.display = 'none';
        currentThinkEl = null;
        var argsStr = '';
        if (ev.toolArgs) {
          try { argsStr = JSON.stringify(ev.toolArgs, null, 2); } catch(e) { argsStr = ''; }
        }
        addMsg('msg-tool',
          '<span class="dot" style="background:#f59e0b"></span> ' + t.lTool,
          '<div class="tool-name">&#x2699; ' + escHtml(ev.toolName || '') + '</div>'
            + (argsStr ? '<div class="tool-args">' + escHtml(argsStr) + '</div>' : ''),
          ''
        );
        break;

      case 'tool_result':
        var isErr = (ev.ok === false);
        addMsg('msg-result',
          '<span class="dot" style="background:' + (isErr ? '#ef4444' : '#475569') + '"></span>'
            + (isErr ? ' ✗ ' + t.lErr : ' ✓ ' + t.lOk),
          escHtml(ev.content || ''),
          isErr ? 'err' : ''
        );
        break;

      case 'answer':
        thinkLive.style.display = 'none';
        currentThinkEl = null;
        addMsg('msg-answer',
          '<span class="dot" style="background:#22c55e;box-shadow:0 0 5px #22c55e"></span> ⚡ ' + t.lAgent,
          renderMarkdown(ev.content || ''),
          '',
          ev.content // Передаємо сирий Markdown для збереження
        );
        break;

      case 'error':
        thinkLive.style.display = 'none';
        addMsg('msg-result',
          '<span class="dot" style="background:#ef4444"></span> ✗ ' + t.lErr,
          escHtml(ev.content || ''),
          'err'
        );
        setIdle();
        break;

      case 'done':
        progBar.style.width = '100%';
        setTimeout(function() {
          progWrap.style.display = 'none';
          progBar.style.width = '0%';
        }, 700);
        setIdle();
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });

})();
</script>
</body>
</html>`;
    }
}
exports.AgentPanel = AgentPanel;
AgentPanel.panels = [];
