import OpenAI from 'openai';
import { db, toUUID } from './db';
import { RAGManager } from './rag';
import type { Plan, PlanStep } from './plan';

/**
 * 会话配置接口
 */
export interface SessionConfig {
  systemPrompt?: string;
  enablePlanning?: boolean; // 是否开启规划功能
}

/**
 * 会话数据接口
 */
interface Session {
  id: string;
  history: OpenAI.Chat.ChatCompletionMessageParam[];
  lastActive: number;
  config: SessionConfig;
  processing: boolean; // 简单的并发锁标志
  plan?: Plan;         // 当前执行计划
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private ragManager = new RAGManager();
  
  // 会话过期时间 (默认 30 分钟)
  private readonly TTL = 30 * 60 * 1000; 

  constructor() {
    // 启动定期清理任务
    setInterval(() => this.cleanup(), 60 * 1000); 
  }

  /**
   * 获取或创建会话
   */
  getOrCreate(id: string, initialConfig?: SessionConfig): Session {
    let session = this.sessions.get(id);
    
    if (!session) { // 新建会话
      session = {
        id,
        history: [],
        lastActive: Date.now(),
        config: initialConfig || {},
        processing: false,
      };
      
      // 如果有 System Prompt，初始化到历史记录第一条
      if (session.config.systemPrompt) {
        session.history.push({
          role: 'system',
          content: session.config.systemPrompt
        });
      }
      
      this.sessions.set(id, session);
    } else {
      // 如果提供了新的配置，更新它
      if (initialConfig?.systemPrompt && initialConfig.systemPrompt !== session.config.systemPrompt) {
        session.config.systemPrompt = initialConfig.systemPrompt;
        // 注意：这里可能需要逻辑来确定是否替换旧的 system prompt，
        // 简单起见，我们假设新的配置在下一次清空历史时生效，或者手动替换历史第一条
        const firstMsg = session.history[0];
        if (firstMsg && firstMsg.role === 'system') {
           // 更新现有的 system prompt
           // 使用解构赋值创建新对象，规避潜在的 undefined 或只读属性问题
           session.history[0] = { ...firstMsg, content: initialConfig.systemPrompt };
        } else {
           session.history.unshift({ role: 'system', content: initialConfig.systemPrompt });
        }
      }
    }

    session.lastActive = Date.now();
    return session;
  }

  /**
   * 更新会话历史
   */
  updateHistory(id: string, newHistory: OpenAI.Chat.ChatCompletionMessageParam[]) {
    const session = this.sessions.get(id);
    if (session) {
      session.history = newHistory;
      session.lastActive = Date.now();
    }
  }

  /**
   * 尝试获取锁 (防止同一个用户的并发请求导致历史记录混乱)
   */
  tryLock(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return true; // 会话不存在，视为可以操作（后续会创建）
    if (session.processing) return false;
    session.processing = true;
    return true;
  }

  /**
   * 释放锁
   */
  unlock(id: string) {
    const session = this.sessions.get(id);
    if (session) {
      session.processing = false;
    }
  }

  /**
   * 清理过期会话
   */
  private cleanup() {
    const now = Date.now();
    let count = 0;
    for (const [id, session] of this.sessions.entries()) {
      if (now - session.lastActive > this.TTL) {
        this.sessions.delete(id);
        count++;
      }
    }
    if (count > 0) {
      console.log(`[SessionManager] Cleaned up ${count} expired sessions`);
    }
  }
/**
   * 初始化或更新计划
   */
  initPlan(id: string, goal: string, steps: PlanStep[]) {
    const session = this.sessions.get(id);
    if (session) {
      session.plan = {
        goal,
        steps,
        createdAt: session.plan?.createdAt || Date.now(),
        updatedAt: Date.now(),
      };
      session.lastActive = Date.now();
    }
  }

  /**
   * 获取当前计划
   */
  getPlan(id: string): Plan | undefined {
    return this.sessions.get(id)?.plan;
  }

  /**
   * 更新计划步骤
   */
  updatePlanStep(id: string, index: number, update: Partial<PlanStep>) {
    const session = this.sessions.get(id);
    if (session && session.plan && session.plan.steps[index]) {
      session.plan.steps[index] = { ...session.plan.steps[index], ...update };
      session.plan.updatedAt = Date.now();
      session.lastActive = Date.now();
    }
  }

