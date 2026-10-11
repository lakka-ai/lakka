import { execFileSync } from 'node:child_process';

/*
 * Helpers for suites that run against the compose stack from outside it, as a customer's clients
 * do: the acceptance suite (test/e2e) and the compatibility suite (test/compat).
 */

/**
 * Creates an account with the operator command inside the running stack (ADR 0033) and returns
 * its principal id. The password goes in on stdin, never on the command line.
 */
export function createUser(email: string, name: string, password: string, admin: boolean): string {
  const args = [
    'compose',
    'exec',
    '-T',
    'api',
    'lakka',
    'create-user',
    '--email',
    email,
    '--name',
    name,
  ];
  if (admin) args.push('--instance-admin');
  const out = execFileSync('docker', args, { input: `${password}\n`, encoding: 'utf8' });
  return out.trim().split('\n').at(-1) ?? '';
}
