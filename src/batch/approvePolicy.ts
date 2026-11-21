// Approve policy -- Cline-style "approve-once" with max-count.
// Reference: plan section 3, "auto-approve có max-count của Cline".
export interface ApproveState {
  approved: number
  remaining: number
}

export class ApproveOncePolicy {
  private used = 0
  constructor(private readonly maxCount: number = 1) {}

  canAutoApprove(): boolean {
    return this.used < this.maxCount
  }

  consume(): ApproveState {
    if (this.used < this.maxCount) this.used++
    return { approved: this.used, remaining: this.maxCount - this.used }
  }

  reset(): void { this.used = 0 }
}