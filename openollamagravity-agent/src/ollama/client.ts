// Copyright (c) 2026 Юрій Кучеренко. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root for full license information.

import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OllamaModel {
  name: string;
  size: number;
  modified_at: string;
  details?: { family: string; parameter_size: string; quantization_level: string };
}

export const oogLogger = vscode.window.createOutputChannel('OpenOllamaGravity');

function cfg<T>(key: string, def: T): T {
  return vscode.workspace.getConfiguration('openollamagravity').get(key, def);
}

export class OllamaClient {
  public baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || cfg<string>('ollamaUrl', 'http://localhost:11434');
  }

  get model()   { return cfg<string>('model', 'codellama'); }
  get temp()    { return cfg<number>('temperature', 0.15); }
  get maxTok()  { return cfg<number>('maxTokens', 4096); }

  // ── Динамічне визначення розміру вікна контексту ──
  private getDynamicContext(modelName: string): number {
    const name = modelName.toLowerCase();

    // Захист від OOM (Out of Memory):
    // Навіть якщо модель підтримує 128k, Ollama впаде з помилкою, якщо VRAM < 24GB.
    // Тому ми дозволяємо обмежити "стелю" через налаштування (за замовчуванням 32768).
    const hardwareLimit = cfg<number>('maxDynamicContext', 32768);

    // 1. Моделі з лімітом 128k (Llama 3.2, Llama 3.3, Gemma 3, Qwen, DeepSeek-R1)
    if (
        name.includes('llama3.2') ||
        name.includes('llama3.3') ||
        name.includes('gemma3') ||
        name.includes('qwen') ||
        name.includes('deepseek')
    ) {
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
    return cfg<number>('baseContextSize', 4096);
  }

  async listModels(): Promise<OllamaModel[]> {
    try {
      const raw = await this.get('/api/tags');
      return (JSON.parse(raw).models ?? []) as OllamaModel[];
    } catch (error) {
      oogLogger.appendLine(`[OllamaClient] listModels error: ${error}`);
      return [];
    }
  }

  async isAvailable(): Promise<boolean> {
    try { await this.get('/api/tags'); return true; } catch { return false; }
  }

  /**
   * Аналізує список доступних моделей на сервері та повертає найоптимальнішу
   * для завдань кодування, спираючись на налаштування modelTiers (станом на 2026).
   */
  async findOptimalModel(): Promise<string | undefined> {
    const models = await this.listModels();
    if (!models || models.length === 0) return undefined;

    // Дефолтний рейтинг моделей станом на 2026 рік
    const defaultTiers: Record<string, number> = {
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
          .get<Record<string, number>>('modelTiers', defaultTiers);
    } catch (e) {
      // Fallback
    }

    const scoreModel = (name: string) => {
      let baseScore = 0;
      let penalties = 0;
      const lower = name.toLowerCase();

      for (const [keyword, tierScore] of Object.entries(modelTiers)) {
        if (lower.includes(keyword.toLowerCase())) {
          if (tierScore > 0) {
            baseScore = Math.max(baseScore, tierScore);
          } else {
            penalties += tierScore;
          }
        }
      }

      let finalScore = baseScore + penalties;

      const sizeMatch = lower.match(/(\d+)([bm])/);
      if (sizeMatch) {
        const size = parseInt(sizeMatch[1], 10);
        if (sizeMatch[2] === 'b') {
          if (size >= 30) finalScore += 20;
          else if (size >= 14) finalScore += 10;
          else if (size >= 7) finalScore += 5;
        }
      }

      return finalScore;
    };

    const sorted = models.sort((a, b) => scoreModel(b.name) - scoreModel(a.name));
    return sorted[0]?.name;
  }

  /** Streaming chat — calls onChunk per token, returns full text */
  async chatStream(
      messages: OllamaMessage[],
      onChunk: (tok: string) => void,
      signal?: AbortSignal,
      modelOverride?: string
  ): Promise<string> {
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
            try { reject(new Error(JSON.parse(buf).error || `HTTP ${res.statusCode}`)); }
            catch { reject(new Error(`HTTP ${res.statusCode}: ${buf}`)); }
          });
          return;
        }

        res.on('data', (chunk: Buffer) => {
          if (signal?.aborted) { req.destroy(); return; }
          buf += chunk.toString();
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const j = JSON.parse(line);

              if (j.error) {
                req.destroy();
                reject(new Error(`Ollama Error: ${j.error}`));
                return;
              }

              const tok: string = j?.message?.content ?? '';
              if (tok) { full += tok; onChunk(tok); }
              if (j.done) resolve(full);
            } catch { /* */ }
          }
        });

        res.on('end', () => {
          if (buf.trim()) {
            try {
              const j = JSON.parse(buf);
              if (j.error) { reject(new Error(`Ollama Error: ${j.error}`)); return; }
              const tok: string = j?.message?.content ?? '';
              if (tok) { full += tok; onChunk(tok); }
            } catch { /* */ }
          }
          resolve(full);
        });

        res.on('error', reject);
      });

      req.on('error', reject);
      signal?.addEventListener('abort', () => { req.destroy(); resolve(full); });
      req.write(body); req.end();
    });
  }

  async generate(prompt: string, maxTokens = 512, modelOverride?: string, signal?: AbortSignal): Promise<string> {
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
    
    try {
      const raw = await this.post('/api/generate', body, signal);
      return JSON.parse(raw).response ?? '';
    } catch (error) {
      oogLogger.appendLine(`[OllamaClient] generate error: ${error}`);
      throw error;
    }
  }

  private get(path: string): Promise<string> {
    return new Promise((res, rej) => {
      const url = new URL(path, this.baseUrl);
      const lib = url.protocol === 'https:' ? https : http;
      lib.get(url.toString(), { timeout: 8000 }, r => {
        let d = '';
        r.on('data', (c: Buffer) => d += c);
        r.on('end', () => {
          if (r.statusCode && r.statusCode >= 400) rej(new Error(`HTTP ${r.statusCode}`));
          else res(d);
        });
        r.on('error', rej);
      }).on('error', rej);
    });
  }

  private post(path: string, body: string, signal?: AbortSignal): Promise<string> {
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
        r.on('data', (c: Buffer) => d += c);
        r.on('end', () => {
          if (r.statusCode && r.statusCode >= 400) {
            try { rej(new Error(JSON.parse(d).error)); } catch { rej(new Error(`HTTP ${r.statusCode}`)); }
          } else res(d);
        });
        r.on('error', rej);
      });
      req.on('error', rej);
      signal?.addEventListener('abort', () => { req.destroy(); rej(new Error('Aborted')); });
      req.write(body); req.end();
    });
  }
}