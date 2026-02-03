import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import OpenAI from 'openai';
import { runAgent } from './agent';
import { tools } from './tools';
import { SessionManager } from './session';
import { PersonaManager } from './persona';
import type { Persona } from './persona';
import { RequestQueue } from './queue';
import { UserProfileManager } from './user';
import type { UserProfile } from './user';

type Bindings = { history: OpenAI.Chat.ChatCompletionMessageParam[] };

const app = new Hono<{ Variables: Bindings }>();

const sessionManager = new SessionManager();
const personaManager = new PersonaManager();
const personaQueue = new RequestQueue();
const userProfileManager = new UserProfileManager();

console.log(`[System] Agent Server Initialized`);

// ---------------------------------------------------------
// 1. 人物管理 API
// ---------------------------------------------------------


// 获取所有可用人物
app.get('/personas', (c) => {
  return c.json(personaManager.getAll());
});

// 创建新人物
// TODO: 还需要添加持久化逻辑
app.post('/personas', async (c) => {
  const body = await c.req.json<Persona>();
  if (!body.id || !body.systemPrompt) {
    return c.json({ error: 'Missing id or systemPrompt' }, 400);
  }
  // 默认 provider
  if (!body.provider) body.provider = 'openai';
  
  personaManager.create(body);
  return c.json({ message: 'Persona created', persona: body });
});

// ---------------------------------------------------------
// 1.5 用户画像 API
// ---------------------------------------------------------

app.get('/profile/:id', async (c) => {
  const id = c.req.param('id');
  const profile = await userProfileManager.get(id);
  if (!profile) return c.json({ error: 'User not found' }, 404);
  return c.json(profile);
});

app.post('/profile', async (c) => {
  const body = await c.req.json<Partial<UserProfile> & { id: string }>();
  if (!body.id) {
    return c.json({ error: 'Missing user id' }, 400);
  }
  
  try {
    const updated = await userProfileManager.update(body.id, body);
    return c.json({ message: 'User profile updated', profile: updated });
  } catch (error) {
    return c.json({ error: 'Failed to update profile' }, 500);
  }
});

// ---------------------------------------------------------
// 2. 聊天 API (支持指定 personaId)
// ---------------------------------------------------------
app.post('/chat', async (c) => {
  const body = await c.req.json<{ 
    sessionId?: string; 
    message: string; 
    personaId?: string; // 指定要聊天的对象
    needSave?: boolean;
  }>();

  const { sessionId = 'default', message, personaId = 'math-teacher', needSave = false } = body;
  
  if (!message) return c.json({ error: 'missing message' }, 400);

  // 获取人物设定
  const persona = personaManager.get(personaId);
  if (!persona) return c.json({ error: `Persona ${personaId} not found` }, 404);

  // 这里的 sessionId 建议组合一下，避免混淆，例如 "user-123:math-teacher"
  // 这样同一个用户可以分别和不同的 AI 保持独立的历史
  const effectiveSessionId = `${sessionId}:${personaId}`;

  // 获取 Session，并确保 System Prompt 是该人物的
  const session = sessionManager.getOrCreate(effectiveSessionId, { systemPrompt: persona.systemPrompt });

  // 简单的并发锁
  if (!sessionManager.tryLock(effectiveSessionId)) {
    return c.json({ error: 'Too many requests. Please wait.' }, 429);
  }

  try {
    // 0. RAG 检索 & User Profile 注入
    // ----------------------------------------------------------------
    //const userProfile = await userProfileManager.get(sessionId.split(':')[0] || 'default'); // 假设 sessionId 格式为 user:xxx
    //const profileContext = userProfile ? userProfileManager.buildContext(userProfile) : '';

    const ragResults = await sessionManager.getRAG().searchContext(message, undefined, 3, 0.5);
    const ragContext = ragResults.length > 0 
      ? `\n\n[Relevant Past Memories]\n${ragResults.map(r => `- ${r.content} (Time: ${r.createdAt})`).join('\n')}`
      : '';

    // 动态更新本次会话的 System Prompt (不持久化到 Session Config，只影响本次)
    // 注意：这里需要深拷贝或切片，避免副作用
    let historyInput = [...session.history];
    
    // 如果历史第一条是 System Prompt，我们追加 Context
    const firstMsg = historyInput[0];
    if (firstMsg && firstMsg.role === 'system') {
       const originalSystem = firstMsg.content as string;
       historyInput[0] = {
         role: 'system',
         content: originalSystem + ragContext
       };
    } else {
       // 如果没有 System Prompt，插入一条
       historyInput.unshift({
         role: 'system',
         content: (persona.systemPrompt || 'You are a helpful assistant.') + ragContext
       });
    }

    // 1. 上下文窗口截断 (简单的滑动窗口)
    // ----------------------------------------------------------------
    if (historyInput.length > 12) {
        // 尝试保留 system prompt (现在已经是注入了 context 的版本)
        const firstMsg = historyInput[0];
        const recent = historyInput.slice(-10);
        
        if (firstMsg && firstMsg.role === 'system') {
            historyInput = [firstMsg, ...recent];
        } else {
            historyInput = recent;
        }
    }

    // 获取 LLM 适配器 (根据人物设定的 provider)
    const llm = personaManager.getAdapter(persona.provider);

    // 运行 Agent (使用队列进行排队保护)
    const task = async () => {
        const { reply, history: newHistory } = await runAgent(llm, message, historyInput, tools);
        return { reply, newHistory };
    }

    // 排队执行
    const { reply, newHistory } = await personaQueue.enqueue(personaId, task);
    
    // 更新历史
    sessionManager.updateHistory(effectiveSessionId, [
        ...newHistory,
        { role: 'assistant', content: reply },
    ]);

    if(needSave) {
      await sessionManager.save(session);
    }

    return c.json({ 
      reply, 
      sessionId: effectiveSessionId, 
      persona: persona.name,
      queueStatus: {
        length: personaQueue.getLength(personaId)
      }
    });
  } finally {
    sessionManager.unlock(effectiveSessionId);
  }
});

