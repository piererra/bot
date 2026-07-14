# Discord Worker Bot

Slash-command Discord bot running on Cloudflare Workers, backed by Cloudflare KV.
Deploys automatically from GitHub — push to `main` and Cloudflare redeploys.

Presence (online/offline status), welcome messages, and any gateway-based features
are handled separately by kite.onl. This Worker only handles slash commands,
buttons, modals, and autocomplete via Discord's Interactions Endpoint.

## Commands

### General
- `/ping` — shows the bot's response latency (time between Discord creating the
  interaction and the Worker replying), visible only to you.

  **Note:** Discord bots cannot see a user's IP address or measure their
  connection speed — Discord never exposes that data to bots, and there's no
  way around it (any site claiming otherwise is either wrong or trying to
  secretly log visitors, which this bot won't do). Latency is the only
  legitimate "ping"-style metric available.

### Private server directory
- `/addserver` — opens a form (Server Name, Region, Game, About, Discord Link).
  Submission is saved as **pending** and posted to the mod review channel with
  Approve/Reject buttons.
- `/serverlist [game]` — browse **approved** servers, 5 per page, with
  ⏮ ◀ ▶ ⏭ pagination buttons. Omit `game` to see all, or filter by game name.
- `/removeserver` — moderator-only. Autocomplete dropdown of approved server
  names; picking one deletes it.

**Approving/rejecting:** only members with the configured moderator role can
click Approve/Reject on submissions posted in the mod channel. Approving marks
the server visible in `/serverlist`; rejecting deletes the submission.

### Moderation
- `/clear qty` — owner-only. Deletes the most recent `qty` (1–100) messages in
  the channel it's run in. Messages older than 14 days can't be bulk-deleted
  (a Discord API limit) — the bot needs **Manage Messages** permission in that
  channel.

## Environment variables

Set these in the Cloudflare dashboard → your Worker → **Settings → Variables
and secrets**. None of these belong in `wrangler.toml` or the git repo.

| Name | Value | Type |
|---|---|---|
| `DISCORD_PUBLIC_KEY` | Discord Developer Portal → General Information | Secret |
| `DISCORD_BOT_TOKEN` | Bot token (Bot page → Reset Token if unsure) | Secret |
| `DISCORD_APPLICATION_ID` | Discord Developer Portal → General Information | Plain text |
| `MOD_CHANNEL_ID` | Channel where pending server submissions get posted | Plain text |
| `MOD_ROLE_ID` | Role allowed to Approve/Reject and use `/removeserver` | Plain text |
| `OWNER_ID` | Your Discord user ID — only this user can run `/clear` | Plain text |

Add them all in one pass and hit **Save and deploy** once at the end —
adding one at a time and re-tapping "+ Add" before saving can wipe unsaved rows.

## Setup

### 1. Discord Developer Portal
- https://discord.com/developers/applications → your app
- General Information: copy Application ID, Public Key
- Bot: copy/reset Bot Token

### 2. Push this repo to GitHub
```
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

### 3. Create a KV namespace
Cloudflare dashboard → Workers & Pages → KV → Create namespace.
Copy its ID into `wrangler.toml`:
```
kv_namespaces = [
  { binding = "DATA", id = "YOUR_KV_NAMESPACE_ID" }
]
```
Commit and push that change.

### 4. Connect the repo to Cloudflare
Dashboard → Workers & Pages → "Ship something new" → **Continue with GitHub** →
select this repo → deploy. Every future push to `main` auto-redeploys.

### 5. Set environment variables
See the table above. Add all six, then **Save and deploy**.

### 6. Set the Interactions Endpoint URL
Discord Developer Portal → General Information → Interactions Endpoint URL:
`https://YOUR-WORKER-NAME.YOUR-SUBDOMAIN.workers.dev`
Discord will ping it to verify — should succeed once steps 4–5 are done.

### 7. Register the slash commands
Needs Node installed in Termux: `pkg install nodejs`
```
npm install
DISCORD_APPLICATION_ID=your_app_id DISCORD_BOT_TOKEN=your_bot_token npm run register
```
Re-run this whenever you add or rename a command — not needed for every deploy.

### 8. Invite the bot
OAuth2 → URL Generator → scopes: `bot`, `applications.commands`. Recommended
bot permissions: **Send Messages**, **Embed Links**, **Manage Messages**
(needed for `/clear` and posting to the mod channel).

## Notes
- The bot shows **offline** in the member list — that's expected, since presence
  requires a persistent gateway connection which Workers doesn't support. kite.onl
  handles that separately using the same bot token.
- `/addserver`, `/serverlist`, and `/removeserver` all read/write KV keys under
  the `server:` prefix, stored as JSON with a `status` of `pending` or `approved`.