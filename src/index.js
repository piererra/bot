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
  const userId = interaction.member?.user?.id || interaction.user?.id;

  if (userId !== env.OWNER_ID) {
    const cooldownSeconds = name === 'addserver' ? 3600 : 30;
    const cooldownKey = `cooldown:${userId}:${name}`;
    const existing = await env.DATA.get(cooldownKey);

    if (existing) {
      const expiresAt = parseInt(existing, 10);
      const remainingMs = expiresAt - Date.now();
      if (remainingMs > 0) {
        return json(reply(`This command is on cooldown. Try again in ${formatDuration(remainingMs)}.`, true));
      }
    }

    await env.DATA.put(cooldownKey, String(Date.now() + cooldownSeconds * 1000), {
      expirationTtl: cooldownSeconds,
    });
  }

  try {
    if (name === 'ping') {
      const createdAt = snowflakeToTimestamp(interaction.id);
      const latencyMs = Date.now() - createdAt;
      return json(reply(`🏓 Pong! Latency: **${latencyMs}ms**`, true));
    }

    if (name === 'addserver') {
      const games = await getGameList(env);
      if (games.length === 0) {
        return json(reply('No games have been configured yet. Ask an owner to run `/managegames add <name>` first.', true));
      }

      return json({
        type: 4,
        data: {
          content: 'Select the game your server is for:',
          flags: 64,
          components: [
            {
              type: 1,
              components: [
                {
                  type: 3, // STRING_SELECT
                  custom_id: 'addserver_game_select',
                  placeholder: 'Choose a game',
                  options: buildGameOptions(games),
                },
              ],
            },
          ],
        },
      });
    }

    if (name === 'managegames') {
      const requesterId = interaction.member?.user?.id || interaction.user?.id;
      if (requesterId !== env.OWNER_ID) {
        return json(reply("You don't have permission to do this.", true));
      }

      const sub = interaction.data.options[0];
      const getSubOpt = (n) => sub.options.find((o) => o.name === n)?.value;
      const gameName = getSubOpt('name')?.trim();
      const games = await getGameList(env);

      if (sub.name === 'add') {
        const icon = getSubOpt('icon')?.trim();
        if (gameName.toLowerCase() === 'other') {
          return json(reply('"Other" is reserved and always shown automatically — no need to add it.', true));
        }
        if (icon && !isValidUrl(icon)) {
          return json(reply('That icon URL doesn\'t look valid. It should be a direct image link starting with https://.', true));
        }
        const existing = games.find((g) => g.name.toLowerCase() === gameName.toLowerCase());
        if (existing) {
          existing.icon = icon || existing.icon;
          await env.DATA.put('config:games', JSON.stringify(games));
          return json(reply(`Updated **${gameName}**${icon ? ' with a new icon' : ''}.`, true));
        }
        if (games.length >= 24) {
          return json(reply('The game list is full (24 max — 1 slot is reserved for "Other").', true));
        }
        games.push({ name: gameName, icon: icon || null });
        await env.DATA.put('config:games', JSON.stringify(games));
        return json(reply(`Added **${gameName}** to the game list${icon ? ' with an icon' : ''}.`, true));
      }

      if (sub.name === 'remove') {
        const filtered = games.filter((g) => g.name.toLowerCase() !== gameName.toLowerCase());
        if (filtered.length === games.length) {
          return json(reply(`**${gameName}** wasn't found in the list.`, true));
        }
        await env.DATA.put('config:games', JSON.stringify(filtered));
        return json(reply(`Removed **${gameName}** from the game list.`, true));
      }

      if (sub.name === 'list') {
        return json(buildGameListEmbed(games));
      }
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

    if (name === 'clear') {
      const requesterId = interaction.member?.user?.id || interaction.user?.id;
      if (requesterId !== env.OWNER_ID) {
        return json(reply("You don't have permission to do this.", true));
      }

      const qtyInput = getOpt('qty');
      let qty = 100; // default: delete as many as allowed when not specified
      if (qtyInput !== undefined) {
        if (qtyInput < 1 || qtyInput > 100) {
          return json(reply('Quantity must be between 1 and 100.', true));
        }
        qty = qtyInput;
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
  const commandName = interaction.data.name;

  if (commandName === 'removeserver') {
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
      type: 8,
      data: { choices: servers.map((s) => ({ name: `${s.name} (${s.game})`, value: s.id })) },
    });
  }

  if (commandName === 'managegames') {
    const sub = interaction.data.options[0];
    if (sub.name === 'remove') {
      const focused = sub.options.find((o) => o.focused);
      const query = (focused?.value || '').toLowerCase();

      const games = await getGameList(env);
      const matches = games
        .filter((g) => g.name.toLowerCase().includes(query))
        .slice(0, 25);

      return json({
        type: 8,
        data: { choices: matches.map((g) => ({ name: g.name, value: g.name })) },
      });
    }
  }

  return json({ type: 8, data: { choices: [] } });
}

function buildGameListEmbed(games) {
  const sorted = [...games].sort((a, b) => a.name.localeCompare(b.name));
  const lines = sorted.map((g) => `${g.icon ? '🖼️' : '▫️'} ${g.name}`);
  lines.push('▫️ Other _(always shown, reserved)_');

  return {
    type: 4,
    data: {
      flags: 64,
      embeds: [
        {
          title: '🎮 Game List',
          color: 0x5865f2,
          description: lines.join('\n'),
          footer: { text: `${sorted.length}/24 games configured • 🖼️ = has an icon` },
        },
      ],
    },
  };
}

// ---------- Modal submissions ----------

async function handleModalSubmit(interaction, env) {
  if (!interaction.data.custom_id.startsWith('addserver_modal:')) {
    return json(reply('Unknown form.'));
  }

  const game = decodeURIComponent(interaction.data.custom_id.split(':')[1]);

  const fields = {};
  for (const row of interaction.data.components) {
    for (const comp of row.components) {
      fields[comp.custom_id] = comp.value;
    }
  }

  const id = crypto.randomUUID().slice(0, 8);
  const submitter = interaction.member?.user || interaction.user;
  const normalizedLink = normalizeLink(fields.server_link);

  if (!isValidDiscordInvite(normalizedLink)) {
    return json(reply(
      "That doesn't look like a valid Discord invite link. It needs to be something like `discord.gg/yourcode` or `discord.com/invite/yourcode`. Please run `/addserver` again with a valid link.",
      true
    ));
  }

  const server = {
    id,
    name: fields.server_name,
    region: fields.server_region,
    game,
    about: fields.server_about,
    link: normalizedLink,
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

  // Notify the public submission log channel
  if (env.SUBMISSION_CHANNEL_ID) {
    await discordApi(env, `/channels/${env.SUBMISSION_CHANNEL_ID}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        content: `📥 **${server.name}** (${server.game}) was just submitted by <@${server.submittedBy}> and is awaiting moderator review.`,
      }),
    });
  }

  return json(reply('Your server submission has been sent for moderator review. Thanks!', true));
}

// ---------- Buttons ----------

async function handleComponent(interaction, env) {
  const customId = interaction.data.custom_id;

  if (customId === 'addserver_game_select') {
    const game = interaction.data.values[0];
    return json({
      type: 9, // MODAL
      data: {
        custom_id: `addserver_modal:${encodeURIComponent(game)}`,
        title: `Add ${game} Server`.slice(0, 45),
        components: [
          textInputRow('server_name', 'Server Name', 1, true, 100),
          textInputRow('server_region', 'Server Region', 1, true, 60),
          textInputRow('server_about', 'About Server', 2, true, 500),
          textInputRow('server_link', 'Server Discord Invite Links', 1, true, 200),
        ],
      },
    });
  }

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

function buildGameOptions(games) {
  const sorted = [...games].sort((a, b) => a.name.localeCompare(b.name));
  const names = sorted.map((g) => g.name);
  const withOther = [...names, 'Other'];
  return withOther.slice(0, 25).map((n) => ({ label: n, value: n }));
}

async function getGameList(env) {
  const raw = await env.DATA.get('config:games');
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  // Backward-compatible: older entries were plain strings, not {name, icon} objects.
  return parsed.map((g) => (typeof g === 'string' ? { name: g, icon: null } : g));
}

function getGameIcon(games, gameName) {
  const match = games.find((g) => g.name.toLowerCase() === gameName.toLowerCase());
  return match?.icon || null;
}

function isValidUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

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

const GAME_COLOR_PALETTE = [0x5865f2, 0xeb459e, 0x57f287, 0xfee75c, 0xed4245, 0x00b0f4, 0xff922b, 0x9b59b6, 0x2ecc71, 0xe67e22];

function colorForGame(gameName) {
  let hash = 0;
  for (let i = 0; i < gameName.length; i++) {
    hash = (hash * 31 + gameName.charCodeAt(i)) >>> 0;
  }
  return GAME_COLOR_PALETTE[hash % GAME_COLOR_PALETTE.length];
}

function serverCardEmbed(server, iconUrl) {
  const about = server.about.length > 150 ? `${server.about.slice(0, 150)}...` : server.about;
  const embed = {
    title: server.name,
    color: colorForGame(server.game),
    fields: [
      { name: 'Game', value: server.game, inline: true },
      { name: 'Region', value: `🌍 ${server.region}`, inline: true },
      { name: 'About', value: about },
    ],
    footer: { text: '🎮 Private Server Directory' },
  };
  if (iconUrl) {
    embed.thumbnail = { url: iconUrl };
  }
  return embed;
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
  const games = await getGameList(env);

  const title = game.toLowerCase() === 'all' ? '**Available Servers**' : `**Available Servers — ${game}**`;
  const summary = `${servers.length} server${servers.length === 1 ? '' : 's'} found • Page ${page + 1} of ${totalPages}`;
  const content = `${title}\n${summary}`;

  const embeds = pageServers.length
    ? pageServers.map((s) => serverCardEmbed(s, getGameIcon(games, s.game)))
    : [{ description: 'No approved servers found.', color: 0x5865f2 }];

  const components = [];

  if (pageServers.length) {
    components.push({
      type: 1,
      components: pageServers.map((s) => ({
        type: 2,
        style: 5, // LINK
        label: `Join ${s.name}`.slice(0, 80),
        url: s.link,
      })),
    });
  }

  const encodedGame = encodeURIComponent(game);
  components.push({
    type: 1,
    components: [
      button('⏮', `slpage:first:${page}:${encodedGame}`, page === 0),
      button('◀', `slpage:prev:${page}:${encodedGame}`, page === 0),
      button('▶', `slpage:next:${page}:${encodedGame}`, page >= totalPages - 1),
      button('⏭', `slpage:last:${page}:${encodedGame}`, page >= totalPages - 1),
    ],
  });

  const data = { content, embeds, components };
  return isUpdate ? { type: 7, data } : { type: 4, data };
}

function button(label, customId, disabled) {
  return { type: 2, style: 2, label, custom_id: customId, disabled };
}

function formatDuration(ms) {
  const totalSeconds = Math.ceil(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function snowflakeToTimestamp(id) {
  const DISCORD_EPOCH = 1420070400000n;
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}

function normalizeLink(link) {
  const trimmed = (link || '').trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

function isValidDiscordInvite(link) {
  let url;
  try {
    url = new URL(link);
  } catch {
    return false;
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');

  if (host === 'discord.gg') {
    return /^\/[a-zA-Z0-9-]{2,}\/?$/.test(url.pathname);
  }

  if (host === 'discord.com' || host === 'discordapp.com') {
    return /^\/invite\/[a-zA-Z0-9-]{2,}\/?$/.test(url.pathname);
  }

  return false;
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
