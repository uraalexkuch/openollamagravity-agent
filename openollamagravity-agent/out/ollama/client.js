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
exports.OllamaClient = void 0;
const vscode = __importStar(require("vscode"));
const http = __importStar(require("http"));
const https = __importStar(require("https"));
function cfg(key, def) {
    return vscode.workspace.getConfiguration('openollamagravity').get(key, def);
}
class OllamaClient {
    get baseUrl() { return cfg('ollamaUrl', 'http://localhost:11434'); }
    get model() { return cfg('model', 'codellama'); }
    get temp() { return cfg('temperature', 0.15); }
    get maxTok() { return cfg('maxTokens', 4096); }
    // ── Динамічне визначення розміру вікна контексту ──
    getDynamicContext(modelName) {
        const name = modelName.toLowerCase();
        // Захист від OOM (Out of Memory):
        // Навіть якщо модель підтримує 128k, Ollama впаде з помилкою, якщо VRAM < 24GB.
        // Тому ми дозволяємо обмежити "стелю" через налаштування (за замовчуванням 32768).
        const hardwareLimit = cfg('maxDynamicContext', 32768);
        // 1. Моделі з лімітом 128k (Llama 3.2, Llama 3.3, Gemma 3, Qwen, DeepSeek-R1)
        if (name.includes('llama3.2') ||
            name.includes('llama3.3') ||
            name.includes('gemma3') ||
            name.includes('qwen') ||
            name.includes('deepseek')) {
            return Math.min(131072, hardwareLimit);
        }
        // 2. Моделі з лімітом 32k (Gemma 2, Mistral)
        if (name.includes('gemma2') || name.includes('mistral')) {
            return Math.min(32768, hardwareLimit);
        }
        // 3. Моделі з лімітом 16k - 32k (Phi-4)
        if (name.includes('phi4') || name.includes('phi-4')) {
            return Math.min(16384, hardwareLimit); // Безпечний дефолт для Phi-4
        }
        // 4. Llama 3/3.1 (зазвичай 8k)
        if (name.includes('llama3')) {
            return Math.min(8192, hardwareLimit);
        }
        // 5. Стандартний (Hard Limit) контекст для інших моделей
        return cfg('baseContextSize', 4096);
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
    /** Streaming chat — calls onChunk per token, returns full text */
    async chatStream(messages, onChunk, signal, modelOverride) {
        const targetModel = modelOverride || this.model;
        const body = JSON.stringify({
            model: targetModel,
            messages,
            stream: true,
            options: {
                temperature: this.temp,
                num_predict: this.maxTok,
                num_ctx: this.getDynamicContext(targetModel)
            },
        });
        return new Promise((resolve, reject) => {
            let full = '';
            const url = new URL('/api/chat', this.baseUrl);
            const lib = url.protocol === 'https:' ? https : http;
            const req = lib.request({
                hostname: url.hostname,
                port: parseInt(url.port) || (url.protocol === 'https:' ? 443 : 11434),
                path: '/api/chat',
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            }, res => {
                let buf = '';
                if (res.statusCode && res.statusCode >= 400) {
                    res.on('data', d => buf += d.toString());
                    res.on('end', () => {
                        try {
                            reject(new Error(JSON.parse(buf).error || `HTTP ${res.statusCode}`));
                        }
                        catch {
                            reject(new Error(`HTTP ${res.statusCode}: ${buf}`));
                        }
                    });
                    return;
                }
                res.on('data', (chunk) => {
                    if (signal?.aborted) {
                        req.destroy();
                        return;
                    }
                    buf += chunk.toString();
                    const lines = buf.split('\n');
                    buf = lines.pop() ?? '';
                    for (const line of lines) {
                        if (!line.trim())
                            continue;
                        try {
                            const j = JSON.parse(line);
                            if (j.error) {
                                req.destroy();
                                reject(new Error(`Ollama Error: ${j.error}`));
                                return;
                            }
                            const tok = j?.message?.content ?? '';
                            if (tok) {
                                full += tok;
                                onChunk(tok);
                            }
                            if (j.done)
                                resolve(full);
                        }
                        catch { /* */ }
                    }
                });
                res.on('end', () => {
                    if (buf.trim()) {
                        try {
                            const j = JSON.parse(buf);
                            if (j.error) {
                                reject(new Error(`Ollama Error: ${j.error}`));
                                return;
                            }
                            const tok = j?.message?.content ?? '';
                            if (tok) {
                                full += tok;
                                onChunk(tok);
                            }
                        }
                        catch { /* */ }
                    }
                    resolve(full);
                });
                res.on('error', reject);
            });
            req.on('error', reject);
            signal?.addEventListener('abort', () => { req.destroy(); resolve(full); });
            req.write(body);
            req.end();
        });
    }
    async generate(prompt, maxTokens = 512, modelOverride) {
        const targetModel = modelOverride || this.model;
        const body = JSON.stringify({
            model: targetModel,
            prompt, stream: false,
            options: {
                temperature: this.temp,
                num_predict: maxTokens,
                num_ctx: this.getDynamicContext(targetModel)
            },
        });
        const raw = await this.post('/api/generate', body);
        return JSON.parse(raw).response ?? '';
    }
    get(path) {
        return new Promise((res, rej) => {
            const url = new URL(path, this.baseUrl);
            const lib = url.protocol === 'https:' ? https : http;
            lib.get(url.toString(), { timeout: 8000 }, r => {
                let d = '';
                r.on('data', (c) => d += c);
                r.on('end', () => {
                    if (r.statusCode && r.statusCode >= 400)
                        rej(new Error(`HTTP ${r.statusCode}`));
                    else
                        res(d);
                });
                r.on('error', rej);
            }).on('error', rej);
        });
    }
    post(path, body) {
        return new Promise((res, rej) => {
            const url = new URL(path, this.baseUrl);
            const lib = url.protocol === 'https:' ? https : http;
            const req = lib.request({
                hostname: url.hostname,
                port: parseInt(url.port) || 11434,
                path, method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            }, r => {
                let d = '';
                r.on('data', (c) => d += c);
                r.on('end', () => {
                    if (r.statusCode && r.statusCode >= 400) {
                        try {
                            rej(new Error(JSON.parse(d).error));
                        }
                        catch {
                            rej(new Error(`HTTP ${r.statusCode}`));
                        }
                    }
                    else
                        res(d);
                });
                r.on('error', rej);
            });
            req.on('error', rej);
            req.write(body);
            req.end();
        });
    }
}
exports.OllamaClient = OllamaClient;
