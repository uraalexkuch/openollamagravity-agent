// Copyright (c) 2026 Юрій Кучеренко.
import * as vscode from 'vscode';
import * as http from 'http';

export interface OllamaModel {
  name: string;
  size: number;
  digest: string;
  details: {
    format: string;
    family: string;
    families: string[] | null;
    parameter_size: string;
    quantization_level: string;
  };
}

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export const oogLogger = vscode.window.createOutputChannel('OpenOllamaGravity');

export class OllamaClient {
  private baseUrl: string;

  constructor(baseUrl = 'http://127.0.0.1:11434') {
    this.baseUrl = baseUrl;
  }

  async listModels(): Promise<OllamaModel[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      const data = await response.json() as { models: OllamaModel[] };
      return data.models || [];
    } catch (error) {
      oogLogger.appendLine(`[OllamaClient] listModels error: ${error}`);
      return [];
    }
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

      const sizeMatch = lower.match(/(\d+)(b|m)/);
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

  async generate(prompt: string, num_predict = 2048, model = 'llama3'): Promise<string> {
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
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      const data = await response.json() as { response: string };
      return data.response;
    } catch (error) {
      oogLogger.appendLine(`[OllamaClient] generate error: ${error}`);
      throw error;
    }
  }

  async chatStream(
      messages: OllamaMessage[],
      onChunk: (text: string) => void,
      signal?: AbortSignal,
      model = 'llama3'
  ): Promise<string> {
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
            } catch (e) {
              // ignore parse errors for incomplete chunks
            }
          }
        });
        res.on('end', () => resolve(fullText));
      });

      req.on('error', (e) => {
        if (signal?.aborted) {
          reject(new Error('Aborted'));
        } else {
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