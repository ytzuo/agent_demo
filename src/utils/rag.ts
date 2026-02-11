import { db, toUUID } from './db';
import { EmbeddingAdapter } from '../llm/embedding';

export interface SearchResult {
  id: number;
  role: string;
  content: string;
  similarity: number;
  createdAt: Date;
}

export class RAGManager {
  private embedding: EmbeddingAdapter;

  private initPromise: Promise<void>;

  constructor() {
    // 根据 EMBEDDING_PROVIDER 环境变量决定使用哪个供应商
    let provider = process.env.EMBEDDING_PROVIDER?.toLowerCase();

    // 如果未指定 EMBEDDING_PROVIDER
    if (!provider) {
       // 为了避免默认通过 OpenAI 连接导致混淆（特别是当用户只有其他 Key 时），
       // 这里进行简单的自动探测，但如果探测不到或有歧义，则报错要求显式指定。
       if (process.env.OPENAI_API_KEY) {
         provider = 'openai';
       } else if (process.env.ZHIPU_API_KEY) {
         provider = 'zhipu';
       } else if (process.env.DEEPSEEK_API_KEY) {
         provider = 'deepseek';
       } else {
         // 没有任何 Key，或者没有指定 Provider，抛出友好错误
         throw new Error('[RAG] EMBEDDING_PROVIDER is not set in .env. Please set it to "openai", "zhipu", "deepseek" or "custom".');
       }
       console.log(`[RAG] EMBEDDING_PROVIDER not set, auto-detected provider: ${provider}`);
    }
    
    let apiKey: string | undefined;
    let baseURL: string | undefined;
    let model: string | undefined;

    switch (provider) {
      case 'zhipu':
      case 'glm':
        apiKey = process.env.ZHIPU_API_KEY;
        baseURL = 'https://open.bigmodel.cn/api/paas/v4';
        model = 'embedding-3';
        break;

      case 'deepseek':
        apiKey = process.env.DEEPSEEK_API_KEY;
        baseURL = 'https://api.deepseek.com';
        model = 'deepseek-embedding-pro-v1';
        break;

      case 'openai':
        apiKey = process.env.OPENAI_API_KEY;
        baseURL = process.env.OPENAI_BASE_URL;
        model = 'text-embedding-3-small';
        break;

      case 'custom':
        // 自定义配置，完全依赖 EMBEDDING_* 环境变量
        apiKey = process.env.EMBEDDING_API_KEY;
        break;

      default:
        throw new Error(`[RAG] Unknown EMBEDDING_PROVIDER: ${provider}`);
    }

    // 允许使用 EMBEDDING_* 环境变量覆盖特定配置
    apiKey = process.env.EMBEDDING_API_KEY || apiKey;
    baseURL = process.env.EMBEDDING_BASE_URL || baseURL;
    model = process.env.EMBEDDING_MODEL || model;

    if (!apiKey) {
      // 只有当不是 custom (可能依赖 proxy 不需要 key) 时才强制检查？
      // 为了安全起见，通常都需要 key
      console.warn(`[RAG] Warning: No API Key found for provider ${provider}`);
    }

    this.embedding = new EmbeddingAdapter(apiKey, baseURL, model, provider);
    
    // 异步初始化数据库 Schema (迁移维度)
    // 使用 Promise 锁确保初始化完成后再执行操作
    this.initPromise = this.ensureSchema(provider).catch(err => {
        console.error('[RAG] Schema initialization failed:', err);
    });
  }

