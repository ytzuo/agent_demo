-- 启用扩展
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 会话表（对话级管理）
CREATE TABLE conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id VARCHAR(50) NOT NULL,
    title TEXT,  -- AI生成的会话主题
    summary_vector VECTOR(1536),  -- 会话语义摘要（用于长期记忆检索）
    model_config JSONB DEFAULT '{}',  -- 模型参数、温度等
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    message_count INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    metadata JSONB DEFAULT '{}'  -- 会话级元数据（标签、分类等）
);

-- 消息表（核心存储）
CREATE TABLE messages (
    id BIGSERIAL PRIMARY KEY,
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sequence_number INTEGER NOT NULL,  -- 严格顺序，从1开始递增
    
    -- OpenAI格式核心字段
    role VARCHAR(20) NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
    content TEXT,
    
    -- 工具调用相关（关键关系字段）
    tool_calls JSONB,  -- 存储完整tool_calls数组
    tool_call_id VARCHAR(50),  -- role='tool'时，关联到assistant消息的tool_calls.id
    
    -- AI检索与分析的向量化字段
    content_vector VECTOR(1536),  -- 内容语义向量
    
    -- 性能与成本追踪
    token_count INTEGER,
    latency_ms INTEGER,  -- 响应耗时
    
    -- 智能元数据（自动提取）
    metadata JSONB DEFAULT '{}',
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- 约束：tool消息必须有tool_call_id；assistant消息有tool_calls时content可为null
    CONSTRAINT chk_tool_message CHECK (
        (role != 'tool') OR (tool_call_id IS NOT NULL)
    ),
    CONSTRAINT chk_sequence CHECK (sequence_number > 0),
    UNIQUE(conversation_id, sequence_number)  -- 确保顺序唯一性
);

-- 性能优化索引
CREATE INDEX idx_messages_conv_seq ON messages(conversation_id, sequence_number);
CREATE INDEX idx_messages_vector ON messages USING ivfflat (content_vector vector_cosine_ops) WITH (lists = 100);
CREATE INDEX idx_messages_tool_calls ON messages USING gin (tool_calls jsonb_path_ops);
CREATE INDEX idx_messages_metadata ON messages USING gin (metadata);
CREATE INDEX idx_conversations_user ON conversations(user_id, updated_at DESC);