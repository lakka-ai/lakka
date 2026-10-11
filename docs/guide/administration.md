# Administration

Everything an administrator does in the app. There are two kinds of admin:

- An **instance admin** runs the whole installation: people, sign-in providers, instance-wide
  provider keys, models and price updates, where tool servers may be, the instance budget,
  retention and diagnostics. The account made during setup is one. Their extra pages are under
  **Admin** in the menu: **Workspaces**, **People and sign-in** (with a **People** tab and a
  **Sign-in providers** tab), **Models and providers** (a **Models** tab and a **Model providers**
  tab), **Tool servers**, **Instance spend**, **Retention** and **Diagnostics**.
- A **workspace admin** runs one workspace: its members, invites, budgets, routing, tools and
  the workspace's own provider keys.

A **workspace** is a team's space: its members, keys, budgets, model routes, tools and provider
keys. A person can be in several workspaces with a different role in each. Everything in one
workspace is invisible from another.

## Workspaces

Instance admins manage workspaces under **Admin**, **Workspaces**. The table shows each
workspace's admins, how many people it has, what it spent this month and when it was created.

- **Create workspace** asks for a name and the first admin, who then invites everyone else.
- **Rename** changes the name people see. Links, API keys and traces keep working.
- **Delete** asks you to type the workspace's name, then **Delete workspace**. At once, its people
  lose access to it, its API keys stop working, its invite links, provider keys, tool servers and
  alert webhook are removed, and any open chats and API streams in it end. Within a minute or so,
  its conversations and files, request traces, recorded prompts, routes and caps are removed too.
  Tool calls stay in the audit without their arguments.

  Its people keep their accounts and their other workspaces. Its spend stays in **Instance
  spend**, shown as _(deleted)_, so the instance cap does not move. It cannot be undone, and
  backups taken earlier still contain the workspace until those backups are deleted.

## People and access

### Inviting someone

On the **Workspace settings** page, under **Invites**, pick the **Role** (Member or Admin) and
**Create invite link**. The link is shown once: copy it and send it yourself, since Lakka sends
no email. Each link works once, for 7 days, and **Withdraw** cancels it. The person opens it and
either creates an account (**Create account and join**) or signs in to an existing one (**Sign in to
accept**, or **Use \<display name>** for a sign-in provider).

Under **Members**, **Make admin** and **Make member** change a role, **Remove** takes someone out
of the workspace, and **Leave**, on your own row, takes you out. A workspace always keeps at
least one admin.

### Signing in with your identity provider

Instance admins add OpenID Connect providers, such as Entra ID, Google Workspace, Okta or
Keycloak, on the **Sign-in providers** tab of **People and sign-in**:

1. In the identity provider, register an application (a confidential web client) with this
   redirect URI, where `<provider id>` is the id you choose in step 2:

   ```
   <your Lakka address>/api/auth/sso/callback/<provider id>
   ```

   Once the provider is saved, its form shows this address as **Redirect URI**, with **Copy**.

2. In Lakka, **Add a provider**: a **Provider ID** (lowercase letters, digits and hyphens),
   a **Display name** for the sign-in button, the **Issuer URL**, and the **Client ID** and
   **Client secret** from step 1. **Save provider**.
3. Choose whether it may create accounts: with **Let this provider create new accounts** off,
   only people who already have an account can sign in with it. With it on, anyone the provider
   vouches for gets an account, or only those with an email in **Allowed email domains**.
   Existing accounts can sign in from any domain.

The sign-in page then offers **Sign in with \<display name>**, above email and password. Later, you
can change the display name, the new-account setting, the allowed email domains and the client
secret. The provider ID, issuer and client ID are fixed: to change one, add a new provider. **Remove
provider** asks first, and when people have no other way to sign in, it asks you to type the
provider ID, since they cannot sign in until a provider with that ID is added again. A provider
sign-in whose email belongs to an existing password account is refused rather than linked, so a
provider cannot take over an account. An identity provider on a private network must be listed in
`LAKKA_OIDC_PRIVATE_ORIGINS` (see [Configuration](configuration.md)).

### Finding people, suspending and resetting passwords

The **People** tab of **People and sign-in** lists everyone on the server, with their workspaces,
how they sign in and when they were last active. **Find a person** searches by name or email.

**Suspend** signs a person out everywhere and stops their keys at once; their open chats and API
streams end within seconds. **Reactivate** lets them back in, with the same keys. To remove
someone from one workspace only, use **Remove** on the workspace page.