  /**
   * 确保数据库 Schema 正确，特别是向量维度
   */
  private async ensureSchema(provider: string) {
    // 1. 确定当前模型预期的维度
    // Zhipu embedding-3: 2048 (但用户可能强制要求 1536)
    // OpenAI text-embedding-3-small: 1536
    let expectedDim = 1536; // 统一默认为 1536
    if (provider === 'zhipu' || provider === 'glm') {
        // expectedDim = 2048; // 之前是 2048，现在用户强制要求 1536
        expectedDim = 1536;
    } else if (provider === 'deepseek') {
        expectedDim = 1024; // TODO: 确认 DeepSeek 具体模型的维度
    }

    try {
        // 2. 检查当前数据库中的维度
        // 查询 pg_attribute 获取 content_vector 列的维度
        // atttypmod = dimension + 4 (pgvector存储头)
        const res = await db.query(`
            SELECT atttypmod 
            FROM pg_attribute 
            WHERE attrelid = 'messages'::regclass 
              AND attname = 'content_vector'
        `);

        if (res.rows.length > 0) {
            const atttypmod = res.rows[0].atttypmod;
            // 注意: atttypmod 在不同版本的 PG/pgvector 中行为可能不同
            // 通常是 dimension + 4 (存储头)，但也可能是直接 dimension
            // 我们这里做一个宽容的检查
            let currentDim = atttypmod;
            if (currentDim > 4) {
                // 尝试猜测是否包含 header
                // 如果 atttypmod 正好是 expectedDim + 4，那肯定是带 header 的
                // 如果 atttypmod 正好是 expectedDim，那肯定是不带 header 的
                if (currentDim === expectedDim + 4) {
                    currentDim = currentDim - 4;
                }
            }

            // 更稳健的逻辑：如果我们读取到的值 (不管是原始值还是减4后的值) 都不等于预期值，才迁移
            // 例如：如果是 1536 (不带头) 或 1540 (带头)，都视为 1536，不迁移
            const match = (atttypmod === expectedDim) || (atttypmod === expectedDim + 4);

            if (!match) {
                console.warn(`[RAG] Dimension mismatch! DB (raw): ${atttypmod}, Expected: ${expectedDim}. Migrating...`);
                
                // 3. 维度不匹配，执行迁移
                // 注意：更改维度需要清空旧数据或重新计算 (这里选择清空旧向量，保留消息内容)
                await db.query(`
                    ALTER TABLE messages 
                    ALTER COLUMN content_vector TYPE vector(${expectedDim}) 
                    USING NULL;
                `);
                console.log(`[RAG] Migration successful: content_vector converted to vector(${expectedDim})`);
            } else {
                console.log(`[RAG] Schema check passed: vector(${expectedDim})`);
            }
        } else {
            // 列不存在？或者表不存在？
            // 如果表不存在，通常在 session.ts 或 setup 中创建
            // 这里可以尝试添加列 (如果是老表没有向量列)
            console.warn('[RAG] content_vector column not found, attempting to add...');
            await db.query(`
                ALTER TABLE messages 
                ADD COLUMN IF NOT EXISTS content_vector vector(${expectedDim});
            `);
        }
    } catch (error: any) {
        // 表可能不存在，忽略错误或者记录
        if (error.code === '42P01') { // undefined_table
            // console.log('[RAG] Table messages does not exist yet.');
        } else {
            console.error('[RAG] Failed to check/migrate schema:', error);
        }
    }
  }

  /**
   * 暴露底层 Embedding 接口，供 SessionManager 使用
   */
  async getEmbedding(text: string): Promise<number[]> {
      return this.embedding.getEmbedding(text);
  }

  /**
   * 语义检索相关的历史消息
   * @param query 用户的问题
   * @param conversationId 当前会话ID (用于排除当前会话或限制范围，可选)
   * @param limit 返回条数
   * @param threshold 相似度阈值 (0-1，越大越相似)
   */
  async searchContext(query: string, conversationId?: string, limit: number = 5, threshold: number = 0.5): Promise<SearchResult[]> {
    try {
      const vector = await this.embedding.getEmbedding(query);
      const vectorStr = `[${vector.join(',')}]`;

      // 使用 pgvector 的余弦相似度 (<=>)
      // 1 - (<=>) = 余弦相似度 (Cosine Similarity)
      // 注意：这里假设 pgvector 扩展已启用
      const sql = `
        SELECT 
          id, 
          role, 
          content, 
          created_at,
          1 - (content_vector <=> $1) as similarity
        FROM messages
        WHERE content_vector IS NOT NULL
          AND role != 'system' -- 不需要检索 system prompt
          AND 1 - (content_vector <=> $1) > $2
        ORDER BY similarity DESC
        LIMIT $3
      `;

      const res = await db.query(sql, [vectorStr, threshold, limit]);

      return res.rows.map(row => ({
        id: row.id,
        role: row.role,
        content: row.content,
        similarity: row.similarity,
        createdAt: row.created_at
      }));
    } catch (error) {
      console.error('[RAG] Search failed:', error);
      return [];
    }
  }

  /**
   * 为消息生成向量并更新到数据库
   * (通常在保存消息后异步调用)
   */
  async indexMessage(messageId: number, content: string): Promise<void> {
    if (!content || content.length < 5) return; // 太短的内容没必要向量化
    
    await this.initPromise; // 确保 Schema 已就绪

    try {
      const vector = await this.embedding.getEmbedding(content);
      const vectorStr = `[${vector.join(',')}]`;

      await db.query(`
        UPDATE messages 
        SET content_vector = $1 
        WHERE id = $2
      `, [vectorStr, messageId]);
      
      console.log(`[RAG] Indexed message ${messageId}`);
    } catch (error) {
      console.error(`[RAG] Failed to index message ${messageId}:`, error);
    }
  }
}