  /**
   * 保存对话历史 (持久化到 DB)
   */
  async save(session: Session): Promise<void> {
    const conversationId = toUUID(session.id);
    const userId = session.id;
    
    // 简单的 Title 生成策略 (取第一条用户消息)
    const title = session.history.find(m => m.role === 'user')?.content?.toString().slice(0, 50) || 'New Conversation';

    try {
      // 生成 Title 的向量作为 summary_vector
      let summaryVectorStr = null;
      if (title && title !== 'New Conversation') {
          try {
             const vector = await this.ragManager.getEmbedding(title);
             summaryVectorStr = `[${vector.join(',')}]`;
          } catch (e) {
             console.error(`[SessionManager] Failed to generate summary vector for ${session.id}`, e);
          }
      }

      // 1. Upsert Conversation
      // 将 plan 也存入 metadata
      const metadata = {
        ...(session.config || {}),
        plan: session.plan
      };
      const configJson = JSON.stringify(metadata);
      
      await db.query(`
        INSERT INTO conversations (id, user_id, title, metadata, updated_at, message_count, summary_vector)
        VALUES ($1, $2, $3, $4, NOW(), $5, $6)
        ON CONFLICT (id) DO UPDATE SET
          updated_at = NOW(),
          message_count = $5,
          metadata = $4, -- 直接覆盖以包含最新的 plan
          summary_vector = COALESCE($6, conversations.summary_vector),
          title = $3
      `, [conversationId, userId, title, configJson, session.history.length, summaryVectorStr]);

      // 2. Insert Messages (Ignore duplicates based on sequence_number)
      // 修改: 使用 DO UPDATE 确保返回 ID 和 vector 状态，以便检查是否需要补充向量
      const query = `
        INSERT INTO messages (
          conversation_id, sequence_number, role, content, 
          tool_calls, tool_call_id, token_count
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (conversation_id, sequence_number) DO UPDATE 
        SET content = EXCLUDED.content -- 强制更新以触发 RETURNING
        RETURNING id, content_vector
      `;

      // 3. 批量插入消息并异步生成向量
      for (let i = 0; i < session.history.length; i++) {
        const msg = session.history[i];
        if (!msg) continue;

        const seq = i + 1;
        
        let toolCalls = null;
        if (msg.role === 'assistant') {
           const assistantMsg = msg as OpenAI.Chat.ChatCompletionAssistantMessageParam;
           if (assistantMsg.tool_calls) {
             toolCalls = JSON.stringify(assistantMsg.tool_calls);
           }
        }
        
        let toolCallId = null;
        if (msg.role === 'tool') {
           const toolMsg = msg as OpenAI.Chat.ChatCompletionToolMessageParam;
           toolCallId = toolMsg.tool_call_id;
        }

        const content = msg.content === null ? null : String(msg.content);

        const res = await db.query(query, [
          conversationId, 
          seq, 
          msg.role, 
          content, 
          toolCalls, 
          toolCallId, 
          0 
        ]);

        // 如果插入成功或已存在，检查是否需要生成向量
        if (res.rowCount && res.rowCount > 0 && content) {
          const row = res.rows[0];
          // 如果是新消息，或者旧消息没有向量，则触发索引
          if (!row.content_vector) {
              const newMsgId = row.id;
              // 异步执行，不阻塞
              this.ragManager.indexMessage(newMsgId, content).catch(err => {
                console.error(`[SessionManager] Async indexing failed for msg ${newMsgId}`, err);
              });
          }
        }
      }
      console.log(`[SessionManager] Saved session ${session.id}`);
    } catch (err) {
      console.error(`[SessionManager] Save failed for ${session.id}`, err);
    }
  }

  /**
   * 暴露 RAG 管理器
   */
  getRAG(): RAGManager {
    return this.ragManager;
  }

  /**
   * 加载对话历史
   */
  async load(id: string): Promise<Session | undefined> {
    const conversationId = toUUID(id);
    try {
      // 1. Check conversation existence
      const convRes = await db.query('SELECT metadata FROM conversations WHERE id = $1', [conversationId]);
      if (convRes.rowCount === 0) return undefined;
      
      const metadata = convRes.rows[0].metadata || {};
      const { plan, ...config } = metadata;

      // 2. Load messages
      const msgRes = await db.query(`
        SELECT role, content, tool_calls, tool_call_id 
        FROM messages 
        WHERE conversation_id = $1 
        ORDER BY sequence_number ASC
      `, [conversationId]);

      const history: OpenAI.Chat.ChatCompletionMessageParam[] = msgRes.rows.map(row => {
        if (row.role === 'tool') {
          return {
            role: 'tool',
            content: row.content,
            tool_call_id: row.tool_call_id
          } as OpenAI.Chat.ChatCompletionToolMessageParam;
        }

        const base: any = { role: row.role, content: row.content };
        
        if (row.role === 'assistant' && row.tool_calls) {
          // pg parses JSONB automatically to object/array
          base.tool_calls = row.tool_calls; 
        }

        return base as OpenAI.Chat.ChatCompletionMessageParam;
      });

      // 3. Reconstruct session
      const session: Session = {
        id,
        history,
        lastActive: Date.now(),
        config: config as SessionConfig,
        processing: false,
        plan: plan as Plan
      };
      
      // Update cache
      this.sessions.set(id, session);
      return session;

    } catch (err) {
      console.error(`[SessionManager] Load failed for ${id}`, err);
      return undefined;
    }
  }

