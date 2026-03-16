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
    constructor() {
        this._dynamicContextCache = new Map();
    }
    /** Повертає поточну модель з налаштувань */
    get model() {
        return vscode.workspace.getConfiguration('openollamagravity').get('model', 'codellama');
    }
    cfg(key, def) {
        return vscode.workspace.getConfiguration('openollamagravity').get(key, def);
    }
    /** Оптимізує вікно контексту під конкретну модель на основі її максимальних можливостей */
    getDynamicContext(model) {
        const m = model.toLowerCase();
        if (this._dynamicContextCache.has(m))
            return this._dynamicContextCache.get(m);
        const limit = this.cfg('maxDynamicContext', 262144);
        let res;
        if (m.includes('qwen3')) {
            res = Math.min(262144, limit);
        }
        else if (m.includes('llama3.1') || m.includes('llama3.2') || m.includes('llama3.3') ||
            (m.includes('gemma3') && !m.includes('1b')) ||
            m.includes('mistral-large') ||
            m.includes('phi3') ||
            m.includes('command-r') ||
            m.includes('qwen2.5') || m.includes('qwen2-vl') ||
            m.includes('deepseek-r1') || m.includes('qwq') || m.includes('deepseek-coder-v2') ||
            m.includes('devstral')) {
            res = Math.min(131072, limit);
        }
        else if (m.includes('codellama')) {
            res = Math.min(102400, limit);
        }
        else if (m.includes('mixtral')) {
            res = Math.min(65536, limit);
        }
        else if (m.includes('mistral') || (m.includes('gemma3') && m.includes('1b'))) {
            res = Math.min(32768, limit);
        }
        else if (m.includes('phi4') || m.includes('starcoder2')) {
            res = Math.min(16384, limit);
        }
        else if (m.includes('llama3') || m.includes('gemma') || m.includes('nomic-embed') || m.includes('bge-m3')) {
            res = Math.min(8192, limit);
        }
        else if (m.includes('moondream')) {
            res = Math.min(2048, limit);
        }
        else if (m.includes('llava')) {
            res = Math.min(4096, limit);
        }
        else if (m.includes('mxbai')) {
            res = Math.min(512, limit);
        }
        else {
            res = Math.min(4096, limit);
        }
        this._dynamicContextCache.set(m, res);
        return res;
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
        const models = await this.listModels();
        return models.length > 0;
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
            const defaultPort = url.protocol === 'https:' ? 443 : 11434;
            const req = lib.request({
                hostname: url.hostname,
                port: url.port || defaultPort,
                path: '/api/chat',
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            }, res => {
                if (res.statusCode && res.statusCode >= 400) {
                    let errBuf = '';
                    res.on('data', d => errBuf += d.toString());
                    res.on('end', () => {
                        try {
                            const j = JSON.parse(errBuf);
                            reject(new Error(`Ollama API Error (${res.statusCode}): ${j.error || errBuf}`));
                        }
                        catch {
                            reject(new Error(`Ollama API HTTP ${res.statusCode}: ${errBuf}`));
                        }
                    });
                    return;
                }
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
                            if (j.error) {
                                reject(new Error(`Ollama Error: ${j.error}`));
                                return;
                            }
                            if (j.message && typeof j.message.content === 'string') {
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
            signal?.addEventListener('abort', () => {
                req.destroy();
                reject(new Error('Aborted'));
            });
            req.write(body);
            req.end();
        });
    }
    /** Генерація для inlineCompletion та простих запитів (підтримує signal) */
    async generate(prompt, maxTokens = 256, modelOverride, signal) {
        const targetModel = modelOverride || this.model;
        const ctx = this.getDynamicContext(targetModel);
        const body = JSON.stringify({
            model: targetModel,
            prompt, stream: false,
            options: { num_ctx: Math.min(ctx, 8192), num_predict: maxTokens }
        });
        try {
            const res = await this.post('/api/generate', body, signal);
            return JSON.parse(res).response || '';
        }
        catch (e) {
            if (e.message !== 'Aborted') {
                exports.oogLogger.appendLine(`[Ollama] generate() error: ${e.message}`);
            }
            return '';
        }
    }
    async get(p) {
        return new Promise((res, rej) => {
            const url = new URL(p, this.cfg('ollamaUrl', 'http://localhost:11434'));
            const lib = url.protocol === 'https:' ? https : http;
            const defaultPort = url.protocol === 'https:' ? 443 : 11434;
            const options = {
                hostname: url.hostname,
                port: url.port || defaultPort,
                path: p,
            };
            lib.get(options, r => { let d = ''; r.on('data', (c) => d += c.toString()); r.on('end', () => res(d)); }).on('error', rej);
        });
    }
    async post(p, b, signal) {
        return new Promise((res, rej) => {
            const url = new URL(p, this.cfg('ollamaUrl', 'http://localhost:11434'));
            const lib = url.protocol === 'https:' ? https : http;
            const defaultPort = url.protocol === 'https:' ? 443 : 11434;
            const req = lib.request({
                hostname: url.hostname,
                port: url.port || defaultPort,
                path: p,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            }, r => {
                let d = '';
                r.on('data', (c) => d += c.toString());
                r.on('end', () => res(d));
            });
            req.on('error', rej);
            // Прив'язка скасування HTTP запиту до AbortController
            signal?.addEventListener('abort', () => { req.destroy(); rej(new Error('Aborted')); });
            req.write(b);
            req.end();
        });
    }
}
exports.OllamaClient = OllamaClient;
