import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { link, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Object storage port (S3 / Azure Blob / GCS). The only operations ingestion needs:
 * streamed writes, ranged streamed reads, and small whole-object reads/writes.
 */
export class BlobExistsError extends Error {
  constructor(key: string) {
    super(`blob already exists: ${key}`);
  }
}

export interface BlobStore {
  /** `ifAbsent`: create-only (S3 / Azure `If-None-Match: *`); throws BlobExistsError. */
  putStream(key: string, body: Readable, opts?: { ifAbsent?: boolean }): Promise<number>;
  put(key: string, body: string | Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** Streams the object starting at byte `start` (S3: Range: bytes=start-). */
  getStream(key: string, start?: number): Readable;
  size(key: string): Promise<number>;
  /** Presigned PUT URL. In the cloud the client uploads directly to storage. */
  presignPut(key: string, ttlSeconds: number): string;
}

/** Local-disk stand-in. The upload route verifies the same signature an S3 presign would carry. */
export class LocalBlobStore implements BlobStore {
  constructor(
    private readonly rootDir: string,
    private readonly publicBaseUrl: string,
    private readonly signingSecret: string,
  ) {}

  private path(key: string): string {
    const p = normalize(join(this.rootDir, key));
    if (!p.startsWith(normalize(this.rootDir))) throw new Error('invalid blob key');
    return p;
  }

  async putStream(key: string, body: Readable, opts: { ifAbsent?: boolean } = {}): Promise<number> {
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.${randomUUID()}.part`;
    await pipeline(body, createWriteStream(tmp));
    if (opts.ifAbsent) {
      // link() fails with EEXIST instead of replacing: atomic create-only publish.
      try {
        await link(tmp, target);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new BlobExistsError(key);
        throw err;
      } finally {
        await unlink(tmp);
      }
    } else {
      await rename(tmp, target); // atomic publish: readers never see a half-written file
    }
    return (await stat(target)).size;
  }

  async put(key: string, body: string | Buffer): Promise<void> {
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(`${target}.part`, body);
    await rename(`${target}.part`, target);
  }

  get(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }

  getStream(key: string, start = 0): Readable {
    return createReadStream(this.path(key), { start, highWaterMark: 64 * 1024 });
  }

  async size(key: string): Promise<number> {
    return (await stat(this.path(key))).size;
  }

  presignPut(key: string, ttlSeconds: number): string {
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    const sig = this.sign(key, expires);
    const qs = new URLSearchParams({ key, expires: String(expires), sig });
    return `${this.publicBaseUrl}/blob-upload?${qs.toString()}`;
  }

  verify(key: string, expires: number, sig: string): boolean {
    if (!Number.isFinite(expires) || expires < Date.now() / 1000) return false;
    const expected = Buffer.from(this.sign(key, expires));
    const given = Buffer.from(sig);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  private sign(key: string, expires: number): string {
    return createHmac('sha256', this.signingSecret).update(`${key}\n${expires}`).digest('hex');
  }
}
