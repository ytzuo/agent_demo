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
  // 我们需要把本地的 Tool 类型转换为 OpenAI API 需要的格式
  const functions = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));

  // 2. 构建对话上下文
  // LLM 是无状态的，每次请求都必须携带完整的对话历史
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    ...history,
    { role: 'user', content: userMessage },
  ];

  // 3. 第一次请求 LLM (思考阶段)
  // 我们把 functions 传给它，告诉它："你可以使用这些工具，如果需要的话请告诉我"
  const completion = await openai.chat.completions.create({
    model: 'gpt-3.5-turbo',
    messages,
    functions, // 注入能力
    temperature: 0, // 设置为 0 让输出更确定，适合工具调用场景
  });

  const choice = completion.choices[0];
  if (!choice) {
    throw new Error('No completion choice');
  }

  // 4. 检查 LLM 是否决定调用函数
  // finish_reason === 'function_call' 意味着 LLM 认为需要使用工具来回答问题
  if (choice.finish_reason === 'function_call' && choice.message.function_call) {
    const { name, arguments: argsStr } = choice.message.function_call;
    
    // 找到对应的本地工具实现
    const tool = tools.find((t) => t.name === name);
    if (!tool) return { reply: `No tool ${name}`, history: messages };

    // 解析参数并执行代码 (行动阶段)
    const args = JSON.parse(argsStr);
    const output = await tool.handler(args);

    // 5. 再次请求 LLM (观察与回答阶段)
    // 关键步骤：我们要把这一轮的交互完整记录下来发回给 LLM
    
    // (a) 添加 LLM 之前的决定："我想调用 xxx 函数"
    messages.push(choice.message);
    
    // (b) 添加函数执行的结果："调用 xxx 的结果是 yyy"
    // role: 'function' 是专门用于告诉 LLM 工具输出的
    messages.push({
      role: 'function',
      name,
      content: JSON.stringify(output),
    });

    // (c) 让 LLM 根据这些新信息，生成给用户的最终自然语言回答
    const second = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages,
      temperature: 0,
    });
    const secondChoice = second.choices[0];
    if (!secondChoice) {
        throw new Error('No second completion choice');
    }

    return {
      reply: secondChoice.message.content!,
      history: messages, // 返回更新后的历史记录
    };
  }

  // 如果 LLM 决定不调用工具，直接返回它的文本回复
  return {
    reply: choice.message.content!,
    history: messages,
  };
}
