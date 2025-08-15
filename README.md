# TikTok → Discord Webhook Forwarder

*Poll one or more TikTok accounts and forward new videos to a Discord channel via a webhook.
Built with TypeScript and Node 18+, powered by Playwright (Chromium) for scraping.*

Features:
- ⏱️ Polls every N minutes (default 30)
- 🔔 Sends new posts as Discord embeds
- 🧠 Remembers what it has forwarded in a tiny JSON state file
- 🪶 Zero external APIs or tokens beyond your Discord webhook

Requirements:
- **Node.js 18+**
- **npm** or **pnpm**
- **Discord Webhook URL** (from your server → channel → Integrations → Webhooks)
- Ability to install **Playwright** + its **Chromium runtime**


Environment Variables:


| Name                | Required | Default                           | Example                                     | Notes                                 |
|---------------------|----------|-----------------------------------|---------------------------------------------|---------------------------------------|
| DISCORD_WEBHOOK_URL | ✅        | https://discord.com/api/webhooks/ | ...                                         | Target channel webhook                |
| TIKTOK_USERNAMES    | ✅        | -                                 | shattereddawnpve                            | Comma-separated, no @                 |
| POLL_MINUTES        | ❌        | 60                                | 10                                          | Minutes between polls (minimum 1)     |
| STATE_FILE          | ❌        | ./state/.state.json               | /var/lib/tiktok-forwarder/state/.state.json | Path to JSON store of seen video IDs  |

*You can put these in a .env file (if you use dotenv) or export them in your shell/service unit.*

---
## Quick Start
1. Install Dependencies:
   ```bash
   npm install
   npx playwright install
   ```
   
2. Build
   ```bash
   npm run build
   DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/*/*" \
   TIKTOK_USERNAMES="nba,shattereddawnpve" \
   npm start
   ```
   
---

## How It Works

- Scrape latest videos: Uses Playwright + headless Chromium to open each profile page and collect video links and thumbnails.
- De-dupe: Keeps a set of already-forwarded video IDs per username in the state file.
- Embed to Discord: Builds a safe, size-bounded embed (title, description, thumbnail, url) and POSTs it to your webhook.
- Loop: Runs once on startup, then repeats every POLL_MINUTES.

### State file structure:
```json
{
  "nba": ["7345678901234567890", "7345678901234567891"],
  "shattereddawnpve": ["7333333333333333333"]
}
```
*You can safely delete this file to “resync” (it will re-forward whatever the script sees next as new).*

---
## Running in Production

### Docker (optional):
Run:
```bash
docker build -t tiktok-forwarder .
```
```bash
docker run --name tiktok-forwarder --restart unless-stopped -e DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/*/*" -e TIKTOK_USERNAMES="shattereddawnpve" -e STATE_FILE="/app/state/.state.json" -e POLL_MINUTES=60 -v "$(pwd)/tiktok_state:/app/state" tiktok-forwarder
```