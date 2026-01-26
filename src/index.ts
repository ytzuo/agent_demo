import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import OpenAI from 'openai';
import { runAgent } from './agent';
import { tools } from './tools';
import 'dotenv/config';

type Bindings = { history: OpenAI.Chat.ChatCompletionMessageParam[] };

const app = new Hono<{ Variables: Bindings }>();

// 简单的内存会话池（重启即丢）
// 在生产环境中，这里通常替换为 Redis 或数据库
// 作用：为每个用户（sessionId）维护一段独立的对话历史，让 AI 拥有"记忆"
const sessions = new Map<string, OpenAI.Chat.ChatCompletionMessageParam[]>();

app.post('/chat', async (c) => {
  const body = await c.req.json<{ sessionId?: string; message: string }>();
  const { sessionId = 'default', message } = body;
  if (!message) return c.json({ error: 'missing message' }, 400);

  // 获取该用户的历史上下文
  let history = sessions.get(sessionId) ?? [];
  
  // 简单的上下文窗口管理：只保留最近 6 条消息（3轮对话）
  // 这里的考量是：
  // 1. 节省 Token 成本
  // 2. 防止超出 LLM 的上下文长度限制
  if (history.length > 6) history = history.slice(-6);

  // 运行 Agent
  const { reply, history: newHistory } = await runAgent(message, history, tools);
  
  // 保存更新后的历史
  // 别忘了把 AI 的最新回复也追加进去
  sessions.set(sessionId, [
    ...newHistory,
    { role: 'assistant', content: reply },
  ]);

  return c.json({ reply, sessionId });
});

const port = Number(process.env.PORT) || 3000;
serve({ fetch: app.fetch, port });
console.log(`Agent ready → POST http://localhost:${port}/chat`);
