import pg from 'pg';
import { v5 as uuidv5 } from 'uuid';

const { Pool } = pg;

// 这是一个任意生成的 UUID，用于作为命名空间
const SESSION_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'; 

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export const db = {
  query: (text: string, params?: any[]) => pool.query(text, params),
  pool,
};

/**
 * 将任意字符串 ID 转换为确定性的 UUID
 */
export function toUUID(id: string): string {
  return uuidv5(id, SESSION_NAMESPACE);
}
