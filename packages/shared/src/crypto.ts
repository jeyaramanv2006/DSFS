const SECRET_BYTES = 32;
const CHUNK_IV_BYTES = 12;
const CHUNK_TAG_BITS = 128;
const HKDF_SALT = new Uint8Array(32);
const FILENAME_ENVELOPE_VERSION = 1;

function getCrypto(): Crypto {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Web Crypto API is required');
  }

  return globalThis.crypto;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(value: string): Uint8Array {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) {
    throw new Error('secret must be exactly 32 bytes encoded as hex');
  }

  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }

  if (bytes.length !== SECRET_BYTES) {
    throw new Error('secret must be exactly 32 bytes encoded as hex');
  }

  return bytes;
}

async function importSecret(secret: string): Promise<CryptoKey> {
  return getCrypto().subtle.importKey(
    'raw',
    hexToBytes(secret) as BufferSource,
    'HKDF',
    false,
    ['deriveBits', 'deriveKey'],
  );
}

export function generateSecret(): string {
  const bytes = new Uint8Array(SECRET_BYTES);
  getCrypto().getRandomValues(bytes);
  return bytesToHex(bytes);
}

export async function deriveKeys(secret: string): Promise<{
  encKey: CryptoKey;
  authToken: Uint8Array;
}> {
  const baseKey = await importSecret(secret);
  const encoder = new TextEncoder();
  const cryptoApi = getCrypto();

  const [encKey, authBits] = await Promise.all([
    cryptoApi.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: HKDF_SALT,
        info: encoder.encode('voidshare-enc'),
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    ),
    cryptoApi.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: HKDF_SALT,
        info: encoder.encode('voidshare-auth'),
      },
      baseKey,
      256,
    ),
  ]);

  return { encKey, authToken: new Uint8Array(authBits) };
}

export function createChunkAad(
  fileId: string,
  chunkIndex: number,
  totalChunks: number,
): Uint8Array {
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > 0xffffffff) {
    throw new Error('chunkIndex must be an unsigned 32-bit integer');
  }

  if (!Number.isSafeInteger(totalChunks) || totalChunks < 1 || totalChunks > 0xffffffff) {
    throw new Error('totalChunks must be an unsigned 32-bit integer');
  }

  const fileIdBytes = new TextEncoder().encode(fileId);
  const aad = new Uint8Array(fileIdBytes.length + 8);
  aad.set(fileIdBytes);
  const view = new DataView(aad.buffer);
  view.setUint32(fileIdBytes.length, chunkIndex);
  view.setUint32(fileIdBytes.length + 4, totalChunks);
  return aad;
}

export async function encryptChunk(
  encKey: CryptoKey,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const iv = new Uint8Array(CHUNK_IV_BYTES);
  getCrypto().getRandomValues(iv);
  const encrypted = await getCrypto().subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv as BufferSource,
      additionalData: aad as BufferSource,
      tagLength: CHUNK_TAG_BITS,
    },
    encKey,
    plaintext as BufferSource,
  );
  const payload = new Uint8Array(CHUNK_IV_BYTES + encrypted.byteLength);
  payload.set(iv);
  payload.set(new Uint8Array(encrypted), CHUNK_IV_BYTES);
  return payload;
}

export async function decryptChunk(
  encKey: CryptoKey,
  payload: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  if (payload.byteLength < CHUNK_IV_BYTES + CHUNK_TAG_BITS / 8) {
    throw new Error('encrypted chunk is too short');
  }

  const iv = payload.slice(0, CHUNK_IV_BYTES);
  const ciphertext = payload.slice(CHUNK_IV_BYTES);
  const decrypted = await getCrypto().subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: iv as BufferSource,
      additionalData: aad as BufferSource,
      tagLength: CHUNK_TAG_BITS,
    },
    encKey,
    ciphertext as BufferSource,
  );
  return new Uint8Array(decrypted);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function deriveFilenameKey(secret: string): Promise<CryptoKey> {
  const baseKey = await importSecret(secret);
  return getCrypto().subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: HKDF_SALT,
      info: new TextEncoder().encode('voidshare-filename'),
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function sha256(buffer: Uint8Array): Promise<string> {
  const digest = await getCrypto().subtle.digest('SHA-256', buffer as BufferSource);
  return bytesToHex(new Uint8Array(digest));
}

export async function encryptFilename(filename: string, secret: string): Promise<string> {
  const key = await deriveFilenameKey(secret);
  const iv = new Uint8Array(CHUNK_IV_BYTES);
  getCrypto().getRandomValues(iv);
  const encrypted = await getCrypto().subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv as BufferSource,
      tagLength: CHUNK_TAG_BITS,
    },
    key,
    new TextEncoder().encode(filename) as BufferSource,
  );
  const payload = new Uint8Array(1 + CHUNK_IV_BYTES + encrypted.byteLength);
  payload[0] = FILENAME_ENVELOPE_VERSION;
  payload.set(iv, 1);
  payload.set(new Uint8Array(encrypted), 1 + CHUNK_IV_BYTES);
  return bytesToBase64(payload);
}

export async function decryptFilename(payload: string, secret: string): Promise<string> {
  const key = await deriveFilenameKey(secret);
  const bytes = base64ToBytes(payload);
  const minLength = 1 + CHUNK_IV_BYTES + CHUNK_TAG_BITS / 8;
  if (bytes.length < minLength || bytes[0] !== FILENAME_ENVELOPE_VERSION) {
    throw new Error('unsupported or invalid filename encryption envelope');
  }
  const iv = bytes.slice(1, 1 + CHUNK_IV_BYTES);
  const ciphertext = bytes.slice(1 + CHUNK_IV_BYTES);
  const decrypted = await getCrypto().subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: iv as BufferSource,
      tagLength: CHUNK_TAG_BITS,
    },
    key,
    ciphertext as BufferSource,
  );
  return new TextDecoder().decode(decrypted);
}
