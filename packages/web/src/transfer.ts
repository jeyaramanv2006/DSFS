import {
  createChunkAad,
  decryptChunk,
  deriveKeys,
  encryptChunk,
  encryptFilename,
  generateSecret,
  sha256,
} from '@voidshare/shared';

const CHUNK_OVERHEAD_BYTES = 28;
const CHUNK_SIZE_BYTES = 4 * 1024 * 1024;
const CONCURRENCY = 3;

export interface UploadProgress {
  stage: 'preparing' | 'encrypting' | 'uploading' | 'finalizing';
  chunkIndex: number;
  chunkCount: number;
  percent: number;
  message: string;
}

export interface UploadOptions {
  ttlSeconds?: number;
  maxDownloads?: number;
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
}

export interface UploadResult {
  fileId: string;
  secret: string;
  expiresAt: string;
  fileName: string;
  fileSizeBytes: number;
  chunkCount: number;
  ttlSeconds: number;
  maxDownloads: number;
}

export interface DownloadProgress {
  stage: 'authorizing' | 'fetching' | 'decrypting' | 'verifying' | 'complete';
  chunkIndex: number;
  chunkCount: number;
  percent: number;
  message: string;
}

export interface DownloadOptions {
  signal?: AbortSignal;
  onProgress?: (progress: DownloadProgress) => void;
}

export interface DownloadResult {
  bytes: Uint8Array;
  encryptedFileName: string | null;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function responseJson(response: Response): Promise<any> {
  if (!response.ok) {
    if (response.status === 410) {
      throw new Error('This transfer has expired or has already reached its download limit.');
    }
    if (response.status === 404) {
      throw new Error('Transfer not found. The link may be invalid or was permanently deleted.');
    }
    if (response.status === 409) {
      throw new Error('A download is currently in progress for this link. Please try again shortly.');
    }
    if (response.status === 400) {
      throw new Error('Invalid transfer request parameter.');
    }
    if (response.status >= 500) {
      throw new Error('Storage network temporarily unavailable. Please try again.');
    }
    throw new Error(`Transfer request failed (HTTP ${response.status})`);
  }
  return response.json();
}

async function withConcurrency<T>(
  items: T[],
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

export async function uploadFile(
  file: File,
  options: UploadOptions = {},
): Promise<UploadResult> {
  const {
    ttlSeconds = 86400,
    maxDownloads = 1,
    signal,
    onProgress,
  } = options;

  if (signal?.aborted) {
    throw new DOMException('Upload aborted by user', 'AbortError');
  }

  onProgress?.({
    stage: 'preparing',
    chunkIndex: 0,
    chunkCount: 1,
    percent: 5,
    message: 'Generating client-side 256-bit encryption master secret...',
  });

  const secret = generateSecret();
  const { encKey, authToken } = await deriveKeys(secret);
  const chunkCount = Math.max(1, Math.ceil(file.size / CHUNK_SIZE_BYTES));
  const totalSizeBytes = file.size + chunkCount * CHUNK_OVERHEAD_BYTES;

  onProgress?.({
    stage: 'preparing',
    chunkIndex: 0,
    chunkCount,
    percent: 10,
    message: 'Initializing zero-knowledge transfer session on coordinator...',
  });

  const init = await responseJson(
    await fetch('/api/transfers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal,
      body: JSON.stringify({
        authToken: bytesToHex(authToken),
        totalSizeBytes,
        chunkCount,
        chunkSizeBytes: CHUNK_SIZE_BYTES + CHUNK_OVERHEAD_BYTES,
        encryptedFileName: await encryptFilename(file.name, secret),
        ttlSeconds,
        maxDownloads,
      }),
    }),
  );

  let uploadedChunks = 0;
  const indices = Array.from({ length: chunkCount }, (_, index) => index);

  await withConcurrency(indices, async (index) => {
    if (signal?.aborted) {
      throw new DOMException('Upload aborted by user', 'AbortError');
    }

    const start = index * CHUNK_SIZE_BYTES;
    const plaintextChunk = new Uint8Array(
      await file.slice(start, start + CHUNK_SIZE_BYTES).arrayBuffer(),
    );

    const encrypted = await encryptChunk(
      encKey,
      plaintextChunk,
      createChunkAad(init.fileId, index, chunkCount),
    );
    const checksum = await sha256(encrypted);

    const response = await fetch(`/api/transfers/${init.fileId}/chunks/${index}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${init.uploadToken}`,
        'content-type': 'application/octet-stream',
        'x-chunk-checksum-sha256': checksum,
      },
      body: encrypted as unknown as BodyInit,
      signal,
    });

    if (!response.ok) {
      throw new Error(`Chunk ${index + 1} of ${chunkCount} could not be uploaded`);
    }

    uploadedChunks++;
    const percent = Math.min(90, Math.round(15 + (uploadedChunks / chunkCount) * 75));
    onProgress?.({
      stage: 'uploading',
      chunkIndex: uploadedChunks,
      chunkCount,
      percent,
      message: `Encrypting & streaming chunk ${uploadedChunks} of ${chunkCount} (${percent}%)...`,
    });
  });

  onProgress?.({
    stage: 'finalizing',
    chunkIndex: chunkCount,
    chunkCount,
    percent: 95,
    message: 'Verifying distributed storage node replicas & finalizing session...',
  });

  await responseJson(
    await fetch(`/api/transfers/${init.fileId}/finalize`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${init.uploadToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ totalChunksUploaded: chunkCount }),
      signal,
    }),
  );

  onProgress?.({
    stage: 'finalizing',
    chunkIndex: chunkCount,
    chunkCount,
    percent: 100,
    message: 'Transfer complete! Share link ready.',
  });

  return {
    fileId: init.fileId,
    secret,
    expiresAt: init.expiresAt,
    fileName: file.name,
    fileSizeBytes: file.size,
    chunkCount,
    ttlSeconds,
    maxDownloads,
  };
}

