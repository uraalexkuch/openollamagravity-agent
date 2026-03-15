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
    /** Оптимізує вікно контексту під конкретну модель на основі її максимальних можливостей */
    getDynamicContext(model) {
        const m = model.toLowerCase();
        const limit = this.cfg('maxDynamicContext', 262144);
        // 256K: Абсолютний лідер
        if (m.includes('qwen3')) {
            return Math.min(262144, limit);
        }
        // 128K: Сучасні флагмани та reasoning моделі
        if (m.includes('llama3.1') || m.includes('llama3.2') || m.includes('llama3.3') ||
            (m.includes('gemma3') && !m.includes('1b')) ||
            m.includes('mistral-large') ||
            m.includes('phi3') ||
            m.includes('command-r') ||
            m.includes('qwen2.5') || m.includes('qwen2-vl') ||
            m.includes('deepseek-r1') || m.includes('qwq') || m.includes('deepseek-coder-v2') ||
            m.includes('devstral')) {
            return Math.min(131072, limit);
        }
        // 100K: CodeLlama
        if (m.includes('codellama')) {
            return Math.min(102400, limit);
        }
        // 64K: Mixtral
        if (m.includes('mixtral')) {
            return Math.min(65536, limit);
        }
        // 32K: Mistral (v0.3) та Gemma 3 (1B)
        if (m.includes('mistral') || (m.includes('gemma3') && m.includes('1b'))) {
            return Math.min(32768, limit);
        }
        // 16K: Phi-4 та StarCoder2
        if (m.includes('phi4') || m.includes('starcoder2')) {
            return Math.min(16384, limit);
        }
        // 8K: Базові Llama 3, Gemma 1/2
        if (m.includes('llama3') || m.includes('gemma') || m.includes('nomic-embed') || m.includes('bge-m3')) {
            return Math.min(8192, limit);
        }
        // 2K-4K: LLaVA, Moondream
        if (m.includes('moondream'))
            return Math.min(2048, limit);
        if (m.includes('llava'))
            return Math.min(4096, limit);
        // 512: mxbai
        if (m.includes('mxbai'))
            return Math.min(512, limit);
        // Дефолт для невідомих моделей
        return Math.min(4096, limit);
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
            const defaultPort = url.protocol === 'https:' ? 443 : 11434;
            const req = lib.request({
                hostname: url.hostname,
                port: url.port || defaultPort,
                path: '/api/chat',
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            }, res => {
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
        const targetModel = modelOverride || this.model;
        const ctx = this.getDynamicContext(targetModel);
        const body = JSON.stringify({
            model: targetModel,
            prompt, stream: false,
            options: { num_ctx: Math.min(ctx, 8192), num_predict: maxTokens }
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
    async post(p, b) {
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
            req.write(b);
            req.end();
        });
    }
}
exports.OllamaClient = OllamaClient;
