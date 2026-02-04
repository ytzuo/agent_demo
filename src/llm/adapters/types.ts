import OpenAI from 'openai';

export interface LLMAdapter {
  chat(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    tools?: OpenAI.Chat.ChatCompletionTool[]
  ): Promise<OpenAI.Chat.ChatCompletion>;
}



/**
 * Embedding 适配器接口
 * 
 * 定义了所有 Embedding 提供商必须实现的标准接口。
 * 这种设计允许我们在不修改核心逻辑的情况下，轻松切换或添加新的 Embedding 服务。
 */
export interface IEmbeddingAdapter {
  /**
   * 将单个文本转换为向量
   * 
   * @param text 输入文本
   * @returns 向量数组 (number[])
   */
  getEmbedding(text: string): Promise<number[]>;

  /**
   * 批量将文本转换为向量
   * 
   * @param texts 文本数组
   * @returns 二维向量数组 (number[][])
   */
  getEmbeddings?(texts: string[]): Promise<number[][]>;
}
