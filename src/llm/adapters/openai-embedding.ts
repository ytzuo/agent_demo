
import OpenAI from 'openai';
import type { IEmbeddingAdapter } from './types';

/**
 * OpenAI (及兼容协议) Embedding 适配器
 * 
 * 适用于:
 * 1. OpenAI 官方 API
 * 2. DeepSeek
 * 3. Moonshot (Kimi)
 * 4. LocalAI / vLLM 等兼容 OpenAI 接口的服务
 */
export class OpenAIEmbeddingAdapter implements IEmbeddingAdapter {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, baseURL?: string, model: string = 'text-embedding-3-small') {
    this.client = new OpenAI({
      apiKey: apiKey,
      baseURL: baseURL,
    });
    this.model = model;
  }

  /**
   * 向量归一化 (L2 Norm)
   */
  private normalize(vector: number[]): number[] {
    const norm = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
    if (norm === 0) return vector;
    return vector.map(val => val / norm);
  }

  async getEmbedding(text: string): Promise<number[]> {
    // 简单的预处理：去除换行，避免某些模型对换行敏感
    const cleanText = text.replace(/\n/g, ' ');
    
    try {
      const response = await this.client.embeddings.create({
        model: this.model,
        input: cleanText,
        encoding_format: 'float',
      });
      const firstItem = response.data?.[0];
      if (!firstItem || !firstItem.embedding) {
        throw new Error('[OpenAIEmbedding] No embedding data returned');
      }
      return this.normalize(firstItem.embedding);
    } catch (error) {
      console.error('[OpenAIEmbedding] Failed to generate embedding:', error);
      throw error;
    }
  }

  async getEmbeddings(texts: string[]): Promise<number[][]> {
    // 简单的预处理：去除换行
    const cleanTexts = texts.map(t => t.replace(/\n/g, ' '));
    
    try {
      const response = await this.client.embeddings.create({
        model: this.model,
        input: cleanTexts,
        encoding_format: 'float',
      });
      return response.data.map(item => this.normalize(item.embedding));
    } catch (error) {
      console.error('[OpenAIEmbedding] Failed to generate embeddings:', error);
      throw error;
    }
  }
}
