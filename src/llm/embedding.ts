
import OpenAI from 'openai';
import { ZhipuEmbeddingAdapter } from './zhipu-embedding';

/**
 * 通用 Embedding 适配器
 * 
 * 这是一个 Facade 类，根据配置（环境变量或构造参数）自动选择具体的 Embedding 提供商。
 * 目前支持：
 * 1. OpenAI (及兼容协议，如 DeepSeek, LocalAI 等)
 * 2. Zhipu AI (GLM) - 使用自定义适配器处理鉴权
 */
export class EmbeddingAdapter {
  private client?: OpenAI;
  private zhipuAdapter?: ZhipuEmbeddingAdapter;
  private model: string;

  /**
   * 初始化适配器
   * 
   * @param apiKey API Key (可选，默认读取环境变量)
   * @param baseURL API Base URL (可选，默认读取环境变量)
   * @param model 模型名称 (默认: embedding-3)
   * @param provider 显式指定提供商 ('openai' | 'zhipu' | 'glm' ...)，默认读取 EMBEDDING_PROVIDER
   */
  constructor(apiKey?: string, baseURL?: string, model: string = 'embedding-3', provider?: string) {
    const currentProvider = provider || process.env.EMBEDDING_PROVIDER || 'openai';
    this.model = model;

    // 根据 provider 选择初始化策略
    if (currentProvider === 'zhipu' || currentProvider === 'glm') {
        // 初始化智谱适配器
        const key = apiKey || process.env.ZHIPU_API_KEY;
        if (!key) throw new Error('Zhipu API Key is required when provider is zhipu');
        this.zhipuAdapter = new ZhipuEmbeddingAdapter(
            key, 
            baseURL || 'https://open.bigmodel.cn/api/paas/v4', 
            model
        );
    } else {
        // 初始化 OpenAI 兼容适配器 (默认)
        // 支持 DeepSeek, Moonshot 等兼容 OpenAI 接口的模型
        this.client = new OpenAI({
            apiKey: apiKey || process.env.OPENAI_API_KEY,
            baseURL: baseURL || process.env.OPENAI_BASE_URL,
        });
    }
  }

  /**
   * 向量归一化 (L2 Norm)
   * 
   * 将向量长度归一化为 1。
   * 许多向量数据库和相似度计算（如余弦相似度）在使用归一化向量时效率更高或更准确。
   */
  private normalize(vector: number[]): number[] {
    const norm = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
    if (norm === 0) return vector;
    return vector.map(val => val / norm);
  }

  /**
   * 将单个文本转换为向量
   * 
   * @param text 输入文本
   * @returns 向量数组
   */
  async getEmbedding(text: string): Promise<number[]> {
    // 策略模式：委托给具体的适配器
    if (this.zhipuAdapter) {
        return this.zhipuAdapter.getEmbedding(text);
    }

    if (!this.client) throw new Error('OpenAI client is not initialized');

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
        throw new Error('[Embedding] No embedding data returned');
      }
      return this.normalize(firstItem.embedding);
    } catch (error) {
      console.error('[Embedding] Failed to generate embedding:', error);
      throw error;
    }
  }

  /**
   * 批量将文本转换为向量
   * 
   * @param texts 文本数组
   * @returns 二维向量数组
   */
  async getEmbeddings(texts: string[]): Promise<number[][]> {
    if (this.zhipuAdapter) {
        return this.zhipuAdapter.getEmbeddings(texts);
    }

    if (!this.client) throw new Error('OpenAI client is not initialized');

    try {
      const response = await this.client.embeddings.create({
        model: this.model,
        input: texts,
        encoding_format: 'float',
      });
      return response.data.map(item => this.normalize(item.embedding));
    } catch (error) {
      console.error('[Embedding] Failed to generate embeddings:', error);
      throw error;
    }
  }
}
