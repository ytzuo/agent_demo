import OpenAI from 'openai';
import type { Tool } from './types';
import type { LLMAdapter } from './llm/types';

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
  llm: LLMAdapter,
  userMessage: string,
  history: OpenAI.Chat.ChatCompletionMessageParam[],
  tools: Tool[]
) {
  // 1. 准备工具定义 (使用新的 tools API)
  const toolsParam: OpenAI.Chat.ChatCompletionTool[] = tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));

  // 2. 构建对话上下文
  // 如果历史记录中没有 System Prompt，则添加默认 Prompt
  const hasSystemPrompt = history.some(m => m.role === 'system');
  const systemPrompt: OpenAI.Chat.ChatCompletionMessageParam[] = hasSystemPrompt ? [] : [
    { role: 'system', content: 'You are a helpful assistant. You can call tools to help answer user questions.' }
  ];

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    ...systemPrompt,
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
    const completion = await llm.chat(messages, toolsParam);

    const choice = completion.choices[0];
    if (!choice) {
      throw new Error('No completion choice');
    }

    // 4. 判断 LLM 意图 (兼容 tool_calls 和 遗留的 function_call)
    const toolCalls = choice.message.tool_calls;
    
    if (toolCalls && toolCalls.length > 0) {
      // (a) 把 AI 的"意图"加入历史
      messages.push(choice.message);

      // (b) 遍历执行所有 requested tools
      for (const toolCall of toolCalls) {
        if (toolCall.type !== 'function') {
           console.log(`[Agent] Unknown tool type: ${toolCall.type}`);
           continue;
        }

        const { function: { name, arguments: argsStr }, id } = toolCall;
        console.log(`[Agent] Tool Call: ${name}(${argsStr})`);

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
        // role: 'tool'，并且需要带上 tool_call_id
        messages.push({
          role: 'tool',
          tool_call_id: id,
          content: JSON.stringify(runResult),
        });
      }

      // 循环继续
      continue;
    }

    // 5. 最终回复
    console.log(`[Agent] Final Reply: ${choice.message.content}`);
    return {
      reply: choice.message.content || 'No content returned',
      history: messages,
    };
  }

  return {
    reply: 'Sorry, I reached the maximum number of steps without finding an answer.',
    history: messages,
  };
}