export async function downloadFile(
  fileId: string,
  secret: string,
  options: DownloadOptions = {},
): Promise<DownloadResult> {
  const { signal, onProgress } = options;

  if (signal?.aborted) {
    throw new DOMException('Download aborted by user', 'AbortError');
  }

  onProgress?.({
    stage: 'authorizing',
    chunkIndex: 0,
    chunkCount: 1,
    percent: 10,
    message: 'Verifying master capability and requesting download lease...',
  });

  const { encKey, authToken } = await deriveKeys(secret);
  const access = await responseJson(
    await fetch(`/api/transfers/${encodeURIComponent(fileId)}/access`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bytesToHex(authToken)}` },
      signal,
    }),
  );

  const manifest = access.manifest as Array<{
    chunkIndex: number;
    sizeBytes: number;
    checksumSha256: string;
  }>;
  const chunkCount = manifest.length;
  const chunks = new Map<number, Uint8Array>();
  let downloadedCount = 0;

  onProgress?.({
    stage: 'fetching',
    chunkIndex: 0,
    chunkCount,
    percent: 20,
    message: `Streaming ${chunkCount} encrypted chunk(s) from storage cluster...`,
  });

  await withConcurrency(manifest, async (manifestChunk) => {
    if (signal?.aborted) {
      throw new DOMException('Download aborted by user', 'AbortError');
    }

    const response = await fetch(
      `/api/transfers/${encodeURIComponent(fileId)}/chunks/${manifestChunk.chunkIndex}`,
      {
        headers: { authorization: `Bearer ${access.downloadToken}` },
        signal,
      },
    );
    if (!response.ok) {
      throw new Error(`Chunk ${manifestChunk.chunkIndex + 1} could not be downloaded`);
    }

    const encrypted = new Uint8Array(await response.arrayBuffer());
    if ((await sha256(encrypted)) !== manifestChunk.checksumSha256) {
      throw new Error(`Chunk ${manifestChunk.chunkIndex + 1} failed its SHA-256 integrity check`);
    }

    const decrypted = await decryptChunk(
      encKey,
      encrypted,
      createChunkAad(fileId, manifestChunk.chunkIndex, chunkCount),
    );
    chunks.set(manifestChunk.chunkIndex, decrypted);

    downloadedCount++;
    const percent = Math.min(90, Math.round(20 + (downloadedCount / chunkCount) * 70));
    onProgress?.({
      stage: 'decrypting',
      chunkIndex: downloadedCount,
      chunkCount,
      percent,
      message: `Decrypted chunk ${downloadedCount} of ${chunkCount} in-browser...`,
    });
  });

  onProgress?.({
    stage: 'verifying',
    chunkIndex: chunkCount,
    chunkCount,
    percent: 95,
    message: 'Completing atomic lease and marking download count...',
  });

  await responseJson(
    await fetch(`/api/transfers/${encodeURIComponent(fileId)}/complete`, {
      method: 'POST',
      headers: { authorization: `Bearer ${access.downloadToken}` },
      signal,
    }),
  );

  const ordered = Array.from({ length: chunkCount }, (_, index) => chunks.get(index)!);
  const bytes = new Uint8Array(ordered.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of ordered) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  onProgress?.({
    stage: 'complete',
    chunkIndex: chunkCount,
    chunkCount,
    percent: 100,
    message: 'Decryption verified successfully.',
  });

  return {
    bytes,
    encryptedFileName: access.encryptedFileName ?? null,
  };
}
