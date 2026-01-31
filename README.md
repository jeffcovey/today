# Today

`today` pulls in all the information you track or which is flowing into your life, and hands it to an AI that helps you work and play. Any AI provider can be used, allowing whatever mixture of purely-local and cloud-based data sharing makes you comfortable.

## Examples

### Web Interface

![Today Web Interface](docs/images/today.png)

### Command Line Interface

```
$ bin/today --no-sync --non-interactive now
[dotenvx@1.51.1] injecting env (30) from .env
[dotenvx@1.51.1] injecting env (0) from .env
🔍 Checking database health...
📊 Starting focused session: What should I do *right now*?
⚠️  Skipping sync (--no-sync flag provided)
📊 Gathering context...
  ⏳ Time Tracking...
  ⏳ Diary / Journal...
  ⏳ Issues & Tickets...
  ⏳ markdown-plans...
  ⏳ stages...
  ⏳ vault-changes...
  ⏳ weather-context...
  ⏳ Calendar Events...
  ⏳ Tasks...
  ⏳ Habits...
  ⏳ Email...
  ⏳ Projects...
  ⏳ Health Metrics...
✅ Context ready
```

> 🤖 Running in non-interactive mode...
> Based on your current context, here's what you should do right now:
> 
> **Stop the time tracker** - You've been tracking "Answering hosting mail" for 26 minutes, but it sounds like you're done with that task.
> 
> **Wind down for the evening** - It's 7:19 PM and your bedtime is 9:30 PM. Today is an Off Stage (personal time) day, and you've already put in almost 5 hours of tracked work.
> 
> **Immediate priorities for the next 2 hours:**
> 
> 1. **Evening routine** - Your habits show 0/12 steps completed. This includes:
>    - Lock the doors
>    - Finish meal tracking
>    - Start the fasting timer
>    - Take your pills
>    - Journal
> 
> 2. **30 minutes of gentle exercise** - This is on your daily plan and your Exercise habit (30 min) is still pending. A short walk or Apple Fitness+ session would check this off.
> 
> 3. **Read offline** - Your plan calls for 45 minutes between events, and your Read Offline habit shows only 2:45 completed. Even 20-30 minutes before bed would help.
> 
> **Note:** Your daily plan mentioned a Prime Gentlemen Mixer at 10 PM, but that's past your 9:30 PM bedtime. You may have already decided to skip it, or adjusted plans.
> 
> **One quick check:** The healthcheck `newsletter-continuous-catchup` went DOWN today. You might want to glance at that, though it can wait until tomorrow (a Back Stage day) if you prefer to keep tonight personal.
> 
> Want me to stop the time tracker or help with anything specific?

---

Sessions can be interactive conversations or one-off suggestions like the above. You can run `bin/today` to start a session with general advice, or `bin/today "What do I need to do for my trip to St. Louis?"` to work on something particular.

The hope is:

1. It pulls in everything you should know about, so nothing slips through the cracks.
2. From your instructions about your goals and what's important to you, it suggests what to do next — whether it's "work like hell" or "go to the beach".
3. It stays flexible with changing circumstances, helping you get the most out of right now.
4. The more information you pour into it, the more it makes connections and thoughtful suggestions. ("Your diary said you're not getting outside enough. And you're up three pounds, and want to lose weight to take the pressure off your bad hip. Bob emailed about pickleball Friday morning. You wrote back that you couldn't, but the meeting you had then was canceled. Should we tell him you'll be there?")

## Installation

Clone https://github.com/jeffcovey/today/ onto a POSIX system with `npm` installed. Running `bin/today` should run `npm install` if you're missing any dependencies, and should run `bin/today configure` if you haven't set up your profile and plugins. The more information you provide through your profile and plugins, the more tailored advice the AI can provide.

## Inputs

Your information comes into the system through plugins. They are categorized into several types with matching binaries. Common data types are stored for each (email "From:", event "Location"), with metadata fields for source-specific types.

Plugin types:

- **Context** (`bin/context`): Weather, location, daily plans, day themes, etc.
- **Diary** (`bin/diary`): Day One, Obsidian, Journey, etc.
- **Email** (`bin/email`): Gmail, iCloud Mail, Fastmail, etc.
- **Events** (`bin/calendar`): Google Calendar, Outlook, Airbnb, TripIt, etc.
- **Habits** (`bin/habits`): Streaks, Habitica, Loop Habit Tracker, etc.
- **Health** (`bin/health`): Apple Health, Fitbit, Oura, Garmin, etc.
- **Issues** (`bin/issues`): GitHub, Jira, Linear, Sentry, etc.
- **Projects** (`bin/projects`): GitHub Projects, Notion, Basecamp, etc.
- **Tasks** (`bin/tasks`): Todoist, Things, Reminders, Obsidian, etc.
- **Time Logs** (`bin/track`): Toggl, Clockify, Harvest, RescueTime, etc.
- **Utility**: Inbox processing, file cleanup, linting, etc.

