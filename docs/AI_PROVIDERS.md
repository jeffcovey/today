# AI Providers

Today supports multiple AI providers for background tasks like auto-tagging, summaries, and natural language search. You can also configure a separate provider for interactive sessions.

## Quick Start

Run `bin/today configure` and navigate to **AI Settings** to select your providers, or edit `config.toml` directly.

## Supported Providers

| Provider | Best For | Cost |
|----------|----------|------|
| **Anthropic** | High-quality responses, complex reasoning | Pay-per-use |
| **OpenAI** | GPT-4, broad compatibility | Pay-per-use |
| **Ollama** | Privacy, offline use, no API costs | Free (local) |
| **Gemini** | Google ecosystem integration | Free tier available |

## Configuration Overview

```toml
[ai]
# Background tasks (auto-tagging, summaries, search)
provider = "anthropic"           # anthropic, openai, ollama, or gemini
model = "claude-sonnet-4-20250514"

# Interactive sessions (bin/today)
interactive_provider = "anthropic"  # Only anthropic supported currently
interactive_model = "opus"          # opus, sonnet, or haiku
```

---

## Anthropic (Claude)

The default provider. Requires an API key.

### Setup

1. Get an API key from [console.anthropic.com](https://console.anthropic.com/)

2. Set the environment variable:

   ```bash
   export ANTHROPIC_API_KEY="sk-ant-..."
   # Or use TODAY_ANTHROPIC_KEY for Today-specific key
   ```

3. Configure (optional - Anthropic is the default):

   ```toml
   [ai]
   provider = "anthropic"
   model = "claude-sonnet-4-20250514"  # or claude-opus-4-20250514
   ```

### Models

See [Anthropic's model documentation](https://docs.anthropic.com/en/docs/about-claude/models) for current models and capabilities.

Our defaults: `claude-sonnet-4-20250514` (background), `opus`/`sonnet`/`haiku` (interactive).

---

## OpenAI (GPT-4)

Use OpenAI's GPT models.

### Setup

1. Get an API key from [platform.openai.com](https://platform.openai.com/)

2. Set the environment variable:

   ```bash
   export OPENAI_API_KEY="sk-..."
   ```

3. Configure:

   ```toml
   [ai]
   provider = "openai"
   model = "gpt-4o"  # or gpt-4-turbo, gpt-3.5-turbo
   ```

### Custom Base URL

For Azure OpenAI or compatible APIs:

```toml
[ai]
provider = "openai"
model = "gpt-4"

[ai.openai]
base_url = "https://your-resource.openai.azure.com/openai/deployments/gpt-4"
```

### Models

See [OpenAI's model documentation](https://platform.openai.com/docs/models) for current models.

Our default: `gpt-4o`.

---

## Ollama (Local Models)

Run AI models locally with no API costs or data leaving your machine.

### Setup

1. Install Ollama:

   ```bash
   # macOS/Linux
   curl -fsSL https://ollama.com/install.sh | sh

   # Or via Homebrew
   brew install ollama
   ```

2. Pull a model:

   ```bash
   ollama pull llama3.2
   ```

3. Start Ollama (runs automatically on install, or):

   ```bash
   ollama serve
   ```

4. Configure:

   ```toml
   [ai]
   provider = "ollama"
   model = "llama3.2"
   ```

### Custom Ollama Server

If Ollama runs on a different machine:

```toml
[ai]
provider = "ollama"
model = "llama3.2"

[ai.ollama]
base_url = "http://192.168.1.100:11434"
```

### Models

Browse available models at [ollama.com/library](https://ollama.com/library).

Our default: `llama3.2`.

### Checking Installed Models

```bash
ollama list
```

### Pulling New Models

```bash
ollama pull mistral
ollama pull codellama
```

---

## Google Gemini

Use Google's Gemini models.

### Setup

1. Get an API key from [Google AI Studio](https://aistudio.google.com/apikey)

2. Set the environment variable:

   ```bash
   export GOOGLE_API_KEY="..."
   # Or GEMINI_API_KEY
   ```

3. Configure:

   ```toml
   [ai]
   provider = "gemini"
   model = "gemini-1.5-flash"
   ```

### Models

See [Google's Gemini models](https://ai.google.dev/gemini-api/docs/models/gemini) for current options.

Our default: `gemini-1.5-flash`.

---

## Interactive vs Background Providers

Today uses two separate AI configurations:

### Background Provider

Used for automated tasks that run without user interaction:
- Auto-tagging tasks and notes
- Generating daily summaries
- Natural language search
- Plan suggestions

```toml
[ai]
provider = "ollama"  # Can be any provider
model = "llama3.2"
```

### Interactive Provider

Used for `bin/today` conversational sessions:

```toml
[ai]
interactive_provider = "anthropic"  # Only anthropic supported
interactive_model = "opus"          # opus, sonnet, or haiku
```

**Note:** Interactive sessions currently only support Anthropic because they use the Claude Code CLI, which requires Anthropic's API.

### Example: Local Background, Cloud Interactive

Run background tasks locally for free, but use Claude for interactive sessions:

```toml
[ai]
provider = "ollama"
model = "llama3.2"
interactive_provider = "anthropic"
interactive_model = "sonnet"
```

---

## Troubleshooting

### "API key not configured"

Set the appropriate environment variable for your provider:

```bash
# Anthropic
export ANTHROPIC_API_KEY="sk-ant-..."

# OpenAI
export OPENAI_API_KEY="sk-..."

# Gemini
export GOOGLE_API_KEY="..."
```

### Ollama: "Connection refused"

Make sure Ollama is running:

```bash
ollama serve
```

Check if it's accessible:

```bash
curl http://localhost:11434/api/tags
```

### Ollama: "Model not found"

Pull the model first:

```bash
ollama pull llama3.2
```

### Slow responses with Ollama

- Use a smaller model (`llama3.2` instead of `llama3.2:70b`)
- Ensure you have enough RAM (8GB minimum, 16GB+ recommended)
- Check CPU/GPU utilization

### Testing your configuration

```bash
# Check if AI is available
node -e "import('./src/ai-provider.js').then(m => m.isAIAvailable().then(console.log))"
```

---

## Environment Variables Reference

| Variable | Provider | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic | API key |
| `TODAY_ANTHROPIC_KEY` | Anthropic | Alternative (takes precedence) |
| `OPENAI_API_KEY` | OpenAI | API key |
| `OPENAI_BASE_URL` | OpenAI | Custom API endpoint |
| `GOOGLE_API_KEY` | Gemini | API key |
| `GEMINI_API_KEY` | Gemini | Alternative |
| `OLLAMA_BASE_URL` | Ollama | Custom server URL |
