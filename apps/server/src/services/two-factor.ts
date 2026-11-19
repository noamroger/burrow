import type { Passkey, SecondFactor, TotpSetup, TwoFactorStatus } from '@burrow/shared';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { and, eq } from 'drizzle-orm';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import QRCode from 'qrcode';
import type { Db } from '../db/client.js';
import { passkeys, users, type PasskeyRow, type UserRow } from '../db/schema.js';
import { AppError, errors } from '../lib/errors.js';
import type { SecretBox } from '../lib/secretbox.js';
import { nowIso } from '../lib/time.js';
import { generateTotpSecret, totpUri, verifyTotp } from '../lib/totp.js';

/** How long a half-finished sign-in (password checked) stays valid. */
const TICKET_TTL_MS = 5 * 60 * 1000;
/** Wrong codes allowed per ticket before the password must be entered again. */
const TICKET_MAX_ATTEMPTS = 5;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const TOTP_SETUP_TTL_MS = 15 * 60 * 1000;
const RECOVERY_CODE_COUNT = 10;
/** No 0/o, 1/l/i: easy to read back from paper. */
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const randomId = () => randomBytes(24).toString('base64url');

/** Where the browser talks to Burrow from: passkeys are bound to this host name. */
export interface WebAuthnOrigin {
  rpId: string;
  /** Accepted origins, e.g. `https://burrow.example.com`. */
  origins: string[];
}

interface Ticket {
  userId: number;
  expiresAt: number;
  attempts: number;
}

interface Challenge {
  kind: 'register' | 'login';
  challenge: string;
  rpId: string;
  /** Registration: the user adding a passkey. Login: set when it follows a password. */
  userId: number | null;
  ticket: string | null;
  expiresAt: number;
}

export interface TwoFactorServiceOptions {
  db: Db;
  box: SecretBox;
  /** Shown by authenticator apps and passkey prompts. */
  issuer?: string;
}

