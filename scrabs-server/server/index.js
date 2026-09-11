require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { upsertScore, getLeaderboard } = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

const API_KEY = process.env.BOT_API_KEY || null;
// Set on Render only — a Discord Channel Webhook URL, never sent to the
// browser. Lets the server announce a new score in Discord itself, so the
// website's automatic submission still shows up in chat without needing
// the bot (or any client-side secret) involved at all.
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || null;
const GAME_URL = process.env.GAME_URL || 'https://YOUR-USERNAME.github.io/scrabs/';

function requireBotKey(req, res, next) {
  if (!API_KEY) return next(); // no key configured, open (fine for local dev only)
  const header = req.get('x-api-key');
  if (header !== API_KEY) return res.status(401).json({ error: 'bad api key' });
  next();
}

// Raw Discord message-component JSON for a link button — webhooks can send
// these same as a bot can, and a link-style button needs no interaction
// handler (Discord just opens the URL client-side). Without this, every
// score announcement was plain text with no way to jump to the game short
// of scrolling up to find the one daily post that had the button.
function buildPlayButtonComponents() {
  return [
    {
      type: 1, // action row
      components: [
        { type: 2, style: 5, label: '🎮 Play now!', url: GAME_URL }, // style 5 = link button
      ],
    },
  ];
}

async function announceScore({ displayName, total, puzzleNo }) {
  if (!WEBHOOK_URL) return;
  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: `🎉 **${displayName}** just scored **${total} pts** on Scrabs #${puzzleNo}!`,
        components: buildPlayButtonComponents(),
      }),
    });
  } catch (err) {
    console.error('Discord webhook announcement failed:', err.message);
  }
}

app.get('/health', (req, res) => res.json({ ok: true }));

// Called either by the Discord bot after parsing a pasted share block, or
// directly by the website itself the moment a player finishes today's game
// (that's the whole point — no manual copy/paste needed for either path).
// No API key check here on purpose: a public webpage can never hold a secret
// safely, so this route validates/sanitizes every field itself instead.
app.post('/api/scores', (req, res) => {
  let { guildId, puzzleNo, discordUserId, displayName, total, words } = req.body || {};
  if (!guildId || !puzzleNo || !discordUserId || !displayName || typeof total !== 'number') {
    return res.status(400).json({ error: 'missing or invalid fields' });
  }
  // Basic sanity bounds now that this is reachable directly from any
  // browser, not just the trusted bot — keeps garbage out of the DB and
  // out of the Discord announcement below.
  displayName = String(displayName).slice(0, 40);
  total = Math.max(0, Math.min(1000, Math.floor(total)));
  puzzleNo = Math.floor(Number(puzzleNo));
  if (!Number.isFinite(puzzleNo) || puzzleNo <= 0) {
    return res.status(400).json({ error: 'invalid puzzleNo' });
  }

  upsertScore({ guildId, puzzleNo, discordUserId, displayName, total, words });
  res.json({ ok: true });
  announceScore({ displayName, total, puzzleNo });
});

app.get('/api/leaderboard/:guildId/:puzzleNo', (req, res) => {
  const { guildId, puzzleNo } = req.params;
  const rows = getLeaderboard(guildId, Number(puzzleNo));
  res.json({ guildId, puzzleNo: Number(puzzleNo), leaderboard: rows });
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`Scrabs API listening on :${PORT}`));
