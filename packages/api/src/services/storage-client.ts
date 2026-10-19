import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Readable } from 'node:stream';

export interface StoredChunkResult {
  sizeBytes: number;
  checksumSha256: string;
}

interface StorageNodePutResponse {
  storedSizeBytes: number;
  checksumVerified: boolean;
}

export interface StorageNodeClient {
  putChunk(
    chunkId: string,
    input: NodeJS.ReadableStream,
    checksumSha256: string,
  ): Promise<StoredChunkResult>;
  getChunk(chunkId: string): Promise<Readable>;
}

export interface StorageMaintenanceClient {
  deleteChunk(chunkId: string): Promise<boolean>;
  listChunks(): Promise<string[]>;
}

export class HttpStorageNodeClient implements StorageNodeClient, StorageMaintenanceClient {
  public constructor(
    private readonly endpoint: string,
    private readonly clusterSecret?: string,
  ) {}

  public putChunk(
    chunkId: string,
    input: NodeJS.ReadableStream,
    checksumSha256: string,
  ): Promise<StoredChunkResult> {
    const target = new URL(`/chunks/${encodeURIComponent(chunkId)}`, this.endpoint);
    const request = target.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {
        'content-type': 'application/octet-stream',
        'x-checksum': checksumSha256,
      };
      if (this.clusterSecret) {
        headers.authorization = `Bearer ${this.clusterSecret}`;
      }

      const outgoing = request(target, {
        method: 'PUT',
        headers,
      }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => { body += chunk; });
        response.on('end', () => {
          if ((response.statusCode ?? 500) >= 400) {
            reject(new Error(`storage node returned ${response.statusCode}`));
            return;
          }
          try {
            const result = JSON.parse(body) as StorageNodePutResponse;
            if (!Number.isInteger(result.storedSizeBytes) || !result.checksumVerified) {
              reject(new Error('storage node rejected checksum or returned invalid size'));
              return;
            }
            resolve({ sizeBytes: result.storedSizeBytes, checksumSha256 });
          } catch {
            reject(new Error('storage node returned invalid JSON'));
          }
        });
      });
      outgoing.on('error', reject);
      input.on('error', reject);
      input.pipe(outgoing);
    });
  }

  public getChunk(chunkId: string): Promise<Readable> {
    const target = new URL(`/chunks/${encodeURIComponent(chunkId)}`, this.endpoint);
    const request = target.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (this.clusterSecret) {
        headers.authorization = `Bearer ${this.clusterSecret}`;
      }

      const outgoing = request(target, { method: 'GET', headers }, (response) => {
        if ((response.statusCode ?? 500) >= 400) {
          response.resume();
          reject(new Error(`storage node returned ${response.statusCode}`));
          return;
        }
        response.on('error', reject);
        resolve(response);
      });
      outgoing.on('error', reject);
      outgoing.end();
    });
  }

  public deleteChunk(chunkId: string): Promise<boolean> {
    return this.requestJson(`/chunks/${encodeURIComponent(chunkId)}`, 'DELETE')
      .then((result) => result.deleted === true);
  }

  public listChunks(): Promise<string[]> {
    return this.requestJson('/chunks', 'GET').then((result) => {
      if (!Array.isArray(result.chunks) || !result.chunks.every((chunk): chunk is string => typeof chunk === 'string')) {
        throw new Error('storage node returned invalid chunk listing');
      }
      return result.chunks;
    });
  }

  private requestJson(path: string, method: 'GET' | 'DELETE'): Promise<Record<string, unknown>> {
    const target = new URL(path, this.endpoint);
    const request = target.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (this.clusterSecret) {
        headers.authorization = `Bearer ${this.clusterSecret}`;
      }

      const outgoing = request(target, { method, headers }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => { body += chunk; });
        response.on('end', () => {
          if ((response.statusCode ?? 500) >= 400) {
            reject(new Error(`storage node returned ${response.statusCode}`));
            return;
          }
          try {
            const result = JSON.parse(body) as Record<string, unknown>;
            resolve(result);
          } catch {
            reject(new Error('storage node returned invalid JSON'));
          }
        });
      });
      outgoing.on('error', reject);
      outgoing.end();
    });
  }
}
