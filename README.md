# LearningAgent

一个轻量级的、基于 Hono 框架的 AI Agent 服务端demo项目。它展示了如何构建一个支持多用户、多虚拟人格（Persona）、以及并发控制的智能对话系统。

## ✨ 核心特性

*   **多虚拟人格 (Multi-Persona)**: 支持定义不同的人设（如“严谨的数学老师”、“浪漫的诗人”），每个 Agent 可配置独立的 System Prompt 和 LLM 提供商（OpenAI/DeepSeek）。
*   **智能会话管理 (Session Management)**:
    *   **上下文隔离**: 不同用户、不同人格之间的对话历史完全隔离。
    *   **自动窗口管理**: 自动维护上下文长度，确保不超出 Token 限制，同时能够保留核心 System Prompt。
    *   **自动清理**: 过期会话自动释放内存。
*   **并发控制队列 (Concurrency Queue)**:
    *   **人物级互斥**: 对同一个虚拟人物的请求会强制排队（实现了“同一个老师一次只能辅导一个学生”的逻辑）。
    *   **并行处理**: 不同虚拟人物之间的请求互不干扰，完全并行。
*   **小剧场模式 (Theater Mode)**: 支持让两个虚拟人物针对指定话题进行多轮自动对话（Agent vs Agent）。
*   **工具调用 (Function Calling)**: 内置工具调用支持（示例中包含基础架构）。

## 🛠️ 快速开始

### 1. 环境准备

确保你已安装 Node.js (v18+)。
如果你还没有安装 pnpm，可以使用以下命令安装：

```bash
npm install -g pnpm
```

克隆项目并安装依赖：

```bash
pnpm install
# 或者
npm install
```

### 2. 配置文件

在项目根目录创建一个 `.env` 文件，并填入你的 API Key：

```env
# 服务端口
PORT=3000

# 默认 LLM 提供商 (openai 或 deepseek)
LLM_PROVIDER=openai

# OpenAI 配置
OPENAI_API_KEY=sk-your-openai-key-here
# OPENAI_BASE_URL=https://api.openai.com/v1 # 可选

# DeepSeek 配置 (如果使用)
DEEPSEEK_API_KEY=sk-your-deepseek-key-here
```

### 3. 启动服务

**开发模式 (支持热重载):**

```bash
pnpm run dev
```

## 📡 API 接口说明

### 1.与人物对话 (`POST /chat`)

这是核心交互接口。如果目标人物当前正在忙（例如正在回复另一个用户），你的请求会自动进入队列等待。

**请求示例:**
```json
POST /chat
{
  "sessionId": "user-001",
  "message": "请帮我解释一下微积分与现代诗的关系",
  "personaId": "math-teacher"  // 可选，默认为 math-teacher
}
```

**响应示例:**
```json
{
  "reply": "这是一个有趣的问题...",
  "sessionId": "user-001:math-teacher",
  "persona": "Math Teacher",
  "queueStatus": {
    "length": 0 // 当前排队人数
  }
}
```

### 2. 小剧场模式 (`POST /theater`)

让两个 AI 互相聊天。

**请求示例:**
```json
POST /theater
{
  "personaA": "math-teacher",
  "personaB": "poet",
  "topic": "圆周率的意义",
  "turns": 3 // 聊几轮
}
```

### 3. 管理人物 (`GET /personas`, `POST /personas`)

查看当前活跃的人物或动态创建一个新人物。

**创建新人物示例:**
```json
POST /personas
{
  "id": "angry-chef",
  "name": "Gordon",
  "description": "暴躁厨师",
  "systemPrompt": "你是一个追求完美的厨师，对任何不完美的食物都会大发雷霆。",
  "provider": "openai"
}
```

## 🧪 测试脚本

项目内置了一个测试脚本，用于在一个终端内模拟并发请求、排队等待和小剧场场景。

确保服务运行在 3000 端口，然后运行：

```bash
node test_api.js
```

你将看到如下测试流程：
1.  基础对话测试
2.  **并发排队测试**: 模拟两个用户同时请求同一个 Agent，观察排队现象。
3.  并行测试: 模拟请求两个不同的 Agent，观察其互不影响。
4.  剧场模式演示。

## 📂 项目结构

*   `src/index.ts` - HTTP 服务器入口与路由定义。
*   `src/agent.ts` - 核心 Agent 逻辑（思考/行动/观察循环）。
*   `src/persona.ts` - 虚拟人物管理器，负责加载 LLM Adapter。
*   `src/session.ts` - 会话状态管理（内存数据库）。
*   `src/queue.ts` - 异步任务队列，实现请求排队核心逻辑。
*   `src/llm/` - LLM 适配器接口与实现。
