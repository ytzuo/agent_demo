export interface PlanStep {
  task: string;          // 任务描述
  thought?: string;      // 思考/理由
  status: 'todo' | 'in_progress' | 'done' | 'failed';
  result?: string;       // 执行结果
}

export interface Plan {
  goal: string;          // 总体目标
  steps: PlanStep[];     // 步骤列表
  createdAt: number;
  updatedAt: number;
}
