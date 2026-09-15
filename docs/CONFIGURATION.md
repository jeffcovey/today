# Configuration and Environment Variables

Today uses two configuration layers:

1. `config.toml` for normal settings like enabled plugins, calendar IDs, vault path, and schedules.
2. `.env` for secrets and runtime overrides, usually managed with `dotenvx`.

Most users should start with `bin/today configure`, which updates both files for you.

## Quick Start

1. Copy the examples you need from `.env.example` into your local `.env`.
2. Store secrets with `dotenvx` instead of editing plaintext by hand:

   ```bash
   npx dotenvx set KEY "value"
   ```

3. Keep normal settings in `config.toml`.
4. Keep `.env` and `.env.keys` out of git. Only `.env.example` is safe to commit.

## Required vs Optional Variables

No single environment variable is required for every installation.

- If you use the default Claude CLI workflow, you can often start without any AI API key in `.env`.
- If you use a cloud AI provider, the matching API key becomes required.
- If you enable the web UI, inbox API, or deployment features, their related variables become required or strongly recommended.

## Core Environment Variables

| Variable | Required when | Default | What it does | Example |
| --- | --- | --- | --- | --- |
| `TODAY_ANTHROPIC_KEY` | Using `anthropic-api` as a provider | none | Anthropic API key preferred by Today | `replace-with-anthropic-key` |
| `ANTHROPIC_API_KEY` | Legacy Anthropic API setup | none | Alternate Anthropic key name | `replace-with-anthropic-key` |
| `OPENAI_API_KEY` | Using OpenAI models | none | OpenAI API key | `replace-with-openai-key` |
| `OPENAI_BASE_URL` | Using Azure OpenAI or a compatible gateway | `https://api.openai.com/v1` behavior when unset | Overrides the OpenAI API base URL | `https://example.openai.endpoint/v1` |
| `GOOGLE_API_KEY` | Using Gemini models | none | Google AI Studio API key | `replace-with-google-ai-key` |
| `GEMINI_API_KEY` | Alternate Gemini setup | none | Alias for `GOOGLE_API_KEY` | `replace-with-google-ai-key` |
| `OLLAMA_HOST` | Ollama is not on the local default host | `http://localhost:11434` | Host used by local LLM helpers and compose integrations | `http://192.168.1.50:11434` |
| `OLLAMA_BASE_URL` | Ollama API is exposed on a custom URL | `http://localhost:11434/api` | Full Ollama API base URL for provider requests | `http://192.168.1.50:11434/api` |
| `CLAUDE_MODEL` | Only for legacy fallback behavior | `claude-sonnet-4-20250514` | Legacy API model override; prefer `config.toml` | `claude-sonnet-4-20250514` |
| `TODAY_CONFIG` | Using a non-default config location | `config.toml` | Points Today at a different config file | `/srv/today/config.toml` |
| `TZ` | Running services in containers/systemd | service-specific defaults | Sets process timezone for containerized jobs | `America/New_York` |
| `DOTENV_PRIVATE_KEY` | Decrypting encrypted `.env` values on a server/container | none | Private key used by `dotenvx` | stored in `.env.keys` |

## Web and API Variables

| Variable | Required when | Default | What it does | Example |
| --- | --- | --- | --- | --- |
| `WEB_PORT` | Running `bin/today web` on a custom port | `3000` | Port for the web UI | `8080` |
| `WEB_USER` | Wanting a non-default login username | `admin` | Web UI username | `jeff` |
| `WEB_PASSWORD` | Recommended for predictable web logins | auto-generated and encrypted on first start | Web UI password | `replace-with-a-random-password` |
| `SESSION_SECRET` | Recommended in production | random per process if unset | Signs session cookies | `generate-with-openssl-rand-hex-32` |
| `INBOX_API_PORT` | Running inbox API on a custom port | `3333` | Port for `src/inbox-api.js` | `3333` |
| `INBOX_API_KEY` | Recommended whenever inbox API is enabled | random per process if unset | Authenticates `/inbox/upload` requests | `generate-with-openssl-rand-hex-32` |
| `NODE_ENV` | Running production services | varies by launcher | Enables production behaviors like secure cookies | `production` |

## Deployment and Automation Variables

