// Batch coordination: sequential per file, bounded parallel across files.
import PQueue from 'p-queue'

export class BatchQueue {
  private global: PQueue
  private perFile = new Map<string, Promise<unknown>>()

  constructor(concurrency = 3) {
    this.global = new PQueue({ concurrency })
  }

  enqueue<T>(file: string, task: () => Promise<T>): Promise<T> {
    const prev = (this.perFile.get(file) ?? Promise.resolve()) as Promise<unknown>
    const next = prev.then(() => this.global.add(task) as Promise<T>)
    this.perFile.set(file, next.catch(() => undefined))
    return next
  }

  idle(): Promise<void> { return this.global.onIdle() }
  get size(): number { return this.global.size + this.global.pending }
}