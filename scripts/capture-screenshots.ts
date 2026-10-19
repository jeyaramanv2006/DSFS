import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { buildServer as buildStorageNodeServer } from '../packages/storage-node/src/server.js';
import type { IStorageNode, ChunkWriteResult, NodeHealthReport } from '../packages/storage-node/src/storage.js';
import { buildApiServer } from '../packages/api/src/server.js';
import { MetadataDatabase } from '../packages/api/src/db/database.js';
import { HttpStorageNodeClient } from '../packages/api/src/services/storage-client.js';
import { ReplicationService } from '../packages/api/src/replication/replication.js';
import { ReplicaReadService } from '../packages/api/src/replication/read-service.js';
import { PlacementService } from '../packages/api/src/placement/service.js';
import { HealthMonitor } from '../packages/api/src/health/monitor.js';
import { uploadBytes } from '../packages/cli/src/client.js';

class MemoryStorageNode implements IStorageNode {
  public readonly chunks = new Map<string, Buffer>();
  public activeOperations = 0;

  public constructor(
    public readonly nodeId: string,
    public readonly totalCapacityBytes = 10_737_418_240, // 10 GB
  ) {}

  public async putChunk(
    chunkId: string,
    input: NodeJS.ReadableStream,
    expectedChecksum: string,
  ): Promise<ChunkWriteResult> {
    const parts: Buffer[] = [];
    for await (const part of input as AsyncIterable<Buffer | string>) {
      parts.push(Buffer.isBuffer(part) ? part : Buffer.from(part));
    }
    const body = Buffer.concat(parts);
    const checksum = createHash('sha256').update(body).digest('hex');
    if (checksum !== expectedChecksum) throw new Error('checksum mismatch');
    this.chunks.set(chunkId, body);
    return { sizeBytes: body.length, checksumSha256: checksum };
  }

  public async getChunk(chunkId: string): Promise<Readable> {
    const body = this.chunks.get(chunkId);
    if (!body) throw new Error('chunk not found');
    return Readable.from(Buffer.from(body));
  }

  public async deleteChunk(chunkId: string): Promise<boolean> {
    return this.chunks.delete(chunkId);
  }

  public async hasChunk(chunkId: string): Promise<boolean> {
    return this.chunks.has(chunkId);
  }

  public async listChunks(): Promise<string[]> {
    return [...this.chunks.keys()];
  }

  public async healthCheck(): Promise<NodeHealthReport> {
    let used = 157286400; // 150 MB base used for nice realistic dashboard visual
    for (const buf of this.chunks.values()) used += buf.length;
    return {
      nodeId: this.nodeId,
      status: 'HEALTHY',
      totalCapacityBytes: this.totalCapacityBytes,
      usedCapacityBytes: used,
      activeOperations: this.activeOperations,
    };
  }

