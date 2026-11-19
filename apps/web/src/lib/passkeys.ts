/**
 * Browser side of passkeys (WebAuthn). Browsers only allow them in a secure
 * context: HTTPS, or http://localhost. Burrow opened on http://192.168.x.x
 * cannot use passkeys; the UI explains why instead of failing.
 */
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  WebAuthnError,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { t } from '../i18n';

export type PasskeySupport = 'ok' | 'insecure' | 'unsupported';

export function passkeySupport(): PasskeySupport {
  if (typeof window === 'undefined') return 'unsupported';
  if (!window.isSecureContext) return 'insecure';
  return browserSupportsWebAuthn() ? 'ok' : 'unsupported';
}

export function createPasskey(options: Record<string, unknown>) {
  return startRegistration({
    optionsJSON: options as unknown as PublicKeyCredentialCreationOptionsJSON,
  });
}

export function getPasskey(options: Record<string, unknown>) {
  return startAuthentication({
    optionsJSON: options as unknown as PublicKeyCredentialRequestOptionsJSON,
  });
}

/** The user closed the browser prompt: not an error worth showing. */
export function isPasskeyCancelled(error: unknown): boolean {
  return (
    (error instanceof WebAuthnError && error.code === 'ERROR_CEREMONY_ABORTED') ||
    (error instanceof Error && error.name === 'NotAllowedError')
  );
}

/** A readable message for a failed browser prompt. */
export function passkeyErrorMessage(error: unknown): string {
  if (
    error instanceof WebAuthnError &&
    error.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED'
  ) {
    return t('security.passkeyAlreadyRegistered');
  }
  if (error instanceof Error && error.message) return error.message;
  return t('errors.unknown');
}