// ---------------------------------------------------------
// 3. 高级：两个 Agent 互相聊天 (剧场模式)
// ---------------------------------------------------------
app.post('/theater', async (c) => {
  const body = await c.req.json<{ 
    personaA: string; 
    personaB: string; 
    topic: string;
    turns?: number; // 聊几轮
  }>();

  const { personaA, personaB, topic, turns = 3 } = body;
  const agentA = personaManager.get(personaA);
  const agentB = personaManager.get(personaB);

  if (!agentA || !agentB) return c.json({ error: 'Agent not found' }, 404);

  const script: any[] = [];
  let currentMessage = `请开始关于"${topic}"的讨论。`;
  
  // 临时历史
  let historyA: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: 'system', content: agentA.systemPrompt }];
  let historyB: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: 'system', content: agentB.systemPrompt }];
  
  for (let i = 0; i < turns; i++) {
    const llmA = personaManager.getAdapter(agentA.provider);
    const llmB = personaManager.getAdapter(agentB.provider);

    // --- Agent A 行动 (排队执行) ---
    console.log(`[Theater] Round ${i+1}: ${agentA.name} is thinking...`);
    const actionA = async () => runAgent(llmA, currentMessage, historyA, tools);
    const resA = await personaQueue.enqueue(personaA, actionA);
    
    const replyA = resA.reply;
    script.push({ speaker: agentA.name, content: replyA });
    
    historyA = [...resA.history, { role: 'assistant', content: replyA }];
    currentMessage = replyA; 

    // --- Agent B 行动 (排队执行) ---
    console.log(`[Theater] Round ${i+1}: ${agentB.name} is thinking...`);
    const actionB = async () => runAgent(llmB, currentMessage, historyB, tools);
    const resB = await personaQueue.enqueue(personaB, actionB);

    const replyB = resB.reply;
    script.push({ speaker: agentB.name, content: replyB });

    historyB = [...resB.history, { role: 'assistant', content: replyB }];
    currentMessage = replyB;
  }

  return c.json({ topic, script });
});

const port = Number(process.env.PORT) || 3000;
serve({ fetch: app.fetch, port });
console.log(`Agent ready → POST http://localhost:${port}/chat`);