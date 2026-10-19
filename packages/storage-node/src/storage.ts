import { createHash } from 'node:crypto';
import { access, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';

export interface ChunkWriteResult {
  sizeBytes: number;
  checksumSha256: string;
}

export interface NodeHealthReport {
  nodeId: string;
  status: 'HEALTHY' | 'UNHEALTHY' | 'UNAVAILABLE' | 'RECOVERING';
  totalCapacityBytes: number;
  usedCapacityBytes: number;
  activeOperations: number;
}

export interface IStorageNode {
  putChunk(
    chunkId: string,
    input: NodeJS.ReadableStream,
    expectedChecksum: string,
  ): Promise<ChunkWriteResult>;
  getChunk(chunkId: string): Promise<Readable>;
  deleteChunk(chunkId: string): Promise<boolean>;
  hasChunk(chunkId: string): Promise<boolean>;
  listChunks(): Promise<string[]>;
  healthCheck(): Promise<NodeHealthReport>;
  reconcile(): Promise<number>;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const CHUNK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class FilesystemChunkStore implements IStorageNode {
  private readonly root: string;
  private usedBytes = 0;
  private initialized = false;

  public constructor(
    private readonly dataDir: string,
    private readonly nodeId: string,
    private readonly totalCapacityBytes = 0,
  ) {
    this.root = resolve(dataDir);
  }

  public async reconcile(): Promise<number> {
    await mkdir(this.root, { recursive: true });
    const entries = await readdir(this.root, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.endsWith('.tmp')) {
        continue;
      }
      try {
        const fileStat = await stat(this.chunkPath(entry.name));
        total += fileStat.size;
      } catch {
        // file removed concurrently
      }
    }
    this.usedBytes = total;
    this.initialized = true;
    return total;
  }

  public async putChunk(
    chunkId: string,
    input: NodeJS.ReadableStream,
    expectedChecksum: string,
  ): Promise<ChunkWriteResult> {
    this.assertChunkId(chunkId);
    this.assertChecksum(expectedChecksum);
    await mkdir(this.root, { recursive: true });

    const finalPath = this.chunkPath(chunkId);
    const temporaryPath = `${finalPath}.tmp`;
    await rm(temporaryPath, { force: true });

    const hash = createHash('sha256');
    let sizeBytes = 0;
    const hashingTransform = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        hash.update(chunk);
        sizeBytes += chunk.byteLength;
        callback(null, chunk);
      },
    });

    try {
      await pipeline(input, hashingTransform, createWriteStream(temporaryPath, { flags: 'wx' }));
      const checksumSha256 = hash.digest('hex');
      if (checksumSha256 !== expectedChecksum.toLowerCase()) {
        throw new Error('checksum mismatch');
      }

      let previousSize = 0;
      try {
        const fileStat = await stat(finalPath);
        previousSize = fileStat.size;
      } catch {
        // file does not exist yet
      }

      await rename(temporaryPath, finalPath);
      if (!this.initialized) {
        await this.reconcile();
      } else {
        this.usedBytes = Math.max(0, this.usedBytes - previousSize + sizeBytes);
      }

      return { sizeBytes, checksumSha256 };
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  public async getChunk(chunkId: string): Promise<Readable> {
    const path = this.chunkPath(chunkId);
    await access(path);
    return createReadStream(path);
  }

  public async deleteChunk(chunkId: string): Promise<boolean> {
    const path = this.chunkPath(chunkId);
    let previousSize = 0;
    try {
      const fileStat = await stat(path);
      previousSize = fileStat.size;
    } catch {
      return false;
    }

    await rm(path);
    if (!this.initialized) {
      await this.reconcile();
    } else {
      this.usedBytes = Math.max(0, this.usedBytes - previousSize);
    }
    return true;
  }

  public async hasChunk(chunkId: string): Promise<boolean> {
    const path = this.chunkPath(chunkId);
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  public async listChunks(): Promise<string[]> {
    await mkdir(this.root, { recursive: true });
    const entries = await readdir(this.root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && !entry.name.endsWith('.tmp'))
      .map((entry) => entry.name)
      .sort();
  }

  public async healthCheck(): Promise<NodeHealthReport> {
    if (!this.initialized) {
      await this.reconcile();
    }

    return {
      nodeId: this.nodeId,
      status: 'HEALTHY',
      totalCapacityBytes: this.totalCapacityBytes,
      usedCapacityBytes: this.usedBytes,
      activeOperations: 0,
    };
  }

  private chunkPath(chunkId: string): string {
    this.assertChunkId(chunkId);
    const path = resolve(this.root, chunkId);
    if (dirname(path) !== this.root || basename(path) !== chunkId) {
      throw new Error('invalid chunk ID');
    }
    return path;
  }

  private assertChunkId(chunkId: string): void {
    if (
      !CHUNK_ID_PATTERN.test(chunkId) ||
      chunkId === '.' ||
      chunkId === '..' ||
      chunkId.endsWith('.tmp')
    ) {
      throw new Error('invalid chunk ID');
    }
  }

  private assertChecksum(checksum: string): void {
    if (!SHA256_PATTERN.test(checksum)) {
      throw new Error('invalid SHA-256 checksum');
    }
  }
}
