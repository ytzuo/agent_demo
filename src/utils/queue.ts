/**
 * 基于 Key 的异步任务队列
 * 确保同一个 Key 的任务串行执行，实现"排队"机制
 */
export class RequestQueue {
    private queues = new Map<string, Promise<void>>();
    private queueCounts = new Map<string, number>();
  
    /**
     * 将任务加入指定 key 的队列中
     * @param key 标识符（例如 personaId）
     * @param task 要执行的异步任务
     */
    async enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
      // 1. 获取该队列当前的最后一个 Promise
      const previous = this.queues.get(key) || Promise.resolve();
  
      // 2. 更新排队计数 (同步操作)
      this.queueCounts.set(key, (this.queueCounts.get(key) || 0) + 1);
  
      // 3. 构建当前任务的执行 Promise
      // 这个 Promise 会等待前一个任务完成（无论成功与否），然后执行自己的 task
      const currentExecution = (async () => {
        try {
          // 等待前面的那个人办完业务
          await previous;
        } catch (error) {
          // 以前的任务失败了不应该影响我，继续往下走
        }
  
        try {
          // 终于轮到我了，开始办业务
          return await task();
        } finally {
          // 4. 任务完成后的清理工作
          const count = (this.queueCounts.get(key) || 1) - 1;
          if (count <= 0) {
            // 如果我是最后一个，关灯走人，清理内存
            this.queueCounts.delete(key);
            this.queues.delete(key);
          } else {
            this.queueCounts.set(key, count);
          }
        }
      })();
  
      // 5. 构建用于链式调用的 Promise (永远解决为 void)
      // 用来作为“下一个任务的前置条件”
      const nextStep = currentExecution.then(
        () => {}, 
        () => {} // 即使 currentExecution 抛出异常，nextStep 也是 resolved 状态
      );
  
      // 6. 更新队列尾部指针
      // 注意：这里需要再次检查是否已经被清理了？
      // 不需要，因为 enqueue 是同步执行的。如果我也在排队，count 至少是 1。
      // 上面的 finally 是异步执行的，会在将来发生。
      // 这里的 set 是立即发生的。
      this.queues.set(key, nextStep);
  
      // 7. 返回给调用者等待结果
      return currentExecution;
    }
  
    /**
     * 获取当前排队长度（包括正在执行的任务）
     */
    getLength(key: string): number {
      return this.queueCounts.get(key) || 0;
    }
}
