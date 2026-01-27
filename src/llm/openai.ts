import OpenAI from 'openai';
import type { LLMAdapter } from './types';

export class OpenAIAdapter implements LLMAdapter {
  private openai: OpenAI;
  private model: string;

  constructor(apiKey?: string, model: string = 'gpt-3.5-turbo') {
    this.openai = new OpenAI({ apiKey: apiKey || process.env.OPENAI_API_KEY });
    this.model = model;
  }

  async chat(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    tools?: OpenAI.Chat.ChatCompletionTool[]
  ): Promise<OpenAI.Chat.ChatCompletion> {
    return this.openai.chat.completions.create({
      model: this.model,
      messages,
      ...(tools && { tools }),
      temperature: 0,
    });
  }
}
