const USAGE_KEY = "public-visits";

export async function onRequestPost({ env }) {
  if (!env.USAGE_KV) {
    return json({ visits: 0, updatedAt: null, configured: false }, 503);
  }

  const usage = await readUsage(env);
  usage.visits += 1;
  usage.updatedAt = new Date().toISOString();
  usage.configured = true;

  await env.USAGE_KV.put(USAGE_KEY, JSON.stringify({
    visits: usage.visits,
    updatedAt: usage.updatedAt,
  }));

  return json(usage);
}

async function readUsage(env) {
  const raw = await env.USAGE_KV.get(USAGE_KEY);
  if (!raw) return { visits: 0, updatedAt: null };

  try {
    const parsed = JSON.parse(raw);
    return {
      visits: Number(parsed.visits || 0),
      updatedAt: parsed.updatedAt || null,
    };
  } catch {
    return { visits: 0, updatedAt: null };
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
