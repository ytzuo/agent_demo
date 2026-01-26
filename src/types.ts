/**
 * 定义 Agent 可使用的工具结构
 * 
 * 在 Agent 系统中，"工具" 是连接 AI 大脑与外部世界的桥梁。
 * AI 无法直接联网或计算，但可以通过输出特定的指令（函数调用），
 * 由我们在代码中捕获并执行，然后将结果返回给它。
 */
export type Tool = {
  /** 工具名称，LLM 会根据这个名字来引用工具 */
  name: string;
  /**
   * 工具描述。
   * ⚠️ 非常重要：这是 LLM 决定是否使用该工具以及如何使用的主要依据。
   * 描述应该清晰、准确，说明工具的功能和适用场景。
   */
  description: string;
  /**
   * 参数定义，遵循 JSON Schema 标准。
   * 告诉 LLM 这个函数需要什么参数，每个参数的类型是什么，是否必填。
   * 比如：查询天气需要 "city" (string)。
   */
  parameters: Record<string, unknown>;
  /**
   * 实际的执行逻辑。
   * 当 LLM 决定调用此工具时，我们会在这个回调中执行具体的 TypeScript 代码。
   */
  handler: (args: any) => Promise<any>;
};