Each row's **Suspend** or **Reactivate**, **Export data** and **Delete** are buttons in the row.
The menu at the end of a row, **More actions for \<name>**, has the rest (on a phone, one menu,
**Actions for \<name>**, holds every action):

- **Make \<name> an instance admin**, or **Remove instance admin from \<name>**. The server always
  keeps one active instance admin.
- **Make a password reset link for \<name>**, for someone who forgot their password. Lakka sends
  no email, so the link is shown once for you to pass on. It works once, for 24 hours, and a newer
  link replaces it. The person opens it, chooses a new password, and is signed out everywhere. It
  also gives a password to someone who until then only signed in through a provider.

### Exporting and deleting a person

On the **People** tab, instance admins can:

- **Export data**: download a `.tar.gz` of everything linked to the person. It contains:
  - their profile, memberships, keys (never the secrets) and budgets;
  - their conversations and files;
  - their usage, tool calls, approvals and recorded prompts;
  - the timings of their requests.
- **Delete**: after typing their email to confirm, **Delete permanently**. This:
  - deletes their sign-in, memberships, conversations and files, recorded prompts and replies,
    tool call arguments and their own MCP connections;
  - revokes their keys;
  - keeps their usage, shown as _Deleted person_, so budgets and spend reports stay correct.

  It cannot be undone, and you cannot delete yourself or a workspace's only admin. Your own row
  offers only **Export data**. Backups taken
  earlier still contain the person until those backups are deleted.

## API keys

Anyone can create a key for a workspace they are in: on the **Workspace settings** page, under **API
keys** (**Your API keys** for members), a **New key name**, **Create key**. The key (`lk_...`) is
shown once. A key acts for the person who made it, with that person's permissions, never more, and
stops working if they are suspended or leave the workspace. **Revoke** ends it for good. See
[The API](api.md) for using it.

## Providers and models

### Provider keys

The **Model providers** tab of **Models and providers** (instance admins) holds keys every workspace
can use. It has a row for each built-in provider (Anthropic, OpenAI, Google, DeepSeek, Moonshot AI,
Qwen Cloud, Xiaomi MiMo and Z.ai), and one for each OpenAI-compatible server:

- **Add key**, or **Replace key**, takes an API key; **Save and check** saves it and checks it at
  once.
- **Add a provider** adds any OpenAI-compatible server, online such as OpenRouter or your own
  such as Ollama or vLLM: a **Name**, used in model names such as `ollama:llama3.3`, an
  **Address**, the API base with its path such as `http://ollama:11434/v1` or
  `https://openrouter.ai/api/v1`, and a key if it needs one. **Change address** changes it later.
  [Adding a provider](providers.md) walks through it, with OpenRouter, and adding its models.
- **Remove** asks first. Requests to that provider's models are then refused, unless a workspace
  has its own key.

**Check** lists the provider's models with the key, which costs nothing, and the row says
**Connected**, **Key refused**, **Could not connect** or **Error**. Keys are stored encrypted and
never shown again.

A workspace admin can add the workspace's own key under **Model providers** on the **Workspace
settings** page, with **Add a workspace key**; it wins over the instance's for that workspace. It is
limited to the built-in providers at their standard addresses.

### Models

Every request is priced before it is sent, so Lakka uses only models it has a price for.

- **Catalogue**: models of the built-in providers that ship with each version, with their
  context window, output limit and prices, and a **Status**: **Available** when the instance's
  key for its provider passed its last check. **Find a model** searches it.
- **Models you added**: anything else, such as a model on your own server or a new release
  not in the catalogue yet. **Add a model** takes:
  - the **Model name**, the provider and the model id with a colon between, such as
    `ollama:mistral-small`, and an optional **Display name**;
  - the **Context window** and **Output limit**, in tokens;
  - the input and output price in US dollars per million tokens ($0.00 for your own hardware is
    fine);
  - whether **It can read** images and PDF files, and whether **It can call tools** (checked
    unless you untick it).

  **Edit** changes everything but the model name, which routes point to. **Remove** asks first.

A model is named `<provider>:<model>`, such as `anthropic:claude-sonnet-4-5` or
`ollama:llama3.3:70b`.

Some models of the built-in providers are left out of the catalogue on purpose:

