---
layout: home
title: A self-hosted AI control plane
hero:
  name: Lakka
  text: A self-hosted AI control plane for teams of 10 to 50 people
  tagline: Use its chat, or point the apps your team already uses at its OpenAI-compatible API. Either way, spend cannot exceed a cap, every request is attributed and traced, and a tool can never do what the person asking is not allowed to do.
  actions:
    - theme: brand
      text: Docs
      link: /guide/
    - theme: alt
      text: Take the tour
      link: /guide/tour
features:
  - title: One set of rules for every surface
    details: Web chat, the OpenAI-compatible API and MCP tools check one set of people, permissions and budgets. A key acts for the person who made it.
    link: /guide/administration#workspaces
    linkText: Workspaces and people
  - title: Caps that hold
    details: Every cap in the chain is reserved before a request is sent. If the stores cannot be reached, the request is refused.
    link: /guide/administration#budgets-and-spend
    linkText: Budgets and spend
  - title: Routing to the right model
    details: Ask for the model auto, from chat or from any app, and the workspace's routes pick the model for each request. The classifier that matches them runs offline inside the image.
    link: /guide/administration#routing
    linkText: Routing
  - title: Traced, and tools that keep to the rules
    details: Every request is traced with its cost and routing decision. Tools run as the person who asked; command-line servers run in a sandbox.
    link: /guide/administration#tools-and-mcp-servers
    linkText: Tools and MCP servers
---
