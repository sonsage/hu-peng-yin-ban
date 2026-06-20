const USAGE_KEY = "public-visits";

export async function onRequestGet({ env }) {
  const usage = await readUsage(env);
  return json(usage);
}

async function readUsage(env) {
  if (!env.USAGE_KV) {
    return { visits: 0, updatedAt: null, configured: false };
  }

  const raw = await env.USAGE_KV.get(USAGE_KEY);
  if (!raw) return { visits: 0, updatedAt: null, configured: true };

  try {
    const parsed = JSON.parse(raw);
    return {
      visits: Number(parsed.visits || 0),
      updatedAt: parsed.updatedAt || null,
      configured: true,
    };
  } catch {
    return { visits: 0, updatedAt: null, configured: true };
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
