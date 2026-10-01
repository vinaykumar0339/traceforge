import type { Logger } from "pino";
import type { InvestigationRepository } from "../storage/repositories/investigation.repository.js";
import type { InvestigationService } from "./investigation.service.js";

export class InvestigationQueue {
  private readonly activeInvestigations = new Set<string>();
  private pumping = false;
  private timer?: NodeJS.Timeout;
  constructor(private readonly repository: InvestigationRepository, private readonly service: InvestigationService, private readonly logger: Logger, private readonly concurrency = 3) {}

  async start(): Promise<void> {
    const count = await this.repository.requeueRunningJobs();
    if (count) this.logger.warn({ count }, "Requeued interrupted investigation jobs");
    this.timer = setInterval(() => this.kick(), 2_000);
    this.timer.unref();
    this.kick();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); }
  kick(): void { void this.pump(); }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.activeInvestigations.size < this.concurrency) {
        const job = await this.repository.claimNextJob(this.activeInvestigations);
        if (!job) break;
        this.activeInvestigations.add(job.investigationId);
        void this.service.process(job).finally(() => { this.activeInvestigations.delete(job.investigationId); this.kick(); });
      }
    } finally { this.pumping = false; }
  }
}
