require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const cron = require('node-cron');

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:8787';
const BOT_API_KEY = process.env.BOT_API_KEY || '';
const GAME_URL = process.env.GAME_URL || 'https://YOUR-USERNAME.github.io/scrabs/';
const ANNOUNCE_CHANNEL_ID = process.env.ANNOUNCE_CHANNEL_ID || null;

const COMMANDS = [
  new SlashCommandBuilder()
    .setName('scrabs-today')
    .setDescription("Get today's Scrabs puzzle link"),
  new SlashCommandBuilder()
    .setName('scrabs-submit')
    .setDescription('Submit your Scrabs result by pasting the copied share text')
    .addStringOption(opt =>
      opt.setName('result')
        .setDescription('Paste the text from the "Copy results to share" button')
        .setRequired(true)),
  new SlashCommandBuilder()
    .setName('scrabs-name')
    .setDescription('Set the name shown on the Scrabs leaderboard — fixes it on past scores too')
    .addStringOption(opt =>
      opt.setName('name')
        .setDescription('The name to show')
        .setRequired(true)),
  new SlashCommandBuilder()
    .setName('scrabs-leaderboard')
    .setDescription("Show today's Scrabs leaderboard for this server")
    .addIntegerOption(opt =>
      opt.setName('puzzle')
        .setDescription('Puzzle number (defaults to today)')
        .setRequired(false)),
].map(c => c.toJSON());

// Registers the slash commands every time the bot boots, so there's no separate
// "npm run register-commands" step to run on a host with no shell access.
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    if (process.env.GUILD_ID) {
      await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
        { body: COMMANDS },
      );
      console.log('Registered guild commands (instant).');
    } else {
      await rest.put(
        Routes.applicationCommands(process.env.CLIENT_ID),
        { body: COMMANDS },
      );
      console.log('Registered global commands (may take up to an hour).');
    }
  } catch (err) {
    console.error('Command registration failed:', err);
  }
}

// Must match game.js exactly: the daily reset is anchored to a fixed AEST
// offset (UTC+10), not UTC or the server's own local time, so the bot and
// every player's browser agree on the same "today" at the same instant.
// Deliberately not daylight-saving-aware — see game.js for why.
const RESET_OFFSET_MS = 10 * 60 * 60 * 1000;
const EPOCH = Date.UTC(2026, 0, 1); // must match game.js's Puzzle #1 date
function puzzleNumber() {
  const shifted = new Date(Date.now() + RESET_OFFSET_MS);
  const startOfDayShifted = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  return Math.floor((startOfDayShifted - EPOCH) / 86400000) + 1;
}

// A real Discord button (not just a plain link) — much easier to spot in a
// busy channel full of chatter and score images than a blue hyperlink.
function buildPlayButtonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('🎮 Play now!').setStyle(ButtonStyle.Link).setURL(GAME_URL),
  );
}

