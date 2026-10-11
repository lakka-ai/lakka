---
layout: home
title: A self-hosted AI control plane
hero:
  name: Lakka
  text: A self-hosted AI control plane for teams of 10 to 50 people
  tagline: Spend cannot exceed a cap, every request is attributed and traced, and a tool can never do what the person asking is not allowed to do.
  actions:
    - theme: brand
      text: Docs
      link: /guide/
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
    details: Each conversation goes to the model its routes pick, chosen by a classifier that runs offline inside the image.
    link: /guide/administration#routing
    linkText: Routing
  - title: Traced, and tools that keep to the rules
    details: Every request is traced with its cost and routing decision. Tools run as the person who asked; command-line servers run in a sandbox.
    link: /guide/administration#tools-and-mcp-servers
    linkText: Tools and MCP servers
---
