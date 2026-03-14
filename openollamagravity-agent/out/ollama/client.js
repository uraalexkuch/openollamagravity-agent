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
exports.OllamaClient = exports.oogLogger = void 0;
// Copyright (c) 2026 Юрій Кучеренко.
const vscode = __importStar(require("vscode"));
const http = __importStar(require("http"));
const https = __importStar(require("https"));
exports.oogLogger = vscode.window.createOutputChannel('OOG Agent Log');
class OllamaClient {
    /** Повертає поточну модель з налаштувань */
    get model() {
        return vscode.workspace.getConfiguration('openollamagravity').get('model', 'codellama');
    }
    cfg(key, def) {
        return vscode.workspace.getConfiguration('openollamagravity').get(key, def);
    }
    /** Оптимізує вікно контексту під конкретну модель */
    getDynamicContext(model) {
        const m = model.toLowerCase();
        const limit = this.cfg('maxDynamicContext', 32768);
        if (m.includes('llama3.2') || m.includes('qwen') || m.includes('deepseek'))
            return Math.min(131072, limit);
        if (m.includes('gemma') || m.includes('mistral'))
            return Math.min(32768, limit);
        return Math.min(8192, limit);
    }
    async listModels() {
        try {
            const res = await this.get('/api/tags');
            return JSON.parse(res).models || [];
        }
        catch {
            return [];
        }
    }
    async isAvailable() {
        try {
            await this.get('/api/tags');
            return true;
        }
        catch {
            return false;
        }
    }
    async chatStream(messages, onChunk, signal, modelOverride) {
        const targetModel = modelOverride || this.model;
        const ctx = this.getDynamicContext(targetModel);
        exports.oogLogger.appendLine(`\n[${new Date().toLocaleTimeString()}] 🚀 Генерація: ${targetModel} (Context: ${ctx})`);
        const body = JSON.stringify({
            model: targetModel,
            messages,
            stream: true,
            options: { temperature: this.cfg('temperature', 0.15), num_ctx: ctx, num_predict: this.cfg('maxTokens', 4096) }
        });
        return new Promise((resolve, reject) => {
            let full = '';
            const url = new URL('/api/chat', this.cfg('ollamaUrl', 'http://localhost:11434'));
            const lib = url.protocol === 'https:' ? https : http;
            const req = lib.request({ hostname: url.hostname, port: url.port || 11434, path: '/api/chat', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
                let buf = '';
                res.on('data', (chunk) => {
                    if (signal?.aborted) {
                        req.destroy();
                        return;
                    }
                    buf += chunk.toString();
                    const lines = buf.split('\n');
                    buf = lines.pop() ?? '';
                    for (const line of lines) {
                        try {
                            const j = JSON.parse(line);
                            if (j.message?.content) {
                                full += j.message.content;
                                onChunk(j.message.content);
                            }
                            if (j.done)
                                resolve(full);
                        }
                        catch { }
                    }
                });
                res.on('end', () => resolve(full));
            });
            req.on('error', reject);
            signal?.addEventListener('abort', () => { req.destroy(); resolve(full); });
            req.write(body);
            req.end();
        });
    }
    /** Генерація для inlineCompletion та простих запитів */
    async generate(prompt, maxTokens = 256, modelOverride) {
        const body = JSON.stringify({
            model: modelOverride || this.model,
            prompt, stream: false,
            options: { num_ctx: 4096, num_predict: maxTokens }
        });
        try {
            const res = await this.post('/api/generate', body);
            return JSON.parse(res).response || '';
        }
        catch {
            return '';
        }
    }
    async get(p) {
        return new Promise((res, rej) => {
            const url = new URL(p, this.cfg('ollamaUrl', 'http://localhost:11434'));
            http.get(url.toString(), r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); }).on('error', rej);
        });
    }
    async post(p, b) {
        return new Promise((res, rej) => {
            const url = new URL(p, this.cfg('ollamaUrl', 'http://localhost:11434'));
            const req = http.request({ hostname: url.hostname, port: url.port || 11434, path: p, method: 'POST', headers: { 'Content-Type': 'application/json' } }, r => {
                let d = '';
                r.on('data', c => d += c);
                r.on('end', () => res(d));
            });
            req.on('error', rej);
            req.write(b);
            req.end();
        });
    }
}
exports.OllamaClient = OllamaClient;
