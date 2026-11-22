# Notes for Claude Code

- Read README.md first; it is the spec. `reference/current-app.html` is the working v1 to match in behaviour and look.
- Håkan works from an iPad. Prefer steps he can do in the Cloudflare dashboard or that you can run with Wrangler; explain dashboard steps briefly.
- Keep it simple: plain HTML/CSS/JS or a light framework, no heavy build chain unless it clearly pays off.
- UI text in Swedish. Talk to Håkan in English (or Swedish if he writes Swedish), concise and practical.
- Never commit secrets (Garmin keys, Cloudflare tokens). Use Worker secrets and `.dev.vars` (gitignored).
- Keep the set text format exactly as documented. Parsed values are derived from it.
