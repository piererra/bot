import { verifyKey } from 'discord-interactions';

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

    // Discord PING check (required for the endpoint to be accepted)
    if (interaction.type === 1) {
      return json({ type: 1 });
    }

    // Slash command
    if (interaction.type === 2) {
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
          return json(
            reply(value ? `**${key}**: ${value}` : `No data found for **${key}**.`)
          );
        }

        if (name === 'delete') {
          const key = getOpt('key');
          await env.DATA.delete(key);
          return json(reply(`Deleted **${key}**.`));
        }

        if (name === 'list') {
          const list = await env.DATA.list();
          const keys = list.keys.map((k) => k.name);
          return json(
            reply(keys.length ? `Saved keys:\n${keys.join(', ')}` : 'No saved keys yet.')
          );
        }
      } catch (err) {
        return json(reply(`Error: ${err.message}`));
      }

      return json(reply('Unknown command.'));
    }

    return json(reply('Unsupported interaction type.'));
  },
};

function reply(content) {
  return { type: 4, data: { content } };
}

function json(data) {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  });
}
