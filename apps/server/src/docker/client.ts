/**
 * Minimal read-only Docker Engine API client: Burrow only lists containers.
 *
 * Talks to a unix socket (`unix:///var/run/docker.sock`, mounted read-only)
 * or to a TCP endpoint such as a docker-socket-proxy
 * (`tcp://socket-proxy:2375`), which is the safer choice.
 */
import { request } from 'node:http';

/** The fields of `GET /containers/json` Burrow reads. */
export interface DockerContainer {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  Labels: Record<string, string> | null;
  Ports?: Array<{ PrivatePort: number; PublicPort?: number; Type: string }>;
  HostConfig?: { NetworkMode?: string };
  NetworkSettings?: {
    Networks?: Record<string, { IPAddress?: string } | null>;
  };
}

export interface DockerApi {
  /** Every container, running or not. */
  listContainers(): Promise<DockerContainer[]>;
}

/** Docker API version requested (supported by Docker Engine 20.10 and later). */
const API_VERSION = 'v1.41';

export class DockerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DockerError';
  }
}

/** Parse `unix:///path`, `/path`, `tcp://host:port` or `http://host:port`. */
export function parseDockerHost(
  value: string,
): { socketPath: string } | { host: string; port: number } {
  const v = value.trim();
  if (v.startsWith('unix://')) return { socketPath: v.slice('unix://'.length) };
  if (v.startsWith('/')) return { socketPath: v };
  const m = /^(?:tcp|http):\/\/([^:/]+)(?::(\d+))?\/?$/.exec(v);
  if (m) return { host: m[1]!, port: m[2] ? Number(m[2]) : 2375 };
  throw new DockerError(
    `Unsupported DOCKER_HOST "${value}". Use unix:///var/run/docker.sock or tcp://host:2375.`,
  );
}

export class DockerClient implements DockerApi {
  private readonly target: ReturnType<typeof parseDockerHost>;

  constructor(
    readonly endpoint: string,
    private readonly timeoutMs = 5_000,
  ) {
    this.target = parseDockerHost(endpoint);
  }

  listContainers(): Promise<DockerContainer[]> {
    return this.get<DockerContainer[]>(`/${API_VERSION}/containers/json?all=1`);
  }

  private get<T>(path: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const req = request(
        {
          ...('socketPath' in this.target
            ? { socketPath: this.target.socketPath }
            : { host: this.target.host, port: this.target.port }),
          path,
          method: 'GET',
          headers: { host: 'docker', accept: 'application/json' },
          timeout: this.timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            if ((res.statusCode ?? 500) >= 400) {
              let message = body.slice(0, 200);
              try {
                message = (JSON.parse(body) as { message?: string }).message ?? message;
              } catch {
                // not JSON
              }
              reject(new DockerError(`Docker API error ${res.statusCode}: ${message}`));
              return;
            }
            try {
              resolve(JSON.parse(body) as T);
            } catch {
              reject(new DockerError('Docker API returned invalid JSON'));
            }
          });
        },
      );
      req.on('timeout', () => req.destroy(new DockerError('Docker API timed out')));
      req.on('error', (err: NodeJS.ErrnoException) =>
        reject(new DockerError(describe(err, this.endpoint))),
      );
      req.end();
    });
  }
}

function describe(err: NodeJS.ErrnoException, endpoint: string): string {
  switch (err.code) {
    case 'ENOENT':
      return `No Docker socket at ${endpoint}. Mount it with -v /var/run/docker.sock:/var/run/docker.sock:ro.`;
    case 'EACCES':
      return `Permission denied on ${endpoint}. The Burrow user must be in the socket's group (see the README), or use a docker-socket-proxy.`;
    case 'ECONNREFUSED':
      return `Connection refused by ${endpoint}.`;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `Cannot resolve ${endpoint}.`;
    default:
      return err.message;
  }
}