/** Format `abcde-fghjk`. */
function newRecoveryCode(): string {
  let code = '';
  for (let i = 0; i < 10; i++) code += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/** Recovery codes are compared without the dash and case. */
const normalizeRecovery = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Optional second factor for the admin: an authenticator app (TOTP), passkeys
 * (WebAuthn), and one-time recovery codes for when both are out of reach.
 *
 * Sign-in with a second factor is two steps: the password gives a short-lived
 * ticket (in memory), the code or the passkey turns it into a session. A
 * passkey can also sign in on its own (passwordless), since it already proves
 * both possession and the user's PIN or biometrics.
 */
export class TwoFactorService {
  private readonly tickets = new Map<string, Ticket>();
  private readonly challenges = new Map<string, Challenge>();
  private readonly pendingTotp = new Map<number, { secret: string; expiresAt: number }>();

  constructor(private readonly opts: TwoFactorServiceOptions) {}

  private get issuer(): string {
    return this.opts.issuer ?? 'Burrow';
  }

  private user(userId: number): UserRow {
    const row = this.opts.db.select().from(users).where(eq(users.id, userId)).get();
    if (!row) throw errors.unauthorized();
    return row;
  }

  private passkeyRows(userId: number): PasskeyRow[] {
    return this.opts.db.select().from(passkeys).where(eq(passkeys.userId, userId)).all();
  }

  private toApi(row: PasskeyRow): Passkey {
    return {
      id: row.id,
      name: row.name,
      backedUp: row.backedUp,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
    };
  }

  /** Purge expired tickets, challenges and unconfirmed TOTP secrets. */
  private sweep(now = Date.now()): void {
    for (const [k, v] of this.tickets) if (v.expiresAt <= now) this.tickets.delete(k);
    for (const [k, v] of this.challenges) if (v.expiresAt <= now) this.challenges.delete(k);
    for (const [k, v] of this.pendingTotp) if (v.expiresAt <= now) this.pendingTotp.delete(k);
  }

  /* ----------------------------- status ----------------------------- */

  /** Second factors the user can sign in with (empty = password only). */
  methods(userId: number): SecondFactor[] {
    const user = this.user(userId);
    const hasPasskeys = this.passkeyRows(userId).length > 0;
    const methods: SecondFactor[] = [];
    if (user.totpSecretEnc) methods.push('totp');
    if (hasPasskeys) methods.push('passkey');
    if (methods.length > 0 && user.recoveryCodes.length > 0) methods.push('recovery');
    return methods;
  }

  isEnabled(userId: number): boolean {
    const user = this.user(userId);
    return user.totpSecretEnc !== null || this.passkeyRows(userId).length > 0;
  }

  status(userId: number): TwoFactorStatus {
    const user = this.user(userId);
    const list = this.passkeyRows(userId).map((r) => this.toApi(r));
    const enabled = user.totpSecretEnc !== null || list.length > 0;
    return {
      totpEnabled: user.totpSecretEnc !== null,
      passkeys: list,
      recoveryCodesLeft: enabled ? user.recoveryCodes.length : 0,
      enabled,
    };
  }

  /* ------------------------------ TOTP ------------------------------ */

  /** A new secret to scan. It only protects the account once a code is confirmed. */
  async startTotpSetup(userId: number): Promise<TotpSetup> {
    this.sweep();
    const user = this.user(userId);
    if (user.totpSecretEnc) {
      throw errors.conflict('An authenticator app is already set up. Turn it off first.');
    }
    const secret = generateTotpSecret();
    this.pendingTotp.set(userId, { secret, expiresAt: Date.now() + TOTP_SETUP_TTL_MS });
    const uri = totpUri(secret, user.email, this.issuer);
    const qrSvg = await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    return { secret, uri, qrSvg };
  }

  /**
   * Confirm the app with a code and turn TOTP on. Returns new recovery codes
   * when the account had none (first second factor), else an empty list.
   */
  enableTotp(userId: number, code: string): string[] {
    this.sweep();
    const pending = this.pendingTotp.get(userId);
    if (!pending) {
      throw new AppError('MFA_EXPIRED', 'The setup expired. Start again.', 400);
    }
    const step = verifyTotp(pending.secret, code);
    if (step === null) {
      throw errors.validation('This code is not valid. Check the time on your phone.');
    }
    this.pendingTotp.delete(userId);
    const codes = this.user(userId).recoveryCodes.length === 0 ? this.newRecoveryCodes() : null;
    this.opts.db
      .update(users)
      .set({
        totpSecretEnc: this.opts.box.encrypt(pending.secret),
        totpLastStep: step,
        ...(codes ? { recoveryCodes: codes.hashes } : {}),
      })
      .where(eq(users.id, userId))
      .run();
    return codes?.plain ?? [];
  }

  /** Turn TOTP off. Recovery codes go too when no passkey is left. */
  disableTotp(userId: number): void {
    this.opts.db
      .update(users)
      .set({ totpSecretEnc: null, totpLastStep: null })
      .where(eq(users.id, userId))
      .run();
    this.dropRecoveryIfUnused(userId);
  }

  /* ------------------------- recovery codes ------------------------- */

  private newRecoveryCodes(): { plain: string[]; hashes: string[] } {
    const plain = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    return { plain, hashes: plain.map((c) => sha256(normalizeRecovery(c))) };
  }

  /** Replace the recovery codes (the old ones stop working). */
  regenerateRecoveryCodes(userId: number): string[] {
    if (!this.isEnabled(userId)) {
      throw errors.conflict('Turn on an authenticator app or add a passkey first.');
    }
    const codes = this.newRecoveryCodes();
    this.opts.db
      .update(users)
      .set({ recoveryCodes: codes.hashes })
      .where(eq(users.id, userId))
      .run();
    return codes.plain;
  }

  private dropRecoveryIfUnused(userId: number): void {
    if (!this.isEnabled(userId)) {
      this.opts.db.update(users).set({ recoveryCodes: [] }).where(eq(users.id, userId)).run();
    }
  }

  /** Remove every second factor (password reset script, lockout recovery). */
  resetAll(userId: number): void {
    this.opts.db.delete(passkeys).where(eq(passkeys.userId, userId)).run();
    this.opts.db
      .update(users)
      .set({ totpSecretEnc: null, totpLastStep: null, recoveryCodes: [] })
      .where(eq(users.id, userId))
      .run();
    this.pendingTotp.delete(userId);
  }

  /* ------------------------- sign-in tickets ------------------------ */

  /** After a correct password: a ticket to finish the sign-in with a second factor. */
  createTicket(userId: number): string {
    this.sweep();
    const ticket = randomId();
    this.tickets.set(ticket, { userId, expiresAt: Date.now() + TICKET_TTL_MS, attempts: 0 });
    return ticket;
  }

  private ticket(value: string): Ticket {
    const ticket = this.tickets.get(value);
    if (!ticket || ticket.expiresAt <= Date.now()) {
      this.tickets.delete(value);
      throw new AppError('MFA_EXPIRED', 'The sign-in expired. Enter your password again.', 401);
    }
    return ticket;
  }

  /**
   * Finish a sign-in with a TOTP code or a recovery code. Returns the user id
   * and the method used. A used recovery code is deleted.
   */
  verifyTicketCode(ticketValue: string, code: string): { userId: number; method: SecondFactor } {
    const ticket = this.ticket(ticketValue);
    const user = this.user(ticket.userId);
    const fail = (): never => {
      ticket.attempts += 1;
      if (ticket.attempts >= TICKET_MAX_ATTEMPTS) {
        this.tickets.delete(ticketValue);
        throw new AppError('MFA_EXPIRED', 'Too many wrong codes. Enter your password again.', 401);
      }
      throw errors.unauthorized('This code is not valid.');
    };

    if (/^\d{6}$/.test(code)) {
      if (!user.totpSecretEnc) return fail();
      const secret = this.opts.box.decrypt(user.totpSecretEnc);
      const step = verifyTotp(secret, code, { notAfter: user.totpLastStep });
      if (step === null) return fail();
      this.opts.db.update(users).set({ totpLastStep: step }).where(eq(users.id, user.id)).run();
      this.tickets.delete(ticketValue);
      return { userId: user.id, method: 'totp' };
    }

    const hash = sha256(normalizeRecovery(code));
    if (!user.recoveryCodes.includes(hash)) return fail();
    this.opts.db
      .update(users)
      .set({ recoveryCodes: user.recoveryCodes.filter((h) => h !== hash) })
      .where(eq(users.id, user.id))
      .run();
    this.tickets.delete(ticketValue);
    return { userId: user.id, method: 'recovery' };
  }

  /* ----------------------------- passkeys --------------------------- */

  /** WebAuthn options to create a passkey for the signed-in user. */
  async registrationOptions(
    userId: number,
    origin: WebAuthnOrigin,
  ): Promise<{ challengeId: string; options: Record<string, unknown> }> {
    this.sweep();
    const user = this.user(userId);
    const existing = this.passkeyRows(userId).filter((p) => p.rpId === origin.rpId);
    const options = await generateRegistrationOptions({
      rpName: this.issuer,
      rpID: origin.rpId,
      userName: user.email,
      userID: new TextEncoder().encode(`burrow-user-${user.id}`),
      attestationType: 'none',
      excludeCredentials: existing.map((p) => ({ id: p.credentialId, transports: p.transports })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    });
    const challengeId = randomId();
    this.challenges.set(challengeId, {
      kind: 'register',
      challenge: options.challenge,
      rpId: origin.rpId,
      userId,
      ticket: null,
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
    });
    return { challengeId, options: options as unknown as Record<string, unknown> };
  }

  private takeChallenge(id: string, kind: Challenge['kind']): Challenge {
    const challenge = this.challenges.get(id);
    this.challenges.delete(id);
    if (!challenge || challenge.kind !== kind || challenge.expiresAt <= Date.now()) {
      throw new AppError('MFA_EXPIRED', 'The passkey request expired. Try again.', 400);
    }
    return challenge;
  }

  /** Save a new passkey from the browser's answer. Returns it and fresh recovery codes if needed. */
  async register(
    userId: number,
    name: string,
    challengeId: string,
    response: unknown,
    origin: WebAuthnOrigin,
  ): Promise<{ passkey: Passkey; recoveryCodes: string[] }> {
    const challenge = this.takeChallenge(challengeId, 'register');
    if (challenge.userId !== userId) throw errors.unauthorized();
    let info;
    try {
      const result = await verifyRegistrationResponse({
        response: response as RegistrationResponseJSON,
        expectedChallenge: challenge.challenge,
        expectedOrigin: origin.origins,
        expectedRPID: challenge.rpId,
        requireUserVerification: false,
      });
      if (!result.verified) throw new Error('not verified');
      info = result.registrationInfo;
    } catch (err) {
      throw errors.validation(
        `The passkey could not be verified: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const clash = this.opts.db
      .select({ id: passkeys.id })
      .from(passkeys)
      .where(eq(passkeys.credentialId, info.credential.id))
      .get();
    if (clash) throw errors.conflict('This passkey is already registered.');

    const needCodes = !this.isEnabled(userId) && this.user(userId).recoveryCodes.length === 0;
    const row = this.opts.db
      .insert(passkeys)
      .values({
        userId,
        name,
        credentialId: info.credential.id,
        publicKey: isoBase64URL.fromBuffer(info.credential.publicKey),
        counter: info.credential.counter,
        transports: info.credential.transports ?? [],
        rpId: challenge.rpId,
        backedUp: info.credentialBackedUp,
      })
      .returning()
      .get();
    let recoveryCodes: string[] = [];
    if (needCodes) {
      const codes = this.newRecoveryCodes();
      this.opts.db
        .update(users)
        .set({ recoveryCodes: codes.hashes })
        .where(eq(users.id, userId))
        .run();
      recoveryCodes = codes.plain;
    }
    return { passkey: this.toApi(row), recoveryCodes };
  }

  rename(userId: number, id: number, name: string): Passkey {
    const row = this.opts.db
      .update(passkeys)
      .set({ name })
      .where(and(eq(passkeys.id, id), eq(passkeys.userId, userId)))
      .returning()
      .get();
    if (!row) throw errors.notFound('Passkey');
    return this.toApi(row);
  }

  /** Delete a passkey. Returns its name (for the audit log). */
  removePasskey(userId: number, id: number): string {
    const row = this.opts.db
      .delete(passkeys)
      .where(and(eq(passkeys.id, id), eq(passkeys.userId, userId)))
      .returning()
      .get();
    if (!row) throw errors.notFound('Passkey');
    this.dropRecoveryIfUnused(userId);
    return row.name;
  }

  /**
   * WebAuthn options to sign in. With a ticket (password already checked),
   * only that user's passkeys are allowed; without, the browser offers the
   * passkeys it has for this site (passwordless).
   */
  async loginOptions(
    origin: WebAuthnOrigin,
    ticketValue?: string,
  ): Promise<{ challengeId: string; options: Record<string, unknown> }> {
    this.sweep();
    let userId: number | null = null;
    let allow: PasskeyRow[] = [];
    if (ticketValue) {
      userId = this.ticket(ticketValue).userId;
      allow = this.passkeyRows(userId).filter((p) => p.rpId === origin.rpId);
      if (allow.length === 0) {
        throw errors.validation(
          `No passkey was registered for ${origin.rpId}. Passkeys only work on the address they were created on.`,
        );
      }
    }
    const options = await generateAuthenticationOptions({
      rpID: origin.rpId,
      allowCredentials: allow.map((p) => ({ id: p.credentialId, transports: p.transports })),
      userVerification: ticketValue ? 'preferred' : 'required',
    });
    const challengeId = randomId();
    this.challenges.set(challengeId, {
      kind: 'login',
      challenge: options.challenge,
      rpId: origin.rpId,
      userId,
      ticket: ticketValue ?? null,
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
    });
    return { challengeId, options: options as unknown as Record<string, unknown> };
  }

  /** Check the browser's passkey assertion. Returns the user to sign in. */
  async verifyLogin(
    challengeId: string,
    response: unknown,
    origin: WebAuthnOrigin,
  ): Promise<number> {
    const challenge = this.takeChallenge(challengeId, 'login');
    const body = response as AuthenticationResponseJSON;
    const credentialId = typeof body?.id === 'string' ? body.id : '';
    const row = this.opts.db
      .select()
      .from(passkeys)
      .where(eq(passkeys.credentialId, credentialId))
      .get();
    const invalid = () => errors.unauthorized('This passkey is not registered in Burrow.');
    if (!row || row.rpId !== challenge.rpId) throw invalid();
    if (challenge.userId !== null && row.userId !== challenge.userId) throw invalid();

    let result;
    try {
      result = await verifyAuthenticationResponse({
        response: body,
        expectedChallenge: challenge.challenge,
        expectedOrigin: origin.origins,
        expectedRPID: challenge.rpId,
        credential: {
          id: row.credentialId,
          publicKey: isoBase64URL.toBuffer(row.publicKey),
          counter: row.counter,
          transports: row.transports,
        },
        // Passwordless sign-in must prove the user (PIN, biometrics), not just presence.
        requireUserVerification: challenge.userId === null,
      });
    } catch {
      throw errors.unauthorized('The passkey could not be verified.');
    }
    if (!result.verified) throw errors.unauthorized('The passkey could not be verified.');
    if (challenge.ticket) this.tickets.delete(challenge.ticket);
    this.opts.db
      .update(passkeys)
      .set({
        counter: result.authenticationInfo.newCounter,
        backedUp: result.authenticationInfo.credentialBackedUp,
        lastUsedAt: nowIso(),
      })
      .where(eq(passkeys.id, row.id))
      .run();
    return row.userId;
  }
}
