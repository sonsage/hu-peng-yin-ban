const CARDS_KEY = "nearby-cards";
const REPLIES_KEY = "card-replies";
const CARD_TTL_MS = 120 * 60 * 1000;
const MAX_REPLIES = 200;
const ALLOWED_VEHICLES = new Set(["機車", "自行車", "重機", "徒步"]);

export async function onRequestPost({ request, env }) {
  if (!env.USAGE_KV) return json({ configured: false }, 503);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const reply = normalizeReply(payload);
  if (!reply) return json({ error: "invalid_payload" }, 400);

  const now = Date.now();
  const cards = (await readList(env, CARDS_KEY)).filter((card) => isActiveCard(card, now));
  const target = cards.find((card) => card.id === reply.cardId);
  if (!target) return json({ error: "card_not_found" }, 404);
  if (target.ownerId === reply.ownerId) return json({ error: "cannot_reply_self" }, 400);

  const activeCardIds = new Set(cards.map((card) => card.id));
  const replies = (await readList(env, REPLIES_KEY))
    .filter((item) => isActiveReply(item, now, activeCardIds));

  replies.unshift({
    ...reply,
    id: crypto.randomUUID(),
    targetOwnerId: target.ownerId,
    createdAt: now,
    expiresAt: Math.min(target.expiresAt, now + CARD_TTL_MS),
  });

  await env.USAGE_KV.put(REPLIES_KEY, JSON.stringify(replies.slice(0, MAX_REPLIES)));
  return json({ configured: true });
}

async function readList(env, key) {
  const raw = await env.USAGE_KV.get(key);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeReply(payload) {
  const location = normalizeLocation(payload?.location);
  const cardId = String(payload?.cardId || "").slice(0, 80);
  const ownerId = normalizeId(payload?.ownerId);
  const message = sanitizeText(payload?.message || "", 80);
  if (!location || !cardId || !ownerId || !message) return null;

  return {
    cardId,
    ownerId,
    nickname: sanitizeText(payload.nickname || "匿名", 16) || "匿名",
    vehicle: ALLOWED_VEHICLES.has(payload.vehicle) ? payload.vehicle : "機車",
    message,
    lat: location.lat,
    lng: location.lng,
  };
}

function normalizeLocation(payload) {
  const lat = Number(payload?.lat);
  const lng = Number(payload?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  return {
    lat: Number(lat.toFixed(3)),
    lng: Number(lng.toFixed(3)),
  };
}

function normalizeId(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
}

function sanitizeText(value, maxLength) {
  return String(value)
    .replace(/[<>{}[\]()`"'\\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function isActiveCard(card, now) {
  return card
    && typeof card.id === "string"
    && typeof card.ownerId === "string"
    && Number.isFinite(card.lat)
    && Number.isFinite(card.lng)
    && Number(card.expiresAt || 0) > now;
}

function isActiveReply(reply, now, activeCardIds) {
  return reply
    && typeof reply.id === "string"
    && typeof reply.cardId === "string"
    && activeCardIds.has(reply.cardId)
    && typeof reply.ownerId === "string"
    && Number.isFinite(reply.lat)
    && Number.isFinite(reply.lng)
    && Number(reply.expiresAt || 0) > now;
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
