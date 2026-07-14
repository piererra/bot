// Run with: DISCORD_APPLICATION_ID=xxx DISCORD_BOT_TOKEN=xxx npm run register
const commands = [
  {
    name: 'ping',
    description: 'Check if the bot is responsive',
  },
  {
    name: 'save',
    description: 'Save a value to storage',
    options: [
      { name: 'key', description: 'Key name', type: 3, required: true },
      { name: 'value', description: 'Value to store', type: 3, required: true },
    ],
  },
  {
    name: 'load',
    description: 'Load a saved value',
    options: [{ name: 'key', description: 'Key name', type: 3, required: true }],
  },
  {
    name: 'delete',
    description: 'Delete a saved value',
    options: [{ name: 'key', description: 'Key name', type: 3, required: true }],
  },
  {
    name: 'list',
    description: 'List all saved keys',
  },
  {
    name: 'addserver',
    description: 'Submit a private server for moderator review',
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
