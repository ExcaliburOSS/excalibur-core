# Model providers

Excalibur talks to models through the **Model Gateway**, configured in `.excalibur/models/providers.yaml`.

> **M1 honesty.** Only the built-in **mock** provider executes in M1. You can configure real providers today — the configuration is validated and stored — but every call runs on the deterministic mock until real adapters land in M2. Mock output always begins with `> Mock provider (M1)` so it can never be mistaken for a real model.

## Configuring

The friendly way:

```bash
excalibur models setup
```

One question: OpenAI-compatible, Anthropic, OpenRouter, Ollama (auto-detected when installed locally), the built-in mock, or "configure later". For hosted providers Excalibur asks for the **name of the environment variable** holding your API key — never the key itself.

The resulting file (OSS spec §14 format):

```yaml
providers:
  default: qwen
  qwen:
    type: openai-compatible
    baseUrl: https://dashscope-intl.aliyuncs.com/compatible-mode/v1
    apiKeyEnv: QWEN_API_KEY
  deepseek:
    type: openai-compatible
    baseUrl: https://api.deepseek.com/v1
    apiKeyEnv: DEEPSEEK_API_KEY
  local:
    type: openai-compatible
    baseUrl: http://localhost:8000/v1
    apiKeyEnv: LOCAL_MODEL_API_KEY
  ollama:
    type: ollama
    baseUrl: http://localhost:11434
    model: llama3
  mock:
    type: mock
```

Provider types: `openai-compatible`, `anthropic`, `ollama`, `vllm`, `custom`, `mock`. OpenRouter is `openai-compatible` with `baseUrl: https://openrouter.ai/api/v1`.

```bash
excalibur models list      # shows providers; real ones are flagged "available in M2"
excalibur doctor           # also checks that the named env vars are set
```

## Key handling rules

- **API keys are never stored in `.excalibur/`** — only environment variable names (`apiKeyEnv`).
- Resolved key values are never logged or persisted.
- Prompts and logs pass through secret redaction (OpenAI/AWS/GitHub/Slack token shapes, private key blocks, `Authorization` headers, `password=`/`apiKey:` values → `[REDACTED]`).

## Cost metadata

Optional per-provider cost rates produce `costCents` on every call (recorded in `model-calls.jsonl` and artifact metadata):

```yaml
  qwen:
    type: openai-compatible
    baseUrl: https://example/v1
    apiKeyEnv: QWEN_API_KEY
    inputCostPerMillionTokensCents: 40
    outputCostPerMillionTokensCents: 120
```

## Routing

`.excalibur/models/routing.yaml` (a declarative `model_routing` extension) and the `models:` section in `config.yaml` route by role, path or workflow:

```yaml
models:
  default: qwen
  byRole:
    planner: qwen
    implementer: minimax
    security: local-secure
  byPath:
    "src/auth/**": local-secure
```

## No provider configured?

Nothing breaks. Commands that need a model fall back to the built-in mock and tell you so, pointing at `excalibur models setup`. You will never see a raw stack trace because a key is missing.
