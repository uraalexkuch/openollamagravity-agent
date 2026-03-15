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

  /** Оптимізує вікно контексту під конкретну модель на основі її максимальних можливостей */
  private getDynamicContext(model: string): number {
    const m = model.toLowerCase();

    // Піднімаємо глобальний дефолтний ліміт до 256K (262144), щоб лідер Qwen3 міг працювати на максимум
    const limit = this.cfg<number>('maxDynamicContext', 262144);

    // 256K: Абсолютний лідер
    if (m.includes('qwen3')) {
      return Math.min(262144, limit);
    }

    // 128K: Сучасні флагмани та reasoning моделі
    if (
        m.includes('llama3.1') || m.includes('llama3.2') || m.includes('llama3.3') ||
        (m.includes('gemma3') && !m.includes('1b')) ||
        m.includes('mistral-large') ||
        m.includes('phi3') ||
        m.includes('command-r') ||
        m.includes('qwen2.5') || m.includes('qwen2-vl') ||
        m.includes('deepseek-r1') || m.includes('qwq') || m.includes('deepseek-coder-v2') ||
        m.includes('devstral')
    ) {
      return Math.min(131072, limit);
    }

    // 100K: Специфічно для CodeLlama
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

    // 16K: Phi-4 (вкл. reasoning) та StarCoder2
    if (m.includes('phi4') || m.includes('starcoder2')) {
      return Math.min(16384, limit);
    }

    // 8K: Базові версії Llama 3, Gemma 1/2, та великі ембедінги
    if (m.includes('llama3') || m.includes('gemma') || m.includes('nomic-embed') || m.includes('bge-m3')) {
      return Math.min(8192, limit);
    }

    // 2K-4K: LLaVA, Moondream та застарілі моделі
    if (m.includes('moondream')) return Math.min(2048, limit);
    if (m.includes('llava')) return Math.min(4096, limit);

    // 512: Специфічні малі ембедінги (mxbai)
    if (m.includes('mxbai')) return Math.min(512, limit);

    // Дефолтний fallback для невідомих моделей (4K)
    return Math.min(4096, limit);
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