- Qwen models that charge thinking tokens more than other output, such as `qwen-turbo` and the
  newer `qwen-plus` versions. Lakka counts thinking tokens as output, so it would charge less
  than Qwen bills and a budget could be overspent. Add one under **Models you added**, priced at
  its thinking rate, if you want it anyway.
- Models a provider lists at no price, such as Z.ai's free GLM Flash models: a price of zero in
  the source means it is unknown.

DeepSeek's off-peak discount is not applied, so those requests are charged its standard price.
The built-in providers are reached at their international addresses: Qwen Cloud is Alibaba Cloud
Model Studio in Singapore, and Moonshot AI is `api.moonshot.ai`. For a provider's mainland China
region, which has its own address and prices, add it as an OpenAI-compatible server under its own
name and add its models yourself.

### Price updates

Prices change between releases. **Price updates**, under the models, lets the server fetch new
prices for catalogue models without an upgrade. It is off until an instance admin turns it on.

- **Get price updates** applies at once. On, the worker fetches a price list once a day, at a
  minute of the day this server picked, and when you press **Check now**. Off, it fetches nothing
  and the prices that came with your version apply again at once.
- **What it contacts**: one `https` address, by default the Lakka project's file on GitHub
  (`raw.githubusercontent.com`). The card names the host. The request carries nothing about your
  instance, not even the version, but the host sees your server's address. It follows no
  redirects, gives up after 10 seconds and reads at most 1 MB.
- **What it may change**: the list is signed by the Lakka project, and the server checks the
  signature with keys built into your version, wherever the file came from. An update can change
  catalogue prices and add models of the built-in providers. It never removes a model, never
  makes one free, and never cuts a price to less than a quarter of your version's; a list that
  tries is refused whole. Your own models always keep the prices you set. Requests already running
  keep the price they started with, and past spend keeps the price it was charged at.
- The card says when the server last checked and what it found, in plain words, and when prices
  last changed. Catalogue models priced by an update show **Price updated**.
- **Locking it off**: set `LAKKA_CATALOGUE_FEED_URL=off` (see
  [Configuration](configuration.md#integrations)) and the switch is hidden, whatever an admin
  chose. Set it to an `https` address to fetch from your own mirror instead.

Until the project publishes its first signed price list, a check finds none: the card says the
host did not return the price list, and your version's prices stay.

## Budgets and spend

A budget, or cap, is a spending limit in US dollars. Caps nest: a key sits inside its person's
cap, a person inside their workspace's, a workspace inside the instance's. A request must fit
every cap above it, and the whole chain is reserved together before the request is sent, so
concurrent requests can never overspend.

| Cap                    | Set by                                                                   | Where                                                                      |
| ---------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Instance               | instance admins                                                          | **Instance spend**                                                         |
| Workspace              | instance admins                                                          | **Spend and budgets**, **Budgets and alerts**                              |
| Person, in a workspace | workspace admins                                                         | **Spend and budgets**, **Budgets and alerts**                              |
| Key                    | workspace admins, or the key's owner (who may only lower an admin's cap) | **Spend and budgets**, and **API keys** on the **Workspace settings** page |

**Set a cap** (or **Edit cap**; **Set a workspace cap** and **Set an instance cap** for those)
takes an **Amount in US dollars**, a **Reset period** (**Every day**, **Every month**, in UTC, or
**Never**), and the percentages to **Alert at** (80 and 100 unless you change them); **Save
cap**. **Remove cap** asks first.

When a request would not fit, Lakka first tries a cheaper model: the route's fallbacks, then
the workspace default. It says so in chat, and in the API's `x-lakka-fallback-from` header. If
nothing fits, the request is refused before anything is sent: in chat with a plain message, in
the API with a 402 `budget_exceeded` error. If the budget cannot be checked, because the
database or Valkey is down, requests are refused, never served unmetered.

### Alerts

Under **Alerts**, on **Spend and budgets**, **Budgets and alerts**, set a **Webhook address** and
**Save address** to receive a POST when a cap passes one of its alert percentages, once per period
each. **Instance alerts**, on **Instance spend**, is the instance's address; it receives every cap's
alerts, unless a workspace set its own. **Send a test alert** checks the address. A workspace's
address must be HTTPS on the public internet. Each alert is signed: check the `lakka-signature`
header, `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>" with the signing secret>`, before
trusting it. The secret is shown once. Failed deliveries are retried for about two hours; **Alerts
sent** shows what happened.

### Spend

The workspace's **Spend and budgets**, under **Report**, shows spend for a range of dates (**This
month**, **Last month**, **Last 7 days** or **Custom**). **Instance spend** shows this month by
workspace, each with its own cap, and **Open the full report** gives the same report for the
whole server. They show spend:

