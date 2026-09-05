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
    submitted_at INTEGER NOT NULL,
    UNIQUE(guild_id, puzzle_no, discord_user_id)
  );
`);

function upsertScore({ guildId, puzzleNo, discordUserId, displayName, total, words }) {
  const stmt = db.prepare(`
    INSERT INTO scores (guild_id, puzzle_no, discord_user_id, display_name, total, words, submitted_at)
    VALUES (@guildId, @puzzleNo, @discordUserId, @displayName, @total, @words, @submittedAt)
    ON CONFLICT(guild_id, puzzle_no, discord_user_id)
    DO UPDATE SET total = excluded.total, words = excluded.words, display_name = excluded.display_name, submitted_at = excluded.submitted_at
  `);
  stmt.run({
    guildId, puzzleNo, discordUserId, displayName, total,
    words: JSON.stringify(words || []),
    submittedAt: Date.now(),
  });
}

function getLeaderboard(guildId, puzzleNo) {
  const stmt = db.prepare(`
    SELECT display_name AS displayName, total, words, submitted_at AS submittedAt
    FROM scores
    WHERE guild_id = ? AND puzzle_no = ?
    ORDER BY total DESC, submitted_at ASC
  `);
  return stmt.all(guildId, puzzleNo).map(row => ({
    ...row,
    words: JSON.parse(row.words || '[]'),
  }));
}

module.exports = { db, upsertScore, getLeaderboard };
