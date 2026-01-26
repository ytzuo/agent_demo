import OpenAI from 'openai';
import type { Tool } from './types';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * 核心 Agent 逻辑
 * 这个函数展示了经典的 "Function Calling" (函数调用) 循环流程。
 * 
 * 流程概览：
 * 1. 【思考(Think)】: 将用户问题和工具定义发给 LLM。
 * 2. 【决策(Decide)】: LLM 判断是否需要使用工具。
 * 3. 【行动(Act)】: 如果需要，本地运行工具函数。
 * 4. 【观察(Observe)】: 将工具运行结果反馈给 LLM。
 * 5. 【回答(Response)】: LLM 根据工具结果生成最终回复。
 */
export async function runAgent(
  userMessage: string,
  history: OpenAI.Chat.ChatCompletionMessageParam[],
  tools: Tool[]
) {
  // 1. 准备工具定义
  const functions = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));

  // 2. 构建对话上下文
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    ...history,
    { role: 'user', content: userMessage },
  ];

  // 设置最大循环次数，防止死循环
  const MAX_STEPS = 5;
  let currentStep = 0;

  while (currentStep < MAX_STEPS) {
    currentStep++;
    console.log(`[Agent] Step ${currentStep} identifying...`);

    // 3. 请求 LLM
    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages,
      functions,
      temperature: 0,
    });

    const choice = completion.choices[0];
    if (!choice) {
      throw new Error('No completion choice');
    }

    // 4. 判断 LLM 意图
    if (choice.finish_reason === 'function_call' && choice.message.function_call) {
      const { name, arguments: argsStr } = choice.message.function_call;
      console.log(`[Agent] Tool Call: ${name}(${argsStr})`);

      // (a) 把 AI 的"意图"加入历史 (这很重要，否则 AI 会忘记它刚才想做什么)
      messages.push(choice.message);

      // (b) 查找并执行工具
      const tool = tools.find((t) => t.name === name);
      let runResult;

      if (!tool) {
        runResult = { error: `Tool ${name} not found` };
      } else {
        try {
          const args = JSON.parse(argsStr);
          runResult = await tool.handler(args);
        } catch (error: any) {
          runResult = { error: error.message || 'Unknown error' };
        }
      }

      console.log(`[Agent] Tool Result:`, runResult);

      // (c) 把工具执行结果加入历史
      // role: 'function' 告诉 LLM 这是之前那个函数调用的返回值
      messages.push({
        role: 'function',
        name,
        content: JSON.stringify(runResult),
      });

      // 循环继续 -> 拿着包含结果的新历史，再次询问 LLM "接下来还要做什么？"
      continue;
    }

    // 5. 如果 finish_reason 不是 function_call，说明 LLM 已经得到了满意的结果，生成了最终文本
    console.log(`[Agent] Final Reply: ${choice.message.content}`);
    return {
      reply: choice.message.content!,
      history: messages,
    };
  }

  return {
    reply: 'Sorry, I reached the maximum number of steps without finding an answer.',
    history: messages,
  };
}
