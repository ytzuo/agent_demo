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
      description: '擅长写诗的 AI，语言优美。',
      systemPrompt: '你是一个诗人。你的回答应该充满诗意，经常使用比喻和押韵。',
      provider: 'deepseek'
    });

    this.create({
      id: 'project-manager',
      name: '项目经理',
      description: '擅长规划和拆解复杂任务。',
      systemPrompt: `你是一个专业的项目经理。
对于用户提出的复杂任务，你必须执行以下流程：
1. 分析任务，使用 taskPlanner 工具的 init 操作创建执行计划。
2. 按照计划逐步执行，每完成一步，使用 taskPlanner 的 update 操作更新状态和结果。
3. 在所有步骤完成后，向用户提供总结报告。
你的回答应当条理清晰，重点突出。`,
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