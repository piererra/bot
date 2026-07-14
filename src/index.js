import { verifyKey } from 'discord-interactions';

const API = 'https://discord.com/api/v10';
const PAGE_SIZE = 5;

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('Discord bot is running.', { status: 200 });
    }

    const signature = request.headers.get('x-signature-ed25519');
    const timestamp = request.headers.get('x-signature-timestamp');
    const body = await request.text();

    const isValid =
      signature &&
      timestamp &&
      (await verifyKey(body, signature, timestamp, env.DISCORD_PUBLIC_KEY));

    if (!isValid) {
      return new Response('Bad request signature', { status: 401 });
    }

    const interaction = JSON.parse(body);

    if (interaction.type === 1) {
      return json({ type: 1 });
    }

    if (interaction.type === 2) {
      return handleCommand(interaction, env);
    }

    if (interaction.type === 4) {
      return handleAutocomplete(interaction, env);
    }

    if (interaction.type === 3) {
      return handleComponent(interaction, env);
    }

    if (interaction.type === 5) {
      return handleModalSubmit(interaction, env);
    }

    return json(reply('Unsupported interaction type.'));
  },
};

// ---------- Slash commands ----------

async function handleCommand(interaction, env) {
  const name = interaction.data.name;
  const options = interaction.data.options || [];
  const getOpt = (n) => options.find((o) => o.name === n)?.value;

  try {
    if (name === 'ping') {
      return json(reply('Pong!'));
    }

    if (name === 'save') {
      const key = getOpt('key');
      const value = getOpt('value');
      await env.DATA.put(key, value);
      return json(reply(`Saved **${key}**.`));
    }

    if (name === 'load') {
      const key = getOpt('key');
      const value = await env.DATA.get(key);
      return json(reply(value ? `**${key}**: ${value}` : `No data found for **${key}**.`));
    }

    if (name === 'delete') {
      const key = getOpt('key');
      await env.DATA.delete(key);
      return json(reply(`Deleted **${key}**.`));
    }

    if (name === 'list') {
      const list = await env.DATA.list();
      const keys = list.keys.map((k) => k.name);
      return json(reply(keys.length ? `Saved keys:\n${keys.join(', ')}` : 'No saved keys yet.'));
    }

    if (name === 'addserver') {
      return json({
        type: 9, // MODAL
        data: {
          custom_id: 'addserver_modal',
          title: 'Submit a Private Server',
          components: [
            textInputRow('server_name', 'Server Name', 1, true, 100),
            textInputRow('server_region', 'Server Region', 1, true, 60),
            textInputRow('server_game', 'Game', 1, true, 60),
            textInputRow('server_about', 'About Server', 2, true, 500),
            textInputRow('server_link', 'Server Discord Link', 1, true, 200),
          ],
        },
      });
    }

    if (name === 'serverlist') {
      const game = getOpt('game') || 'all';
      const page = 0;
      return json(await buildServerListResponse(env, game, page, false));
    }

    if (name === 'removeserver') {
      const memberRoles = interaction.member?.roles || [];
      if (!memberRoles.includes(env.MOD_ROLE_ID)) {
        return json(reply("You don't have permission to do this.", true));
      }

      const id = getOpt('server');
      const raw = await env.DATA.get(`server:${id}`);
      if (!raw) {
        return json(reply('That server could not be found (it may already be removed).', true));
      }

      const server = JSON.parse(raw);
      await env.DATA.delete(`server:${id}`);
      return json(reply(`Removed **${server.name}** (${server.game}) from the server list.`, true));
    }
  } catch (err) {
    return json(reply(`Error: ${err.message}`));
  }

  return json(reply('Unknown command.'));
}

// ---------- Autocomplete ----------

async function handleAutocomplete(interaction, env) {
  const options = interaction.data.options || [];
  const focused = options.find((o) => o.focused);
  const query = (focused?.value || '').toLowerCase();

  const list = await env.DATA.list({ prefix: 'server:' });
  const records = await Promise.all(list.keys.map((k) => env.DATA.get(k.name)));
  const servers = records
    .filter(Boolean)
    .map((r) => JSON.parse(r))
    .filter((s) => s.status === 'approved')
    .filter((s) => s.name.toLowerCase().includes(query))
    .slice(0, 25);

  return json({
    type: 8, // APPLICATION_COMMAND_AUTOCOMPLETE_RESULT
    data: {
      choices: servers.map((s) => ({ name: `${s.name} (${s.game})`, value: s.id })),
    },
  });
}

// ---------- Modal submissions ----------

