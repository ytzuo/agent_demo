import * as fs from 'fs/promises';
import * as path from 'path';
import type { Tool } from '../types';
import type { LLMAdapter } from '../llm/adapters/types';
import { SessionManager } from './session';
import { keyframes } from 'hono/css';

/**
 * 为了安全起见，限制 Agent 只能访问特定的工作目录
 * 在实际生产中，这需要更严格的沙箱隔离
 */
const ALLOWED_ROOT = process.cwd();

/** 可随意新增/删除工具，LLM 会自动选择 */
// 这里定义了 Agent 的“技能树”。
export const tools: Tool[] = [
  {
    name: 'listFiles',
    description: 'List files and directories in the current working directory or a subdirectory. Useful to explore the project structure.',
    parameters: {
      type: 'object',
      properties: {
        dirPath: { type: 'string', description: 'Relative path to list. Defaults to root "."' }
      }
    },
    handler: async ({ dirPath = '.' }: { dirPath?: string }) => {
      try {
        // 安全检查：防止目录穿越 (../..)
        const targetPath = path.resolve(ALLOWED_ROOT, dirPath);
        if (!targetPath.startsWith(ALLOWED_ROOT)) {
          return `Error: Access denied. You can only access files within ${ALLOWED_ROOT}`;
        }

        const entries = await fs.readdir(targetPath, { withFileTypes: true });
        const result = entries.map(e => e.isDirectory() ? `[DIR]  ${e.name}` : `[FILE] ${e.name}`).join('\n');
        return result || '(Empty Directory)';
      } catch (err: any) {
        return `Error listing directory: ${err.message}`;
      }
    }
  },
  {
    name: 'readFile',
    description: 'Read the contents of a text file. Use this to analyze code or read documents.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Relative path to the file to read' }
      },
      required: ['filePath']
    },
    handler: async ({ filePath }: { filePath: string }) => {
      try {
        const targetPath = path.resolve(ALLOWED_ROOT, filePath);
        if (!targetPath.startsWith(ALLOWED_ROOT)) {
          return `Error: Access denied.`;
        }

        const stats = await fs.stat(targetPath);
        if (stats.size > 10 * 1024) {
          return `Error: File is too large (${(stats.size/1024).toFixed(2)}KB). Please read specific lines or ask user to provide summary. (Currently only full read supported in this demo)`;
        }

        const content = await fs.readFile(targetPath, 'utf-8');
        return content;
      } catch (err: any) {
        return `Error reading file: ${err.message}`;
      }
    }
  },
  {
    name: 'getWeather',
    description: 'Get current weather for a city, you need to provide the city\'s lower case english name', // 描述越清晰，AI 调用越准确
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
      if(city.toLowerCase() === 'fuzhou') {
        return `${city} 现在是晴天，10~23°C`;
      }
      if(city.toLowerCase() === 'nanjing') {
        return `${city} 现在是小雨，8°C`;
      }
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
  {
    name: 'getCurrentTime',
    description: 'Get the current local time', // 获取当前时间的工具
    parameters: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      return new Date().toLocaleString();
    },
  },
  {
    name: 'recallMemory',
    description: 'Get the conversation history of the current or past messages', // 获取对话历史的工具
    parameters: {
      type: 'object',
      keyword: { type: 'string', description: 'Keyword to search in past messages' },
      limit: { type: 'number', description: 'Maximum number of results to return', default: 5 },
      method: { type: 'string', description: 'Search method, "literal" or "semantic"', default: 'literal' }
    },
    handler: async ({ keyword, limit, method }: { keyword: string; limit: number; method: string }) => {
      if (method !== 'literal' && method !== 'semantic') {
        return 'Error: Invalid search method. Please use "literal" or "semantic".';
      }
      if (!keyword) {
        return 'Error: Keyword is required.';
      }
      if (limit <= 0) {
        return 'Error: Limit must be a positive number.';
      }
      if (method === 'semantic') {
        const sessionManager = new SessionManager();
        const memory: string[] =  await sessionManager.searchBySemantic(keyword, limit);
        return memory.join('\n---\n');
      }
      if(method === 'literal') {
        const sessionManager = new SessionManager();
        const memory: string[] =  await sessionManager.searchHistory(keyword, limit);
        return memory.join('\n---\n');
      }
    }
  },
  {
    name: 'getKnowledge',
    description: 'Get knowledge about specific topics from the knowledge base. Use this to provide accurate information based on uploaded documents.',
    parameters: {
      type: 'object',
      properties: {
        topics: { type: 'string', description: 'The topics or questions to search for in the knowledge base.' },
        limit: { type: 'number', description: 'Maximum number of chunks to retrieve.', default: 5 },
      },
      required: ['topics'],
    },
    handler: async ({ topics, limit }: { topics: string; limit: number }) => {
      const sessionManager = new SessionManager();
      const knowledge: string[] = await sessionManager.searchKnowledge(topics, limit);
      return knowledge.join('\n---\n');
    },
  },
  {
    name: 'ingestKnowledge',
    description: 'Read documents from the project root "knowledge/" directory and save them into the knowledge base.',
    parameters: {
      type: 'object',
      properties: {
        dirPath: { type: 'string', description: 'Relative path to the knowledge directory. Defaults to "knowledge".', default: 'knowledge' }
      },
    },
    handler: async ({ dirPath = 'knowledge' }: { dirPath?: string }) => {
      try {
        const targetPath = path.resolve(ALLOWED_ROOT, dirPath);
        if (!targetPath.startsWith(ALLOWED_ROOT)) {
          return `Error: Access denied.`;
        }

        const sessionManager = new SessionManager();
        const result = await sessionManager.ingestKnowledge(targetPath);
        return result;
      } catch (err: any) {
        return `Error during ingestion: ${err.message}`;
      }
    }
  }
];
