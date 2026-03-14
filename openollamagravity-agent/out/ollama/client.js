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
exports.OllamaClient = exports.oogLogger = void 0;
const vscode = __importStar(require("vscode"));
const http = __importStar(require("http"));
const https = __importStar(require("https"));
// ── Глобальний канал виводу для технічного моніторингу ──
exports.oogLogger = vscode.window.createOutputChannel('OOG Agent Log');
function cfg(key, def) {
    return vscode.workspace.getConfiguration('openollamagravity').get(key, def);
}
class OllamaClient {
    get baseUrl() { return cfg('ollamaUrl', 'http://localhost:11434'); }
    get model() { return cfg('model', 'codellama'); }
    get temp() { return cfg('temperature', 0.15); }
    get maxTok() { return cfg('maxTokens', 4096); }
    getDynamicContext(modelName) {
        const name = modelName.toLowerCase();
        const hardwareLimit = cfg('maxDynamicContext', 32768);
        let ctxSize = cfg('baseContextSize', 4096);
        // Моделі з великим вікном контексту (128k+)
        if (name.includes('llama3.2') || name.includes('qwen') || name.includes('deepseek')) {
            ctxSize = Math.min(131072, hardwareLimit);
        }
        else if (name.includes('llama3')) {
            ctxSize = Math.min(8192, hardwareLimit);
        }
        return ctxSize;
    }
    async listModels() {
        const raw = await this.get('/api/tags');
        return (JSON.parse(raw).models ?? []);
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
        const dynamicCtx = this.getDynamicContext(targetModel);
        exports.oogLogger.appendLine(`\n[${new Date().toLocaleTimeString()}] 🚀 Старт генерації (${targetModel})`);
        exports.oogLogger.appendLine(`[${new Date().toLocaleTimeString()}] ⚙️ Вікно контексту (num_ctx): ${dynamicCtx}`);
        const body = JSON.stringify({
            model: targetModel,
            messages,
            stream: true,
            options: { temperature: this.temp, num_predict: this.maxTok, num_ctx: dynamicCtx },
        });
        const startTime = Date.now();
        let firstTok = false;
        return new Promise((resolve, reject) => {
            let full = '';
            const url = new URL('/api/chat', this.baseUrl);
            const lib = url.protocol === 'https:' ? https : http;
            const req = lib.request({
                hostname: url.hostname,
                port: parseInt(url.port) || 11434,
                path: '/api/chat',
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            }, res => {
                let buf = '';
                res.on('data', (chunk) => {
                    if (signal?.aborted) {
                        req.destroy();
                        return;
                    }
                    if (!firstTok) {
                        firstTok = true;
                        exports.oogLogger.appendLine(`[${new Date().toLocaleTimeString()}] ⏱️ Перша відповідь через ${((Date.now() - startTime) / 1000).toFixed(1)}с.`);
                    }
                    buf += chunk.toString();
                    const lines = buf.split('\n');
                    buf = lines.pop() ?? '';
                    for (const line of lines) {
                        try {
                            const j = JSON.parse(line);
                            const tok = j?.message?.content ?? '';
                            if (tok) {
                                full += tok;
                                onChunk(tok);
                            }
                            if (j.done) {
                                exports.oogLogger.appendLine(`[${new Date().toLocaleTimeString()}] ✅ Отримано повну відповідь за ${((Date.now() - startTime) / 1000).toFixed(1)}с.`);
                                resolve(full);
                            }
                        }
                        catch { /* parse error */ }
                    }
                });
                res.on('end', () => resolve(full));
            });
            req.on('error', reject);
            signal?.addEventListener('abort', () => req.destroy());
            req.write(body);
            req.end();
        });
    }
    async generate(prompt, maxTokens = 512, modelOverride) {
        const targetModel = modelOverride || this.model;
        const body = JSON.stringify({
            model: targetModel,
            prompt, stream: false,
            options: { temperature: this.temp, num_predict: maxTokens, num_ctx: this.getDynamicContext(targetModel) },
        });
        const raw = await this.post('/api/generate', body);
        return JSON.parse(raw).response ?? '';
    }
    get(path) {
        return new Promise((res, rej) => {
            const url = new URL(path, this.baseUrl);
            const lib = url.protocol === 'https:' ? https : http;
            lib.get(url.toString(), r => {
                let d = '';
                r.on('data', c => d += c);
                r.on('end', () => res(d));
            }).on('error', rej);
        });
    }
    post(path, body) {
        return new Promise((res, rej) => {
            const url = new URL(path, this.baseUrl);
            const lib = url.protocol === 'https:' ? https : http;
            const req = lib.request({ hostname: url.hostname, port: parseInt(url.port) || 11434, path, method: 'POST', headers: { 'Content-Type': 'application/json' } }, r => {
                let d = '';
                r.on('data', c => d += c);
                r.on('end', () => res(d));
            });
            req.write(body);
            req.end();
        });
    }
}
exports.OllamaClient = OllamaClient;