You can configure multiple sources for each plugin, for example, for a work Gmail account and a personal Gmail account. You can add instructions for each source to tell the AI something about it ("This is my birthdays calendar. Remind me of these events one week in advance, and then the day of."). *Only some of the above-listed services already have [plugins](plugins/)!* Please share your own where you see a gap you want to fill. The [Plugin README](plugins/README.md) explains how to create plugins. Reach out at https://github.com/jeffcovey/today/discussions to share your work or ideas or to ask questions.

You can manage your plugins with `bin/today configure` (which just calls out to `bin/plugins configure` if you want to go straight there), or edit ./config.toml directly. You can see what will be passed to the AI with `bin/today dry-run`.

---

## Focus Presets

Define reusable focus sessions in `config.toml` for common workflows:

```toml
[focus.inbox]
description = "Process inbox and messages"
instructions = """
Help me process my inbox. Start with highest priority items.
Check Front conversations, then emails, then vault inbox.
"""

[focus.weekly-review]
description = "Weekly planning and review"
instructions = """
Let's do a weekly review. Look at:
1. What I accomplished this week
2. What's carrying over to next week
3. Any projects that need attention
"""
```

Then run with:

```bash
bin/today --focus inbox          # Run specific preset
bin/today --focus                # Show menu to choose preset
bin/today --focus --non-interactive  # Automated preset run
```

---

## Vault & Obsidian

