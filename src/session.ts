import OpenAI from 'openai';
import { db, toUUID } from './db';

/**
 * 会话配置接口
 * 可以在这里定义每个会话独有的设置，比如角色设定(System Prompt)、模型参数等
 */
export interface SessionConfig {
  systemPrompt?: string;
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
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  
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
   * 保存对话历史
   */
/**
   * 保存对话历史 (持久化到 DB)
   */
  async save(session: Session): Promise<void> {
    const conversationId = toUUID(session.id);
    const userId = session.id;
    
    // 简单的 Title 生成策略 (取第一条用户消息)
    const title = session.history.find(m => m.role === 'user')?.content?.toString().slice(0, 50) || 'New Conversation';

    try {
      // 1. Upsert Conversation
      const configJson = JSON.stringify(session.config || {});
      await db.query(`
        INSERT INTO conversations (id, user_id, title, metadata, updated_at, message_count)
        VALUES ($1, $2, $3, $4, NOW(), $5)
        ON CONFLICT (id) DO UPDATE SET
          updated_at = NOW(),
          message_count = $5,
          metadata = conversations.metadata || $4
      `, [conversationId, userId, title, configJson, session.history.length]);

      // 2. Insert Messages (Ignore duplicates based on sequence_number)
      const query = `
        INSERT INTO messages (
          conversation_id, sequence_number, role, content, 
          tool_calls, tool_call_id, token_count
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (conversation_id, sequence_number) DO NOTHING
      `;

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

        await db.query(query, [
          conversationId, 
          seq, 
          msg.role, 
          content, 
          toolCalls, 
          toolCallId, 
          0 
        ]);
      }
      console.log(`[SessionManager] Saved session ${session.id}`);
    } catch (err) {
      console.error(`[SessionManager] Save failed for ${session.id}`, err);
    }
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
      
      const config = convRes.rows[0].metadata || {};

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
        processing: false
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
}
