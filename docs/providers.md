# Model providers

Excalibur talks to models through the **Model Gateway**, configured in `.excalibur/models/providers.yaml`.

> **Real, not mock.** The `anthropic`, `openai-compatible` (incl. vLLM, OpenRouter and any custom OpenAI-style endpoint), and `ollama` adapters are shipped and live — real streaming, real token/cost accounting, and secret redaction. A built-in deterministic **mock** still exists, but only as the zero-config offline default and as a CI test double — its output is always prefixed `> Mock provider` so it's never mistaken for a real model. The mock is never a silent runtime fallback for an interactive user: onboarding always wires up a real provider (or free local Ollama).

## Configuring

The friendly way:

```bash
excalibur models setup
```

Pick a provider from the catalog — **Kimi K2 (Moonshot)** (recommended), **MiniMax**, **GLM (Zhipu / Z.ai)**, Anthropic, OpenAI, Google Gemini, DeepSeek, OpenRouter, plus fast inference hosts **Groq**, **xAI (Grok)**, **Cerebras**, **Together** and **Fireworks** — plus free local **Ollama** (auto-detected when installed), a keyless **self-hosted** endpoint (vLLM/TGI/your own Qwen gateway), or "configure later". For a hosted provider you simply **paste your API key** (masked); Excalibur saves it to a global secrets store (`~/.config/excalibur/secrets.env`, mode `0600`) and loads it on every launch. `providers.yaml` records only the **name of the environment variable** that holds the key — never the value — so the committed config stays secret-free. Pasting one key auto-configures a curated good + fast model pair (`default` + `cheap`).

The resulting file (OSS spec §14 format):

```yaml
providers:
  default: kimi
  cheap: kimi-fast
  kimi:
    type: openai-compatible
    baseUrl: https://api.moonshot.ai/v1
    apiKeyEnv: MOONSHOT_API_KEY
    model: kimi-k2.7-code
  kimi-fast:
    type: openai-compatible
    baseUrl: https://api.moonshot.ai/v1
    apiKeyEnv: MOONSHOT_API_KEY
    model: moonshot-v1-8k
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

Provider types: `openai-compatible`, `anthropic`, `ollama`, `vllm`, `custom`, `mock`. `vllm` and `custom` are convenience **aliases** of `openai-compatible` (same wire format) — use whichever reads clearer in your config. OpenRouter, Groq, xAI, Cerebras, Together and Fireworks are all `openai-compatible` with their own `baseUrl` (e.g. OpenRouter `https://openrouter.ai/api/v1`, Groq `https://api.groq.com/openai/v1`). The `default` and `cheap` keys are **role pointers** (each names a configured provider, not a provider itself): `default` is the main model, `cheap` the fast/low-cost one used for latency-sensitive roles (ghost-text, context compaction). Per-provider knobs like `extraBody`, `timeoutMs`, `maxRetries`, `apiVersion` and `organization` are also supported.

### Azure OpenAI

Azure OpenAI speaks the OpenAI wire format but routes by **deployment** and
authenticates with an `api-key` header. Configure it as an `openai-compatible`
provider with an `azure` block — `baseUrl` is the resource root and the `model`
is your **deployment** name:

```yaml
providers:
  azure:
    type: openai-compatible
    baseUrl: https://<your-resource>.openai.azure.com
    apiKeyEnv: AZURE_OPENAI_API_KEY
    model: my-gpt4o-deployment # the Azure deployment name
    azure:
      apiVersion: '2024-02-01'
```

Excalibur then calls `…/openai/deployments/<model>/chat/completions?api-version=…`
with the `api-key` header. (Google Gemini works today via Google's
OpenAI-compatible endpoint as a plain `openai-compatible` provider with its
`baseUrl`. Amazon Bedrock and Anthropic-on-Vertex need cloud-native signing/auth
and are tracked separately.)

```bash
excalibur models list      # shows configured providers, the active one, and per-provider status
excalibur models test      # sends a tiny request to confirm the provider works
excalibur doctor           # also checks that the named env vars are set, plus the proxy/CA plan
```

## Key handling rules

- **API keys are never stored in `.excalibur/`** — only environment variable names (`apiKeyEnv`). A pasted key lives in `~/.config/excalibur/secrets.env` (`0600`), outside any repo.
- A variable already set in the real environment always wins; the secrets file only fills gaps, so an explicit `export` or CI-injected key is never clobbered.
- Resolved key values are never logged or persisted.
- Prompts and logs pass through secret redaction (OpenAI/AWS/GitHub/Slack token shapes, private key blocks, `Authorization` headers, `password=`/`apiKey:` values → `[REDACTED]`).

## Cost metadata

Optional per-provider cost rates produce `costCents` on every call (recorded in `model-calls.jsonl` and artifact metadata):

```yaml
kimi:
  type: openai-compatible
  baseUrl: https://api.moonshot.ai/v1
  apiKeyEnv: MOONSHOT_API_KEY
  inputCostPerMillionTokensCents: 40
  outputCostPerMillionTokensCents: 120
```

## Routing

`.excalibur/models/routing.yaml` (a declarative `model_routing` extension) and the `models:` section in `config.yaml` route by role, path or workflow:

```yaml
models:
  default: kimi
  byRole:
    planner: kimi
    implementer: minimax
    security: local-secure
  byPath:
    'src/auth/**': local-secure
```

## Corporate proxy & custom CA

Egress (model, web and MCP) honors standard `HTTP(S)_PROXY` / `NO_PROXY` and `NODE_EXTRA_CA_CERTS`, so Excalibur works behind a corporate proxy with a custom certificate authority out of the box. `excalibur doctor` reports the effective proxy/CA plan. Repo-supplied `config.network` settings are honored only when you opt in with `EXCALIBUR_TRUST_REPO_NETWORK`.

## No provider configured?

Nothing breaks. The interactive onboarding always offers a real provider (including free local Ollama and keyless self-hosted endpoints) and points at `excalibur models setup` — you'll never see a raw stack trace because a key is missing. The deterministic mock is reachable only via the explicit non-interactive hatch (`excalibur models setup --yes`, used by tests/CI) or a hand-written `type: mock` entry.
