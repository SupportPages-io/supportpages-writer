<h1 align="center">SupportPages Writer</h1>

<p align="center">
  <strong>Your coding agent writes the help docs, screenshots included.</strong>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: Apache 2.0" src="https://img.shields.io/badge/license-Apache%202.0-blue.svg"></a>
  <img alt="Platforms: macOS and Linux" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey.svg">
  <img alt="Works with Claude Code and Codex" src="https://img.shields.io/badge/works%20with-Claude%20Code%20%7C%20Codex-8A2BE2.svg">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#cli-commands">CLI commands</a> ·
  <a href="#supportpagesio-integration">SupportPages.io</a> ·
  <a href="#faq">FAQ</a>
</p>

<!-- TODO: demo GIF of a coding agent writing an article -->

SupportPages Writer turns [Claude Code](https://claude.com/claude-code) or
[Codex](https://github.com/openai/codex) into a technical writer for your product.
Ask for a guide ("how do I invite a teammate?") and your agent reads the code,
writes a step-by-step article, and renders screenshots from your real interface
code. No running app, no manual captures, no account.

Set it up once in your terminal, then just ask your agent:

```sh
curl -fsSL https://downloads.supportpages.io/install.sh | bash
supportpages setup          # once per computer
supportpages init           # once per project
```

> **You → Claude Code:** Write an illustrated guide to inviting a teammate.

## Features

- **Written from your source.** Routes, button labels and flows come from the code,
  not from a description you type, so the steps match what users actually see.
- **Screenshots without running the app.** Mockups are rebuilt from your own markup,
  styles and branding, then rendered to PNG in a local headless Chromium.
- **Plain Markdown output.** Each article is an `index.md` with its images beside it,
  ready to commit next to your code or drop into any docs site.
- **Checked before it's saved.** Every article passes structure, copy and screenshot
  checks first.
- **Uses the agent you already have.** Claude Code or Codex, with your own subscription
  and model settings.
- **Local-first.** Nothing is sent to SupportPages.io unless you choose to publish.

## Install

```sh
curl -fsSL https://downloads.supportpages.io/install.sh | bash
```

The installer downloads a checksum-verified release with its own Node.js, installs
the `supportpages` command into `~/.local/bin` (no `sudo`), and offers to add it to
your `PATH`.

**You'll need:**

- macOS or Linux, on ARM64 or x64 (on Windows, use WSL)
- [Claude Code](https://claude.com/claude-code) or [Codex](https://github.com/openai/codex),
  installed and signed in
- Git

Chromium for screenshots is downloaded the first time you run `supportpages setup`.

**Updating:** releases check for updates once a day and install them in the background.
Run `supportpages update` to update now, or set `SUPPORTPAGES_AUTO_UPDATE=0` to turn
automatic updates off.

### Build from source

You'll need Node.js 22.12 or later, npm and Git.

```sh
git clone https://github.com/SupportPages-io/supportpages-writer.git
cd supportpages-writer
./install-cli.sh
```

This builds your checkout and installs it as `supportpages`. Run `./install-cli.sh`
again after pulling changes.

## Quick start

Configure once in the terminal, then do everything else in your coding agent.

### 1. Set up your computer

```sh
supportpages setup
```

This connects Claude Code and/or Codex, adds the SupportPages writer to them and
downloads the screenshot renderer. When it asks how you want to work, choose
**Save articles in my projects without an account**.

### 2. Set up your project

```sh
cd path/to/your-product
supportpages init
```

Pick where articles should be saved and which model to use. SupportPages Writer then
studies the project's structure, styles and branding once, so every article starts
from that analysis.

### 3. Ask your coding agent

Open Claude Code or Codex in your project (restart any session that was already open)
and ask for an article in plain words:

> Write an illustrated guide to inviting a teammate.

A few minutes later the article is in your project:

```text
output/articles/how-to-invite-a-teammate/
├── index.md
├── block_open-settings.png
├── block_invite-form.png
└── block_send-invite.png
```

That's the whole loop. Some other things to ask:

> What help articles do we have?

> Write a troubleshooting article for when a sign-in link has expired.

## CLI commands

You only need the terminal to set things up and keep them running. Writing happens in
your coding agent.

| Command | What it does |
| --- | --- |
| `supportpages setup` | Set up this computer: connect your coding agents and install the renderer |
| `supportpages init` | Set up this project: where articles go, which model, project analysis |
| `supportpages configure` | Change this project's agent, model, writing style or article folder |
| `supportpages analyse` | Re-run project analysis after big changes (`--refresh`) |
| `supportpages status` | Show this project's setup and article progress |
| `supportpages doctor` | Check that everything is installed and connected |
| `supportpages telemetry off` | Stop anonymous usage counts and crash reports (`on`, `status`) |
| `supportpages update` | Install the latest release |
| `supportpages uninit` | Forget this project's setup (keeps a recovery archive) |
| `supportpages remove` | Disconnect from your coding agents (keeps projects and articles) |

Run `supportpages --help` for every option. `status` and `doctor` accept `--json`.

## Your articles

- **Where they go.** `output/articles/<slug>/` by default. To keep them in your repo,
  choose a folder like `docs/help` during `init` or with `supportpages configure`.
- **Writing style.** Pick from friendly, minimal, technical or formal with
  `supportpages configure`.
- **Screenshots.** Each article gets up to three. The main path gets them first;
  optional branches are described in text. Every screenshot carries a small
  "created automatically by supportpages.io" strip.

## How it works

1. `setup` connects a local [MCP](https://modelcontextprotocol.io) server and a
   writer agent to Claude Code or Codex.
2. `init` has your agent map the project once: framework, routes, layouts, CSS and
   branding.
3. When you ask for an article, the writer agent reads the relevant source, writes the
   steps, and builds each screenshot as an HTML mockup of your real UI.
4. The mockups are rendered to PNG with a local Chromium, checked against your source,
   and saved with the article.

## SupportPages.io integration

Everything above works on its own. If you'd like your articles online, connect a free
[SupportPages.io](https://supportpages.io) account to get:

- a public help centre with your branding and your own domain
- an editor to review and polish drafts before anyone sees them
- publishing straight from your coding agent
- AI answers for your readers, drawn from your articles
- extras such as topic suggestions, updates when you merge a pull request, and video
  walkthroughs

The same pattern applies: connect once in the terminal, then work in your agent.

**Connect a project:**

```sh
supportpages publish
```

You'll sign in or create an account in your browser and choose a help centre. Any
articles you've already saved upload as drafts. (Setting up a new project? Choose
**Publish them to a SupportPages.io help centre** during `supportpages init` instead.)

**Then keep asking your agent:**

> Write a guide to exporting a report.

New articles arrive in the help centre as drafts, with a link to review them in the
editor. Publishing is always a separate step: click **Publish** in the editor, or ask:

> Publish the guide to exporting a report.

| Command | What it does |
| --- | --- |
| `supportpages publish` | Sign in, pick a help centre and upload this project's saved articles |
| `supportpages login` / `logout` | Sign this computer in or out |
| `supportpages sync` | Refresh help-centre settings and article history |

A help centre never needs access to your GitHub or Bitbucket.

## Privacy

- **Local projects send only anonymous usage counts and crash reports** to
  SupportPages.io (see below). Your coding agent and its model provider read your
  source, as they do for any other task.
- **Publishing uploads** the article, its images and a small provenance record.
  Your source code is never uploaded.
- **Credentials** are stored in private files under `~/.config/supportpages`, never in
  your repository.
- **Project analysis runs unattended.** `init` and `analyse` start your agent with its
  permission prompts off (`--dangerously-skip-permissions` for Claude Code,
  `--dangerously-bypass-approvals-and-sandbox` for Codex). Writing articles uses the
  agent's normal approval prompts.

### Anonymous usage counts and crash reports

The Writer tells us how many installs are in use and when something breaks, so we
can fix it. It says so the first time you set up a project, and it's easy to turn
off. It is sent to SupportPages.io without your sign-in, so it can't be linked to
your account.

**What is sent**

- A random install ID created on this computer (not derived from it), the Writer
  version, the coding client's name (e.g. `claude-code`), your OS, CPU architecture
  and Node.js major version.
- A count when the Writer is first used, when a project is set up (local or hosted),
  and when an article or video walkthrough finishes: its outcome, where it went
  (local, uploaded or generated on SupportPages.io), an error code if it failed,
  and how many seconds it took.
- For unexpected errors only: the error type and code, and stack frames with every
  path outside the Writer replaced by `<external>`. Messages from other code are
  never sent.

**What is never sent:** your code, file names or paths, article titles or content,
repository or project names, your email or account, or credentials. Your IP address
is not stored.

**Turn it off** with any of these:

- ask your coding agent to turn off SupportPages telemetry;
- run `supportpages telemetry off`;
- set `SUPPORTPAGES_TELEMETRY=0` or `DO_NOT_TRACK=1`.

It is always off in CI. `supportpages doctor` shows whether it's on and why; set
`SUPPORTPAGES_TELEMETRY_DEBUG=1` to print each report to stderr as it is sent.

## FAQ

**`supportpages: command not found`**
Open a new terminal, or run the `PATH` command the installer printed.

**My agent can't see the SupportPages tools.**
Restart any Claude Code or Codex sessions that were open during `supportpages setup`.

**Setup won't finish.**
Run `supportpages doctor`, fix what it reports, then run `supportpages init` again.

**An article was interrupted halfway.**
Ask your agent to continue it, or run `supportpages status` to see where it stopped.

**Does it collect usage data?**
Only anonymous counts and crash reports, never your code or articles. See
[Anonymous usage counts and crash reports](#anonymous-usage-counts-and-crash-reports)
to see exactly what is sent or turn it off.

**Can I use it on Windows?**
Yes, inside WSL.

Full documentation is on [supportpages.io](https://supportpages.io).

## Contributing

Bug reports and pull requests are welcome. When reporting a bug, include your OS,
`supportpages --version`, the command you ran and its output, with credentials and
private code removed. For larger changes, open an issue first so we can agree on the
approach.

To work on the code:

```sh
npm ci
npm test
node scripts/cli.mjs --help
```

The article engine in `engine/` is synced from upstream on each engine release, so
changes there are reviewed here and ported back by the maintainers.

## License

[Apache 2.0](LICENSE). The UI stylesheets bundled under `engine/` keep their own
licenses; see [NOTICE](NOTICE). The license doesn't cover the SupportPages name or logo.
