import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { IStorageNode } from './storage.js';

export interface HeartbeatEmitterOptions {
  nodeId: string;
  endpointUrl: string;
  coordinatorUrl: string;
  clusterSecret?: string;
  intervalMs?: number;
  store: IStorageNode;
  getActiveOperations?: () => number;
  logger?: { info(msg: string): void; error(msg: string, err?: unknown): void };
}

export class StorageNodeHeartbeatEmitter {
  private timer: NodeJS.Timeout | null = null;
  private isEmitting = false;
  private isStopped = false;
  private activeAbortController: AbortController | null = null;
  private readonly intervalMs: number;

  public constructor(private readonly options: HeartbeatEmitterOptions) {
    this.intervalMs = options.intervalMs ?? 2000;
  }

  public start(): void {
    if (this.timer || this.isStopped) return;
    void this.emitOnce();
    this.timer = setInterval(() => {
      void this.emitOnce();
    }, this.intervalMs);
  }

  public stop(): void {
    this.isStopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }
  }

  public async emitOnce(): Promise<boolean> {
    if (this.isEmitting || this.isStopped) return false;
    this.isEmitting = true;
    const controller = new AbortController();
    this.activeAbortController = controller;

    try {
      const health = await this.options.store.healthCheck();
      const activeOps = this.options.getActiveOperations ? this.options.getActiveOperations() : 0;
      const payload = JSON.stringify({
        nodeId: this.options.nodeId,
        endpointUrl: this.options.endpointUrl,
        totalCapacityBytes: health.totalCapacityBytes,
        usedCapacityBytes: health.usedCapacityBytes,
        activeOperations: activeOps,
      });

      const target = new URL('/api/nodes/heartbeat', this.options.coordinatorUrl);
      const reqFn = target.protocol === 'https:' ? httpsRequest : httpRequest;

      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(payload)),
      };
      if (this.options.clusterSecret) {
        headers.authorization = `Bearer ${this.options.clusterSecret}`;
      }

      const success = await new Promise<boolean>((resolve) => {
        const req = reqFn(target, {
          method: 'POST',
          headers,
          signal: controller.signal,
          timeout: Math.min(5000, Math.max(1000, this.intervalMs * 2)),
        }, (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { body += c; });
          res.on('end', () => {
            const ok = (res.statusCode ?? 500) >= 200 && (res.statusCode ?? 500) < 300;
            if (!ok && this.options.logger) {
              this.options.logger.error(`Heartbeat rejected by coordinator: ${res.statusCode} ${body}`);
            }
            resolve(ok);
          });
        });

        req.on('timeout', () => {
          req.destroy(new Error('Heartbeat request timed out'));
          resolve(false);
        });

        req.on('error', (err) => {
          if (!controller.signal.aborted && this.options.logger) {
            this.options.logger.error(`Heartbeat dispatch error: ${err.message}`);
          }
          resolve(false);
        });

        req.write(payload);
        req.end();
      });

      return success;
    } catch (error) {
      if (!controller.signal.aborted && this.options.logger) {
        this.options.logger.error('Unexpected error emitting heartbeat', error);
      }
      return false;
    } finally {
      this.isEmitting = false;
      if (this.activeAbortController === controller) {
        this.activeAbortController = null;
      }
    }
  }
}
