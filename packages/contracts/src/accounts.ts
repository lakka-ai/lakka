import { z } from 'zod';

/*
 * A new local account (ID-2), as entered during first-run setup or when accepting an invite.
 * The password bounds match Better Auth's configuration in core (ADR 0028).
 */

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export const newAccount = z
  .object({
    name: z.string().trim().min(1).max(100),
    email: z.email().max(254),
    password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
  })
  .strict();

export type NewAccount = z.infer<typeof newAccount>;

/*
 * Password reset links (ADR 0098). There is no email, so an instance admin makes a one-time link
 * and passes it on; the person opens it and chooses a new password. Like an invite, the token
 * travels in the link's fragment and in request bodies, never in a URL a server sees.
 */

export const PASSWORD_RESET_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const passwordResetToken = z.string().regex(PASSWORD_RESET_TOKEN_PATTERN);

export const passwordResetTokenBody = z.object({ token: passwordResetToken }).strict();

export const usePasswordResetBody = z
  .object({
    token: passwordResetToken,
    password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
  })
  .strict();
export type UsePasswordResetBody = z.infer<typeof usePasswordResetBody>;

export interface CreatedPasswordReset {
  /** Shown once. The web app builds the link from it. */
  token: string;
  expiresAt: string;
}

/** What the holder of a usable link sees: whose password it sets. */
export interface PasswordResetPreview {
  displayName: string;
  email: string;
  expiresAt: string;
}
