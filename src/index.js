import { verifyKey } from 'discord-interactions';

const API = 'https://discord.com/api/v10';
const PAGE_SIZE = 5;

export default {
  async fetch(request, env, ctx) {
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
      return handleCommand(interaction, env, ctx);
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

async function handleCommand(interaction, env, ctx) {
  const name = interaction.data.name;
  const options = interaction.data.options || [];
  const getOpt = (n) => options.find((o) => o.name === n)?.value;

  try {
    if (name === 'ping') {
      const createdAt = snowflakeToTimestamp(interaction.id);
      const latencyMs = Date.now() - createdAt;
      return json(reply(`Latency: **${latencyMs}ms**`, true));
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
      await removeFromApprovedIndex(env, id);
      return json(reply(`Removed **${server.name}** (${server.game}) from the server list.`, true));
    }

    if (name === 'clear') {
      const requesterId = interaction.member?.user?.id || interaction.user?.id;
      if (requesterId !== env.OWNER_ID) {
        return json(reply("You don't have permission to do this.", true));
      }

      const qty = getOpt('qty');
      if (!qty || qty < 1 || qty > 100) {
        return json(reply('Quantity must be between 1 and 100.', true));
      }

      const channelId = interaction.channel_id || interaction.channel?.id;
      ctx.waitUntil(clearMessages(env, interaction, channelId, qty));

      return json({ type: 5, data: { flags: 64 } }); // DEFERRED, ephemeral
    }
  } catch (err) {
    return json(reply(`Error: ${err.message}`));
  }

  return json(reply('Unknown command.'));
}

// ---------- Clear command ----------

async function clearMessages(env, interaction, channelId, qty) {
  let resultText;

  try {
    const fetchRes = await discordApi(env, `/channels/${channelId}/messages?limit=${qty}`, {
      method: 'GET',
    });

    if (!fetchRes.ok) {
      resultText = 'Could not fetch messages. Make sure the bot has View Channel and Read Message History permissions here.';
    } else {
      const messages = await fetchRes.json();
      const ids = messages.map((m) => m.id);

      if (ids.length === 0) {
        resultText = 'No messages to delete.';
      } else if (ids.length === 1) {
        const delRes = await discordApi(env, `/channels/${channelId}/messages/${ids[0]}`, {
          method: 'DELETE',
        });
        resultText = delRes.ok ? 'Deleted 1 message.' : 'Failed to delete the message.';
      } else {
        const bulkRes = await discordApi(env, `/channels/${channelId}/messages/bulk-delete`, {
          method: 'POST',
          body: JSON.stringify({ messages: ids }),
        });
        resultText = bulkRes.ok
          ? `Deleted ${ids.length} messages.`
          : 'Bulk delete failed — messages older than 14 days cannot be bulk deleted, and the bot needs Manage Messages permission here.';
      }
    }
  } catch (err) {
    resultText = `Error while clearing messages: ${err.message}`;
  }

  await editOriginalResponse(env, interaction, resultText);
}

async function editOriginalResponse(env, interaction, content) {
  await fetch(`${API}/webhooks/${env.DISCORD_APPLICATION_ID}/${interaction.token}/messages/@original`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
}

// ---------- Autocomplete ----------

async function handleAutocomplete(interaction, env) {
  const options = interaction.data.options || [];
  const focused = options.find((o) => o.focused);
  const query = (focused?.value || '').toLowerCase();

  const index = await getApprovedIndex(env);
  const servers = index.filter((s) => s.name.toLowerCase().includes(query)).slice(0, 25);

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

  const submitter = interaction.member?.user || interaction.user;

  const existingPendingId = await env.DATA.get(`pending_by_user:${submitter?.id}`);
  if (existingPendingId) {
    return json(
      reply(
        'You already have a submission awaiting review. Please wait for a moderator to approve or reject it before submitting another.',
        true
      )
    );
  }

  const fields = {};
  for (const row of interaction.data.components) {
    for (const comp of row.components) {
      fields[comp.custom_id] = comp.value;
    }
  }

  const id = await generateUniqueId(env);

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
  await env.DATA.put(`pending_by_user:${submitter?.id}`, id);

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

  if (server.submittedBy) {
    const lockedId = await env.DATA.get(`pending_by_user:${server.submittedBy}`);
    if (lockedId === id) {
      await env.DATA.delete(`pending_by_user:${server.submittedBy}`);
    }
  }

  if (isApprove) {
    server.status = 'approved';
    await env.DATA.put(`server:${id}`, JSON.stringify(server));
    await addToApprovedIndex(env, server);
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
  let servers = await getApprovedIndex(env);

  if (game && game.toLowerCase() !== 'all') {
    servers = servers.filter((s) => s.game.toLowerCase() === game.toLowerCase());
  }

  const totalPages = Math.max(1, Math.ceil(servers.length / PAGE_SIZE));
  return { servers, totalPages };
}

// ---------- Approved-servers index ----------
// Reading/filtering every "server:" key from KV on each /serverlist, pagination
// click, and autocomplete keystroke doesn't scale. This index keeps a single
// sorted JSON array of approved servers under one KV key, updated whenever a
// server is approved or removed. If the index key is missing (first run after
// this update, or if it's ever lost) it's rebuilt once from a full scan.

const APPROVED_INDEX_KEY = 'approved_index';

function toIndexEntry(server) {
  const { id, name, region, game, about, link } = server;
  return { id, name, region, game, about, link };
}

async function getApprovedIndex(env) {
  const raw = await env.DATA.get(APPROVED_INDEX_KEY);
  if (raw) return JSON.parse(raw);

  // Migration/repair path: rebuild from a full scan, then cache it.
  const list = await env.DATA.list({ prefix: 'server:' });
  const records = await Promise.all(list.keys.map((k) => env.DATA.get(k.name)));
  const servers = records
    .filter(Boolean)
    .map((r) => JSON.parse(r))
    .filter((s) => s.status === 'approved')
    .map(toIndexEntry)
    .sort((a, b) => a.name.localeCompare(b.name));

  await env.DATA.put(APPROVED_INDEX_KEY, JSON.stringify(servers));
  return servers;
}

async function addToApprovedIndex(env, server) {
  const index = await getApprovedIndex(env);
  const withoutExisting = index.filter((s) => s.id !== server.id);
  withoutExisting.push(toIndexEntry(server));
  withoutExisting.sort((a, b) => a.name.localeCompare(b.name));
  await env.DATA.put(APPROVED_INDEX_KEY, JSON.stringify(withoutExisting));
}

async function removeFromApprovedIndex(env, id) {
  const index = await getApprovedIndex(env);
  const filtered = index.filter((s) => s.id !== id);
  await env.DATA.put(APPROVED_INDEX_KEY, JSON.stringify(filtered));
}

// ---------- Collision-safe ID generation ----------

async function generateUniqueId(env) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = crypto.randomUUID().slice(0, 8);
    const existing = await env.DATA.get(`server:${candidate}`);
    if (!existing) return candidate;
  }
  // Extremely unlikely fallback: full UUID, effectively collision-proof.
  return crypto.randomUUID();
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

function snowflakeToTimestamp(id) {
  const DISCORD_EPOCH = 1420070400000n;
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
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
