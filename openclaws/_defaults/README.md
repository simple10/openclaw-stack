# Default Configs

This dir contains the default fallback configuration files used when an OpenClaw instance
does not have it's own configuration.

- `openclaw.json` - main OpenClaw config file
- `models.json` - provider base URL patch to route LLM requests to the AI Gateway Proxy Worker

Both `openclaw.json` and `models.json` are override only, not merge.

If an OpenClaw instance has an `openclaw.json` file, then the default openclaw.json config
in this dir is ignored for that OpenClaw instance.
