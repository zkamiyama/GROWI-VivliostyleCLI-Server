import PQueue from "p-queue";

export type JobTask = () => Promise<void>;

export class JobQueue {
  private readonly queue: PQueue;

  constructor(concurrency: number) {
    this.queue = new PQueue({ concurrency });
  }

  enqueue(jobId: string, task: JobTask): Promise<void> {
    return this.queue.add(async () => {
      await task();
    }, { throwOnTimeout: false });
  }

  get size(): number {
    return this.queue.size;
  }

  get pending(): number {
    return this.queue.pending;
  }

  async onIdle(): Promise<void> {
    await this.queue.onIdle();
  }
}
