"""The official OpenAI Python SDK against the running stack (AC 15, ADR 0064).

Runs in a python container on the compose network, never in the product, which has no Python
runtime. It reads the state test/compat/global-setup.ts wrote, and uses nothing but a base URL and
a key, with the SDK's ordinary API. Exits non-zero on the first failed check.
"""

import json
import os
import sys
import time

import httpx2
import openai

state = json.load(open(os.environ.get("LAKKA_COMPAT_STATE", "/compat/.state.json")))
api_base = os.environ.get("LAKKA_COMPAT_API_BASE", state["apiBase"])
models = state["models"]
client = openai.OpenAI(base_url=api_base, api_key=state["key"])
results = {}


def check(name):
    def run(fn):
        try:
            fn()
            results[name] = "ok"
        except Exception as error:  # noqa: BLE001 - every failure is reported, then fatal
            results[name] = f"failed: {type(error).__name__}: {error}"
        return fn

    return run


@check("API-2: lists auto, the routes and the models the key may use")
def _():
    ids = [m.id for m in client.models.list()]
    assert ids[:2] == ["auto", "route/" + state["route"]], ids
    assert set(models.values()) <= set(ids), ids


@check("API-1: a completion, with the routing decision in the headers")
def _():
    raw = client.chat.completions.with_raw_response.create(
        model=models["ok"], messages=[{"role": "user", "content": "Hello"}]
    )
    completion = raw.parse()
    assert completion.choices[0].message.content == "Hello there", completion
    assert completion.choices[0].finish_reason == "stop", completion
    assert completion.model == models["ok"], completion
    assert raw.headers["x-lakka-routing-rule"] == "explicit", raw.headers


@check("API-1: a streamed completion, arriving as it is sent, with usage when asked")
def _():
    started = time.monotonic()
    arrivals, text, usage = [], "", None
    stream = client.chat.completions.create(
        model=models["slow"],
        messages=[{"role": "user", "content": "Count"}],
        stream=True,
        stream_options={"include_usage": True},
    )
    for chunk in stream:
        if chunk.usage is not None:
            usage = chunk.usage
        if chunk.choices and chunk.choices[0].delta.content:
            text += chunk.choices[0].delta.content
            arrivals.append(time.monotonic() - started)
    assert len(arrivals) >= 30, len(arrivals)
    assert arrivals[-1] - arrivals[0] > 0.6, arrivals
    assert usage is not None and usage.completion_tokens > 0, usage


@check("API-4: auto routes code to the code route; route/<name> asks for it")
def _():
    code = "Why does this fail?\n```py\nx = 1\nx()\n```"
    routed = client.chat.completions.create(
        model="auto", messages=[{"role": "user", "content": code}]
    )
    assert routed.model == models["coder"], routed.model
    named = client.chat.completions.create(
        model="route/" + state["route"], messages=[{"role": "user", "content": "Hello"}]
    )
    assert named.model == models["coder"], named.model


@check("API-5, G2: a budget refusal is a 402 of its own, which the SDK does not retry")
def _():
    calls = []
    poor = openai.OpenAI(
        base_url=api_base,
        api_key=state["poorKey"],
        http_client=httpx2.Client(event_hooks={"request": [lambda r: calls.append(r)]}),
    )
    try:
        poor.chat.completions.create(model="auto", messages=[{"role": "user", "content": "Hi"}])
    except openai.APIStatusError as error:
        assert error.status_code == 402, error.status_code
        assert error.code == "budget_exceeded", error.code
        assert error.type == "budget_exceeded", error.type
    else:
        raise AssertionError("the request was not refused")
    assert len(calls) == 1, len(calls)


@check("API-5: a bad key and an unknown model are the errors the SDK knows")
def _():
    stranger = openai.OpenAI(base_url=api_base, api_key="sk-not-a-real-key")
    try:
        stranger.models.list()
    except openai.AuthenticationError:
        pass
    else:
        raise AssertionError("a bad key was accepted")
    try:
        client.chat.completions.create(
            model="nobody:nothing", messages=[{"role": "user", "content": "Hi"}]
        )
    except openai.NotFoundError as error:
        assert error.code == "model_not_found", error.code
    else:
        raise AssertionError("an unknown model was accepted")


@check("CH-7: a stream that breaks after it started ends with an error the SDK raises")
def _():
    text = ""
    try:
        for chunk in client.chat.completions.create(
            model=models["drop"], messages=[{"role": "user", "content": "Hi"}], stream=True
        ):
            if chunk.choices and chunk.choices[0].delta.content:
                text += chunk.choices[0].delta.content
    except openai.APIError as error:
        assert "interrupted" in str(error), str(error)
    else:
        raise AssertionError("the broken stream ended without an error")
    assert text != "", text


print(json.dumps({"openai": openai.__version__, "checks": results}, indent=2))
sys.exit(0 if all(r == "ok" for r in results.values()) else 1)
