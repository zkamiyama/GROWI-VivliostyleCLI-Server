"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.JobQueue = void 0;
const p_queue_1 = __importDefault(require("p-queue"));
class JobQueue {
    queue;
    constructor(concurrency) {
        this.queue = new p_queue_1.default({ concurrency });
    }
    enqueue(jobId, task) {
        return this.queue.add(async () => {
            await task();
        }, { throwOnTimeout: false });
    }
    get size() {
        return this.queue.size;
    }
    get pending() {
        return this.queue.pending;
    }
    async onIdle() {
        await this.queue.onIdle();
    }
}
exports.JobQueue = JobQueue;
//# sourceMappingURL=jobQueue.js.map