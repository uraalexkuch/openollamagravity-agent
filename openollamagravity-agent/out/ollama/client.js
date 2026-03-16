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
exports.oogLogger = vscode.window.createOutputChannel('OpenOllamaGravity');
class OllamaClient {
    constructor(baseUrl = 'http://127.0.0.1:11434') {
        this.baseUrl = baseUrl;
    }
    async listModels() {
        try {
            const response = await fetch(`${this.baseUrl}/api/tags`);
            if (!response.ok)
                throw new Error(`HTTP error! status: ${response.status}`);
            const data = await response.json();
            return data.models || [];
        }
        catch (error) {
            exports.oogLogger.appendLine(`[OllamaClient] listModels error: ${error}`);
            return [];
        }
    }
    /**
     * Аналізує список доступних моделей на сервері та повертає найоптимальнішу
     * для завдань кодування, спираючись на налаштування modelTiers (станом на 2026).
     */
    async findOptimalModel() {
        const models = await this.listModels();
        if (!models || models.length === 0)
            return undefined;
        // Дефолтний рейтинг моделей станом на 2026 рік
        const defaultTiers = {
            "deepseek-r1": 100, "deepseek-v3.2": 100, "qwen3": 100, "glm-5": 100,
            "llama3.3": 95, "qwen2.5-coder": 95, "devstral": 90, "phi4": 90,
            "codestral": 90, "yi-coder": 90, "gpt-oss": 90, "minimax-m2.5": 85,
            "gemma3": 85, "llama3.2": 85, "llama3.1": 80, "qwen2.5": 80,
            "deepseek-coder-v2": 80, "mistral-large": 80, "starcoder2": 70,
            "mixtral": 70, "deepseek-coder": 70, "codellama": 60, "llama3": 50,
            "phi3": -20, "llama2": -50, "llama3.2:1b": -50, "gemma:2b": -50,
            "gemma2:2b": -50, "qwen:0.5b": -50, "qwen2.5:0.5b": -50, "qwen2.5:1.5b": -50
        };
        let modelTiers = defaultTiers;
        try {
            modelTiers = vscode.workspace
                .getConfiguration('openollamagravity')
                .get('modelTiers', defaultTiers);
        }
        catch (e) {
            // Fallback
        }
        const scoreModel = (name) => {
            let baseScore = 0;
            let penalties = 0;
            const lower = name.toLowerCase();
            for (const [keyword, tierScore] of Object.entries(modelTiers)) {
                if (lower.includes(keyword.toLowerCase())) {
                    if (tierScore > 0) {
                        baseScore = Math.max(baseScore, tierScore);
                    }
                    else {
                        penalties += tierScore;
                    }
                }
            }
            let finalScore = baseScore + penalties;
            const sizeMatch = lower.match(/(\d+)(b|m)/);
            if (sizeMatch) {
                const size = parseInt(sizeMatch[1], 10);
                if (sizeMatch[2] === 'b') {
                    if (size >= 30)
                        finalScore += 20;
                    else if (size >= 14)
                        finalScore += 10;
                    else if (size >= 7)
                        finalScore += 5;
                }
            }
            return finalScore;
        };
        const sorted = models.sort((a, b) => scoreModel(b.name) - scoreModel(a.name));
        return sorted[0]?.name;
    }
    async generate(prompt, num_predict = 2048, model = 'llama3') {
        try {
            const response = await fetch(`${this.baseUrl}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model,
                    prompt,
                    stream: false,
                    options: { num_predict, temperature: 0.1 }
                })
            });
            if (!response.ok)
                throw new Error(`HTTP error! status: ${response.status}`);
            const data = await response.json();
            return data.response;
        }
        catch (error) {
            exports.oogLogger.appendLine(`[OllamaClient] generate error: ${error}`);
            throw error;
        }
    }
    async chatStream(messages, onChunk, signal, model = 'llama3') {
        return new Promise((resolve, reject) => {
            const url = new URL(`${this.baseUrl}/api/chat`);
            const req = http.request(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal
            }, (res) => {
                let fullText = '';
                res.on('data', (chunk) => {
                    const lines = chunk.toString().split('\n').filter(Boolean);
                    for (const line of lines) {
                        try {
                            const parsed = JSON.parse(line);
                            if (parsed.message?.content) {
                                fullText += parsed.message.content;
                                onChunk(parsed.message.content);
                            }
                        }
                        catch (e) {
                            // ignore parse errors for incomplete chunks
                        }
                    }
                });
                res.on('end', () => resolve(fullText));
            });
            req.on('error', (e) => {
                if (signal?.aborted) {
                    reject(new Error('Aborted'));
                }
                else {
                    reject(e);
                }
            });
            req.write(JSON.stringify({
                model,
                messages,
                stream: true,
                options: { temperature: 0.1 }
            }));
            req.end();
        });
    }
}
exports.OllamaClient = OllamaClient;
