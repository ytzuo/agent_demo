import type { Tool } from './types';

/** 可随意新增/删除工具，LLM 会自动选择 */
// 这里定义了 Agent 的“技能树”。
// 每一个对象都是一个技能，包含：
// 1. 认知层：name/description/parameters (让 AI 知道它能做什么)
// 2. 执行层：handler (通过代码实现真正的能力)
export const tools: Tool[] = [
  {
    name: 'getWeather',
    description: 'Get current weather for a city', // 描述越清晰，AI 调用越准确
    parameters: {
      type: 'object',
      properties: {
        // 定义参数字段，AI 会尝试从用户对话中提取这些信息
        city: { type: 'string' },
      },
      required: ['city'], // 必填项，如果用户没提供，AI 可能会反问用户
    },
    // 将被调用的实际函数
    handler: async ({ city }: { city: string }) => {
      // 在实际生产中，这里通常会调用第三方 API (如高德地图、OpenWeatherMap)
      // Agent 的价值就在于它可以灵活编排这些 API 调用
      return `${city} 现在是晴天，25°C`;
    },
  },
  {
    name: 'add',
    description: 'Add two numbers', // 简单的工具，用于增强 LLM 的计算能力（防止它胡说八道计算题）
    parameters: {
      type: 'object',
      properties: {
        a: { type: 'number' },
        b: { type: 'number' },
      },
      required: ['a', 'b'],
    },
    handler: async ({ a, b }: { a: number; b: number }) => a + b,
  },
];