- by day, person, model and, on the instance report, workspace;
- by where it came from: chat, API or MCP;
- by route, with tool calls;
- how many requests a budget sent to a cheaper model, or refused.

Figures come from the same usage records budgets are charged from.

### Rate limit

Besides budgets, each person may start only so many model requests a minute: 120 on average, and
up to 60 at once, unless the operator changed that for the whole server (see
[Configuration](configuration.md#rate-limit)). Chat, the API and MCP count together, in every
workspace, and a person's API keys count as them. There is no setting per workspace or per person.

A request past the limit is refused before anything is sent, and costs nothing. Chat says **Too
many requests at once.** and how long to wait; the API answers 429 `rate_limited` (see
[The API](api.md#errors)). The request's trace shows the refusal, and **Downgrades, refusals and
tool calls**, on **Spend and budgets**, counts such requests as **Too many requests at once**. A
key shared by a team, such as one behind Open WebUI, gets one person's limit for everyone using it.

## Routing

Routing picks a model for each conversation. On the workspace's **Routing** page:

- **Choose models automatically** turns routing on or off.
- **Default model** answers whenever nothing else decides. Without one, a request that names no
  model fails.
- **Pinned model** sends every request to one model, unless the person chose another.
- **Routes** send some kinds of request to a particular model. A route has:
  - a **Name**, a **Model** and optional **Fallbacks, in order**;
  - an optional **Description**: one line on what the route is for. Routing uses it from the
    start, and with the examples once there are some;
  - **Example phrasings, one per line**: twelve or more work best;
  - optional **Signals**: a code block, or a source file name, sends a request to the route
    without the classifier.

  The two values under **How sure routing must be** decide how sure the classifier must be before it
  uses the route. They are stricter when the route's model is cheaper than the default, so a request
  is not sent to a weaker model by mistake.

- **Try a phrase** shows which route a message would take, and why.

How a model is chosen, first match wins:

1. the model or route the person or client chose;
2. the conversation's earlier decision, since routing is decided once per conversation, not per
   message;
3. the pinned model;
4. a signal;
5. the classifier;
6. the default model.

Messages under three words skip the classifier. A classifier that is not sure uses the default
model, and remembers that for the conversation.

### When people choose another model

When someone picks a different model in a conversation that routing decided, that counts as an
override of the route. **When people choose another model**, at the bottom of the Routing page,
shows the last 30 days per route: how often the routed model answered and how often people chose
another, which way, the model chosen most, and roughly what the route would cost on it.

While **Record prompts and replies** is on (see [Content capture](#content-capture)), each route
there also has **Review**. It lists the messages its conversations were routed on before people
moved away, grouped by the model they chose:

- **Add to a route** opens the route with the message as its last example. Edit it before you save:
  an example is kept until you remove it, even after the recorded text is deleted. The menu lists
  every route but the one people moved away from, those that already use the model they chose
  first, then **New route with \<model>**.
- **Dismiss** hides the message for good.

Only messages the classifier decided are listed; a signal decides without examples. A message
goes from the list when its recorded text expires, when the conversation or the person is
deleted, and as soon as recording is turned off. Lakka never adds an example on its own.

### How accurate it is

The classifier runs inside Lakka and sends nothing out. Its model reads more than fifty
languages, so a route's example phrasings can be written in one language and still match
messages in another. On the project's evaluation set, with twelve example phrasings per route:

| Messages in | Examples in the same language | Examples in English |
| ----------- | ----------------------------- | ------------------- |
| English     | 84% (plus or minus 2)         | same                |
| Spanish     | 82%                           | 82%                 |
| French      | 80%                           | 81%                 |
| Swedish     | 78%                           | 78%                 |
| German      | 77%                           | 77%                 |

"Correct" means the intended route for a clearly typed message, and the default model for one
that fits no route. Between 10% (English) and 19% (German) of clearly typed messages go to
another route; when you set a cheaper route's model, keep that in mind.

- More examples help, and fewer hurt. Twelve or more per route is the advice.
- Languages beyond these five were not measured, but the model reads them. Check routes in
  them with **Try a phrase**, and expect results closer to German's than English's.
- The evaluation sets for languages other than English are translations, and like the English
  set they are provisional until measured against real use.
- Signals are exact and do not depend on language.

A new route with only its **Description** can be chosen at once, and the description keeps
counting, as one more example, once the route has some. Measured with the default model, one
new route and six routes with twelve example phrasings each:

| Messages in | Without the new route | Its description | And one example | And two examples |
| ----------- | --------------------- | --------------- | --------------- | ---------------- |
| English     | 76%                   | 80% to 81%      | 81% to 82%      | 82%              |
| Spanish     | 74%                   | 77% to 78%      | 79%             | 80%              |
| French      | 73%                   | 76%             | 77% to 78%      | 78%              |
| Swedish     | 71%                   | 74% to 75%      | 76%             | 77%              |
| German      | 70%                   | 73%             | 75%             | 76%              |

- Fewer messages go to the wrong route, 2 to 3 fewer in every 100 with the description alone,
  because the new route's messages stop landing on its neighbours.
- A quarter to a half of the new route's own messages reach it on its description alone, and
  about half once it also has one example. A description that names concrete things, such as
  NDAs or GDPR, does better than one that blurs into another route's.
- Each example counts as much as the description, so the examples soon outweigh it. Twelve or
  more is still the advice. With twelve on every route, describing every route adds up to about
  one point.
- The description is part of the route, so editing it, or renaming a route that has one,
  changes where messages go. Check with **Try a phrase**.

### A larger classifier

The image also carries a larger model of the same family, paraphrase-multilingual-mpnet-base-v2. It
routes other languages better, at about twice the cost per classification. On the same set,
with twelve example phrasings per route:

| Messages in | Examples in the same language | Examples in English |
| ----------- | ----------------------------- | ------------------- |
| English     | 87% (plus or minus 2)         | same                |
| Spanish     | 84%                           | 86%                 |
| French      | 82%                           | 84%                 |
| Swedish     | 82%                           | 83%                 |
| German      | 80%                           | 83%                 |

- A route with only its **Description** does better too: 76% to 82% across the five languages
  when every route has only a description, against 68% to 74% with the default model.
- Classifying a long first message takes about 65 ms with two classifier threads, and about
  120 ms with one, against about 30 ms and 50 ms with the default model, on two ARM CPUs. On
  two x86 CPUs it is slower: about 105 ms with two threads and 185 ms with one, against about
  35 ms and 60 ms with the default model. A conversation is classified once, on its
  first message.
- The app uses about 350 MB more memory with it.

To use it, set `LAKKA_CLASSIFIER_MODEL_DIR` and two classifier threads (see
[Configuration](configuration.md#settings-compose-does-not-pass-on)), then restart. Routes
recompile themselves with the new model; switching back recompiles them again.

## Tools and MCP servers

Workspace admins connect MCP servers on the workspace's **Tools** page, and choose which of their
tools the model may use. A tool can never do what the person asking is not allowed to do.

1. **Add a tool server**, with a **Name** people see and a **Short name** models see its tools
   under. Under **How Lakka reaches it**:
   - **Over HTTP**, with its **Address**;
   - or **A command on this server**, a program already in the image or a volume mounted into the
     `sandbox` service. Instance admins only. See [Command-line servers](#command-line-servers).
2. Choose **How Lakka signs in to it**:
   - **Nothing**;
   - **A shared credential**: one **Credential** for everyone, and a box to tick, since the tool
     then cannot tell people apart;
   - **Each person's own account**: OAuth, for a server reached over HTTP. Each person connects
     under **Your connections**, and the tool then acts as them. The server's authorization
     server must allow this redirect URI: `<your Lakka address>/api/mcp/oauth/callback`. If it
     offers no dynamic client registration, register a client there and enter its client ID and
     secret in the same form.

   **Add and sync tools** adds it and reads its tools.

3. **Sync tools** reads the server's tools again. The model is offered these stored definitions, not
   whatever the server says later: sync again after the server changes.
4. Each tool starts off. Turn **Enabled** on to allow it, and **Asks first** to make the person
   approve each call. These apply at once. Tools the server marks read-only start without asking;
   others start asking.

In chat, a tool that asks first shows **Allow {tool} to run?**, with **Allow once**, **Always
allow** and **Deny**. **Always allow** is a standing approval, listed and revocable under **Your
connections**, and for admins on the **Tools** page. A tool gets 30 seconds per call and up to 8
rounds per reply.

### Allowed tool server origins

Lakka reaches a tool server over HTTP only at an origin an instance admin allowed: a scheme,
host and port, such as `https://mcp.example.com`, with no path and no wildcards. The list is for
the whole instance, on **Admin**, **Tool servers**:

- **Allow an origin** adds one. **Remove** asks first; removing one stops every server there from
  its next request.
- Adding or changing a server at an origin that is not listed is refused. An instance admin can
  **Allow \<origin>** from the error in the server form, which allows it and saves the server; a
  workspace admin is told to ask one.
- An OAuth server's authorization server must be allowed too, with every origin its metadata
  names: where Lakka registers, gets tokens, and sends people to sign in. Until it is, people
  cannot connect their accounts, and the error names the origin.
- Origins in `LAKKA_MCP_PRIVATE_ORIGINS` are allowed as well, and shown under **Set by the
  operator**.
- Lakka never follows a redirect from a tool server: point the server at the address it
  redirects to.

Where a server may be also depends on who added it. A workspace admin's server must be HTTPS on the
public internet, unless its origin is in `LAKKA_MCP_PRIVATE_ORIGINS`, and its address is checked
again on every connection, so a DNS change cannot point it inside your network. An instance admin's
server may be on a private network, once its origin is allowed.

The list covers what Lakka itself sends, and what a command-line server sends through the
egress proxy (below). What a remote server does after Lakka calls it is up to that server.

### Command-line servers

A server added as **A command on this server** runs in the `sandbox` service, never in the api.
Every test, sync and tool call starts the command afresh, under a user of its own with limits (64
processes, 1 GiB of memory, 2 minutes of CPU), and ends everything it started afterwards. It
cannot read Lakka's secrets or reach its database, cache or api, and it can write only in a
temporary home that is emptied after each call.

- **Network.** The sandbox has no route out. A server reaches the network only through the
  `egress` proxy, which it finds in the standard `HTTPS_PROXY` and `HTTP_PROXY` variables, and
  only at the allowed origins on **Admin**, **Tool servers**, private addresses included. List
  every origin the server calls, such as `https://api.example.com`. A program that ignores the
  proxy variables has no network at all; Node programs use them, as most HTTP clients do.
- **The command and its files** must be in the image or in a volume you mount into `sandbox`, in a
  compose override, readable by any user. For example, `compose.override.yaml` next to
  `compose.yaml`:

  ```yaml
  services:
    sandbox:
      volumes:
        - ./tools:/tools:ro
  ```

  and the server's command is then `node` with `/tools/server.js`.

- **When the sandbox is down**, testing a command-line server says it cannot be reached, and its
  tools tell the model they are unavailable. Everything else keeps working.
- `LAKKA_SANDBOX_SLOTS` sets how many such calls run at once, 8 by default; more wait for a
  free one, up to their deadline. See [Configuration](configuration.md).

## Chat

People talk to models on the **Chat** page. They attach files with **Attach files**, by dropping
them on the conversation, or by pasting: up to 10 MB a file and 20 MB a message. Every model reads
text files, which must be UTF-8; images and PDFs go only to a model that can read them (see
[Models](#models)). A paste of more than 2,000 characters becomes an attached file, `Pasted
text.txt`. Replies are shown as Markdown: HTML in a reply is dropped, only `http`, `https` and
`mailto` links work, and images in a reply are shown as links, never loaded.

## Content capture

Lakka does not keep prompts and replies, except as the conversation history people see in chat.
For troubleshooting, a workspace admin can tick **Record prompts and replies** under **Content
capture** on the **Workspace settings** page, set **Keep recorded text for** (1 to 90 days, default
7), and **Save**. While it is on, every member sees that in chat. Recorded content appears on the
request's trace, only to those who may see that trace, and is deleted when its time is up. When
someone picks a different model from the one routing chose, workspace admins can also see the
message the conversation was routed on, on the Routing page, to add it to a route as an example
(see [When people choose another model](#when-people-choose-another-model)). Turning recording off
hides those messages at once.

## Requests and traces

Each workspace's **Requests** page lists its requests, newest first. Workspace admins see
everyone's; members see their own, their keys' included. A request's trace shows:

- how the model was chosen;
- the budget check;
- each attempt, with its tokens, cost and timing;
- tool calls;
- recorded content, where the workspace records it.

Chat links to a reply's trace with **View trace**. Traces are kept 30 days by default (see
[Operations](operations.md#retention)).
