require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { upsertScore, getLeaderboard } = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

const API_KEY = process.env.BOT_API_KEY || null;

function requireBotKey(req, res, next) {
  if (!API_KEY) return next(); // no key configured, open (fine for local dev only)
  const header = req.get('x-api-key');
  if (header !== API_KEY) return res.status(401).json({ error: 'bad api key' });
  next();
}

app.get('/health', (req, res) => res.json({ ok: true }));

// Called by the Discord bot after it parses a pasted share block.
app.post('/api/scores', requireBotKey, (req, res) => {
  const { guildId, puzzleNo, discordUserId, displayName, total, words } = req.body || {};
  if (!guildId || !puzzleNo || !discordUserId || !displayName || typeof total !== 'number') {
    return res.status(400).json({ error: 'missing or invalid fields' });
  }
  upsertScore({ guildId, puzzleNo, discordUserId, displayName, total, words });
  res.json({ ok: true });
});

app.get('/api/leaderboard/:guildId/:puzzleNo', (req, res) => {
  const { guildId, puzzleNo } = req.params;
  const rows = getLeaderboard(guildId, Number(puzzleNo));
  res.json({ guildId, puzzleNo: Number(puzzleNo), leaderboard: rows });
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`Scrabs API listening on :${PORT}`));
