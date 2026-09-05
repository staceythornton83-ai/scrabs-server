# Scrabs backend + Discord bot

Two small services that turn the copy-paste share text into a real,
automatic leaderboard in your Discord server.

```
scrabs-server/
  server/   the score API (Express + SQLite)
  bot/      the Discord bot (discord.js)
```

They're separate because they scale and restart independently, but for
your friend group you can run both on one small always-on box.

## 1. Set up the API

```
cd server
cp .env.example .env      # then edit BOT_API_KEY to a random string
npm install
npm start
```

This starts the API on port 8787 and creates `scrabs.db` (SQLite,
just a file, no separate database server needed) the first time it runs.

Two endpoints:
- `POST /api/scores` — the bot calls this after parsing a pasted result
- `GET /api/leaderboard/:guildId/:puzzleNo` — the bot calls this for `/scrabs-leaderboard`

## 2. Set up the Discord bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications), create a new application, add a Bot user, and copy the bot token.
2. Under OAuth2 → URL Generator, tick `bot` and `applications.commands`, tick `Send Messages` and `Use Slash Commands`, then use the generated link to invite it to your server.
3. In `bot/.env`, set `DISCORD_TOKEN`, `CLIENT_ID` (the application ID), and `GUILD_ID` (right-click your server in Discord with Developer Mode on, Copy Server ID) so commands register instantly while you're testing.
4. Set `API_BASE_URL` to wherever the server from step 1 is reachable, and `BOT_API_KEY` to match the server's.
5. Set `GAME_URL` to your deployed GitHub Pages link, and `ANNOUNCE_CHANNEL_ID` to the channel you want the daily reminder posted in.

```
cd bot
cp .env.example .env      # then fill in the values above
npm install
npm run register-commands  # tells Discord about the three slash commands
npm start
```

## The three commands

- `/scrabs-today` — posts today's puzzle number and the game link.
- `/scrabs-submit` — paste the text from the game's "Copy results to share" button; the bot parses it and logs your score for that server.
- `/scrabs-leaderboard` — posts today's (or a chosen puzzle number's) leaderboard, ranked by score.

Plus an automatic daily message at 00:05 UTC (five minutes after the
puzzle resets) reminding the server that a new one is up, if you set
`ANNOUNCE_CHANNEL_ID`.

## Where to actually run this

Both `server` and `bot` need to stay running continuously (unlike the
static game, which is just files). Reasonable free-tier-friendly hosts:

- **Railway** or **Render** — push each folder as its own service, set the env vars in their dashboard, done. Easiest option.
- **Fly.io** — similar, a bit more config but generous free allowance.
- **A cheap always-on VPS** (e.g. a $4-6/mo box) — run both with `pm2` or as systemd services if you'd rather not depend on a platform's free tier.

Keep the two `.env` files out of git (already covered by the
`.gitignore` included here) since they hold your bot token and API key.

## Honest limitations of this v1

- Scores are self-reported: the bot trusts whatever share text you
  paste. Fine for a friend group, not fine if this ever needs to
  resist someone typing in a fake number. Locking that down means
  the server, not the browser, has to generate and score the puzzle,
  which is a bigger follow-up project.
- One leaderboard per Discord server (guild), which matches "my
  friends in a server" — if you want a global cross-server
  leaderboard later, that's a small addition to `db.js`.
