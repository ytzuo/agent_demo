import { db } from './db';

/**
 * 用户画像接口
 */
export interface UserProfile {
  id: string;
  name?: string;
  preferences?: string; // e.g. "喜欢Python，讨厌Java，喜欢幽默的风格"
  metadata?: Record<string, any>; // 扩展字段
  created_at?: Date;
  updated_at?: Date;
}

export class UserProfileManager {
  
  constructor() {
    // 可以在应用启动时调用 ensureTable，或者单独的迁移脚本
    // 这里为了方便，我们假设表会在首次使用前准备好，或者可以在这里通过异步立即执行（不推荐）
  }

  /**
   * 确保 users 表存在 (简易迁移逻辑)
   */
  async ensureTable() {
    try {
      await db.query(`
        CREATE TABLE IF NOT EXISTS users (
          id VARCHAR(255) PRIMARY KEY,
          name VARCHAR(255),
          preferences TEXT,
          metadata JSONB DEFAULT '{}',
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);
      console.log('[UserProfile] Table "users" ensured');
    } catch (err) {
      console.error('[UserProfile] Failed to ensure table', err);
    }
  }

  /**
   * 获取用户画像
   */
  async get(userId: string): Promise<UserProfile | null> {
    try {
      const res = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
      if (res.rows.length > 0) {
        return res.rows[0] as UserProfile;
      }
      return null;
    } catch (error) {
      console.error(`[UserProfile] Failed to get profile for ${userId}`, error);
      return null;
    }
  }

  /**
   * 创建或更新用户画像
   */
  async update(userId: string, data: Partial<UserProfile>): Promise<UserProfile> {
    const current = await this.get(userId);
    
    // 合并 metadata
    const newMetadata = {
      ...(current?.metadata || {}),
      ...(data.metadata || {})
    };

    // 构建更新数据
    // 如果是新建，使用 data.name；如果是更新，优先使用 data.name，否则保持原样
    const name = data.name !== undefined ? data.name : (current?.name || null);
    const preferences = data.preferences !== undefined ? data.preferences : (current?.preferences || null);
    
    try {
      // Upsert Logic
      const res = await db.query(`
        INSERT INTO users (id, name, preferences, metadata, updated_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (id) DO UPDATE SET
          name = COALESCE(EXCLUDED.name, users.name),
          preferences = COALESCE(EXCLUDED.preferences, users.preferences),
          metadata = EXCLUDED.metadata,
          updated_at = NOW()
        RETURNING *
      `, [userId, name, preferences, JSON.stringify(newMetadata)]);
      
      console.log(`[UserProfile] Updated ${userId}`);
      return res.rows[0] as UserProfile;
    } catch (error) {
      console.error(`[UserProfile] Failed to update ${userId}`, error);
      throw error;
    }
  }

  /**
   * 生成注入到 System Prompt 的上下文片段
   */
  buildContext(profile: UserProfile): string {
    if (!profile) return '';
    
    let context = `\n\n[User Profile]\nID: ${profile.id}`;
    if (profile.name) context += `\nName: ${profile.name}`;
    if (profile.preferences) context += `\nPreferences: ${profile.preferences}`;
    return context;
  }
}
