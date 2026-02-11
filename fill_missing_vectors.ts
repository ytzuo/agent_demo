
import 'dotenv/config';
import { db } from './src/utils/db';
import { RAGManager } from './src/utils/rag';

async function fillMissingVectors() {
  console.log('--- Starting Vector Backfill Script ---');
  
  const rag = new RAGManager();
  
  try {
    // 1. Find messages without vectors but with content
    const res = await db.query(`
      SELECT id, content 
      FROM messages 
      WHERE content_vector IS NULL 
        AND content IS NOT NULL 
        AND length(content) >= 5
      ORDER BY id ASC
    `);

    const total = res.rows.length;
    console.log(`Found ${total} messages needing vectors.`);

    if (total === 0) {
      console.log('Nothing to do.');
      return;
    }

    // 2. Process them one by one
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < total; i++) {
      const row = res.rows[i];
      const { id, content } = row;
      
      console.log(`[${i + 1}/${total}] Processing message ${id}...`);
      
      try {
        await rag.indexMessage(id, content);
        successCount++;
        // Optional: slight delay to be nice to the API
        await new Promise(r => setTimeout(r, 200)); 
      } catch (err) {
        console.error(`Failed to index message ${id}:`, err);
        failCount++;
      }
    }

    console.log('\n--- Backfill Complete ---');
    console.log(`Total: ${total}`);
    console.log(`Success: ${successCount}`);
    console.log(`Failed: ${failCount}`);

  } catch (err) {
    console.error('Fatal script error:', err);
  } finally {
    process.exit(0);
  }
}

fillMissingVectors();
