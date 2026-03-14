// Copyright (c) 2026 Юрій Кучеренко.
import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';

export const oogLogger = vscode.window.createOutputChannel('OOG Agent Log');

export interface OllamaMessage { role: 'system' | 'user' | 'assistant'; content: string; }

export class OllamaClient {
  /** Повертає поточну модель з налаштувань */
  get model(): string {
    return vscode.workspace.getConfiguration('openollamagravity').get('model', 'codellama');
  }

  private cfg<T>(key: string, def: T): T {
    return vscode.workspace.getConfiguration('openollamagravity').get(key, def);
  }

  /** Оптимізує вікно контексту під конкретну модель */
  private getDynamicContext(model: string): number {
    const m = model.toLowerCase();
    const limit = this.cfg<number>('maxDynamicContext', 32768);
    if (m.includes('llama3.2') || m.includes('qwen') || m.includes('deepseek')) return Math.min(131072, limit);
    if (m.includes('gemma') || m.includes('mistral')) return Math.min(32768, limit);
    return Math.min(8192, limit);
  }

  async listModels(): Promise<any[]> {
    try {
      const res = await this.get('/api/tags');
      return JSON.parse(res).models || [];
    } catch { return []; }
  }

  async isAvailable(): Promise<boolean> {
    try { await this.get('/api/tags'); return true; } catch { return false; }
  }

  async chatStream(messages: OllamaMessage[], onChunk: (t: string) => void, signal?: AbortSignal, modelOverride?: string): Promise<string> {
    const targetModel = modelOverride || this.model;
    const ctx = this.getDynamicContext(targetModel);
    oogLogger.appendLine(`\n[${new Date().toLocaleTimeString()}] 🚀 Генерація: ${targetModel} (Context: ${ctx})`);

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
        res.on('data', (chunk: Buffer) => {
          if (signal?.aborted) { req.destroy(); return; }
          buf += chunk.toString();
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            try {
              const j = JSON.parse(line);
              if (j.message?.content) { full += j.message.content; onChunk(j.message.content); }
              if (j.done) resolve(full);
            } catch {}
          }
        });
        res.on('end', () => resolve(full));
      });
      req.on('error', reject);
      signal?.addEventListener('abort', () => { req.destroy(); resolve(full); });
      req.write(body); req.end();
    });
  }

  /** Генерація для inlineCompletion та простих запитів */
  async generate(prompt: string, maxTokens = 256, modelOverride?: string): Promise<string> {
    const body = JSON.stringify({
      model: modelOverride || this.model,
      prompt, stream: false,
      options: { num_ctx: 4096, num_predict: maxTokens }
    });
    try {
      const res = await this.post('/api/generate', body);
      return JSON.parse(res).response || '';
    } catch { return ''; }
  }

  private async get(p: string): Promise<string> {
    return new Promise((res, rej) => {
      const url = new URL(p, this.cfg('ollamaUrl', 'http://localhost:11434'));
      http.get(url.toString(), r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); }).on('error', rej);
    });
  }

  private async post(p: string, b: string): Promise<string> {
    return new Promise((res, rej) => {
      const url = new URL(p, this.cfg('ollamaUrl', 'http://localhost:11434'));
      const req = http.request({ hostname: url.hostname, port: url.port || 11434, path: p, method: 'POST', headers: { 'Content-Type': 'application/json' } }, r => {
        let d = ''; r.on('data', c => d += c); r.on('end', () => res(d));
      });
      req.on('error', rej); req.write(b); req.end();
    });
  }
}