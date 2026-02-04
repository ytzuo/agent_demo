
import * as crypto from 'crypto';

import type { IEmbeddingAdapter } from './types';

/**
 * 智谱 AI Embedding API 响应接口定义
 * 对应 API 文档: https://open.bigmodel.cn/dev/api#text_embedding
 */
interface ZhipuResponse {
  data: Array<{
    embedding: number[];
    index: number;
    object: string;
  }>;
  model: string;
  object: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * 智谱 AI (ZhipuAI/GLM) Embedding 适配器
 * 
 * 由于智谱 AI 的 API 鉴权方式（自定义 JWT）与 OpenAI 不兼容，
 * 因此独立实现该适配器，而不是复用 OpenAI SDK。
 */
export class ZhipuEmbeddingAdapter implements IEmbeddingAdapter {
  private apiKey: string;
  private baseURL: string;
  private model: string;

  /**
   * @param apiKey 智谱 API Key (格式: id.secret)
   * @param baseURL API 基础 URL
   * @param model 模型名称 (默认: embedding-3)
   */
  constructor(apiKey: string, baseURL: string = 'https://open.bigmodel.cn/api/paas/v4', model: string = 'embedding-3') {
    this.apiKey = apiKey;
    this.baseURL = baseURL;
    this.model = model;
  }

  /**
   * 生成智谱 API 所需的 JWT Token
   * 
   * 智谱 API 不直接使用 API Key，而是需要将其拆分为 id 和 secret，
   * 并使用 HMAC-SHA256 算法生成 JWT Token。
   * Token 有效期通常建议设置较短（此处设为 1 小时）。
   */
  private generateToken(): string {
    const [id, secret] = this.apiKey.split('.');
    if (!id || !secret) throw new Error('Invalid Zhipu API Key format. Expected "id.secret"');

    const now = Date.now();
    const payload = {
      api_key: id,
      exp: now + 3600 * 1000, // 1小时后过期
      timestamp: now,
    };

    const header = {
      alg: 'HS256',
      sign_type: 'SIGN',
    };

    // 使用 base64url 编码 Header 和 Payload
    const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');

    // 生成签名
    const signature = crypto
      .createHmac('sha256', Buffer.from(secret, 'utf8'))
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest('base64url');

    return `${encodedHeader}.${encodedPayload}.${signature}`;
  }

  /**
   * 向量归一化 (L2 Norm)
   * 确保向量长度为 1，这对余弦相似度计算很重要
   */
  private normalize(vector: number[]): number[] {
    const norm = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
    if (norm === 0) return vector;
    return vector.map(val => val / norm);
  }

  /**
   * 获取单个文本的向量
   */
  async getEmbedding(text: string): Promise<number[]> {
    const token = this.generateToken();
    const cleanText = text.replace(/\n/g, ' '); // 移除换行符，避免影响生成质量

    const response = await fetch(`${this.baseURL}/embeddings`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.model,
        input: cleanText,
        dimension: 1536 
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`[Zhipu] API Error: ${response.status} ${errText}`);
    }

    const data = await response.json() as ZhipuResponse;
    if (!data.data?.[0]?.embedding) {
      throw new Error('[Zhipu] No embedding data returned');
    }
    
    // 如果返回的维度大于 1536，进行裁剪并重新归一化
    // 这样做是为了兼容 vector(1536) 的数据库定义
    let embedding = data.data[0].embedding;
    if (embedding.length > 1536) {
        embedding = embedding.slice(0, 1536);
        return this.normalize(embedding);
    }
    
    return this.normalize(embedding);
  }

  /**
   * 批量获取文本向量
   */
  async getEmbeddings(texts: string[]): Promise<number[][]> {
    const token = this.generateToken();
    // 智谱 API 可能对 batch size 有限制，这里不做额外分片，假设调用方会控制
    const cleanTexts = texts.map(t => t.replace(/\n/g, ' '));

    const response = await fetch(`${this.baseURL}/embeddings`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.model,
        input: cleanTexts,
        dimension: 1536
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`[Zhipu] API Error: ${response.status} ${errText}`);
    }

    const data = await response.json() as ZhipuResponse;
    if (!data.data) {
      throw new Error('[Zhipu] No embedding data returned');
    }
    
    return data.data.map(item => {
        let embedding = item.embedding;
        if (embedding.length > 1536) {
            embedding = embedding.slice(0, 1536);
            return this.normalize(embedding);
        }
        return this.normalize(embedding);
    });
  }
}
