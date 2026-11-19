/**
 * `burrow-reset-password`: set a new admin password from inside the
 * container, for when the password (or the second factor) is lost.
 *
 *   docker exec -it burrow burrow-reset-password
 *   docker exec -it burrow burrow-reset-password --generate --disable-2fa
 *   echo 'new password' | docker exec -i burrow burrow-reset-password --password-stdin
 *
 * Anyone who can run `docker exec` already controls the container and its
 * data, so this does not weaken Burrow: it only saves a lost admin from
 * deleting the database. Every session is signed out and the reset is written
 * to the audit log.
 */
import { passwordSchema } from '@burrow/shared';
import { eq } from 'drizzle-orm';
import { randomInt } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/client.js';
import { users } from '../db/schema.js';
import { SecretBox } from '../lib/secretbox.js';
import { AuditService } from '../services/audit.js';
import { AuthService } from '../services/auth.js';
import { TwoFactorService } from '../services/two-factor.js';

export const USAGE = `Usage: burrow-reset-password [options]

Set a new password for the Burrow admin account and sign out every session.
Without options, asks for the new password (run with docker exec -it).

Options:
  --generate         Generate a strong random password and print it
  --password-stdin   Read the new password from standard input
  --disable-2fa      Also turn off two-step verification (authenticator app,
                     passkeys and recovery codes), for a lost phone or key
  --keep-2fa         Keep two-step verification without asking
  --email <address>  Account to reset (only needed if there are several)
  -h, --help         Show this help
`;

export interface ResetOptions {
  dataDir: string;
  secret?: string;
  password: string;
  disable2fa: boolean;
  email?: string;
}

export interface ResetResult {
  email: string;
  twoFactorWasOn: boolean;
  twoFactorDisabled: boolean;
}

/** List the admin accounts (to pick one, and to know whether 2FA is on). */
export function readAdmins(
  dataDir: string,
  secret?: string,
): { id: number; email: string; twoFactor: boolean }[] {
  const { db, sqlite } = openDatabase(join(dataDir, 'burrow.db'));
  try {
    const twoFactor = new TwoFactorService({ db, box: SecretBox.load(dataDir, secret) });
    return db
      .select({ id: users.id, email: users.email })
      .from(users)
      .all()
      .map((u) => ({ ...u, twoFactor: twoFactor.isEnabled(u.id) }));
  } finally {
    sqlite.close();
  }
}

/** Do the reset. Throws with a readable message when it cannot. */
export async function resetPassword(opts: ResetOptions): Promise<ResetResult> {
  const valid = passwordSchema.safeParse(opts.password);
  if (!valid.success) throw new Error(valid.error.issues[0]?.message ?? 'Invalid password');

  const { db, sqlite } = openDatabase(join(opts.dataDir, 'burrow.db'));
  try {
    const all = db.select().from(users).all();
    if (all.length === 0) {
      throw new Error('No admin account yet: open the web UI to create it.');
    }
    const user = opts.email
      ? all.find((u) => u.email === opts.email!.trim().toLowerCase())
      : all.length === 1
        ? all[0]
        : undefined;
    if (!user) {
      throw new Error(
        opts.email
          ? `No account with the email ${opts.email}.`
          : `Several accounts exist; choose one with --email (${all.map((u) => u.email).join(', ')}).`,
      );
    }

    const auth = new AuthService(db);
    const twoFactor = new TwoFactorService({ db, box: SecretBox.load(opts.dataDir, opts.secret) });
    const audit = new AuditService(db);
    const twoFactorWasOn = twoFactor.isEnabled(user.id);

    await auth.resetPassword(user.id, opts.password);
    audit.record(null, 'auth.password.reset', `${user.email} (reset script)`);
    if (opts.disable2fa && twoFactorWasOn) {
      twoFactor.resetAll(user.id);
      audit.record(null, 'auth.2fa.reset', `${user.email} (reset script)`);
    }
    const after = db.select().from(users).where(eq(users.id, user.id)).get();
    return {
      email: after?.email ?? user.email,
      twoFactorWasOn,
      twoFactorDisabled: opts.disable2fa && twoFactorWasOn,
    };
  } finally {
    sqlite.close();
  }
}

/** 24 characters from an unambiguous alphabet (about 139 bits). */
export function generatePassword(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  // randomInt draws uniformly (no modulo bias).
  for (let i = 0; i < 24; i++) out += alphabet[randomInt(alphabet.length)];
  return out.replace(/(.{6})(?!$)/g, '$1-');
}

interface Args {
  generate: boolean;
  stdin: boolean;
  disable2fa: boolean | null;
  email?: string;
  help: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { generate: false, stdin: false, disable2fa: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--generate') args.generate = true;
    else if (a === '--password-stdin') args.stdin = true;
    else if (a === '--disable-2fa') args.disable2fa = true;
    else if (a === '--keep-2fa') args.disable2fa = false;
    else if (a === '--email') args.email = argv[++i];
    else if (a.startsWith('--email=')) args.email = a.slice('--email='.length);
    else if (a === '-h' || a === '--help') args.help = true;
    else throw new Error(`Unknown option: ${a}`);
  }
  if (args.generate && args.stdin) throw new Error('Use either --generate or --password-stdin.');
  return args;
}

/** Ask a question on the terminal; `hidden` does not echo what is typed. */
function ask(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput;
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
        // Show the prompt, mask the typing.
        write.call(rl, s.startsWith(question) ? question : s.includes('\n') ? '\n' : '');
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
}

export async function main(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const config = loadConfig();
  const interactive = process.stdin.isTTY === true;
  if (!args.generate && !args.stdin && !interactive) {
    console.error(
      'No terminal: run with "docker exec -it", or pass --generate or --password-stdin.',
    );
    return 2;
  }

  const admins = readAdmins(config.dataDir, config.secret);
  if (admins.length === 0) {
    console.error('No admin account yet: open the web UI to create it.');
    return 1;
  }
  const target = args.email
    ? admins.find((a) => a.email === args.email!.trim().toLowerCase())
    : admins[0];

  let password: string;
  if (args.generate) password = generatePassword();
  else if (args.stdin) password = await readStdin();
  else {
    console.log(`Resetting the password of ${target?.email ?? args.email}.`);
    password = await ask('New password (12 characters or more): ', true);
    const again = await ask('Repeat it: ', true);
    if (password !== again) {
      console.error('The passwords do not match. Nothing was changed.');
      return 1;
    }
  }

  let disable2fa = args.disable2fa ?? false;
  if (args.disable2fa === null && target?.twoFactor && interactive) {
    const answer = await ask(
      'Two-step verification is on. Turn it off too (lost phone or passkey)? [y/N] ',
    );
    disable2fa = /^y(es)?$/i.test(answer.trim());
  }

  try {
    const result = await resetPassword({
      dataDir: config.dataDir,
      secret: config.secret,
      password,
      disable2fa,
      email: args.email,
    });
    console.log(`\nPassword reset for ${result.email}. Every session was signed out.`);
    if (args.generate) console.log(`New password: ${password}`);
    if (result.twoFactorDisabled) {
      console.log('Two-step verification was turned off. Set it up again in Settings.');
    } else if (result.twoFactorWasOn) {
      console.log('Two-step verification is still on (use --disable-2fa to turn it off).');
    }
    return 0;
  } catch (err) {
    console.error(`Could not reset the password: ${(err as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err);
      process.exit(1);
    },
  );
}
