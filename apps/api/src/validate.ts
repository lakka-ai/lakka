import type { z } from 'zod';
import { InvalidRequestError } from '@lakka/contracts';

/** Parses external input at the boundary. The error names the fields, never their values. */
export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const fields = [...new Set(result.error.issues.map((i) => i.path.join('.') || '(body)'))];
  throw new InvalidRequestError(`invalid request: ${fields.join(', ')}`);
}
