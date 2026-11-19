/**
 * A software WebAuthn authenticator for tests: creates an ES256 key pair,
 * answers registration ("none" attestation) and authentication requests like
 * a browser + security key would.
 */
import { isoBase64URL, isoCBOR } from '@simplewebauthn/server/helpers';
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest();

export class SoftAuthenticator {
  readonly credentialId = randomBytes(16);
  private readonly privateKey: KeyObject;
  private readonly jwk: { x: string; y: string };
  private counter = 0;

  constructor(private readonly origin: string) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = privateKey;
    this.jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  }

  get id(): string {
    return isoBase64URL.fromBuffer(new Uint8Array(this.credentialId));
  }

  private clientData(type: string, challenge: string, origin = this.origin): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  private authData(rpId: string, flags: number, attested?: Buffer): Buffer {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.counter);
    return Buffer.concat([sha256(rpId), Buffer.from([flags]), count, attested ?? Buffer.alloc(0)]);
  }

  /** Answer `navigator.credentials.create()` options. */
  register(options: { challenge: string; rp: { id: string } }, origin?: string) {
    const cose = new Map<number, number | Uint8Array>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, Buffer.from(this.jwk.x, 'base64url')],
      [-3, Buffer.from(this.jwk.y, 'base64url')],
    ]);
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(this.credentialId.length);
    const attested = Buffer.concat([
      Buffer.alloc(16),
      idLen,
      this.credentialId,
      Buffer.from(isoCBOR.encode(cose)),
    ]);
    // UP + UV + AT
    const authData = this.authData(options.rp.id, 0x01 | 0x04 | 0x40, attested);
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', new Uint8Array(authData)],
      ]) as never,
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: isoBase64URL.fromBuffer(
          new Uint8Array(this.clientData('webauthn.create', options.challenge, origin)),
        ),
        attestationObject: isoBase64URL.fromBuffer(new Uint8Array(attestationObject)),
        transports: ['usb'],
      },
    };
  }

  /** Answer `navigator.credentials.get()` options. */
  authenticate(options: { challenge: string; rpId: string }, userVerified = true) {
    this.counter += 1;
    const authData = this.authData(options.rpId, 0x01 | (userVerified ? 0x04 : 0));
    const clientDataJSON = this.clientData('webauthn.get', options.challenge);
    const signature = sign(
      'sha256',
      Buffer.concat([authData, sha256(clientDataJSON)]),
      this.privateKey,
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: isoBase64URL.fromBuffer(new Uint8Array(clientDataJSON)),
        authenticatorData: isoBase64URL.fromBuffer(new Uint8Array(authData)),
        signature: isoBase64URL.fromBuffer(new Uint8Array(signature)),
      },
    };
  }
}