function parseShareText(text) {
  const lines = text.trim().split('\n').map(l => l.trim()).filter(Boolean);
  const header = lines[0] || '';
  const headerMatch = header.match(/#(\d+)\D+(\d+)\s*pts/i);
  if (!headerMatch) return null;
  const puzzleNo = Number(headerMatch[1]);
  const total = Number(headerMatch[2]);
  const words = [];
  for (const line of lines.slice(1)) {
    // matches "WORD (score)" at the start of the line, ignoring anything
    // that follows (e.g. the bonus-tile emoji tacked on after the score)
    const m = line.match(/^([A-Za-z]+)\s*\((\d+)\)/);
    if (m) words.push({ word: m[1].toLowerCase(), score: Number(m[2]) });
  }
  return { puzzleNo, total, words };
}

async function submitScore({ guildId, discordUserId, displayName, puzzleNo, total, words }) {
  const res = await fetch(`${API_BASE_URL}/api/scores`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': BOT_API_KEY },
    body: JSON.stringify({ guildId, discordUserId, displayName, puzzleNo, total, words }),
  });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

async function setName({ guildId, discordUserId, displayName }) {
  const res = await fetch(`${API_BASE_URL}/api/name`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': BOT_API_KEY },
    body: JSON.stringify({ guildId, discordUserId, displayName }),
  });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

async function claimPost(guildId, puzzleNo) {
  const res = await fetch(`${API_BASE_URL}/api/claim-post`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': BOT_API_KEY },
    body: JSON.stringify({ guildId, puzzleNo }),
  });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

async function fetchLeaderboard(guildId, puzzleNo) {
  const res = await fetch(`${API_BASE_URL}/api/leaderboard/${guildId}/${puzzleNo}`);
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

// Shared by both the /scrabs-leaderboard command and the automatic morning
// recap, so the two never drift out of sync with each other.
// Pure vs Assisted: the ranked board only counts unassisted results, so
// nobody can outspend their way to the top with Word Jackpot. Assisted
// results still show, just underneath, unranked.
function buildLeaderboardEmbed(data, puzzleNo, isPastPuzzle) {
  const medals = ['🥇', '🥈', '🥉'];
  const line = (row, rankLabel) => {
    const rank = `${rankLabel} **${row.displayName}** — ${row.total} pts`;
    // Only reveal the actual words once this puzzle's 24-hour window is
    // over, so nobody still playing today's puzzle gets spoiled.
    if (isPastPuzzle && Array.isArray(row.words) && row.words.length) {
      const wordList = row.words.map(w => `${w.word.toUpperCase()} (${w.score})`).join(', ');
      return `${rank}\n${wordList}`;
    }
    return rank;
  };

  const pure = data.leaderboard.filter(r => !r.assisted);
  const assisted = data.leaderboard.filter(r => r.assisted);

  const sections = [];
  sections.push(
    pure.length
      ? pure.map((row, i) => line(row, medals[i] || `${i + 1}.`)).join('\n\n')
      : '_No unassisted results yet today._'
  );
  if (assisted.length) {
    sections.push(
      `\n**Assisted** (used Word Jackpot)\n` +
      assisted.map((row, i) => line(row, `${i + 1}.`)).join('\n\n')
    );
  }

  const embed = new EmbedBuilder()
    .setTitle(`Scrabs #${puzzleNo} leaderboard`)
    .setDescription(sections.join('\n\n'))
    .setColor(0xc9a227);
  if (!isPastPuzzle) {
    embed.setFooter({ text: "Words reveal here once today's puzzle ends." });
  }
  return embed;
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();

  // The API server is on Render's free tier, which spins down after ~15
  // minutes idle and can then take 20-50s to wake back up — long enough to
  // blow past Discord's interaction timeout even with deferReply(). Since
  // this bot itself runs 24/7 anyway (it's the paid worker), just ping the
  // server's health check often enough that it never gets the chance to
  // sleep in the first place.
  setInterval(() => {
    fetch(`${API_BASE_URL}/health`).catch((err) => console.error('Keep-alive ping failed:', err.message));
  }, 10 * 60 * 1000);
  fetch(`${API_BASE_URL}/health`).catch((err) => console.error('Keep-alive ping failed:', err.message));

  if (ANNOUNCE_CHANNEL_ID) {
    // The puzzle itself still rolls over at midnight AEST (see the reset
    // math above), but the announcement waits until a reasonable morning
    // hour so nobody's phone buzzes at midnight — same reason Wordle's own
    // bot posts its recap around 6am rather than right at rollover.
    // Brisbane never observes daylight saving, so this stays a fixed
    // UTC+10 instant year-round.
    cron.schedule('0 6 * * *', async () => {
      try {
        const channel = await client.channels.fetch(ANNOUNCE_CHANNEL_ID);
        const no = puzzleNumber();
        const embed = new EmbedBuilder()
          .setTitle(`Today's Scrabs is #${no}`)
          .setDescription('Four words, one board, 24 hours. Your score logs itself the moment you finish.')
          .setColor(0xc9a227);
        await channel.send({ embeds: [embed], components: [buildPlayButtonRow()] });

        // Post yesterday's full leaderboard automatically right after —
        // this is the part that used to require someone typing
        // /scrabs-leaderboard by hand. If nobody played, say nothing rather
        // than posting an empty "no scores" message nobody asked for.
        const guildId = channel.guildId || (channel.guild && channel.guild.id);
        if (guildId) {
          const yesterday = no - 1;
          try {
            // Claimed in the database first — a Render restart landing on
            // the same minute, or the cron firing twice, can't double-post.
            const { claimed } = await claimPost(guildId, yesterday);
            if (claimed) {
              const data = await fetchLeaderboard(guildId, yesterday);
              if (data.leaderboard.length) {
                const recap = buildLeaderboardEmbed(data, yesterday, true);
                await channel.send({ embeds: [recap] });
              }
            }
          } catch (err) {
            console.error('Automatic leaderboard recap failed:', err);
          }
        }
      } catch (err) {
        console.error('Daily announcement failed:', err);
      }
    }, { timezone: 'Australia/Brisbane' });
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'scrabs-today') {
    const no = puzzleNumber();
    const embed = new EmbedBuilder()
      .setTitle(`Today's Scrabs is #${no}`)
      .setDescription('Four words, one board, 24 hours.')
      .setColor(0xc9a227);
    await interaction.reply({ embeds: [embed], components: [buildPlayButtonRow()] });
    return;
  }

  if (interaction.commandName === 'scrabs-name') {
    const name = interaction.options.getString('name', true).trim().slice(0, 32);
    if (!name) {
      await interaction.reply({ content: 'That name is empty, try again.', ephemeral: true });
      return;
    }
    await interaction.deferReply();
    try {
      const { rowsUpdated } = await setName({
        guildId: interaction.guildId,
        discordUserId: interaction.user.id,
        displayName: name,
      });
      await interaction.editReply(
        `Your Scrabs name is now **${name}**` +
        (rowsUpdated ? `, and I've updated it on ${rowsUpdated} past score${rowsUpdated === 1 ? '' : 's'}.` : '.')
      );
    } catch (err) {
      console.error(err);
      await interaction.editReply({ content: 'Something went wrong saving that name, try again in a bit.' });
    }
    return;
  }

  if (interaction.commandName === 'scrabs-submit') {
    const raw = interaction.options.getString('result', true);
    const parsed = parseShareText(raw);
    if (!parsed) {
      // Pure local check, no API call — safe to reply immediately.
      await interaction.reply({ content: "Couldn't read that. Paste the exact text from the \"Copy results to share\" button.", ephemeral: true });
      return;
    }
    // Discord only allows 3 seconds before an un-deferred reply times out
    // ("The application did not respond"). The API below lives on a free
    // Render instance that can take 20-50s to wake from a cold start, so we
    // defer first — that buys up to 15 minutes instead of 3 seconds.
    await interaction.deferReply();
    try {
      await submitScore({
        guildId: interaction.guildId,
        discordUserId: interaction.user.id,
        displayName: interaction.member?.displayName || interaction.user.username,
        puzzleNo: parsed.puzzleNo,
        total: parsed.total,
        words: parsed.words,
      });
      await interaction.editReply(`Logged **${parsed.total} pts** for puzzle #${parsed.puzzleNo}. Check \`/scrabs-leaderboard\` to see where that lands.`);
    } catch (err) {
      console.error(err);
      await interaction.editReply({ content: 'Something went wrong saving that score, try again in a bit.' });
    }
    return;
  }

  if (interaction.commandName === 'scrabs-leaderboard') {
    const puzzleNo = interaction.options.getInteger('puzzle') || puzzleNumber();
    const isPastPuzzle = puzzleNo < puzzleNumber();
    // Same cold-start risk as scrabs-submit above — defer before the fetch.
    await interaction.deferReply();
    try {
      const data = await fetchLeaderboard(interaction.guildId, puzzleNo);
      if (!data.leaderboard.length) {
        await interaction.editReply(`No scores logged yet for puzzle #${puzzleNo}. Be the first with \`/scrabs-submit\`.`);
        return;
      }
      const embed = buildLeaderboardEmbed(data, puzzleNo, isPastPuzzle);
      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error(err);
      await interaction.editReply({ content: 'Could not reach the leaderboard right now.' });
    }
    return;
  }
});
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'scrabs.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    puzzle_no INTEGER NOT NULL,
    discord_user_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    total INTEGER NOT NULL,
    words TEXT,
    assisted INTEGER NOT NULL DEFAULT 0,
    submitted_at INTEGER NOT NULL,
    UNIQUE(guild_id, puzzle_no, discord_user_id)
  );

  -- A player's chosen name, so a typo made on day one via /scrabs-name
  -- fixes itself everywhere: every past score and every future submission.
  CREATE TABLE IF NOT EXISTS players (
    guild_id TEXT NOT NULL,
    discord_user_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, discord_user_id)
  );

  -- Which puzzle numbers already had a leaderboard posted, so a Render
  -- restart or an overlapping cron firing twice can't post it twice.
  CREATE TABLE IF NOT EXISTS posted (
    guild_id TEXT NOT NULL,
    puzzle_no INTEGER NOT NULL,
    posted_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, puzzle_no)
  );
