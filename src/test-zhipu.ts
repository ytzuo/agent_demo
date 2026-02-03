
import 'dotenv/config';
import { ZhipuEmbeddingAdapter } from './llm/zhipu-embedding';

async function main() {
  const apiKey = process.env.ZHIPU_API_KEY;
  if (!apiKey) {
    console.error('Error: ZHIPU_API_KEY is not set in .env');
    process.exit(1);
  }

  console.log('Testing Zhipu Embedding Adapter...');
  const adapter = new ZhipuEmbeddingAdapter(apiKey);

  try {
    const text = 'Hello, Zhipu AI!';
    console.log(`Generating embedding for: "${text}"`);
    
    const embedding = await adapter.getEmbedding(text);
    console.log('Success!');
    console.log(`Embedding dimension: ${embedding.length}`);
    
    if (embedding.length === 1536) {
      console.log('✅ Dimension check passed (1536)');
    } else {
      console.warn(`⚠️ Unexpected dimension: ${embedding.length} (Expected 1536)`);
    }

  } catch (error) {
    console.error('Failed to generate embedding:', error);
  }
}

main();
