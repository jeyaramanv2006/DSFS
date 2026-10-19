import {
  createChunkAad,
  decryptChunk,
  deriveKeys,
  encodeRetrievalCode,
  decodeRetrievalCode,
  isValidRetrievalCode,
  encryptChunk,
  encryptFilename,
  generateSecret,
  sha256,
} from '@voidshare/shared';

const CHUNK_OVERHEAD_BYTES = 28;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function apiUrl(baseUrl: string, path: string): string {
  return new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

async function expectResponse(response: Response): Promise<Response> {
  if (!response.ok) {
    throw new Error(`VoidShare API request failed with ${response.status}`);
  }
  return response;
}

export interface CliUploadResult {
  fileId: string;
  secret: string;
  retrievalCode: string;
}

export async function uploadBytes(
  baseUrl: string,
  plaintext: Uint8Array,
  options: {
    fileName?: string;
    secret?: string;
    chunkSizeBytes?: number;
    ttlSeconds?: number;
    maxDownloads?: number;
  } = {},
): Promise<CliUploadResult> {
  const secret = options.secret ?? generateSecret();
  const chunkSizeBytes = options.chunkSizeBytes ?? 4 * 1024 * 1024;
  const { encKey, authToken } = await deriveKeys(secret);
  if (plaintext.byteLength === 0) throw new Error('cannot upload an empty file');
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < plaintext.byteLength; offset += chunkSizeBytes) {
    chunks.push(plaintext.slice(offset, offset + chunkSizeBytes));
  }
  const authHex = bytesToHex(authToken);
  const init = await expectResponse(await fetch(apiUrl(baseUrl, '/api/transfers'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      authToken: authHex,
      totalSizeBytes: plaintext.byteLength + chunks.length * CHUNK_OVERHEAD_BYTES,
      chunkCount: chunks.length,
      chunkSizeBytes: chunkSizeBytes + CHUNK_OVERHEAD_BYTES,
      encryptedFileName: options.fileName ? await encryptFilename(options.fileName, secret) : null,
      ttlSeconds: options.ttlSeconds ?? 600,
      maxDownloads: options.maxDownloads ?? 1,
    }),
  })).then((response) => response.json());

  const encryptedChunks: Uint8Array[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    encryptedChunks.push(await encryptChunk(encKey, chunks[index], createChunkAad(init.fileId, index, chunks.length)));
  }

  for (let index = 0; index < encryptedChunks.length; index += 1) {
    const chunk = encryptedChunks[index];
    const checksum = await sha256(chunk);
    await expectResponse(await fetch(apiUrl(baseUrl, `/api/transfers/${init.fileId}/chunks/${index}`), {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${init.uploadToken}`,
        'content-type': 'application/octet-stream',
        'x-chunk-checksum-sha256': checksum,
      },
      body: Buffer.from(chunk),
    }));
  }
  await expectResponse(await fetch(apiUrl(baseUrl, `/api/transfers/${init.fileId}/finalize`), {
    method: 'POST',
    headers: { authorization: `Bearer ${init.uploadToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ totalChunksUploaded: encryptedChunks.length }),
  }));
  return { fileId: init.fileId, secret, retrievalCode: encodeRetrievalCode(secret) };
}

export async function resolveTransfer(
  baseUrl: string,
  secretOrCode: string,
): Promise<{ fileId: string; status: string; totalSizeBytes: number; encryptedFileName: string | null }> {
  const secret = isValidRetrievalCode(secretOrCode)
    ? decodeRetrievalCode(secretOrCode)
    : secretOrCode;
  const { authToken } = await deriveKeys(secret);
  const response = await expectResponse(await fetch(apiUrl(baseUrl, '/api/transfers/resolve'), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bytesToHex(authToken)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ authToken: bytesToHex(authToken) }),
  }));
  return response.json();
}

export async function downloadByCode(baseUrl: string, retrievalCode: string): Promise<Uint8Array> {
  if (!isValidRetrievalCode(retrievalCode)) {
    throw new Error('invalid retrieval code');
  }
  const secret = decodeRetrievalCode(retrievalCode);
  const resolved = await resolveTransfer(baseUrl, retrievalCode);
  return downloadBytes(baseUrl, resolved.fileId, secret);
}

export async function downloadBytes(baseUrl: string, fileId: string, secret: string): Promise<Uint8Array> {
  const { encKey, authToken } = await deriveKeys(secret);
  const access = await expectResponse(await fetch(apiUrl(baseUrl, `/api/transfers/${fileId}/access`), {
    method: 'POST',
    headers: { authorization: `Bearer ${bytesToHex(authToken)}` },
  })).then((response) => response.json());
  const parts: Uint8Array[] = [];
  for (const manifestChunk of access.manifest as Array<{ chunkIndex: number; checksumSha256: string }>) {
    const response = await expectResponse(await fetch(apiUrl(baseUrl, `/api/transfers/${fileId}/chunks/${manifestChunk.chunkIndex}`), {
      headers: { authorization: `Bearer ${access.downloadToken}` },
    }));
    const encrypted = new Uint8Array(await response.arrayBuffer());
    if (await sha256(encrypted) !== manifestChunk.checksumSha256) {
      throw new Error('downloaded chunk checksum mismatch');
    }
    parts.push(await decryptChunk(encKey, encrypted, createChunkAad(fileId, manifestChunk.chunkIndex, access.manifest.length)));
  }
  await expectResponse(await fetch(apiUrl(baseUrl, `/api/transfers/${fileId}/complete`), {
    method: 'POST',
    headers: { authorization: `Bearer ${access.downloadToken}` },
  }));
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}
