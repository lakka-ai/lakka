# Troubleshooting

Start with the state of each part:

```
docker compose ps
curl -s http://localhost:8080/healthz
docker compose logs --tail 100 api worker web sandbox egress
```

`/healthz` names the component that is down and why (see [Operations](operations.md#health)).
Logs never contain passwords, keys, prompts or replies, so you can share them.

## Installing and first start

**`docker compose up` fails with "port is already allocated".** Another program uses port 8080
(or 8443). Pick others in `.env`: `LAKKA_HTTP_PORT=8090`, `LAKKA_HTTPS_PORT=8453`.

**`docker compose up` fails with "include is not supported" or an unknown option.** Docker
Compose is older than v2.20. Update Docker.

**The `sandbox` service never turns healthy, and its log says `uid_switch_failed`.** It runs each
command-line tool call under a user id from 61000 to 61063, and Docker could not switch to one.
Under rootless Docker or userns-remap, the container's mapped range must cover those ids; the
default 65,536 does, so widen a smaller one in `/etc/subuid` and `/etc/subgid`. Everything but
command-line tool servers works meanwhile.

**A container keeps restarting.** Its log's last lines say why. The api refuses to start on a
database newer than itself (after a downgrade) and when a secret it needs is missing; the
`init` service must have finished first, so start the whole stack, not one service.

**The page cannot be reached from another computer.** By default Lakka listens on this
machine only. Give it a domain (see [Install](install.md#serve-it-on-a-domain-with-https)).

**The setup code is refused.** Copy it again from
`docker compose exec api lakka setup-code`. After too many tries, wait a minute. If the
command says setup is already complete, sign in instead. If you reloaded the page during setup,
it starts again at the setup code; that is expected.

## HTTPS and addresses

**No certificate: the browser warns, or Caddy's log shows certificate errors.** Let's Encrypt must
reach the machine by its name on ports 80 and 443. Check that the DNS record points at it, that a
firewall or cloud security group lets both ports in, and that nothing else on the machine uses
them. `docker compose logs caddy` shows each attempt.

**Sign-in seems to work but you are sent back to the sign-in page.** The address in the browser
differs from Lakka's public address, so the session cookie is not sent back. Use the address
Lakka expects (`https://<LAKKA_DOMAIN>`, or `http://localhost:8080`), or, behind your own
proxy, set `LAKKA_PUBLIC_URL` to the address people use.

**Chat replies arrive all at once, or streams stop halfway, behind your own proxy.** The proxy
buffers responses. Turn off response buffering for `/v1/` and `/api/` (for nginx,
`proxy_buffering off;`), and allow long-lived responses.

## Signing in

**Someone forgot their password.** An instance admin makes them a reset link on the **People**
tab of **People and sign-in**: in the menu at the end of their row, **Make a password reset link
for \<name>** (see
[Administration](administration.md#finding-people-suspending-and-resetting-passwords)).

**A reset link says "This reset link does not work".** It expired (after 24 hours), was used, or a
newer link replaced it; or the admin who made it is no longer an instance admin. Ask for a new one.

**Nobody can sign in: the only admin forgot their password or left.** Create a new instance
admin from the server:

```
echo 'a long new password' | docker compose exec -T api lakka create-user --email you@example.com --name You --instance-admin
```

**"This account cannot sign in. Ask an instance admin."** The person is suspended. An instance
admin can **Reactivate** them on the **People** tab of **People and sign-in**.

**"Signing in with that provider did not work."** In order of likelihood:

- The redirect URI registered at the identity provider is not exactly
  `<Lakka address>/api/auth/sso/callback/<provider id>`.
- The person has no account and the provider may not create one: turn on **Let this provider
  create new accounts**, or add their email's domain.
- Their email already belongs to a password account. That is refused so a provider cannot take an
  account over; they should sign in with their password.
- The provider did not send an email address.
- The provider is on a private network: list its origin in `LAKKA_OIDC_PRIVATE_ORIGINS`.

## Models and requests

**Every request is refused with `budget_unavailable` (503).** Lakka cannot reach its database
or Valkey, and refuses rather than serving requests it cannot meter or rate limit. This includes
requests no budget applies to, unless the rate limit is turned off. `/healthz` shows which; the
container's log shows why.

**A request is refused with `rate_limited` (429), or chat says "Too many requests at once."** The
person started more model requests than their rate limit allows, and the error says how long to
wait. Their API keys count as them, in every workspace, so a script or app running on one of their
keys uses up the same limit as their chat. A key shared by a team, such as one key behind Open
WebUI, gets one person's limit for everyone using it: give such an integration an account of its
own and issue its key there. To change the limit for everyone, set
`LAKKA_MODEL_REQUESTS_PER_MINUTE` and `LAKKA_MODEL_REQUEST_BURST` (see
[Configuration](configuration.md#rate-limit)).

**A request is refused with `budget_exceeded` (402).** A cap has no room, even for a cheaper
model. The message names the cap: `the workspace budget does not have room`. See the cap and its
spend under **Spend and budgets**; it resets at the start of its next day or month (UTC), or an
admin can raise it.

**`no_model` (422).** Nothing chose a model and the workspace has no **Default model**. Set one
under **Routing**.

**`provider_not_configured` (422).** No key for that model's provider, for the workspace or the
instance. Add one on the **Model providers** tab of **Models and providers**.

**`model_not_found` (404).** The model is not in the catalogue and was not added on the **Models**
tab, so Lakka has no price for it. Add it, with its prices.

**`provider_auth_failed` (502), or a provider `down` with `auth_failed` in `/healthz`.** The
provider refused the key: it was revoked, expired or ran out of credit. **Replace key** on the
**Model providers** tab; **Save and check** checks the new one.

**`provider_billing` (502).** The provider refused because of its account's billing, usually
no credit left. Top up the account with the provider. Nothing was charged in Lakka.

**`provider_model_not_found` (502).** Lakka has the model, but its provider does not know the id
after the colon. Look the id up in the provider's model list, add the model again with that id
on the **Models** tab, point routes and the workspace default at it, and remove the old one.

**`upstream_unavailable` (502) or replies that stop with `stream_interrupted`.** The provider did
not answer or broke off. Its status page may say more; a fallback on the route helps next time.

**Routing always uses the default model.** `x-lakka-routing-reason`, and the trace, say why:

- `routing_off`: **Choose models automatically** is off;
- `no_routes`: no route is enabled;
- `too_short`: the message had fewer than three words;
- `classifier_unavailable`: see `/healthz`;
- `below_threshold` or `ambiguous`: the classifier was not sure. Add example phrasings, lower the
  route's values under **How sure routing must be** a little, and check with **Try a phrase**.

Remember that a conversation keeps its first decision.

**Price updates say the last check failed.** The card on the **Models** tab says why, and the
worker's log has `catalogue_feed.check_failed` with the reason. Prices stay as they were, and the
server tries again the next day, or at once with **Check now**.

- The list could not be reached, did not answer in time, or the host did not return it: the
  server cannot reach the address in `LAKKA_CATALOGUE_FEED_URL` (by default
  `raw.githubusercontent.com`) over HTTPS. Check the worker's outbound access to it. Until the
  project publishes its first signed list, the host does not return one; nothing is wrong.
- The signature did not match, it was signed with a key this version does not trust, or it was
  older than one already applied: the list was refused whole. If you use your own mirror, it is
  serving a changed or stale file; copy the project's file again.
- It made a model free, cut a price below a quarter of this release's, or priced a provider it may
  not: the list was refused whole, by design. Report it to the project.

**Get price updates cannot be turned on.** The card says why: `LAKKA_CATALOGUE_FEED_URL=off`
locks it off, or a changed build has no price feed key (see
[Administration](administration.md#price-updates)).

## Tools

**A tool server says "The server could not be reached."** Check its address from the server Lakka
runs on. A workspace admin's server must be HTTPS on the public internet unless its origin is in
`LAKKA_MCP_PRIVATE_ORIGINS`; addresses on private networks, and names that resolve to them, are
refused.

**Adding a tool server says its origin "is not on the list of allowed origins".** An instance
admin allows it under **Admin**, **Tool servers**, or with **Allow \<origin>** in the error. A
server that already worked and now says "Its origin is not on the list of allowed origins" had its
origin removed from that list. In chat, the model is told an administrator has not allowed its
server; the request's trace records the call as denied.

**A tool server that worked before an upgrade now fails.** Lakka no longer follows redirects:
change the server's address to the one it redirects to, and allow that origin.

**A command-line tool server says "The server could not be reached."** The `sandbox` service is
down or busy: `docker compose ps sandbox` shows its health, and its log says why. With every slot
busy, calls wait up to their deadline; raise `LAKKA_SANDBOX_SLOTS` if that is common. A slot
that a call left something running in is taken out of use (`sandbox.slot_quarantined`); when none
is left, the sandbox restarts with all of them fresh.

**A command-line tool server runs, but cannot reach the service it calls.** Its origin is not
allowed: the `egress` log shows `egress.refused` with the host and port. Allow the origin on
**Admin**, **Tool servers**. If nothing is refused there, the program ignores the `HTTPS_PROXY`
and `HTTP_PROXY` variables and has no network at all; configure it to use them. It also cannot
reach Lakka's own services, even when their origin is allowed.

**A command-line tool server cannot find its command or files.** They must be in the image or a
volume mounted into the `sandbox` service, not the api, and readable by any user (see
[Administration](administration.md#command-line-servers)).

**Connecting your own account to an MCP server fails.** If the message names an origin, the
server's sign-in service is not on the list of allowed origins: ask an instance admin to allow it.
Otherwise, the server's authorization server must allow the redirect URI
`<Lakka address>/api/mcp/oauth/callback`. If it offers no automatic client registration, an
admin registers a client there and enters its client ID and secret with **Edit** on the **Tools**
page.

**A tool is missing from chat.** It is not **Enabled** on the **Tools** page, the server has not
been synced since it gained the tool (**Sync tools**), or the person has not connected their own
account under **Your connections**.

## Backup, restore and upgrade

**Restore says "connections are still open".** Stop what writes to the database first:
`docker compose stop api worker web valkey`, then restore.

**After an upgrade the api does not start, and its log names a migration.** Take a
diagnostics bundle, then go back to the previous version and restore the backup you took before
upgrading (see [Upgrade](upgrade.md#if-something-goes-wrong)).

**The recovery key is lost.** It is in the `secrets` volume, and in every backup, so the instance
keeps working; `docker compose exec api lakka recovery-key` prints it. Nothing can recover the
stored credentials if both the volume and every backup are lost: keep backups, and keep the key in
a password manager.

**The api or worker does not start, and its log says `credential_key_missing`.** The message names
a key version, such as "credential key v2 is active in the database but was not given to this
process". The database was re-encrypted with a newer recovery key, and its file
(`credential_master_key_v2`) is not in the `secrets` volume, or not in `LAKKA_CREDENTIAL_KEYS`
if you use it. Restore a backup taken after the rotation, which holds both, or put the key you
saved back as that file.

**A request fails with `credential_key_unavailable` (500).** A stored credential was encrypted
with a recovery key version this server was not given, such as an older version left out of
`LAKKA_CREDENTIAL_KEYS`, or a key file removed by hand. Give that version back, as its file in
the `secrets` volume or in the variable, and restart the api and the worker.

**The log says `credential_key_mismatch`.** The key given for the named version is not the one
the database was encrypted with: the `secrets` volume and the database come from different
installs or backups. Restore both from the same backup.

**Rotating says `database_in_use`.** Something is still connected to the database. Stop the api
and the worker first: `docker compose stop api worker`.

**Rotating says `credential_unreadable`.** One stored credential, named by its table, column and
row, does not decrypt with the key it names, and nothing was changed. Remove it and enter it again
(for a provider key, delete the provider's key and add it again), then rotate again.

**Retiring says `credential_key_in_use`.** Something stored still needs the old key, usually
because the api or the worker kept running through the rotation and wrote with the old key. Stop
them, run `docker compose run --rm credential-key rotate` again, then retire.

## Asking for help

Include a diagnostics bundle, which holds no credentials, prompts, names or emails:

```
docker compose exec -T api lakka diagnostics > lakka-diagnostics.tar.gz
```

Add the last lines of the logs if they show an error, and the `x-lakka-request-id` of a
request that went wrong. Report a security problem privately, as `SECURITY.md` describes, never
in a public issue.
