# Discord Worker Bot

Slash-command Discord bot running on Cloudflare Workers, with save/load/delete/list
backed by Cloudflare KV. Deploys automatically from GitHub — no local build needed.

## Commands
- `/ping` — health check
- `/save key value` — store a value
- `/load key` — retrieve a value
- `/delete key` — remove a value
- `/list` — list all saved keys

## Setup

### 1. Discord Developer Portal
- https://discord.com/developers/applications → your app (or create one)
- Under **General Information**, copy: Application ID, Public Key
- Under **Bot**, copy/reset: Bot Token
- Leave "Interactions Endpoint URL" blank for now — you'll set it after step 4

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
Cloudflare dashboard → Workers & Pages → KV → Create namespace (e.g. `discord-bot-data`).
Copy its ID and paste it into `wrangler.toml` in place of `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.
Commit and push that change.

### 4. Connect the repo to Cloudflare
Dashboard → Workers & Pages → "Ship something new" → **Continue with GitHub** →
select this repo → deploy. Cloudflare will auto-redeploy on every future push.

### 5. Set environment variables on the Worker
Worker → Settings → Variables:
- `DISCORD_PUBLIC_KEY` (as a secret or plain var, either works for this)

### 6. Set the Interactions Endpoint URL
Back in Discord Developer Portal → General Information → Interactions Endpoint URL:
`https://YOUR-WORKER-NAME.YOUR-SUBDOMAIN.workers.dev`
Discord will ping it — it should succeed once steps 4–5 are done.

### 7. Register the slash commands
From Termux (needs Node installed: `pkg install nodejs`):
```
npm install
DISCORD_APPLICATION_ID=your_app_id DISCORD_BOT_TOKEN=your_bot_token npm run register
```
This only needs to be re-run when you add/change commands, not on every deploy.

### 8. Invite the bot
OAuth2 → URL Generator → scopes: `bot`, `applications.commands` → open the generated
URL to invite it to your server.
