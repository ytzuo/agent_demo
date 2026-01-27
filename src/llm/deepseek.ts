import OpenAI from 'openai';
import type { LLMAdapter } from './types';

export class DeepSeekAdapter implements LLMAdapter {
  private openai: OpenAI;
  private model: string;

  /**
   * @param apiKey DeepSeek API Key
   * @param model 模型名称，默认为 deepseek-chat
   * @param useBeta 是否使用 Beta 版 API (https://api.deepseek.com/beta)，用于支持 strict 模式等新特性
   */
  constructor(apiKey?: string, model: string = 'deepseek-chat', useBeta: boolean = false) {
    const baseURL = (useBeta || process.env.DEEPSEEK_USE_BETA === 'true')
      ? 'https://api.deepseek.com/beta'
      : 'https://api.deepseek.com';

    this.openai = new OpenAI({
      baseURL,
      apiKey: apiKey || process.env.DEEPSEEK_API_KEY,
    });
    this.model = model;
  }

  async chat(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    tools?: OpenAI.Chat.ChatCompletionTool[]
  ): Promise<OpenAI.Chat.ChatCompletion> {
    return this.openai.chat.completions.create({
      messages,
      model: this.model,
      ...(tools && { tools }),
      temperature: 0,
    });
  }
}