  public async reconcile(): Promise<number> {
    return this.chunks.size;
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const CLUSTER_SECRET = 'demo-cluster-secret-key-32-chars!!';

async function main() {
  console.log('Starting screenshot capture automation...');
  await mkdir(resolve(root, 'docs/assets'), { recursive: true });

  // 1. Storage Nodes
  const store1 = new MemoryStorageNode('node-1');
  const store2 = new MemoryStorageNode('node-2');
  const node1App = buildStorageNodeServer(store1, { clusterSecret: CLUSTER_SECRET });
  const node2App = buildStorageNodeServer(store2, { clusterSecret: CLUSTER_SECRET });

  await node1App.listen({ host: '127.0.0.1', port: 9001 });
  await node2App.listen({ host: '127.0.0.1', port: 9002 });
  console.log('Storage nodes listening on 9001, 9002');

  // 2. Coordinator API
  const db = new MetadataDatabase();
  const url1 = 'http://127.0.0.1:9001';
  const url2 = 'http://127.0.0.1:9002';
  db.registerStorageNode({
    nodeId: 'node-1',
    endpointUrl: url1,
    status: 'HEALTHY',
    totalCapacityBytes: 10 * 1024 * 1024 * 1024,
    usedCapacityBytes: 157286400,
    activeOperations: 0,
  });
  db.registerStorageNode({
    nodeId: 'node-2',
    endpointUrl: url2,
    status: 'HEALTHY',
    totalCapacityBytes: 10 * 1024 * 1024 * 1024,
    usedCapacityBytes: 157286400,
    activeOperations: 0,
  });

  const nodeTargets = [
    { nodeId: 'node-1', client: new HttpStorageNodeClient(url1, CLUSTER_SECRET) },
    { nodeId: 'node-2', client: new HttpStorageNodeClient(url2, CLUSTER_SECRET) },
  ];
  const replicator = new ReplicationService(db, new PlacementService(db), nodeTargets);
  const readService = new ReplicaReadService(db, nodeTargets);
  const monitor = new HealthMonitor(db, () => new Date(), { unhealthyAfterMs: 5000, unavailableAfterMs: 10000 });

  const apiApp = buildApiServer(db, nodeTargets[0].client, replicator, readService, monitor, {
    clusterSecret: CLUSTER_SECRET,
    allowedNodeIds: ['node-1', 'node-2'],
  });
  await apiApp.listen({ host: '127.0.0.1', port: 3000 });
  console.log('Coordinator API listening on 3000');

  // 3. Seed realistic transfers & events
  // Transfer 1: 12MB file (3 chunks, replicated on both nodes)
  const dummyData = new Uint8Array(12 * 1024 * 1024);
  dummyData.fill(42);
  const uploadResult = await uploadBytes('http://127.0.0.1:3000', dummyData, {
    fileName: 'ubuntu-24.04-desktop-amd64.iso',
    chunkSizeBytes: 4 * 1024 * 1024,
    maxDownloads: 5,
    ttlSeconds: 86400,
  });
  console.log('Seeded transfer:', uploadResult.fileId);

  // Seed realistic cluster events
  db.recordClusterEvent({
    eventType: 'NODE_RECOVERED',
    severity: 'INFO',
    nodeId: 'node-1',
    details: { status: 'HEALTHY', message: 'Heartbeat restored within latency window' },
    createdAt: new Date(Date.now() - 45_000).toISOString(),
  });
  db.recordClusterEvent({
    eventType: 'READ_FAILOVER_SUCCEEDED',
    severity: 'WARN',
    nodeId: 'node-2',
    fileId: uploadResult.fileId,
    details: { primaryNode: 'node-1', fallbackNode: 'node-2', message: 'Transparent replica failover' },
    createdAt: new Date(Date.now() - 90_000).toISOString(),
  });
  db.recordClusterEvent({
    eventType: 'TRANSFER_FINALIZED',
    severity: 'INFO',
    fileId: uploadResult.fileId,
    details: { chunks: 3, replicas: 6, replicationFactor: 2 },
    createdAt: new Date(Date.now() - 150_000).toISOString(),
  });

  // 4. Start Vite web dev server
  const viteProcess = spawn('npx', ['vite', 'packages/web', '--port', '5173', '--host', '127.0.0.1'], {
    cwd: root,
    shell: true,
    stdio: 'pipe',
    env: { ...process.env, VOIDSHARE_API_TARGET: 'http://127.0.0.1:3000' },
  });

  // Wait for Vite to be ready
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch('http://127.0.0.1:5173/');
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ready) throw new Error('Vite dev server did not start in time');
  console.log('Vite web server ready on 5173');

  // 5. Capture screenshots with Playwright
  const runScreenshot = async (url: string, outputFilename: string) => {
    console.log(`Capturing ${outputFilename}...`);
    return new Promise<void>((resolvePromise, rejectPromise) => {
      const proc = spawn(
        'npx',
        [
          'playwright',
          'screenshot',
          '--channel=chrome',
          '--viewport-size=1440,900',
          '--wait-for-timeout=2000',
          url,
          outputFilename,
        ],
        { cwd: root, shell: true, stdio: 'inherit' },
      );
      proc.on('exit', (code) => {
        if (code === 0) resolvePromise();
        else rejectPromise(new Error(`Screenshot process exited with code ${code}`));
      });
    });
  };

  // Keep fresh heartbeats flowing so dashboard shows 2/2 HEALTHY
  const heartbeatTimer = setInterval(() => {
    const now = new Date().toISOString();
    db.registerStorageNode({
      nodeId: 'node-1',
      endpointUrl: url1,
      status: 'HEALTHY',
      totalCapacityBytes: 10 * 1024 * 1024 * 1024,
      usedCapacityBytes: 157286400,
      activeOperations: 0,
      heartbeatAt: now,
    });
    db.registerStorageNode({
      nodeId: 'node-2',
      endpointUrl: url2,
      status: 'HEALTHY',
      totalCapacityBytes: 10 * 1024 * 1024 * 1024,
      usedCapacityBytes: 157286400,
      activeOperations: 0,
      heartbeatAt: now,
    });
  }, 1000);

  try {
    await runScreenshot('http://127.0.0.1:5173/cluster', 'docs/assets/dashboard-overview.png');
    await runScreenshot('http://127.0.0.1:5173/', 'docs/assets/landing-home.png');
    await runScreenshot('http://127.0.0.1:5173/send', 'docs/assets/upload-interface.png');
    await runScreenshot('http://127.0.0.1:5173/download?tab=code', 'docs/assets/retrieval-code.png');
    console.log('All screenshots captured successfully!');
  } finally {
    clearInterval(heartbeatTimer);
    viteProcess.kill();
    await apiApp.close();
    await node1App.close();
    await node2App.close();
    db.close();
    console.log('All servers shut down.');
  }
}

main().catch((err) => {
  console.error('Error capturing screenshots:', err);
  process.exit(1);
});