async function handleModalSubmit(interaction, env) {
  if (interaction.data.custom_id !== 'addserver_modal') {
    return json(reply('Unknown form.'));
  }

  const fields = {};
  for (const row of interaction.data.components) {
    for (const comp of row.components) {
      fields[comp.custom_id] = comp.value;
    }
  }

  const id = crypto.randomUUID().slice(0, 8);
  const submitter = interaction.member?.user || interaction.user;

  const server = {
    id,
    name: fields.server_name,
    region: fields.server_region,
    game: fields.server_game,
    about: fields.server_about,
    link: fields.server_link,
    status: 'pending',
    submittedBy: submitter?.id,
    submittedByName: submitter?.username || 'Unknown',
    submittedAt: Date.now(),
  };

  await env.DATA.put(`server:${id}`, JSON.stringify(server));

  // Post to the mod review channel with Approve/Reject buttons
  const embed = serverEmbed(server, 0xffaa00, 'Pending review');
  const res = await discordApi(env, `/channels/${env.MOD_CHANNEL_ID}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      embeds: [embed],
      components: [
        {
          type: 1,
          components: [
            { type: 2, style: 3, label: 'Approve', custom_id: `approve_${id}` },
            { type: 2, style: 4, label: 'Reject', custom_id: `reject_${id}` },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    return json(reply('Submitted, but I could not notify the mod channel. Ask an admin to check the bot permissions.', true));
  }

  return json(reply('Your server submission has been sent for moderator review. Thanks!', true));
}

// ---------- Buttons ----------

async function handleComponent(interaction, env) {
  const customId = interaction.data.custom_id;

  if (customId.startsWith('approve_') || customId.startsWith('reject_')) {
    return handleApproval(interaction, env, customId);
  }

  if (customId.startsWith('slpage:')) {
    return handlePagination(interaction, env, customId);
  }

  return json(reply('Unknown interaction.', true));
}

async function handleApproval(interaction, env, customId) {
  const memberRoles = interaction.member?.roles || [];
  if (!memberRoles.includes(env.MOD_ROLE_ID)) {
    return json(reply("You don't have permission to do this.", true));
  }

  const isApprove = customId.startsWith('approve_');
  const id = customId.split('_')[1];
  const raw = await env.DATA.get(`server:${id}`);

  if (!raw) {
    return json({
      type: 7,
      data: { content: 'This submission no longer exists.', embeds: [], components: [] },
    });
  }

  const server = JSON.parse(raw);
  const modName = interaction.member?.user?.username || 'a moderator';

  if (isApprove) {
    server.status = 'approved';
    await env.DATA.put(`server:${id}`, JSON.stringify(server));
    const embed = serverEmbed(server, 0x2ecc71, `Approved by ${modName}`);
    return json({ type: 7, data: { embeds: [embed], components: [] } });
  } else {
    await env.DATA.delete(`server:${id}`);
    const embed = serverEmbed(server, 0xe74c3c, `Rejected by ${modName}`);
    return json({ type: 7, data: { embeds: [embed], components: [] } });
  }
}

async function handlePagination(interaction, env, customId) {
  const parts = customId.split(':');
  const action = parts[1];
  const currentPage = parseInt(parts[2], 10);
  const game = decodeURIComponent(parts.slice(3).join(':'));

  const { servers, totalPages } = await getApprovedServers(env, game);

  let page = currentPage;
  if (action === 'first') page = 0;
  else if (action === 'prev') page = Math.max(0, currentPage - 1);
  else if (action === 'next') page = Math.min(totalPages - 1, currentPage + 1);
  else if (action === 'last') page = Math.max(0, totalPages - 1);

  return json(await buildServerListResponse(env, game, page, true, { servers, totalPages }));
}

// ---------- Helpers ----------

function textInputRow(customId, label, style, required, maxLength) {
  return {
    type: 1,
    components: [
      {
        type: 4,
        custom_id: customId,
        label,
        style,
        required,
        max_length: maxLength,
      },
    ],
  };
}

function serverEmbed(server, color, statusLabel) {
  return {
    title: server.name,
    color,
    fields: [
      { name: 'Game', value: server.game, inline: true },
      { name: 'Region', value: server.region, inline: true },
      { name: 'Status', value: statusLabel, inline: true },
      { name: 'About', value: server.about },
      { name: 'Discord Link', value: server.link },
    ],
    footer: { text: `Submitted by ${server.submittedByName} • ID: ${server.id}` },
  };
}

async function getApprovedServers(env, game) {
  const list = await env.DATA.list({ prefix: 'server:' });
  const records = await Promise.all(list.keys.map((k) => env.DATA.get(k.name)));
  let servers = records.filter(Boolean).map((r) => JSON.parse(r)).filter((s) => s.status === 'approved');

  if (game && game.toLowerCase() !== 'all') {
    servers = servers.filter((s) => s.game.toLowerCase() === game.toLowerCase());
  }

  servers.sort((a, b) => a.name.localeCompare(b.name));
  const totalPages = Math.max(1, Math.ceil(servers.length / PAGE_SIZE));
  return { servers, totalPages };
}

async function buildServerListResponse(env, game, page, isUpdate, precomputed) {
  const { servers, totalPages } = precomputed || (await getApprovedServers(env, game));
  const start = page * PAGE_SIZE;
  const pageServers = servers.slice(start, start + PAGE_SIZE);

  const title = game.toLowerCase() === 'all' ? 'Available Servers' : `Available Servers — ${game}`;
  const embed = {
    title,
    color: 0x5865f2,
    description: pageServers.length
      ? pageServers
          .map(
            (s) =>
              `**${s.name}** — ${s.game} (${s.region})\n${s.about}\n${s.link}`
          )
          .join('\n\n')
      : 'No approved servers found.',
    footer: { text: `Page ${page + 1} of ${totalPages}` },
  };

  const encodedGame = encodeURIComponent(game);
  const components = [
    {
      type: 1,
      components: [
        button('⏮', `slpage:first:${page}:${encodedGame}`, page === 0),
        button('◀', `slpage:prev:${page}:${encodedGame}`, page === 0),
        button('▶', `slpage:next:${page}:${encodedGame}`, page >= totalPages - 1),
        button('⏭', `slpage:last:${page}:${encodedGame}`, page >= totalPages - 1),
      ],
    },
  ];

  const data = { embeds: [embed], components };
  return isUpdate ? { type: 7, data } : { type: 4, data };
}

function button(label, customId, disabled) {
  return { type: 2, style: 2, label, custom_id: customId, disabled };
}

function reply(content, ephemeral) {
  return { type: 4, data: { content, flags: ephemeral ? 64 : undefined } };
}

function json(data) {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  });
}

async function discordApi(env, path, options = {}) {
  return fetch(`${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
}
