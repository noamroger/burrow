/**
 * Admin account security: two-factor authentication with TOTP codes, passkeys
 * (WebAuthn) and one-time recovery codes. Everything here is optional.
 */
import { z } from 'zod';

/** Ways to finish a sign-in once the password is checked. */
export const SECOND_FACTORS = ['totp', 'passkey', 'recovery'] as const;
export const secondFactorSchema = z.enum(SECOND_FACTORS);
export type SecondFactor = z.infer<typeof secondFactorSchema>;

/**
 * POST /api/auth/login, when the account has two-factor authentication:
 * no session yet, finish with POST /api/auth/login/verify (code) or the
 * passkey routes, passing `ticket`. The ticket is valid 5 minutes.
 */
export const mfaChallengeSchema = z.object({
  mfaRequired: z.literal(true),
  ticket: z.string(),
  methods: z.array(secondFactorSchema),
});
export type MfaChallenge = z.infer<typeof mfaChallengeSchema>;

/** A 6-digit code from the authenticator app, or a recovery code (`xxxxx-xxxxx`). */
export const twoFactorCodeSchema = z
  .string()
  .trim()
  .min(6, 'Enter the 6-digit code')
  .max(32)
  .transform((v) => v.replace(/\s+/g, '').toLowerCase());

/** POST /api/auth/login/verify (public, rate limited) -> 200 MeResponse */
export const verifyLoginSchema = z.object({
  ticket: z.string().min(1).max(128),
  code: twoFactorCodeSchema,
});
export type VerifyLoginInput = z.input<typeof verifyLoginSchema>;

/**
 * POST /api/auth/passkey/options (public) -> 200 PasskeyOptions.
 * With a `ticket`: second step after the password. Without: passwordless
 * sign-in with a passkey saved on this device.
 */
export const passkeyLoginOptionsInputSchema = z.object({
  ticket: z.string().min(1).max(128).optional(),
});
export type PasskeyLoginOptionsInput = z.infer<typeof passkeyLoginOptionsInputSchema>;

/** WebAuthn options for the browser (`navigator.credentials.*`), as JSON. */
export const passkeyOptionsSchema = z.object({
  /** Pass back with the browser's answer. */
  challengeId: z.string(),
  options: z.record(z.string(), z.unknown()),
});
export type PasskeyOptions = z.infer<typeof passkeyOptionsSchema>;

/** POST /api/auth/passkey/verify (public, rate limited) -> 200 MeResponse */
export const passkeyLoginVerifySchema = z.object({
  challengeId: z.string().min(1).max(128),
  response: z.record(z.string(), z.unknown()),
});
export type PasskeyLoginVerifyInput = z.infer<typeof passkeyLoginVerifySchema>;

export const passkeySchema = z.object({
  id: z.number().int(),
  name: z.string(),
  /** Synced by a password manager or the platform (iCloud Keychain, Google…). */
  backedUp: z.boolean(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});
export type Passkey = z.infer<typeof passkeySchema>;

/** GET /api/auth/2fa -> 200 (browser session only) */
export const twoFactorStatusSchema = z.object({
  totpEnabled: z.boolean(),
  passkeys: z.array(passkeySchema),
  /** Unused recovery codes left (0 when two-factor authentication is off). */
  recoveryCodesLeft: z.number().int(),
  /** True when a TOTP app or at least one passkey protects the account. */
  enabled: z.boolean(),
});
export type TwoFactorStatus = z.infer<typeof twoFactorStatusSchema>;

/** POST /api/auth/2fa/totp/setup -> 200: a new secret to scan, not active until confirmed. */
export const totpSetupSchema = z.object({
  secret: z.string(),
  /** `otpauth://` URI encoded in the QR code. */
  uri: z.string(),
  /** QR code as an SVG document. */
  qrSvg: z.string(),
});
export type TotpSetup = z.infer<typeof totpSetupSchema>;

/** POST /api/auth/2fa/totp/enable { code } -> 200 RecoveryCodes (when new codes were made) */
export const enableTotpSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit code'),
});
export type EnableTotpInput = z.infer<typeof enableTotpSchema>;

/** Shown once: Burrow stores only a hash of each code. Empty when existing codes were kept. */
export const recoveryCodesSchema = z.object({ recoveryCodes: z.array(z.string()) });
export type RecoveryCodes = z.infer<typeof recoveryCodesSchema>;

/**
 * Body of the routes that weaken or reset the protection (turn TOTP off,
 * remove a passkey, new recovery codes): the current password again.
 */
export const confirmPasswordSchema = z.object({ password: z.string().min(1).max(256) });
export type ConfirmPasswordInput = z.infer<typeof confirmPasswordSchema>;

/** POST /api/auth/2fa/passkeys { name, challengeId, response } -> 201 Passkey */
export const passkeyNameSchema = z.string().trim().min(1).max(64);
export const registerPasskeySchema = z.object({
  name: passkeyNameSchema,
  challengeId: z.string().min(1).max(128),
  response: z.record(z.string(), z.unknown()),
});
export type RegisterPasskeyInput = z.infer<typeof registerPasskeySchema>;

export const registeredPasskeySchema = z.object({
  passkey: passkeySchema,
  /** New recovery codes when this is the first second factor, else empty. */
  recoveryCodes: z.array(z.string()),
});
export type RegisteredPasskey = z.infer<typeof registeredPasskeySchema>;

/** PATCH /api/auth/2fa/passkeys/:id { name } -> 200 Passkey */
export const renamePasskeySchema = z.object({ name: passkeyNameSchema });
export type RenamePasskeyInput = z.infer<typeof renamePasskeySchema>;
