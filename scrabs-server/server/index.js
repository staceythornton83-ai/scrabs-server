require('dotenv').config();
const express = require('express');
const cors = require('cors');
const {
  upsertScore, getLeaderboard, setPlayerName, alreadyPosted, markPosted,
  createGroup, getGroup,
} = require('./db');

const app = express();
app.use(cors());
// Raised from the 100kb default: a submitted score can carry the rendered
// share-card PNG (base64-encoded, so ~33% larger than the ~50-150KB image
// itself) for the automatic Discord post to attach.
app.use(express.json({ limit: '2mb' }));

const API_KEY = process.env.BOT_API_KEY || null;
// Set on Render only — a Discord Channel Webhook URL, never sent to the
// browser. Lets the server announce a new score in Discord itself, so the
// website's automatic submission still shows up in chat without needing
// the bot (or any client-side secret) involved at all.
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || null;
const GAME_URL = process.env.GAME_URL || 'https://YOUR-USERNAME.github.io/scrabs/';

// The only Discord server this webhook may ever announce into. /api/scores
// is shared by every guildId that submits to this server (including
// STACKD's 'stackd-app-leaderboard') — the DB rows are already scoped per
// guildId, but the announcement below previously fired for ANY submission
// regardless of guildId, leaking non-Scrabs scores into the real channel.
const REAL_SCRABS_GUILD_ID = '1482127702176698408';

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
async function postToWebhook(payload, cardImage) {
  // Plain "incoming" webhooks (the kind created from a channel's own
  // Integrations settings, as opposed to one owned by a bot application)
  // silently drop a `components` field unless this query param is set —
  // Discord accepts the request either way (204), it just strips the
  // button without it, which is why this went unnoticed at first. True
  // whether the body is plain JSON or the multipart form a file attachment
  // requires, so it's appended either way.
  const url = `${WEBHOOK_URL}?with_components=true`;
  if (cardImage) {
    // The website renders the same spoiler-safe card "Copy to share"
    // produces and hands it over as base64 — attaching it here as a real
    // Discord file (not a link) is what makes it show up inline. Discord
    // webhooks take this as multipart: the normal JSON payload goes in a
    // `payload_json` field alongside a `files[0]` field with the image
    // bytes.
    const form = new FormData();
    form.append('payload_json', JSON.stringify(payload));
    form.append('files[0]', new Blob([Buffer.from(cardImage, 'base64')], { type: 'image/png' }), 'scrabs-score.png');
    return fetch(url, { method: 'POST', body: form });
  }
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function announceScore({ displayName, total, puzzleNo, cardImage }) {
  if (!WEBHOOK_URL) return;
  const payload = {
    content: `🎉 **${displayName}** just scored **${total} pts** on Scrabs #${puzzleNo}!`,
    components: buildPlayButtonComponents(),
  };
  try {
    const res = await postToWebhook(payload, cardImage);
    if (!res.ok && cardImage) {
      // Never let an image-attach failure (bad bytes, a Discord-side quirk)
      // cost the day its announcement entirely — plain text still worked
      // fine before this feature existed, so fall back to exactly that.
      console.error('Webhook image attach failed, retrying without the image:', res.status);
      await postToWebhook(payload, null);
    }
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
  let { guildId, puzzleNo, discordUserId, displayName, total, words, assisted, cardImage } = req.body || {};
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
  // Optional and only ever from the website's own auto-submit (the bot's
  // /scrabs-submit path never sends one) — a malformed value just means no
  // image gets attached, not a failed submission.
  if (typeof cardImage !== 'string' || !cardImage) cardImage = null;

  const { displayName: stored } = upsertScore({
    guildId, puzzleNo, discordUserId, displayName, total, words, assisted: !!assisted,
  });
  res.json({ ok: true, displayName: stored });
  if (guildId === REAL_SCRABS_GUILD_ID) {
    announceScore({ displayName: stored, total, puzzleNo, cardImage });
  }
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

// STACKD-only: private groups, entirely separate from Discord. A group's
// code doubles as its guildId once prefixed by the client
// ('stackd-group-<code>') — scores/leaderboard need no new schema for
// this, this table just exists so a mistyped join code gets a real error
// instead of silently landing in an empty group.
const GROUP_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L — easy to read aloud or text
function randomGroupCode(length = 6) {
  let code = '';
  for (let i = 0; i < length; i++) {
    code += GROUP_CODE_CHARS[Math.floor(Math.random() * GROUP_CODE_CHARS.length)];
  }
  return code;
}

app.post('/api/groups', (req, res) => {
  let { name } = req.body || {};
  name = String(name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: 'missing group name' });

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomGroupCode();
    try {
      createGroup(code, name);
      return res.json({ code, name });
    } catch (e) {
      if (!/UNIQUE/.test(e.message)) throw e; // genuine collision — retry with a fresh code
    }
  }
  res.status(500).json({ error: 'could not generate a unique group code, try again' });
});

app.get('/api/groups/:code', (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  const group = getGroup(code);
  if (!group) return res.status(404).json({ error: 'group not found' });
  res.json(group);
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