  /**
   * 根据关键词查找历史消息
   * 用于 Tool 调用，帮助 Agent 回忆之前的对话细节
   */
  async searchHistory(keyword: string, limit: number = 5): Promise<string[]> {
    //const conversationId = toUUID(id);
    try {
      // 1. 优先从数据库搜索 (支持更久远的历史)
      const res = await db.query(`
        SELECT role, content
        FROM messages
        WHERE content ILIKE $1
          AND role IN ('user', 'assistant')
        ORDER BY sequence_number DESC
        LIMIT $2
      `, [`%${keyword}%`, limit]);

      if (res.rows.length > 0) {
        // 反转顺序，让结果按时间正序排列，更符合阅读习惯
        return res.rows.reverse().map(row => `[Prior History] ${row.role}: ${row.content}`);
      }
      
      // // 2. 如果数据库没结果（可能是刚开始对话还没保存），尝试搜内存
      // const session = this.sessions.get(id);
      // if (session) {
      //    return session.history
      //        .filter(m => {
      //           const content = m.content ? String(m.content) : '';
      //           return content.toLowerCase().includes(keyword.toLowerCase()) && 
      //                  (m.role === 'user' || m.role === 'assistant');
      //        })
      //        .slice(-limit)
      //        .map(m => `[Active Memory] ${m.role}: ${m.content}`);
      // }

      return [];
    } catch (err) {
      console.error(`[SessionManager] Search failed for keyword "${keyword}"`, err);
      return [];
    }
  }

  async searchBySemantic(keyword: string, limit: number = 3): Promise<string[]> {
    try {
      // 验证 keyword 是否为空
      if (!keyword) {
        return ['Error: Keyword is required.'];
      }
      // 验证 limit 是否为正整数
      if (limit <= 0) {
        return ['Error: Limit must be a positive number.'];
      }
      const embedding = await this.ragManager.getEmbedding(keyword);

      const res = await db.query(`
        SELECT role, content
        FROM messages
        WHERE content_vector IS NOT NULL
          AND role IN ('user', 'assistant')
        ORDER BY content_vector <=> $1::vector
        LIMIT $2
      `, [JSON.stringify(embedding), limit]);

      if (res.rows.length > 0) {
        return res.rows.reverse().map(row => `[Semantic Match] ${row.role}: ${row.content}`);
      }
      
      return [];
    } catch (err) {
      console.error(`[SessionManager] Semantic search failed for keyword "${keyword}"`, err);
      return [];
    }
  }

  async searchKnowledge(topics: string, limit: number = 3): Promise<string[]> {
    try {
      // 验证 topics 是否为空
      if (!topics) {
        return ['Error: Topics are required.'];
      }
      // 验证 limit 是否为正整数
      if (limit <= 0) {
        return ['Error: Limit must be a positive number.'];
      }
      
      const results = await this.ragManager.searchKnowledge(topics, limit);
      
      if (results.length > 0) {
        return results.map(res => `[Knowledge] (Source: ${res.sourceName}) ${res.content}`);
      }
      
      return ['No matching knowledge found.'];
    } catch (err) {
      console.error(`[SessionManager] Knowledge search failed for topics "${topics}"`, err);
      return [];
    }
  }

  async ingestKnowledge(dirPath: string): Promise<string> {
    try {
      const stats = await this.ragManager.ingestKnowledge(dirPath);
      return `Ingestion complete. Success: ${stats.success}, Failed: ${stats.failed}. ${stats.errors.length > 0 ? '\nErrors:\n' + stats.errors.join('\n') : ''}`;
    } catch (err: any) {
      console.error(`[SessionManager] Ingestion failed`, err);
      return `Error: ${err.message}`;
    }
  }
}
