---
name: ask-grok
description: Use when the user wants a Grok answer or an Imagine image from the askgrok plugin. The grok MCP tools call the signed-in grok CLI and spend the Grok subscription.
---

# Ask Grok

Call the grok MCP tools. Those tools run the grok CLI.

- A question, review, consensus run, or validation goes to `ask_grok`, `grok_consensus`, or `grok_validate`.
- A picture goes to `generate_image` with the description and a file path. Imagine writes the file.
- Omit `temperature`, `max_tokens`, and `top_p`. This plugin's backend rejects them.
- Pass `model` on `ask_grok` to select a chat model from `list_models`. Imagine picks its own image model.
