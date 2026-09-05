require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder } = require('discord.js');
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

const EPOCH = Date.UTC(2026, 0, 1); // must match game.js's Puzzle #1 date
function puzzleNumber(date = new Date()) {
  const startOfDayUTC = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Math.floor((startOfDayUTC - EPOCH) / 86400000) + 1;
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
    const m = line.match(/([A-Za-z]+)\s*\((\d+)\)\s*$/);
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

async function fetchLeaderboard(guildId, puzzleNo) {
  const res = await fetch(`${API_BASE_URL}/api/leaderboard/${guildId}/${puzzleNo}`);
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();

  if (ANNOUNCE_CHANNEL_ID) {
    // Post the daily reminder at 00:05 UTC, five minutes after the puzzle rolls over.
    cron.schedule('5 0 * * *', async () => {
      try {
        const channel = await client.channels.fetch(ANNOUNCE_CHANNEL_ID);
        const no = puzzleNumber();
        await channel.send(`Today's Scrabs (#${no}) is up: ${GAME_URL}\nFour words, one board, 24 hours. Submit with \`/scrabs-submit\` once you're done.`);
      } catch (err) {
        console.error('Daily announcement failed:', err);
      }
    }, { timezone: 'UTC' });
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'scrabs-today') {
    const no = puzzleNumber();
    await interaction.reply(`Today's Scrabs is #${no}: ${GAME_URL}`);
    return;
  }

  if (interaction.commandName === 'scrabs-submit') {
    const raw = interaction.options.getString('result', true);
    const parsed = parseShareText(raw);
    if (!parsed) {
      await interaction.reply({ content: "Couldn't read that. Paste the exact text from the \"Copy results to share\" button.", ephemeral: true });
      return;
    }
    try {
      await submitScore({
        guildId: interaction.guildId,
        discordUserId: interaction.user.id,
        displayName: interaction.member?.displayName || interaction.user.username,
        puzzleNo: parsed.puzzleNo,
        total: parsed.total,
        words: parsed.words,
      });
      await interaction.reply(`Logged **${parsed.total} pts** for puzzle #${parsed.puzzleNo}. Check \`/scrabs-leaderboard\` to see where that lands.`);
    } catch (err) {
      console.error(err);
      await interaction.reply({ content: 'Something went wrong saving that score, try again in a bit.', ephemeral: true });
    }
    return;
  }

  if (interaction.commandName === 'scrabs-leaderboard') {
    const puzzleNo = interaction.options.getInteger('puzzle') || puzzleNumber();
    try {
      const data = await fetchLeaderboard(interaction.guildId, puzzleNo);
      if (!data.leaderboard.length) {
        await interaction.reply(`No scores logged yet for puzzle #${puzzleNo}. Be the first with \`/scrabs-submit\`.`);
        return;
      }
      const medals = ['🥇', '🥈', '🥉'];
      const lines = data.leaderboard.map((row, i) =>
        `${medals[i] || `${i + 1}.`} **${row.displayName}** — ${row.total} pts`);
      const embed = new EmbedBuilder()
        .setTitle(`Scrabs #${puzzleNo} leaderboard`)
        .setDescription(lines.join('\n'))
        .setColor(0xc9a227);
      await interaction.reply({ embeds: [embed] });
    } catch (err) {
      console.error(err);
      await interaction.reply({ content: 'Could not reach the leaderboard right now.', ephemeral: true });
    }
    return;
  }
});

client.login(process.env.DISCORD_TOKEN);
