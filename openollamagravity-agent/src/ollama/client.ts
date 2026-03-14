// Copyright (c) 2026 Юрій Кучеренко. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root for full license information.

import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';

// ── Глобальний канал виводу для технічного моніторингу ──
export const oogLogger = vscode.window.createOutputChannel('OOG Agent Log');

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OllamaModel {
  name: string;
  size: number;
  modified_at: string;
}

function cfg<T>(key: string, def: T): T {
  return vscode.workspace.getConfiguration('openollamagravity').get(key, def);
}

export class OllamaClient {
  get baseUrl() { return cfg<string>('ollamaUrl', 'http://localhost:11434'); }
  get model()   { return cfg<string>('model', 'codellama'); }
  get temp()    { return cfg<number>('temperature', 0.15); }
  get maxTok()  { return cfg<number>('maxTokens', 4096); }

  private getDynamicContext(modelName: string): number {
    const name = modelName.toLowerCase();
    const hardwareLimit = cfg<number>('maxDynamicContext', 32768);
    let ctxSize = cfg<number>('baseContextSize', 4096);

    // Моделі з великим вікном контексту (128k+)
    if (name.includes('llama3.2') || name.includes('qwen') || name.includes('deepseek')) {
      ctxSize = Math.min(131072, hardwareLimit);
    } else if (name.includes('llama3')) {
      ctxSize = Math.min(8192, hardwareLimit);
    }
    return ctxSize;
  }

  async listModels(): Promise<OllamaModel[]> {
    const raw = await this.get('/api/tags');
    return (JSON.parse(raw).models ?? []) as OllamaModel[];
  }

  async isAvailable(): Promise<boolean> {
    try { await this.get('/api/tags'); return true; } catch { return false; }
  }

  async chatStream(
      messages: OllamaMessage[],
      onChunk: (tok: string) => void,
      signal?: AbortSignal,
      modelOverride?: string
  ): Promise<string> {
    const targetModel = modelOverride || this.model;
    const dynamicCtx = this.getDynamicContext(targetModel);

    oogLogger.appendLine(`\n[${new Date().toLocaleTimeString()}] 🚀 Старт генерації (${targetModel})`);
    oogLogger.appendLine(`[${new Date().toLocaleTimeString()}] ⚙️ Вікно контексту (num_ctx): ${dynamicCtx}`);

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
        res.on('data', (chunk: Buffer) => {
          if (signal?.aborted) { req.destroy(); return; }
          if (!firstTok) {
            firstTok = true;
            oogLogger.appendLine(`[${new Date().toLocaleTimeString()}] ⏱️ Перша відповідь через ${((Date.now() - startTime) / 1000).toFixed(1)}с.`);
          }
          buf += chunk.toString();
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            try {
              const j = JSON.parse(line);
              const tok = j?.message?.content ?? '';
              if (tok) { full += tok; onChunk(tok); }
              if (j.done) {
                oogLogger.appendLine(`[${new Date().toLocaleTimeString()}] ✅ Отримано повну відповідь за ${((Date.now() - startTime) / 1000).toFixed(1)}с.`);
                resolve(full);
              }
            } catch { /* parse error */ }
          }
        });
        res.on('end', () => resolve(full));
      });
      req.on('error', reject);
      signal?.addEventListener('abort', () => req.destroy());
      req.write(body); req.end();
    });
  }

  async generate(prompt: string, maxTokens = 512, modelOverride?: string): Promise<string> {
    const targetModel = modelOverride || this.model;
    const body = JSON.stringify({
      model: targetModel,
      prompt, stream: false,
      options: { temperature: this.temp, num_predict: maxTokens, num_ctx: this.getDynamicContext(targetModel) },
    });
    const raw = await this.post('/api/generate', body);
    return JSON.parse(raw).response ?? '';
  }

  private get(path: string): Promise<string> {
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

  private post(path: string, body: string): Promise<string> {
    return new Promise((res, rej) => {
      const url = new URL(path, this.baseUrl);
      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.request({ hostname: url.hostname, port: parseInt(url.port) || 11434, path, method: 'POST', headers: { 'Content-Type': 'application/json' } }, r => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => res(d));
      });
      req.write(body); req.end();
    });
  }
}