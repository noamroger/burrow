/**
 * A light password strength estimate for the setup hint. This is guidance
 * only: the real rule (min 12 characters) lives in the shared zod schema.
 */
export type Strength = 0 | 1 | 2 | 3 | 4;

export function passwordStrength(password: string): Strength {
  if (!password) return 0;
  let score = 0;
  if (password.length >= 12) score++;
  if (password.length >= 16) score++;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  if (classes >= 3) score++;
  if (classes === 4 || password.length >= 24) score++;
  // Penalise repeated characters such as "aaaaaaaaaaaa".
  if (/^(.)\1+$/.test(password)) score = 0;
  if (password.length < 12) score = Math.min(score, 1);
  return Math.min(score, 4) as Strength;
}