Many file-based plugins look for a "vault" directory and follow some [Obsidian](https://obsidian.md) conventions. The path to the vault can be configured, and defaults to `vault/` under Today's directory. Plugins automatically create their required directories inside the vault when first used.

**Important:** The `vault/` directory is gitignored because it contains personal data. Initialize it as a separate repository or sync it with your preferred solution (Resilio Sync, Syncthing, iCloud, Obsidian, etc.). Plugins have permission to read and write from the vault. We *strongly suggest* you run `git init` within the vault and monitor its changes to make sure you're happy with any changes `today` makes.

---

## Web Interface

Today includes a web server for browsing and interacting with your vault through a browser. The web interface provides full Obsidian compatibility and additional features for task and project management.

### Starting the Web Server

```bash
bin/today web                    # Start web server (default port 3000)
bin/today web --port 8080        # Start on custom port
```

Then visit `http://localhost:3000` to browse your vault.

For remote access, deploy Today to a server using `bin/today configure` and `bin/deploy` commands. See the [Server Deployment](#server-deployment) section for details.

### Features

- **Vault browsing**: Navigate your markdown files with Obsidian compatibility
- **Task management**: Interactive task lists with clickable links and detail pages
- **AI chat integration**: Built-in AI assistant with access to your context and tools
- **Live editing**: Edit tasks and markdown files directly in the browser
- **Image support**: View embedded images and Obsidian-style image syntax
- **Wiki links**: Full support for `[[internal links]]` and relative paths
- **Table of contents**: Auto-generated TOC for long documents
- **Responsive design**: Works on desktop and mobile devices

### Obsidian Compatibility

The web interface supports Obsidian markdown features:

- `[[Wiki Links]]` and `![[Image Embeds]]`
- Frontmatter properties (YAML)
- Task syntax with priorities and dates
- Callouts and admonitions
- Line breaks and formatting

This makes it easy to use alongside Obsidian or as a standalone interface to your vault.

---

### Inbox Processing

The `vault/inbox/` directory is a drop zone for quick capture. The inbox-processing plugin automatically processes files based on their content:

| File Type | Detection | Action |
|-----------|-----------|--------|
| **Progress notes** | First line is `# Progress` | Appended to diary file, moved to `.trash` |
| **Concern notes** | First line is `# Concerns` or filename contains "concerns" | Appended to diary file, moved to `.trash` |
| **Task files** | Contains only checkbox lines (`- [ ]` or `- [x]`) | Tasks appended to `tasks/tasks.md`, moved to `.trash` |
| **Other notes** | Default | Left in inbox for user review |

Processed files are kept in `vault/inbox/.trash/` for 7 days (configurable) before automatic deletion.

#### Quick Capture with Mobile Apps

The inbox works great with quick-capture apps. If you have a server with the inbox-api service running, you can upload directly via HTTPS. Otherwise, use file sync.

**[Drafts](https://getdrafts.com/)** (iOS/Mac):

- **With inbox-api**: Copy `scripts/drafts-send-to-inbox.js` into a Drafts Action to upload directly to your server
- **With file sync**: Create actions that save to your synced vault folder:

```
# Progress note action
Title: Progress
Body: {{date}} {{time}}
{{draft}}
Save to: vault/inbox/progress-{{timestamp}}.md

# Quick task action
Body: - [ ] {{draft}}
Save to: vault/inbox/task-{{timestamp}}.md
```

**[TextExpander](https://textexpander.com/)** - Create snippets for note formats:

```
# Progress snippet (;prog)
# Progress
%B %e, %Y %H:%M
<cursor>

# Concerns snippet (;concern)
# Concerns
%B %e, %Y %H:%M
<cursor>
```

The date format `December 7, 2025 14:30` is parsed to determine which plan file to append to.


## Automation

The scheduler (`src/scheduler.js`) automates daily operations:

- **Every 10 minutes**: Plugin sync (external sources, task classification, plan updates)
- **Every 6 hours**: Database maintenance (WAL checkpoint)
- **Weekly**: Database vacuum

### Running the Scheduler

**Option 1: Run Locally**

```bash
# Run scheduler in foreground
node src/scheduler.js

# Or run in background with pm2
npm install -g pm2
pm2 start src/scheduler.js --name today-scheduler
pm2 save
```

**Option 2: System cron** (manual setup)

```bash
# Edit crontab
crontab -e

# Add entries like:
*/10 * * * * cd /path/to/today && bin/sync --quick
0 */2 * * * cd /path/to/today && bin/today update
```

### Important: Version Control Your Vault

**The scheduler modifies files automatically without asking.** It will update daily plans, archive tasks, and sync data. To track these changes and recover if needed:

```bash
cd vault
git init
git add .
git commit -m "Initial vault"

# After running the scheduler, review changes:
git status
git diff
```

This lets you see exactly what the scheduler changed and revert if needed.

## Server Deployment

Today can be deployed to remote servers for scheduled automation and always-on operation. The deployment system supports multiple servers and providers.

### Why Deploy?

- **Always-on scheduling**: Run the scheduler 24/7 without keeping your laptop open
- **Inbox API**: Receive files from mobile apps like Drafts directly via HTTPS
- **Vault syncing**: Keep your vault synchronized between local and remote
- **Multiple environments**: Deploy to production, staging, or backup servers

### Configuration

Run `bin/today configure` and select "Deployments" to add servers. The interactive UI handles all configuration including secure storage of server IPs.

### Commands

```bash
bin/deploy --list                    # Show all deployments
bin/deploy production status         # Check server status
bin/deploy production setup          # Initial server setup (nginx, SSL, systemd)
bin/deploy production deploy         # Deploy code and restart services
bin/deploy production logs           # View recent logs
bin/deploy production ssh            # Open SSH session
bin/deploy production maintenance    # Run cleanup tasks
```

### How It Works

Deployment copies your **local configuration** to the remote server, making the remote a mirror of your local setup. This means:

- Your `config.toml` plugins run on the server with the same settings
- Scheduled jobs execute remotely instead of locally
- Vault changes sync between local and remote

### Supported Providers

| Provider | Description |
|----------|-------------|
| `digitalocean` | DigitalOcean Droplets with automated setup |
| `hetzner` | Hetzner Cloud servers |
| `generic` | Any VPS with SSH access |

### Services & Jobs

Configure which services run and what scheduled jobs execute in `bin/today configure` under Deployments. Available services:

- **scheduler**: Runs scheduled jobs (plugin sync, maintenance, custom commands)
- **vault-watcher**: Watches for vault changes and triggers actions
- **vault-web**: Serves your vault as a web site
- **inbox-api**: Receives files uploaded from mobile apps

Services and jobs are configured per-deployment, so different servers can run different workloads.

---

## Development

### Using the Devcontainer

The easiest way to develop is using VS Code's devcontainer:

1. Install [Docker](https://www.docker.com/) and [VS Code](https://code.visualstudio.com/)
2. Install the [Dev Containers](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers) extension
3. Open this folder in VS Code
4. Click "Reopen in Container" when prompted

### Running Tests

```bash
npm test                       # Run all tests
npm run test:watch             # Watch mode
npm run test:coverage          # Coverage report
```

## Documentation

- [Email Setup Guide](docs/EMAIL_SETUP.md) - Configure email integration

## License

MIT
