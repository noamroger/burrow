/**
 * In-memory S3-compatible server for tests: path-style PutObject, GetObject,
 * DeleteObject and ListObjectsV2 on one bucket. Requests must carry a SigV4
 * `Authorization` header for the expected access key (the signature itself is
 * not verified).
 */
import { createServer, type Server } from 'node:http';

export class MockS3 {
  readonly objects = new Map<string, Buffer>();
  readonly requests: Array<{ method: string; path: string }> = [];
  /** Set to make every request fail with this HTTP status. */
  failWith: number | null = null;
  private server: Server | null = null;
  url = '';

  constructor(
    readonly bucket = 'backups',
    readonly accessKeyId = 'AKIDTEST',
  ) {}

  async listen(): Promise<string> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const method = req.method ?? 'GET';
        this.requests.push({ method, path: url.pathname });
        const auth = req.headers.authorization ?? '';
        const error = (status: number, code: string) => {
          res.writeHead(status, { 'content-type': 'application/xml' });
          res.end(
            `<?xml version="1.0"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`,
          );
        };
        if (this.failWith) return error(this.failWith, 'InternalError');
        if (!auth.startsWith(`AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/`)) {
          return error(403, 'InvalidAccessKeyId');
        }
        const [, bucket, ...rest] = url.pathname.split('/');
        if (bucket !== this.bucket) return error(404, 'NoSuchBucket');
        const key = rest.map(decodeURIComponent).join('/');
        if (method === 'GET' && !key && url.searchParams.get('list-type') === '2') {
          const prefix = url.searchParams.get('prefix') ?? '';
          const items = [...this.objects.entries()]
            .filter(([k]) => k.startsWith(prefix))
            .sort(([a], [b]) => a.localeCompare(b))
            .map(
              ([k, v]) =>
                `<Contents><Key>${k}</Key><Size>${v.length}</Size><LastModified>2026-11-19T00:00:00.000Z</LastModified></Contents>`,
            );
          res.writeHead(200, { 'content-type': 'application/xml' });
          return res.end(
            `<?xml version="1.0"?><ListBucketResult><Name>${bucket}</Name><IsTruncated>false</IsTruncated>${items.join('')}</ListBucketResult>`,
          );
        }
        if (method === 'PUT') {
          this.objects.set(key, Buffer.concat(chunks));
          res.writeHead(200);
          return res.end();
        }
        if (method === 'GET') {
          const obj = this.objects.get(key);
          if (!obj) return error(404, 'NoSuchKey');
          res.writeHead(200, { 'content-type': 'application/octet-stream' });
          return res.end(obj);
        }
        if (method === 'DELETE') {
          this.objects.delete(key);
          res.writeHead(204);
          return res.end();
        }
        return error(405, 'MethodNotAllowed');
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const addr = this.server.address();
    this.url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    return this.url;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }
}