| Variable | Required when | Default | What it does | Example |
| --- | --- | --- | --- | --- |
| `DEPLOY_<PROVIDER>_<NAME>_IP` | Using `bin/deploy` for a non-local deployment | none | Server IP lookup for a deployment entry | `DEPLOY_DIGITALOCEAN_PRODUCTION_IP=203.0.113.10` |
| `DO_DROPLET_IP` | Using the legacy DigitalOcean production alias | none | Backwards-compatible IP variable | `203.0.113.10` |
| `GITHUB_TOKEN` | Remote deployment needs HTTPS git auth | none | Lets remote deploy scripts configure git credentials | `replace-with-github-token` |
| `DO_DEPLOY_KEY_PRIVATE` | Legacy devcontainer/unison deploy-key flow | none | Private SSH key used by helper scripts | `replace-with-private-key` |
| `DO_DEPLOY_KEY_PUBLIC` | Legacy devcontainer/unison deploy-key flow | none | Matching public SSH key | `replace-with-public-key` |
| `SKIP_DEP_CHECK` | Automating in containers/CI | unset/false | Skips dependency bootstrap checks | `true` |
| `SKIP_UPDATE_CHECK` | Automating or debugging | unset | Skips update checks in `bin/today` | `1` |
| `SKIP_DB_HEALTH` | Automating or debugging | unset | Skips database health checks | `1` |
| `SKIP_CONTEXT` | Testing/debugging | unset | Short-circuits context gathering | `true` |
| `SKIP_CONTEXT_CACHE` | Testing/debugging | unset | Bypasses cached context | `1` |
| `TODAY_QUIET` | Running quietly in scripts | unset | Suppresses some CLI output when `1` | `1` |
| `DEBUG` | Debugging | unset | Enables verbose logs in several commands | `true` |
| `DEBUG_AI` | Debugging AI activity | unset | Prints additional AI/debug output | `true` |
| `USE_BUILTIN_REPL` | Debugging interactive Anthropic mode | unset | Avoids Claude Code CLI for that path | `true` |

## Plugin Secrets

Encrypted plugin settings do not usually have fixed names. Today derives them from the plugin name, source name, and setting key:

```text
TODAY_<PLUGIN>_<SOURCE>_<SETTING>
```

Examples:

- `TODAY_IMAP_EMAIL_PERSONAL_PASSWORD`
- `TODAY_GOOGLE_CALENDAR_WORK_SERVICE_ACCOUNT_KEY`
- `TODAY_FRONT_CONVERSATIONS_DEFAULT_API_TOKEN`
- `TODAY_ICLOUD_CONTACTS_DEFAULT_APP_PASSWORD`

Use `bin/today configure` or `bin/plugins configure` whenever possible. Those commands keep non-secret values in `config.toml` and store only encrypted secrets in `.env`.

### Common plugin-backed integrations

- **IMAP email (Gmail, iCloud Mail, Fastmail, custom IMAP)**
  - Keep server settings like `host`, `port`, and `username` in `config.toml`.
  - Store the password as `TODAY_IMAP_EMAIL_<SOURCE>_PASSWORD`.
  - Prefer provider-issued app passwords over your primary mailbox password.
- **Google Calendar**
  - Create a Google Cloud service account.
  - Enable the Google Calendar API.
  - Share the target calendar with the service account email.
  - Base64-encode the JSON key and store it as `TODAY_GOOGLE_CALENDAR_<SOURCE>_SERVICE_ACCOUNT_KEY`.
- **iCloud Contacts**
  - Use your Apple ID in `config.toml`.
  - Generate an Apple app-specific password and store it as `TODAY_ICLOUD_CONTACTS_<SOURCE>_APP_PASSWORD`.
- **Front, Sentry, Healthchecks.io, YNAB**
  - Put the non-secret identifiers in `config.toml`.
  - Put API tokens in the matching `TODAY_<PLUGIN>_<SOURCE>_<SETTING>` variable.

## Where to Get Keys and Passwords

- **Anthropic**: create a key in <https://console.anthropic.com/>.
- **OpenAI**: create a key in <https://platform.openai.com/api-keys>.
- **Google Gemini**: create a key in <https://aistudio.google.com/apikey>.
- **Google Calendar service account**: create a service account in Google Cloud Console, enable Calendar API, then download the JSON key.
- **Apple app-specific passwords**: create one from your Apple ID security settings before using iCloud-backed integrations.
- **Front**: generate an API token from your Front workspace developer settings.
- **Healthchecks.io**: copy the API key from your account settings.
- **Sentry**: create a personal or internal integration token with the scopes your plugin needs.
- **YNAB**: create a personal access token from <https://app.ynab.com/settings/developer>.

## Security Best Practices

- Never commit `.env`, `.env.keys`, SSH keys, or real API tokens.
- Commit `.env.example`, not your live secrets.
- Treat `DOTENV_PRIVATE_KEY` like a production secret; anyone with it can decrypt your encrypted `.env` values.
- Use app-specific passwords for Apple/iCloud and Gmail instead of your main account password.
- Prefer least-privilege API keys and service accounts.
- Rotate keys after sharing a machine, publishing a screenshot, or suspecting leakage.
- Use different secrets for local development and remote deployments.
- Prefer `bin/today configure` so encrypted plugin settings stay out of `config.toml`.
