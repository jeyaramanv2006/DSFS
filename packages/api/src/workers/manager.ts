import { MetadataDatabase } from '../db/database.js';
import { ExpirationSweeper, StorageReconciler, type CleanupReport, type ReconciliationReport } from '../cleanup/cleanup.js';
import { RecoveryService, type RecoveryReport } from '../recovery/recovery.js';

export interface WorkerManagerOptions {
  expirationSweepIntervalMs?: number;
  reconciliationIntervalMs?: number;
  recoveryIntervalMs?: number;
}

export class BackgroundWorkerManager {
  private sweeperTimer: NodeJS.Timeout | null = null;
  private reconcilerTimer: NodeJS.Timeout | null = null;
  private recoveryTimer: NodeJS.Timeout | null = null;
  private isSweeping = false;
  private isReconciling = false;
  private isRecovering = false;
  private isRunning = false;

  public constructor(
    private readonly database: MetadataDatabase,
    private readonly sweeper: ExpirationSweeper,
    private readonly reconciler: StorageReconciler,
    private readonly recovery: RecoveryService,
    private readonly options: WorkerManagerOptions = {},
  ) {}

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    const sweepInterval = this.options.expirationSweepIntervalMs ?? 15_000;
    const reconcileInterval = this.options.reconciliationIntervalMs ?? 30_000;
    const recoveryInterval = this.options.recoveryIntervalMs ?? 30_000;

    this.sweeperTimer = setInterval(() => void this.runSweep(), sweepInterval);
    this.reconcilerTimer = setInterval(() => void this.runReconciliation(), reconcileInterval);
    this.recoveryTimer = setInterval(() => void this.runRecovery(), recoveryInterval);

    if (this.sweeperTimer && typeof this.sweeperTimer.unref === 'function') this.sweeperTimer.unref();
    if (this.reconcilerTimer && typeof this.reconcilerTimer.unref === 'function') this.reconcilerTimer.unref();
    if (this.recoveryTimer && typeof this.recoveryTimer.unref === 'function') this.recoveryTimer.unref();
  }

  public stop(): void {
    this.isRunning = false;
    if (this.sweeperTimer) {
      clearInterval(this.sweeperTimer);
      this.sweeperTimer = null;
    }
    if (this.reconcilerTimer) {
      clearInterval(this.reconcilerTimer);
      this.reconcilerTimer = null;
    }
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  }

  public isStarted(): boolean {
    return this.isRunning;
  }

  public async runSweep(now = new Date()): Promise<CleanupReport | null> {
    if (this.isSweeping) return null;
    this.isSweeping = true;
    try {
      const report = await this.sweeper.sweep(now);
      if (report.claimedTransfers.length > 0 || report.orphanedReplicas.length > 0) {
        this.database.recordClusterEvent({
          eventType: 'SWEEP_COMPLETED',
          severity: 'INFO',
          details: {
            claimed: report.claimedTransfers.length,
            deleted: report.deletedTransfers.length,
            orphanedReplicas: report.orphanedReplicas.length,
          },
        });
      }
      return report;
    } catch (err) {
      this.database.recordClusterEvent({
        eventType: 'SWEEP_ERROR',
        severity: 'ERROR',
        details: { message: err instanceof Error ? err.message : String(err) },
      });
      return null;
    } finally {
      this.isSweeping = false;
    }
  }

  public async runReconciliation(): Promise<ReconciliationReport | null> {
    if (this.isReconciling) return null;
    this.isReconciling = true;
    try {
      const report = await this.reconciler.reconcile();
      if (report.deletedOrphans.length > 0 || report.failedDeletes.length > 0) {
        this.database.recordClusterEvent({
          eventType: 'RECONCILIATION_COMPLETED',
          severity: report.failedDeletes.length > 0 ? 'WARN' : 'INFO',
          details: {
            deletedOrphans: report.deletedOrphans.length,
            failedDeletes: report.failedDeletes.length,
          },
        });
      }
      return report;
    } catch (err) {
      this.database.recordClusterEvent({
        eventType: 'RECONCILIATION_ERROR',
        severity: 'ERROR',
        details: { message: err instanceof Error ? err.message : String(err) },
      });
      return null;
    } finally {
      this.isReconciling = false;
    }
  }

  public async runRecovery(): Promise<RecoveryReport | null> {
    if (this.isRecovering) return null;
    this.isRecovering = true;
    try {
      const report = await this.recovery.recoverUnderReplicated();
      if (report.recovered.length > 0) {
        this.database.recordClusterEvent({
          eventType: 'RECOVERY_COMPLETED',
          severity: 'INFO',
          details: {
            recoveredCount: report.recovered.length,
            skippedCount: report.skipped.length,
          },
        });
      }
      return report;
    } catch (err) {
      this.database.recordClusterEvent({
        eventType: 'RECOVERY_ERROR',
        severity: 'ERROR',
        details: { message: err instanceof Error ? err.message : String(err) },
      });
      return null;
    } finally {
      this.isRecovering = false;
    }
  }
}
