import { db, toUUID } from './db';
import { EmbeddingAdapter } from '../llm/embedding';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface SearchResult {
  id: string | number;
  role?: string;
  content: string;
  similarity: number;
  createdAt: Date;
  sourceName?: string;
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
        expectedDim = 1536;
    } else if (provider === 'deepseek') {
        expectedDim = 1024; // TODO: 确认 DeepSeek 具体模型的维度
    }

    try {
        // 2. 检查知识库表的维度
        const knowledgeRes = await db.query(`
            SELECT atttypmod 
            FROM pg_attribute 
            WHERE attrelid = 'knowledge_chunks'::regclass 
              AND attname = 'content_vector'
        `);

        if (knowledgeRes.rows.length > 0) {
            const atttypmod = knowledgeRes.rows[0].atttypmod;
            const match = (atttypmod === expectedDim) || (atttypmod === expectedDim + 4);

            if (!match) {
                console.warn(`[RAG] Knowledge dimension mismatch! DB (raw): ${atttypmod}, Expected: ${expectedDim}. Migrating...`);
                await db.query(`
                    ALTER TABLE knowledge_chunks 
                    ALTER COLUMN content_vector TYPE vector(${expectedDim}) 
                    USING NULL;
                `);
            }
        }

        // 3. 检查当前数据库中的维度 (messages 表)
        const res = await db.query(`
            SELECT atttypmod 
            FROM pg_attribute 
            WHERE attrelid = 'messages'::regclass 
              AND attname = 'content_vector'
        `);

        if (res.rows.length > 0) {
            const atttypmod = res.rows[0].atttypmod;
            const match = (atttypmod === expectedDim) || (atttypmod === expectedDim + 4);

            if (!match) {
                console.warn(`[RAG] Dimension mismatch! DB (raw): ${atttypmod}, Expected: ${expectedDim}. Migrating...`);
                await db.query(`
                    ALTER TABLE messages 
                    ALTER COLUMN content_vector TYPE vector(${expectedDim}) 
                    USING NULL;
                `);
            }
        }
    } catch (error: any) {
        if (error.code === '42P01') { 
            // 表不存在，跳过
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
   */
  async searchContext(query: string, conversationId?: string, limit: number = 5, threshold: number = 0.5): Promise<SearchResult[]> {
    try {
      const vector = await this.embedding.getEmbedding(query);
      const vectorStr = `[${vector.join(',')}]`;

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
   * 从知识库中搜索知识
   */
  async searchKnowledge(topics: string, limit: number = 5, threshold: number = 0.4): Promise<SearchResult[]> {
    await this.initPromise;
    try {
      const vector = await this.embedding.getEmbedding(topics);
      const vectorStr = `[${vector.join(',')}]`;

      const sql = `
        SELECT 
          kc.id, 
          kc.content, 
          ks.name as source_name,
          kc.created_at,
          1 - (kc.content_vector <=> $1) as similarity
        FROM knowledge_chunks kc
        JOIN knowledge_sources ks ON kc.source_id = ks.id
        WHERE kc.content_vector IS NOT NULL
          AND 1 - (kc.content_vector <=> $1) > $2
        ORDER BY similarity DESC
        LIMIT $3
      `;

      const res = await db.query(sql, [vectorStr, threshold, limit]);

      return res.rows.map(row => ({
        id: row.id,
        content: row.content,
        sourceName: row.source_name,
        similarity: row.similarity,
        createdAt: row.created_at
      }));
    } catch (error) {
      console.error('[RAG] Knowledge search failed:', error);
      return [];
    }
  }

  /**
   * 从本地目录入库知识
   */
  async ingestKnowledge(dirPath: string): Promise<{ success: number, failed: number, errors: string[] }> {
    await this.initPromise;
    const stats = { success: 0, failed: 0, errors: [] as string[] };
    
    try {
      const files = await fs.readdir(dirPath);
      for (const file of files) {
        const filePath = path.join(dirPath, file);
        const fileStat = await fs.stat(filePath);
        
        if (!fileStat.isFile()) continue;

        try {
          const content = await fs.readFile(filePath, 'utf-8');
          
          // 1. 创建或获取 source
          const sourceRes = await db.query(`
            INSERT INTO knowledge_sources (name, source_type, file_path)
            VALUES ($1, 'file', $2)
            ON CONFLICT DO NOTHING -- 这里假设没有唯一约束，如果有可以根据 file_path 冲突处理
            RETURNING id
          `, [file, filePath]);
          
          let sourceId: string;
          if (sourceRes.rows.length > 0) {
            sourceId = sourceRes.rows[0].id;
          } else {
            // 如果没返回 ID (例如冲突)，尝试查询
            const existing = await db.query('SELECT id FROM knowledge_sources WHERE file_path = $1', [filePath]);
            if (existing.rows.length > 0) {
              sourceId = existing.rows[0].id;
              // 清理旧的 chunks
              await db.query('DELETE FROM knowledge_chunks WHERE source_id = $1', [sourceId]);
            } else {
              throw new Error(`Failed to create source for ${file}`);
            }
          }

          // 2. 切分 chunks
          const chunks = this.chunkText(content, 1000, 200);
          if(!chunks || chunks.length === 0) {
            continue;
          }
          // 3. 批量生成向量并入库
          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            if (!chunk) continue;
            
            const chunkContent = chunk.trim();
            if (!chunkContent) continue;

            const vector = await this.embedding.getEmbedding(chunkContent);
            const vectorStr = `[${vector.join(',')}]`;

            await db.query(`
              INSERT INTO knowledge_chunks (source_id, content, content_vector, chunk_index)
              VALUES ($1, $2, $3, $4)
            `, [sourceId, chunkContent, vectorStr, i]);
          }

          stats.success++;
          console.log(`[RAG] Ingested ${file}: ${chunks.length} chunks`);
        } catch (err: any) {
          stats.failed++;
          stats.errors.push(`${file}: ${err.message}`);
          console.error(`[RAG] Failed to ingest ${file}:`, err);
        }
      }
    } catch (error: any) {
      stats.errors.push(`Directory access failed: ${error.message}`);
    }

    return stats;
  }

  /**
   * 简单的文本切分逻辑
   */
  private chunkText(text: string, chunkSize: number, overlap: number): string[] {
    const chunks: string[] = [];
    let start = 0;
    
    while (start < text.length) {
      let end = start + chunkSize;
      if (end > text.length) end = text.length;
      
      chunks.push(text.slice(start, end));
      start += (chunkSize - overlap);
    }
    
    return chunks;
  }

  /**
   * 为消息生成向量并更新到数据库
   */
  async indexMessage(messageId: number, content: string): Promise<void> {
    if (!content || content.length < 5) return; 
    
    await this.initPromise;

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