`);

// Migrate databases created before the `assisted` column existed.
{
  const cols = new Set(db.prepare('PRAGMA table_info(scores)').all().map(c => c.name));
  if (!cols.has('assisted')) {
    db.exec('ALTER TABLE scores ADD COLUMN assisted INTEGER NOT NULL DEFAULT 0');
  }
}

/* ---------- names ---------- */
function setPlayerName({ guildId, discordUserId, displayName }) {
  db.prepare(`
    INSERT INTO players (guild_id, discord_user_id, display_name, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id, discord_user_id)
    DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at
  `).run(guildId, discordUserId, displayName, Date.now());

  // Retroactively fix every score this player has already submitted.
  const res = db.prepare(
    'UPDATE scores SET display_name = ? WHERE guild_id = ? AND discord_user_id = ?'
  ).run(displayName, guildId, discordUserId);
  return { rowsUpdated: res.changes };
}

function getPlayerName(guildId, discordUserId) {
  const row = db.prepare(
    'SELECT display_name AS displayName FROM players WHERE guild_id = ? AND discord_user_id = ?'
  ).get(guildId, discordUserId);
  return row ? row.displayName : null;
}

/* ---------- scores ---------- */
function upsertScore({ guildId, puzzleNo, discordUserId, displayName, total, words, assisted }) {
  // A name the player has explicitly chosen always wins over whatever the
  // client happened to send, so a rename sticks for every future score too.
  const chosen = getPlayerName(guildId, discordUserId) || displayName;
  db.prepare(`
    INSERT INTO scores (guild_id, puzzle_no, discord_user_id, display_name, total, words, assisted, submitted_at)
    VALUES (@guildId, @puzzleNo, @discordUserId, @displayName, @total, @words, @assisted, @submittedAt)
    ON CONFLICT(guild_id, puzzle_no, discord_user_id)
    DO UPDATE SET total = excluded.total, words = excluded.words,
                  display_name = excluded.display_name, assisted = excluded.assisted,
                  submitted_at = excluded.submitted_at
  `).run({
    guildId, puzzleNo, discordUserId, displayName: chosen, total,
    words: JSON.stringify(words || []),
    assisted: assisted ? 1 : 0,
    submittedAt: Date.now(),
  });
  return { displayName: chosen };
}

function getLeaderboard(guildId, puzzleNo) {
  return db.prepare(`
    SELECT display_name AS displayName, total, words, assisted, submitted_at AS submittedAt
    FROM scores
    WHERE guild_id = ? AND puzzle_no = ?
    ORDER BY total DESC, submitted_at ASC
  `).all(guildId, puzzleNo).map(row => ({
    ...row,
    words: JSON.parse(row.words || '[]'),
    assisted: !!row.assisted,
  }));
}

/* ---------- post-once bookkeeping for the automated daily post ---------- */
function alreadyPosted(guildId, puzzleNo) {
  return !!db.prepare('SELECT 1 FROM posted WHERE guild_id = ? AND puzzle_no = ?')
    .get(guildId, puzzleNo);
}
function markPosted(guildId, puzzleNo) {
  db.prepare('INSERT OR IGNORE INTO posted (guild_id, puzzle_no, posted_at) VALUES (?, ?, ?)')
    .run(guildId, puzzleNo, Date.now());
}

module.exports = {
  db, upsertScore, getLeaderboard, setPlayerName, getPlayerName,
  alreadyPosted, markPosted,
};

client.login(process.env.DISCORD_TOKEN);
