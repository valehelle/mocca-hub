# Mocca

**A desktop home for installable AI agents.** Browse a marketplace, install an
agent, and chat with it — powered by the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk).

![Mocca — asked in plain English, the agent builds a working player on the Canvas](assets/screenshot-canvas.png)

---

## Why this exists

Claude Code plugins and skills are genuinely good. The problem is where they live.

Today a plugin is a GitHub repo you had to hear about, clone, and drive from a
terminal with slash commands you're expected to memorize. That means:

- **Nobody can find them.** There's no shelf to browse. Plugins spread by tweets,
  READMEs, and word of mouth — so most people never learn they exist.
- **Nobody outside a terminal can use them.** If your workflow isn't `git clone`,
  the door is closed. A career coach or a tax helper shouldn't require a CLI.
- **The answer is always a wall of text.** A terminal can print. It can't show you
  a dashboard, a comparison, or a working player.

Mocca fixes the *distribution and interface* problem — not by replacing those
plugins, but by giving them a home. It installs the **real** Claude Code plugin
(`plugin.json` + `SKILL.md`) straight from its repo and puts a GUI around it.

## What it solves

### 1. Plugins you can actually find
A built-in marketplace with 28 curated agents, grouped by category (Career,
Money, Work, Learning…). Open one and read what it *actually* does — its README,
its skills, and the tools it brings with it — before you install. You can also
install any Claude Code plugin straight from a GitHub repo (`owner/name`) or a
local folder.

![The Mocca marketplace — 28 agents, browsable by category, each linking to its source repo](assets/screenshot-marketplace.png)

### 2. Agents that can do real work
Each agent gets file tools, sandboxed Bash, web search — and a **headless browser**
(Playwright). `WebFetch` only sees static HTML, so when a page is JavaScript-heavy
or needs interaction (job boards, dashboards), the agent drives a real browser
instead of giving up. Agents can also connect **MCP tools** per workspace — Linear,
Notion, GitHub, Sentry, Stripe — from a catalog, by name, or bundled by the plugin.

### 3. The Canvas — apps built on the fly
Instead of walling the answer into chat, an agent writes a self-contained HTML app
that runs **live in the panel**: a comparison, a dashboard, a timeline, a working
music player. It's a real app, not a screenshot — it handles its own interactions
in-page, and can talk back through a small `window.mocca` bridge
(`chat.send`, `files.read/write/list`). Mocca injects its design system, so
whatever the agent builds looks native. Don't like what it made? Say so — "make the
player minimal, add a rain toggle" — and it rebuilds it.

## How it works

- **Every agent is a workspace** — its own folder, its own chat threads (which keep
  their memory across restarts), and two folders you can see: `input/` for files
  you hand it, `output/` for everything it makes you.
- **Installing pulls the real plugin.** Marketplace entries are mostly metadata
  pointing at a repo; installing clones it so the agent's own files, skills, and
  MCP servers come along.
- **The agent is sandboxed.** Its Bash can only write inside its own workspace;
  package installs are redirected there too. Anything that reaches outside —
  `brew`, `sudo` — pauses and asks you first, and you can grant or revoke standing
  approvals per workspace.
- **The Canvas is untrusted.** It runs in a sandboxed iframe on a loopback origin,
  cross-origin to Mocca, reaching back only through workspace-scoped verbs.
- **Schedules** — run an agent on a timer (daily or every N minutes); the run
  continues its own thread.
- **Build your own** — give a name and a sentence about what it should do, and
  Claude authors it as a real, portable Claude Code plugin.

## Requirements

- **macOS (Apple Silicon).** That's what's built and tested.
- **Claude Code auth** — sign in with a Claude subscription (Pro/Max), or set
  `ANTHROPIC_API_KEY`. Mocca checks on startup and tells you if it's missing.
  Settings shows your plan and how much of your usage window you've used.

## Install

No build is published yet — grab it from [Releases](../../releases) once one is,
or build it yourself below. Release DMGs are signed and notarized, so they install
without a Gatekeeper warning.

## Build from source

```bash
npm install
npm start          # dev
npm run make       # signed + notarized release → out/make
```

Releasing (signing, notarization, verification) is documented in
[RELEASE.md](RELEASE.md).

## Adding an agent to the marketplace

Each entry is a folder under [`registry/`](registry/) with an `agent.json`:

```jsonc
{
  "id": "coding-dj",
  "name": "Coding DJ",
  "emoji": "🎵",
  "description": "Streams mood-matched background music while you work.",
  "allowedTools": ["Read", "Write", "Edit", "Bash", "WebSearch", "WebFetch"],
  "examplePrompt": "Play some lofi to help me focus for the next hour.",
  "source": "github:kennethleungty/claude-music",
  "category": "Work",
  "tagline": "Mood-matched music while you work"
}
```

`source` points at the Claude Code plugin to clone on install. Open a PR to add
yours.

## License

MIT © [Hazmi Irfan](https://github.com/valehelle)
