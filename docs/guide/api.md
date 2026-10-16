# The API

Lakka speaks the OpenAI Chat Completions API. Any app, coding harness, script or SDK that lets
you set a base URL and a key can use Lakka in place of OpenAI, so your team does not have to
switch to Lakka's chat. Every request goes through the same budgets, routing, permissions and
tracing as chat: a key acts for the person who made it and spends against their caps.

Set `model` to `auto` and Lakka chooses the model for each request from the workspace's routes
(see [Choosing a model](#choosing-a-model)). The app does not need to know which models exist or
what they cost, and when an admin changes a route, every app follows.

## Connecting

- **Base URL**: `<your Lakka address>/v1`, such as `https://ai.example.com/v1`.
- **Key**: create one on the workspace page under **API keys**. It starts with `lk_`, belongs to
  one workspace, and acts with the permissions of the person who made it.

```python
from openai import OpenAI

client = OpenAI(base_url="https://ai.example.com/v1", api_key="lk_...")
reply = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Summarise this changelog: ..."}],
)
print(reply.choices[0].message.content)
```

```
curl https://ai.example.com/v1/chat/completions \
  -H "Authorization: Bearer lk_..." -H "Content-Type: application/json" \
  -d '{"model": "auto", "messages": [{"role": "user", "content": "Hello"}]}'
```

### Open WebUI and LibreChat

- **Open WebUI**: set `OPENAI_API_BASE_URLS` to the base URL and `OPENAI_API_KEYS` to a key, or
  add a connection with both under its admin settings.
- **LibreChat**: add a custom endpoint in `librechat.yaml` with `baseURL` set to the base URL,
  `apiKey` to a key, and `models: { fetch: true }`, so it lists the models Lakka offers.

Both are tested against Lakka, unmodified, on every change. Their model lists show `auto` and
each route, so people can pick routing there.

### Other apps and harnesses

Other chat apps, coding harnesses and agent frameworks that use Chat Completions should work the
same way, but the project does not test them. Before you rely on one, check that it does not need
something Lakka refuses (see [Request](#request)): structured output, `tool_choice` other than
`auto` or `none`, or more than one reply per request. Lakka offers only Chat Completions, not
OpenAI's Responses API or Anthropic's Messages API, so an app that speaks only one of those cannot
use it.

## Endpoints

| Endpoint                    | What it does                                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/models`            | The models this key may use: `auto`, then `route/<name>` for each enabled route, then each model with a key configured. |
| `POST /v1/chat/completions` | A reply, whole or streamed (`"stream": true`).                                                                          |

## Choosing a model

| `model`              | Means                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------- |
| `auto`               | Let the workspace's routing choose (see [Administration](administration.md#routing)). |
| `route/<name>`       | Use that route's model, and its fallbacks.                                            |
| `<provider>:<model>` | Exactly this model, such as `anthropic:claude-sonnet-4-5` or `ollama:llama3.3:70b`.   |

With `auto`, Lakka matches the request against the workspace's routes, the same way it does in
chat, unless an admin pinned one model for the workspace. A signal, such as a code block, sends
the request to its route straight away. Otherwise a classifier compares the message with each
route's description and example phrasings, inside Lakka and offline. A request no route claims
with enough confidence goes to the workspace's default model. The response headers say
which model answered and why (see [Headers you get back](#headers-you-get-back)), and so does the
request's trace.

A budget can still send a request to a cheaper model; the response headers say when.

### Routing without a conversation

Routing reads the latest user message. In chat, and in a request that sends
`x-lakka-conversation`, it decides once for the conversation and keeps that decision. Most apps
cannot send that header, and the conversation it names must already exist in Lakka. Without it,
each request is routed on its own:

- While a harness or agent works through tool calls, the latest user message stays the same, so
  the request is routed the same way each time.
- A new user message can go to a different route's model. The provider's prompt cache for the
  earlier model is then lost, so the next reply can cost more.

To keep one model for a whole session, choose `route/<name>`, which keeps the route's fallbacks,
or a model, instead of `auto`.

## Request

The usual fields are accepted:

- `model`, `messages`, `stream` and `stream_options.include_usage`;
- `max_tokens` or `max_completion_tokens`;
- `temperature`, `top_p` and `stop`;
- `tools` and `tool_choice` (`auto` or `none`).

Roles are `system` (or `developer`), `user`, `assistant` and `tool`. Images (PNG, JPEG, GIF, WebP),
PDFs and plain text files are accepted as base64 `data:` URLs, not as links, up to 10 MB each and 20
MB in one message. A text file (`data:text/plain;base64,...`, in a `file` part) must be UTF-8; every
model reads it, given to the model as the file's text, delimited and named by its `filename`.

Refused with a clear `invalid_request` error:

- `n` other than 1;
- the legacy `functions` and `function_call` fields;
- structured output (`response_format` other than `text`);
- `tool_choice` other than `auto` or `none`.

Unknown fields are ignored.

### Headers you can send

| Header                           | Means                                                                                                                                     |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `x-lakka-workspace: <id>`        | Which workspace to use when signed in as a person in several. A key always uses its own.                                                  |
| `x-lakka-conversation: <id>`     | Keep this exchange as a conversation: history is stored, routing is decided once for it, and the workspace's tools can be used.           |
| `x-lakka-approve: <approval id>` | Approve a waiting tool call (see below). Add `x-lakka-approve-scope: always` to approve that tool for good; only a person can, not a key. |
| `x-lakka-deny: <approval id>`    | Refuse a waiting tool call.                                                                                                               |

### Headers you get back

| Header                                            | Means                                                                                                                                   |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `x-lakka-request-id`                              | The request's id, on refusals too. Find its trace under **Requests**.                                                                   |
| `x-lakka-model`                                   | The model that answered.                                                                                                                |
| `x-lakka-routing-rule`                            | Why: `explicit`, `sticky` (the conversation's earlier choice), `pinned`, `signal`, `classified` or `default`.                           |
| `x-lakka-route`                                   | The route, when one decided.                                                                                                            |
| `x-lakka-routing-reason`                          | Why the default was used: `routing_off`, `no_routes`, `too_short`, `classifier_unavailable`, `below_threshold` or `ambiguous`.          |
| `x-lakka-routing-confidence`                      | How sure the classifier was, from 0 to 1, when it was asked.                                                                            |
| `x-lakka-fallback-from`, `x-lakka-fallback-scope` | A budget sent the request to a cheaper model: which model it would have used, and which cap (`instance`, `workspace`, `member`, `key`). |

## Streaming

Nothing is sent until the model's first chunk has arrived. Until then Lakka may retry or fall
back to another model, and an error comes as an ordinary JSON error with its real status. After
that, an error ends the stream with a final `data: {"error": {...}}` event, and a normal end is
`data: [DONE]`. Add `"stream_options": {"include_usage": true}` for a final usage chunk.

## Tools

Tools you send in `tools` work as with OpenAI: the model's `tool_calls` come back to you to run.

A workspace's own tools, set up by its admins, run inside Lakka instead, as the person the key
belongs to, in a conversation (`x-lakka-conversation`). When one needs approval, the reply
stops and says so under a `lakka` field:

```json
"lakka": { "pending_approval": { "id": "<approval id>", "tool": "files__search", "arguments": { "query": "Q3" } } }
```

Answer with a new request in the same conversation, carrying `x-lakka-approve: <approval id>` or
`x-lakka-deny: <approval id>`. Only whoever made the call may answer.

A tool whose server is at an origin an instance admin has not allowed (see
[Administration](administration.md#allowed-tool-server-origins)) does not fail the request: the
model is told it cannot be used, and the trace records the call as denied.

## Errors

Errors use OpenAI's shape, so SDKs handle them: `{"error": {"message", "type", "param", "code"}}`.
The `message` is written for people; branch on `code`.

| HTTP    | `code`                        | Means                                                                                                                                                                 | Retry?                                       |
| ------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 400     | `invalid_request`             | Something in the request is wrong; `message` and `param` say what.                                                                                                    | No                                           |
| 400     | `context_length_exceeded`     | The messages are too long for the model.                                                                                                                              | No, shorten them                             |
| 400     | `output_too_long`             | `max_tokens` is above the model's limit.                                                                                                                              | No                                           |
| 400     | `content_filter`              | The provider's safety system refused it.                                                                                                                              | No                                           |
| 400     | `provider_rejected_request`   | The provider refused the request.                                                                                                                                     | No                                           |
| 401     | `invalid_api_key`             | The key is wrong, revoked, or its owner is suspended or left the workspace.                                                                                           | No                                           |
| **402** | **`budget_exceeded`**         | **A budget has no room for this request, even on a cheaper model. Nothing was sent. `type` is also `budget_exceeded`, so it is never mistaken for a provider error.** | **No, until the budget resets or is raised** |
| 403     | `forbidden`, `access_revoked` | Not allowed; or access was removed during the request.                                                                                                                | No                                           |
| 404     | `model_not_found`             | No such model or route, or no price for it.                                                                                                                           | No                                           |
| 404     | `not_found`                   | No such workspace, conversation or approval, or not yours.                                                                                                            | No                                           |
| 413     | `request_too_large`           | The request body is over 32 MB.                                                                                                                                       | No                                           |
| 422     | `no_model`                    | Nothing chose a model and the workspace has no default.                                                                                                               | No                                           |
| 422     | `provider_not_configured`     | No key for that model's provider.                                                                                                                                     | No                                           |
| 422     | `unsupported_input`           | The model cannot read the image or PDF attached.                                                                                                                      | No                                           |
| 429     | `rate_limited`                | You started more model requests than your rate limit allows; your keys count as you. Nothing was sent. `type` is `rate_limit_error`.                                  | Yes, after `Retry-After`                     |
| 502     | `upstream_unavailable`        | No provider answered in time, or each one refused for its rate limit.                                                                                                 | Yes                                          |
| 502     | `provider_auth_failed`        | The provider refused Lakka's key: an admin must fix it.                                                                                                               | No                                           |
| 502     | `provider_billing`            | The provider refused because of its account's billing, usually no credit left: an admin must fix it. Never a 402, which is only `budget_exceeded`.                    | No                                           |
| 502     | `provider_model_not_found`    | Lakka has the model, but its provider does not know the model id: an admin must correct it.                                                                           | No                                           |
| 502     | `stream_interrupted`          | The reply broke off.                                                                                                                                                  | Yes                                          |
| 503     | `budget_unavailable`          | Budgets or the rate limit cannot be checked right now, so nothing is served.                                                                                          | Yes, shortly                                 |
| 200     | `server_shutting_down`        | Lakka is restarting: the last event of a stream already sent.                                                                                                         | Yes                                          |
| 500     | `credential_key_unavailable`  | A stored credential needs a recovery key version the server was not given: an operator must fix it.                                                                   | No                                           |
| 500     | `internal_error`              | Something went wrong on Lakka's side; `x-lakka-request-id` identifies it.                                                                                             | Yes                                          |

A `budget_exceeded` error also carries `"lakka": {"scope", "remaining_micro_usd",
"required_micro_usd"}`: the cap that refused, its room left and what the request needed, in
millionths of a US dollar. An `upstream_unavailable` error names the `provider` there, and, when
it refused for its rate limit, `rate_limited: true` and `retry_after_seconds`. A
`provider_billing` error names the `provider`, and a `provider_model_not_found` error the
`provider` and the `model` it did not know. While Lakka
shuts down, a new request gets a plain 503 that is not in OpenAI's shape.

A `rate_limited` error comes with a `Retry-After` header in seconds, `retry-after-ms`, and
`"lakka": {"retry_after_seconds"}`. The official OpenAI SDKs wait and retry a 429 on their own;
anything else should wait that long before trying again. The limit is per person, not per key:
every key a person owns draws on the same allowance as their chat, in every workspace (see
[Configuration](configuration.md#rate-limit)). A key shared by a team, such as one key behind Open
WebUI, therefore gets one person's limit. For such an integration, give it an account of its own:
invite it to the workspace like a person, sign in as it once, and issue the key there. It then has
a limit of its own, and its spend shows under its own name.

A request refused before it was sent costs nothing. A reply that broke off is charged for what
the provider produced.
