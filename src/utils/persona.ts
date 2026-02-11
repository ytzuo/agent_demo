import type { LLMAdapter } from '../llm/adapters/types';
import { OpenAIAdapter } from '../llm/adapters/openai';
import { DeepSeekAdapter } from '../llm/adapters/deepseek';

/**
 * 虚拟人物定义
 */
export interface Persona {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  provider: 'openai' | 'deepseek'; // 每个 Agent 可以用不同的模型
}

export class PersonaManager {
  private personas = new Map<string, Persona>();
  private adapters = new Map<string, LLMAdapter>();

  constructor() {
    // 预置一些示例人物
    this.create({
      id: 'math-teacher',
      name: 'Math Teacher',
      description: '一个严谨的数学老师',
      systemPrompt: '你是一位严谨的数学老师，喜欢用公式推导，说话非常简练，不苟言笑，对于他人提出的数学问题，你总是耐心解答。',
      provider: 'deepseek' 
    });

    this.create({
      id: 'poet',
      name: 'Poet',
      description: '一个浪漫的诗人',
      systemPrompt: '你是一位浪漫的诗人，无论回答什么问题，都必须以诗人的语言回答，有时也会写点短诗，富有情感。',
      provider: 'deepseek'
    });
  }

  // 创建新人物
  create(persona: Persona) {
    this.personas.set(persona.id, persona);
  }

  // 获取人物设定
  get(id: string): Persona | undefined {
    return this.personas.get(id);
  }

  // 获取所有人物
  getAll(): Persona[] {
    return Array.from(this.personas.values());
  }

  // 根据 provider 获取对应的 LLM 适配器 (懒加载)
  getAdapter(provider: string): LLMAdapter {
    if (!this.adapters.has(provider)) {
        console.log(`[PersonaManager] Initializing adapter for ${provider}...`);
        try {
            if (provider === 'deepseek') {
                this.adapters.set('deepseek', new DeepSeekAdapter());
            } else {
                this.adapters.set('openai', new OpenAIAdapter());
            }
        } catch (error: any) {
            console.error(`[PersonaManager] Failed to initialize ${provider} adapter: ${error.message}`);
            // 如果初始化失败，抛出更友好的错误，避免 crash 整个应用
            throw new Error(`The AI service '${provider}' is not configured correctly. Missing API Key?`);
        }
    }
    return this.adapters.get(provider)!;
  }
}