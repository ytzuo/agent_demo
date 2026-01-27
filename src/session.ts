import OpenAI from 'openai';

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
}
