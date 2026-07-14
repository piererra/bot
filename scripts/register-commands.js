// Run with: DISCORD_APPLICATION_ID=xxx DISCORD_BOT_TOKEN=xxx npm run register
const commands = [
  {
    name: 'ping',
    description: 'Check the bot\'s response latency',
  },
  {
    name: 'addserver',
    description: 'Submit a private server for moderator review',
  },
  {
    name: 'managegames',
    description: 'Manage the game list used in /addserver (owner only)',
    options: [
      {
        name: 'add',
        description: 'Add a game to the list',
        type: 1, // SUB_COMMAND
        options: [{ name: 'name', description: 'Game name', type: 3, required: true }],
      },
      {
        name: 'remove',
        description: 'Remove a game from the list',
        type: 1,
        options: [{ name: 'name', description: 'Game name', type: 3, required: true }],
      },
      {
        name: 'list',
        description: 'Show the current game list',
        type: 1,
      },
    ],
  },
  {
    name: 'serverlist',
    description: 'Browse approved private servers',
    options: [
      {
        name: 'game',
        description: 'Filter by game name (leave blank for all)',
        type: 3,
        required: false,
      },
    ],
  },
  {
    name: 'removeserver',
    description: 'Remove a server listing (moderators only)',
    options: [
      {
        name: 'server',
        description: 'Start typing the server name',
        type: 3,
        required: true,
        autocomplete: true,
      },
    ],
  },
  {
    name: 'clear',
    description: 'Delete recent messages in this channel (owner only)',
    options: [
      {
        name: 'qty',
        description: 'Number of messages to delete (1-100)',
        type: 4,
        required: true,
        min_value: 1,
        max_value: 100,
      },
    ],
  },
];

const APPLICATION_ID = process.env.DISCORD_APPLICATION_ID;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

if (!APPLICATION_ID || !BOT_TOKEN) {
  console.error('Missing DISCORD_APPLICATION_ID or DISCORD_BOT_TOKEN env vars.');
  process.exit(1);
}

const res = await fetch(
  `https://discord.com/api/v10/applications/${APPLICATION_ID}/commands`,
  {
    method: 'PUT',
    headers: {
      Authorization: `Bot ${BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
  }
);

const data = await res.json();
console.log(JSON.stringify(data, null, 2));
