
import type { IEmbeddingAdapter } from './adapters/types';
import { ZhipuEmbeddingAdapter } from './adapters/zhipu-embedding';
import { OpenAIEmbeddingAdapter } from './adapters/openai-embedding';

/**
 * 通用 Embedding 适配器 (Facade)
 * 
 * 这是一个门面类，根据配置（环境变量或构造参数）自动选择并管理具体的 Embedding 适配器。
 * 它的主要职责是：
 * 1. 初始化逻辑：根据 provider 实例化正确的适配器
 * 2. 统一接口：对外提供一致的调用方式
 */
export class EmbeddingAdapter implements IEmbeddingAdapter {
  private adapter: IEmbeddingAdapter;
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
        this.adapter = new ZhipuEmbeddingAdapter(
            key, 
            baseURL || 'https://open.bigmodel.cn/api/paas/v4', 
            model
        );
    } else {
        // 初始化 OpenAI 兼容适配器 (默认)
        // 支持 DeepSeek, Moonshot 等兼容 OpenAI 接口的模型
        const key = apiKey || process.env.OPENAI_API_KEY;
        // 注意：OpenAI SDK 允许 apiKey 为空 (如果只是为了测试或者有其他配置方式)，但通常是需要的
        // 如果这里不传，OpenAI SDK 内部也会尝试读环境变量
        // 为了保持一致性，我们尽量显式传递
        
        this.adapter = new OpenAIEmbeddingAdapter(
            key || '', // 如果没传且环境变量也没有，OpenAI SDK 可能会报错，这里透传空字符串让 SDK 处理或报错
            baseURL || process.env.OPENAI_BASE_URL,
            model
        );
    }
  }

  /**
   * 将单个文本转换为向量
   */
  async getEmbedding(text: string): Promise<number[]> {
    return this.adapter.getEmbedding(text);
  }

  /**
   * 批量将文本转换为向量
   */
  async getEmbeddings(texts: string[]): Promise<number[][]> {
    if (this.adapter.getEmbeddings) {
        return this.adapter.getEmbeddings(texts);
    }
    // Fallback: 如果适配器没实现批量接口，循环调用 (虽然目前我们的两个实现都实现了)
    return Promise.all(texts.map(text => this.adapter.getEmbedding(text)));
  }
}
