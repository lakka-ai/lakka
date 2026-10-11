import { z } from 'zod';

/** Instance administration of people (ID-6). */

export const principalParams = z.object({ principalId: z.uuid() });

/**
 * Deleting a person (NF-P4, ADR 0082) names them twice: by id in the path and by their email
 * here, so a script or a slip of the mouse cannot delete the wrong person.
 */
export const deletePersonBody = z.object({ confirmEmail: z.string().min(1).max(320) }).strict();
export type DeletePersonBody = z.infer<typeof deletePersonBody>;

/** Grants or removes instance admin from the People page (ID-3, ADR 0097). */
export const instanceAdminBody = z.object({ isInstanceAdmin: z.boolean() }).strict();
export type InstanceAdminBody = z.infer<typeof instanceAdminBody>;

/** One way a person can sign in: a password, or an identity provider (ID-2). */
export type SignInMethodView =
  | { kind: 'password' }
  /** displayName is null when the provider has since been removed. */
  | { kind: 'sso'; providerId: string; displayName: string | null };

export interface UserAdminView {
  id: string;
  displayName: string;
  email: string | null;
  status: 'active' | 'suspended' | 'deleted';
  isInstanceAdmin: boolean;
  createdAt: string;
  /** Sorted by name. */
  workspaces: { id: string; name: string; role: 'admin' | 'member' }[];
  /** Passwords first, then providers by name. */
  signsInWith: SignInMethodView[];
  /** Null if they have not been active since this was first recorded (ADR 0097). */
  lastActiveAt: string | null;
}
