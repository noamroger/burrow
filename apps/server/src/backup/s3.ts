import { AwsClient } from 'aws4fetch';

export interface S3Options {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  fetch?: typeof fetch;
}

export interface S3Object {
  key: string;
  size: number;
  lastModified: string;
}

/**
 * The four S3 calls backups need (PutObject, GetObject, DeleteObject,
 * ListObjectsV2), signed with SigV4 by aws4fetch. Works with AWS S3,
 * Cloudflare R2 (`https://<account>.r2.cloudflarestorage.com`, region `auto`),
 * MinIO, Backblaze B2 and other compatible stores.
 */
export class S3Storage {
  private readonly client: AwsClient;
  private readonly doFetch: typeof fetch;

  constructor(private readonly opts: S3Options) {
    this.client = new AwsClient({
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      service: 's3',
      region: opts.region,
      retries: 0,
    });
    this.doFetch = opts.fetch ?? fetch;
  }

  private url(key = ''): URL {
    const base = new URL(this.opts.endpoint);
    const path = key
      .split('/')
      .map((s) => encodeURIComponent(s))
      .join('/');
    if (this.opts.forcePathStyle) {
      const root = base.pathname.replace(/\/+$/, '');
      base.pathname = `${root}/${this.opts.bucket}/${path}`;
    } else {
      base.hostname = `${this.opts.bucket}.${base.hostname}`;
      base.pathname = `/${path}`;
    }
    return base;
  }

  private async send(url: URL, init: RequestInit = {}): Promise<Response> {
    const signed = await this.client.sign(url.toString(), init);
    const res = await this.doFetch(signed);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1];
      const message = /<Message>([^<]+)<\/Message>/.exec(body)?.[1];
      throw new Error(
        `S3 ${init.method ?? 'GET'} failed: HTTP ${res.status}${code ? ` ${code}` : ''}${message ? `: ${message}` : ''}`,
      );
    }
    return res;
  }

  async put(
    key: string,
    body: Uint8Array,
    contentType = 'application/octet-stream',
  ): Promise<void> {
    await this.send(this.url(key), {
      method: 'PUT',
      body: new Uint8Array(body),
      headers: { 'content-type': contentType },
    });
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.send(this.url(key));
    return Buffer.from(await res.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    await this.send(this.url(key), { method: 'DELETE' });
  }

  /** Every object under `prefix` (follows continuation tokens). */
  async list(prefix: string): Promise<S3Object[]> {
    const out: S3Object[] = [];
    let token: string | undefined;
    do {
      const url = this.url();
      url.searchParams.set('list-type', '2');
      if (prefix) url.searchParams.set('prefix', prefix);
      if (token) url.searchParams.set('continuation-token', token);
      const xml = await (await this.send(url)).text();
      for (const [, block] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const key = tag(block!, 'Key');
        if (!key) continue;
        out.push({
          key,
          size: Number(tag(block!, 'Size') ?? 0),
          lastModified: tag(block!, 'LastModified') ?? '',
        });
      }
      token = tag(xml, 'IsTruncated') === 'true' ? tag(xml, 'NextContinuationToken') : undefined;
    } while (token);
    return out;
  }
}

function tag(xml: string, name: string): string | undefined {
  const raw = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1];
  return raw === undefined ? undefined : unescapeXml(raw);
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
