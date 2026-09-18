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
