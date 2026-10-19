import { describe, expect, it } from 'vitest';
import {
  createChunkAad,
  decryptChunk,
  deriveKeys,
  encryptChunk,
  decryptFilename,
  encryptFilename,
  generateSecret,
  sha256,
} from './crypto.js';

describe('secret generation and key derivation', () => {
  it('generates a 32-byte secret encoded as 64 lowercase hex characters', () => {
    const secret = generateSecret();

    expect(secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it('derives an AES-256 encryption key and a separate 32-byte auth token', async () => {
    const { encKey, authToken } = await deriveKeys(
      '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
    );

    expect(encKey.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    expect(encKey.usages).toEqual(expect.arrayContaining(['decrypt', 'encrypt']));
    expect(authToken).toBeInstanceOf(Uint8Array);
    expect(authToken).toHaveLength(32);

    expect(encKey.extractable).toBe(false);

    const secondDerivation = await deriveKeys(
      '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
    );
    expect(secondDerivation.authToken).toEqual(authToken);
  });

  it('rejects malformed secrets', async () => {
    await expect(deriveKeys('not-a-secret')).rejects.toThrow(
      'secret must be exactly 32 bytes encoded as hex',
    );
  });

  it('constructs AAD from the file ID and unsigned chunk metadata', () => {
    const aad = createChunkAad('file-123', 2, 10);

    expect(new TextDecoder().decode(aad.slice(0, 8))).toBe('file-123');
    expect(new DataView(aad.buffer).getUint32(8)).toBe(2);
    expect(new DataView(aad.buffer).getUint32(12)).toBe(10);
  });

  it('encrypts and decrypts a chunk with an IV prefix', async () => {
    const { encKey } = await deriveKeys(
      '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
    );
    const plaintext = new TextEncoder().encode('ciphertext only');
    const aad = createChunkAad('file-123', 0, 1);

    const ciphertext = await encryptChunk(encKey, plaintext, aad);
    const decrypted = await decryptChunk(encKey, ciphertext, aad);

    expect(ciphertext).toHaveLength(plaintext.length + 12 + 16);
    expect(decrypted).toEqual(plaintext);
  });

  it('rejects a ciphertext byte that was tampered with', async () => {
    const { encKey } = await deriveKeys(
      '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
    );
    const aad = createChunkAad('file-123', 0, 1);
    const ciphertext = await encryptChunk(
      encKey,
      new TextEncoder().encode('tamper me'),
      aad,
    );
    ciphertext[ciphertext.length - 1] ^= 1;

    await expect(decryptChunk(encKey, ciphertext, aad)).rejects.toThrow();
  });

  it('rejects a chunk decrypted with a different index AAD', async () => {
    const { encKey } = await deriveKeys(
      '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
    );
    const ciphertext = await encryptChunk(
      encKey,
      new TextEncoder().encode('ordered chunk'),
      createChunkAad('file-123', 0, 2),
    );

    await expect(
      decryptChunk(encKey, ciphertext, createChunkAad('file-123', 1, 2)),
    ).rejects.toThrow();
  });

  it('rejects a ciphertext decrypted with a different key', async () => {
    const { encKey } = await deriveKeys(
      '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
    );
    const { encKey: wrongKey } = await deriveKeys(
      '1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100',
    );
    const aad = createChunkAad('file-123', 0, 1);
    const ciphertext = await encryptChunk(encKey, new Uint8Array([1, 2, 3]), aad);

    await expect(decryptChunk(wrongKey, ciphertext, aad)).rejects.toThrow();
  });

  it('computes a standard SHA-256 digest', async () => {
    const digest = await sha256(new TextEncoder().encode('hello'));

    expect(digest).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });

  it('encrypts and decrypts a filename without returning plaintext', async () => {
    const secret = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
    const encrypted = await encryptFilename('private-report.pdf', secret);

    expect(encrypted).not.toContain('private-report.pdf');
    await expect(decryptFilename(encrypted, secret)).resolves.toBe('private-report.pdf');
  });

  it('rejects a filename encrypted with another secret', async () => {
    const encrypted = await encryptFilename(
      'private-report.pdf',
      '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
    );

    await expect(
      decryptFilename(
        encrypted,
        '1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100',
      ),
    ).rejects.toThrow();
  });

  it('generates unique IVs and distinct ciphertexts across repeated encryptions', async () => {
    const secret = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
    const filename = 'sensitive-data.csv';

    const enc1 = await encryptFilename(filename, secret);
    const enc2 = await encryptFilename(filename, secret);

    expect(enc1).not.toBe(enc2);

    const bytes1 = Uint8Array.from(atob(enc1), (c) => c.charCodeAt(0));
    const bytes2 = Uint8Array.from(atob(enc2), (c) => c.charCodeAt(0));

    // Envelope version byte 0x01
    expect(bytes1[0]).toBe(1);
    expect(bytes2[0]).toBe(1);

    // IV is bytes 1..12
    const iv1 = bytes1.slice(1, 13);
    const iv2 = bytes2.slice(1, 13);
    expect(iv1).not.toEqual(iv2);

    await expect(decryptFilename(enc1, secret)).resolves.toBe(filename);
    await expect(decryptFilename(enc2, secret)).resolves.toBe(filename);
  });

  it('rejects a tampered encrypted filename', async () => {
    const secret = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
    const encrypted = await encryptFilename('document.docx', secret);
    const bytes = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));

    // Tamper with ciphertext byte
    bytes[bytes.length - 1] ^= 0x01;
    const tampered = btoa(String.fromCharCode(...bytes));

    await expect(decryptFilename(tampered, secret)).rejects.toThrow();
  });

  it('rejects an invalid envelope version or truncated payload', async () => {
    const secret = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
    const encrypted = await encryptFilename('doc.txt', secret);
    const bytes = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));

    // Tamper with envelope version byte (set to 2)
    bytes[0] = 2;
    const invalidVersion = btoa(String.fromCharCode(...bytes));
    await expect(decryptFilename(invalidVersion, secret)).rejects.toThrow(
      'unsupported or invalid filename encryption envelope',
    );

    // Payload too short (< 29 bytes)
    const tooShort = btoa(String.fromCharCode(...bytes.slice(0, 20)));
    await expect(decryptFilename(tooShort, secret)).rejects.toThrow(
      'unsupported or invalid filename encryption envelope',
    );
  });
});

