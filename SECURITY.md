# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately by opening a security advisory on GitHub:

- [GitHub Security Advisories](https://github.com/marceloceccon/askgrokmcp/security/advisories)

Do not open public issues for undisclosed vulnerabilities.

## Scope

This project handles:

- xAI API authentication via `XAI_API_KEY` when `GROK_BACKEND=api`
- A local `grok` CLI login session when `GROK_BACKEND=cli`. Child processes have `XAI_API_KEY` and `GROK_CODE_XAI_API_KEY` removed. Imagine runs in a temporary directory with only the `image_gen` tool allowed, and image bytes are read only from that directory or the grok home
- Local file writes for generated images (constrained by `SAFE_WRITE_BASE_DIR`)
- MCP tool requests over stdio

## Security best practices

- Use least-privilege API keys.
- Keep `SAFE_WRITE_BASE_DIR` restricted to a controlled directory.
- Leave `LOG_REQUEST_PAYLOADS` disabled unless required for debugging.
