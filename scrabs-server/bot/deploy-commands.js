require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
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

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    if (process.env.GUILD_ID) {
      // instant registration, scoped to one server, best while testing
      await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
        { body: commands },
      );
      console.log('Registered guild commands (instant).');
    } else {
      // global registration, can take up to an hour to propagate
      await rest.put(
        Routes.applicationCommands(process.env.CLIENT_ID),
        { body: commands },
      );
      console.log('Registered global commands (may take up to an hour).');
    }
  } catch (err) {
    console.error(err);
  }
})();
