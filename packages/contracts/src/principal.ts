/**
 * Who is making a request (ID-1). Every surface resolves its credential to one of these, and
 * every policy decision takes one.
 *
 * A key is a delegation of a person (ID-5): permissions always resolve through `actingUserId`,
 * which is the key's owner for a key and the principal itself for a user (NF-S2).
 */
/**
 * What /api/me answers: the principal, and for a person's own session their email, shown under
 * their name in the account menu. A key's caller gets no email (null).
 */
export interface MeView {
  principal: Principal;
  email: string | null;
}

export interface Principal {
  id: string;
  kind: 'user' | 'key';
  displayName: string;
  /** The person whose permissions apply. */
  actingUserId: string;
  isInstanceAdmin: boolean;
  /**
   * For a key, the one workspace it may act in (ID-5); null for a user. A key never reaches
   * another workspace, even one its owner belongs to.
   */
  workspaceScope: string | null;
}
