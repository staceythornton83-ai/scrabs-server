require('dotenv').config();
const express = require('express');
const cors = require('cors');
const {
  upsertScore, getLeaderboard, setPlayerName, alreadyPosted, markPosted,
} = require('./db');

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

// Must match game.js/bot's index.js exactly: the daily reset is anchored to
// a fixed AEST offset (UTC+10), not UTC or the server's own local time.
const RESET_OFFSET_MS = 10 * 60 * 60 * 1000;
const EPOCH = Date.UTC(2026, 0, 1); // must match game.js's Puzzle #1 date
function puzzleNumber() {
  const shifted = new Date(Date.now() + RESET_OFFSET_MS);
  const startOfDayShifted = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  return Math.floor((startOfDayShifted - EPOCH) / 86400000) + 1;
}

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
    // Plain "incoming" webhooks (the kind created from a channel's own
    // Integrations settings, as opposed to one owned by a bot application)
    // silently drop a `components` field unless this query param is set —
    // Discord accepts the request either way (204), it just strips the
    // button without it, which is why this went unnoticed at first.
    await fetch(`${WEBHOOK_URL}?with_components=true`, {
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
  let { guildId, puzzleNo, discordUserId, displayName, total, words, assisted } = req.body || {};
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

  const { displayName: stored } = upsertScore({
    guildId, puzzleNo, discordUserId, displayName, total, words, assisted: !!assisted,
  });
  res.json({ ok: true, displayName: stored });
  announceScore({ displayName: stored, total, puzzleNo });
});

// Bot-only: lets a player correct the name attached to all of their scores,
// past and future. Protected by the same key the bot already sends on
// /api/scores from its own /scrabs-submit path — a browser never calls this.
app.post('/api/name', requireBotKey, (req, res) => {
  const { guildId, discordUserId, displayName } = req.body || {};
  if (!guildId || !discordUserId || !displayName) {
    return res.status(400).json({ error: 'missing fields' });
  }
  const name = String(displayName).trim().slice(0, 32);
  if (!name) return res.status(400).json({ error: 'empty name' });
  const { rowsUpdated } = setPlayerName({ guildId, discordUserId, displayName: name });
  res.json({ ok: true, displayName: name, rowsUpdated });
});

// Also called directly by the browser now (for the "so far today" percentile
// on the summary screen) — not just the bot. That's fine for name/score/rank,
// which are already shown live in Discord via /scrabs-leaderboard before a
// puzzle ends, but the actual WORDS stay hidden until the puzzle is over
// (same rule the bot already enforces client-side); redacting them here too
// closes the gap where a browser could otherwise fetch this endpoint
// directly and read today's still-live words before the bot would ever show
// them.
app.get('/api/leaderboard/:guildId/:puzzleNo', (req, res) => {
  const { guildId, puzzleNo } = req.params;
  const isPastPuzzle = Number(puzzleNo) < puzzleNumber();
  const rows = getLeaderboard(guildId, Number(puzzleNo))
    .map((row) => (isPastPuzzle ? row : { ...row, words: [] }));
  res.json({ guildId, puzzleNo: Number(puzzleNo), leaderboard: rows });
});

// Bot-only: the bot claims a puzzle before posting its automatic recap, so
// a Render restart or an overlapping cron tick can never post it twice.
app.post('/api/claim-post', requireBotKey, (req, res) => {
  const { guildId, puzzleNo } = req.body || {};
  if (!guildId || !puzzleNo) return res.status(400).json({ error: 'missing fields' });
  if (alreadyPosted(guildId, Number(puzzleNo))) return res.json({ claimed: false });
  markPosted(guildId, Number(puzzleNo));
  res.json({ claimed: true });
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`Scrabs API listening on :${PORT}`));
