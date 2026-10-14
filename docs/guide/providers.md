# Adding a provider

The built-in providers (Anthropic, OpenAI, Google, DeepSeek, Moonshot AI, Qwen Cloud, Xiaomi MiMo
and Z.ai) need only a key, and their models come priced in the catalogue. Anything else that
speaks the OpenAI Chat Completions API can be added too: a hosted service such as OpenRouter, or a
server you run, such as Ollama or vLLM. It takes two steps, both on **Models and providers**, and
both for instance admins:

1. add the provider: a name, its address and its key;
2. add each model you want people to use, with its limits and prices.

Lakka prices every request before it is sent, so it never calls a model you have not priced.
Adding a provider makes none of its models available by itself.

This page adds [OpenRouter](https://openrouter.ai), which serves models from many providers
through one key, and one of its models, Mistral Medium 3.5. The same steps fit any other
OpenAI-compatible service; [Servers you run](#servers-you-run) covers what is different for those.

## Before you start

- An OpenRouter account with credit, and an API key from its **Keys** page. Keys start with
  `sk-or-`.
- The models you want. Each one is added by hand, so pick the few your people need rather than
  the whole list.

## Add the provider

On the **Model providers** tab of **Models and providers**, choose **Add a provider**:

| Field                        | For OpenRouter                 | Notes                                                                                                                                                                    |
| ---------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Name**                     | `openrouter`                   | Lowercase letters, numbers and dashes. It is the first part of every model name, `openrouter:<model>`, and cannot change later. The built-in providers' names are taken. |
| **Address**                  | `https://openrouter.ai/api/v1` | The API base with its path, without `/chat/completions`: Lakka adds that, and `/models` for the check. A trailing slash is dropped.                                      |
| **API key, if it needs one** | your `sk-or-...` key           | Stored encrypted and never shown again.                                                                                                                                  |

**Save and check** saves it and checks it at once. The new row on the tab says what the check
found.

### What the check proves

**Check** lists the provider's models, which costs nothing. For most providers that proves the
key works. OpenRouter lists its models to anyone, with or without a key, so for OpenRouter
**Connected** only proves the address is right: a mistyped key shows **Connected** too. Send one
request once you have added a model ([Try it](#try-it)) to know the key works.

The provider's key is for the whole instance: every workspace uses it, and Lakka's spend
reports still split the cost by workspace, person and key. A workspace cannot add its own key for
a provider you added; workspace keys are for the built-in providers only.

## Add a model

### Find its details

Each model on OpenRouter has a page at `https://openrouter.ai/<model id>`, such as
[openrouter.ai/mistralai/mistral-medium-3-5](https://openrouter.ai/mistralai/mistral-medium-3-5),
with its id, context window and prices. Its **Providers** tab lists every provider that serves it
on OpenRouter, each with its own limits and prices.

The same details, for every upstream provider of one model, come from OpenRouter's API, which
needs no key. With `jq` installed:

```
curl -s https://openrouter.ai/api/v1/models/mistralai/mistral-medium-3-5/endpoints | jq '.data | {id, architecture, endpoints: [.endpoints[] | {provider_name, context_length, max_completion_tokens, input: ((.pricing.prompt | tonumber) * 1000000), output: ((.pricing.completion | tonumber) * 1000000), tools: (.supported_parameters | index("tools") != null)}]}'
```

The API gives prices per token; the command turns them into dollars per million tokens, which is
what Lakka asks for.

### Enter it

Under **Models you added** on the **Models** tab, choose **Add a model**:

| Field                               | For Mistral Medium 3.5                    | Where it comes from                                                                                                            |
| ----------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Model name**                      | `openrouter:mistralai/mistral-medium-3-5` | Your provider's name, a colon, then OpenRouter's model id exactly, slash included. It cannot change later: routes point to it. |
| **Display name**                    | `Mistral Medium 3.5`                      | What people see in the model picker. Made from the model name if left empty.                                                   |
| **Context window**                  | `262144`                                  | `context_length`.                                                                                                              |
| **Output limit**                    | `209715`                                  | `max_completion_tokens`, or less. See [the output limit](#the-output-limit).                                                   |
| **Input price per million tokens**  | `1.65`                                    | The highest input price among its providers. See [prices](#prices).                                                            |
| **Output price per million tokens** | `8.25`                                    | The highest output price among its providers.                                                                                  |
| **It can read**: Images, PDF files  | both                                      | Images when `input_modalities` has `image`; PDF files when it has `file`.                                                      |
| **It can call tools**               | checked                                   | When `tools` is true. Untick it otherwise.                                                                                     |

**Add model**. It can be picked in chat and named in the API at once, and it is listed by
`GET /v1/models` for every workspace.

The prices above were OpenRouter's when this page was written. Use what its page shows today.

### Prices

The prices you enter are what Lakka holds against budgets before each request and charges
after it, so a cap is only as exact as they are. Lakka never asks OpenRouter what a request
cost.

- **Several providers, several prices.** OpenRouter may send a request to any provider of the
  model, and they do not all charge the same: Mistral Medium 3.5 is $1.50 and $7.50 per million
  tokens from one and $1.65 and $8.25 from another. Enter the highest, so a cap is never overspent.
  Lakka may then charge a little more than OpenRouter bills; it never charges less.
- **Long inputs.** If a model charges more above some input size, enter the higher price.
- **Cached input** is charged at the input price, since a model you add has no cache price. That
  is above what OpenRouter bills for it, never below.
- **Reasoning** counts as output, as OpenRouter bills it.
- **Variants are separate models.** An id with a suffix, such as `:free` or `:batch`, is its own
  model on OpenRouter with its own prices and limits; add it under its full id if you want it. A
  model priced at $0.00 is never held against a budget, so its use is not capped; the rate limit
  still applies.

### The output limit

Lakka sends the output limit with every request that does not set its own, and holds that many
output tokens against the budget until the reply is in. With the full 209,715 tokens at $8.25 per
million, each request holds about $1.73 while it runs, which on a small budget can send requests
to a cheaper model or refuse them. A lower limit, such as `32768`, holds less and caps every reply
at that length. OpenRouter also refuses a request whose output limit its remaining credit cannot
cover.

### Capabilities

A model is only sent what you said it can read. Unticked, Lakka passes over it for a request
with images or PDF files, or one that offers tools, and moves to the next fallback, so a wrong tick
costs a failed request and a wrong untick only an unused model.

## Try it

In chat, start a conversation and pick **Mistral Medium 3.5**. Or with an API key (see
[The API](api.md)):

```
curl https://ai.example.com/v1/chat/completions \
  -H "Authorization: Bearer lk_..." -H "Content-Type: application/json" \
  -d '{"model": "openrouter:mistralai/mistral-medium-3-5", "messages": [{"role": "user", "content": "Hello"}]}'
```

A reply proves the key works. The `x-lakka-model` header names the model that answered, and
the request shows in the workspace's spend and traces like any other.

To use the model without anyone naming it, make it a workspace's **Default model**, or the model
or a fallback of a route, on that workspace's **Routing** page (see
[Administration](administration.md#routing)).

## Servers you run

The steps are the same for a server on your own hardware, such as Ollama, vLLM or LM Studio. What
differs:

- **The address is as Lakka's server reaches it**, from inside its container. `localhost` there
  is the container itself, not your machine.
  - A server in the same compose project: its service name, such as `http://ollama:11434/v1`.
  - A server on the same machine, with Docker Desktop: `http://host.docker.internal:11434/v1`.
  - A server elsewhere, or on the same Linux machine: its address on your network, such as
    `http://192.168.1.20:8000/v1`. The server must listen on that address, not only on
    `127.0.0.1`.
- **The usual addresses**: Ollama `http://<host>:11434/v1`, vLLM `http://<host>:8000/v1`, LM
  Studio `http://<host>:1234/v1`.
- **The key** is often not needed. Leave it empty if the server takes none.
- **The check proves the address.** A server that takes no key always says **Connected** when it
  answers.
- **The model id** is the server's own, such as `ollama:llama3.3:70b`; Ollama's tags keep their
  colon. `ollama list` or `GET /v1/models` on the server shows them.
- **Prices** can be $0.00 on your own hardware. Requests to it are then not capped by budgets, only
  by the rate limit.
- **The context window** is what the server runs the model with, which can be less than the
  model's own: Ollama, for one, uses a shorter window unless you set a longer one. Enter a larger
  window than the server runs and long inputs are cut short or refused by the server, instead of
  sent by Lakka to a model that fits.

For a built-in provider's mainland China region, add it the same way, under its own name, with
that region's address and prices.

## Changing or removing it

- **Change address**, on the provider's row, changes its address, its key, or both. Leave the key
  empty to keep the one saved. It saves and checks.
- **Edit**, on a model's row, changes everything but its model name. To rename a model, add it
  again under the new name, point routes at it, and remove the old one.
- **Remove** on a model asks first. Routes that send to it then need another model; check
  **Routing** in each workspace.
- **Remove** on the provider asks first. Requests to its models are then refused, and its models
  stay under **Models you added** until you remove them; add the provider again under the same
  name and they work again. To rename a provider, add it again under the new name, with
  its models, and remove the old one.

## When it does not work

- **Could not connect** on the check: nothing answered at the address. Check it from the server
  Lakka runs on, and that the address ends in `/v1` or whatever path the provider's API uses.
- **Key refused** on the check: the provider did not accept the key. **Change address** and enter
  it again.
- **`provider_not_configured` (422)**: the model's provider part does not match a provider's
  **Name**. Model names are `<provider>:<model>` exactly.
- **`model_not_found` (404)**: no model by that name in Lakka. Add it under **Models you added**.
- **`provider_auth_failed` (502)** on a request: the provider refused the key. **Change address**
  and enter it again.
- **`provider_billing` (502)**: the provider refused because of its account's billing. The
  account is most often empty, or, from OpenRouter, its credit does not cover the model's output
  limit. Top it up, or lower the [output limit](#the-output-limit). **Check** does not catch
  this: listing models is free.
- **`provider_model_not_found` (502)**: the model id after the colon is not one the provider
  knows. Copy it again from the provider's model list, suffix included. **Check** does not catch
  this either: it tests the key, not each model.
- **`provider_rejected_request` (400)** on every request: the provider turned the request down
  for another reason, such as an option the model does not take.

[Troubleshooting](troubleshooting.md) has the rest.
