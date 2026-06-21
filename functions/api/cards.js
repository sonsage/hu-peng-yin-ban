const CARDS_KEY = "nearby-cards";
const REPLIES_KEY = "card-replies";
const CARD_TTL_MS = 120 * 60 * 1000;
const MAX_CARDS = 50;
const ALLOWED_VEHICLES = new Set(["機車", "自行車", "重機", "徒步"]);
const ALLOWED_TYPES = new Set(["找同騎", "問路況", "補給詢問", "需要協助", "模板訊息"]);

export async function onRequestGet({ request, env }) {
  if (!env.USAGE_KV) return json({ configured: false, cards: [] }, 503);

  const url = new URL(request.url);
  const viewer = normalizeLocation({
    lat: url.searchParams.get("lat"),
    lng: url.searchParams.get("lng"),
    radiusKm: url.searchParams.get("radiusKm"),
  });
  const viewerId = normalizeId(url.searchParams.get("viewerId"));
  if (!viewer) return json({ error: "invalid_location" }, 400);

  const now = Date.now();
  const active = (await readCards(env)).filter((card) => isActive(card, now));
  const activeIds = new Set(active.map((card) => card.id));
  const replies = (await readReplies(env)).filter((reply) => isActiveReply(reply, now, activeIds));
  await env.USAGE_KV.put(CARDS_KEY, JSON.stringify(active));
  await env.USAGE_KV.put(REPLIES_KEY, JSON.stringify(replies));

  const cards = active
    .map((card) => ({
      id: card.id,
      ownerId: card.ownerId,
      nickname: card.nickname,
      vehicle: card.vehicle,
      type: card.type,
      note: card.note,
      distanceMeters: Math.round(distanceMeters(viewer, card) / 100) * 100,
      bearingDegrees: quantizeBearing(bearingDegrees(viewer, card)),
      createdAt: card.createdAt,
      expiresAt: card.expiresAt,
      replies: replies
        .filter((reply) => reply.cardId === card.id)
        .filter((reply) => card.ownerId === viewerId || reply.ownerId === viewerId)
        .map((reply) => ({
          id: reply.id,
          nickname: reply.nickname,
          vehicle: reply.vehicle,
          message: reply.message,
          distanceMeters: Math.round(distanceMeters(viewer, reply) / 100) * 100,
          createdAt: reply.createdAt,
        })),
    }))
    .filter((card) => card.distanceMeters <= viewer.radiusKm * 1000)
    .sort((a, b) => a.expiresAt - b.expiresAt)
    .slice(0, MAX_CARDS);

  return json({ configured: true, ttlMinutes: Math.round(CARD_TTL_MS / 60000), cards });
}

export async function onRequestPost({ request, env }) {
  if (!env.USAGE_KV) return json({ configured: false, cards: [] }, 503);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const card = normalizeCard(payload);
  if (!card) return json({ error: "invalid_payload" }, 400);

  const now = Date.now();
  const active = (await readCards(env)).filter((item) => isActive(item, now));
  active.unshift({
    ...card,
    id: crypto.randomUUID(),
    createdAt: now,
    expiresAt: now + CARD_TTL_MS,
  });

  await env.USAGE_KV.put(CARDS_KEY, JSON.stringify(active.slice(0, MAX_CARDS)));
  return json({ configured: true, ttlMinutes: Math.round(CARD_TTL_MS / 60000) });
}

export async function onRequestDelete({ request, env }) {
  if (!env.USAGE_KV) return json({ configured: false }, 503);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const cardId = String(payload.cardId || "");
  const ownerId = normalizeId(payload.ownerId);
  if (!cardId || !ownerId) return json({ error: "invalid_payload" }, 400);

  const now = Date.now();
  const active = (await readCards(env))
    .filter((card) => isActive(card, now))
    .filter((card) => !(card.id === cardId && card.ownerId === ownerId));

  await env.USAGE_KV.put(CARDS_KEY, JSON.stringify(active));
  return json({ configured: true });
}

async function readCards(env) {
  const raw = await env.USAGE_KV.get(CARDS_KEY);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function readReplies(env) {
  const raw = await env.USAGE_KV.get(REPLIES_KEY);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeCard(payload) {
  const location = normalizeLocation(payload?.location);
  const ownerId = normalizeId(payload?.ownerId);
  if (!location || !ownerId) return null;

  const type = ALLOWED_TYPES.has(payload.type) ? payload.type : "模板訊息";
  const vehicle = ALLOWED_VEHICLES.has(payload.vehicle) ? payload.vehicle : "機車";

  return {
    ownerId,
    nickname: sanitizeText(payload.nickname || "匿名", 16),
    vehicle,
    type,
    note: sanitizeText(payload.note || "", 80),
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
    radiusKm: Math.min(50, Math.max(1, Number(payload.radiusKm || 30))),
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

function isActive(card, now) {
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

function distanceMeters(from, to) {
  const radius = 6371000;
  const lat1 = from.lat * Math.PI / 180;
  const lat2 = to.lat * Math.PI / 180;
  const dLat = (to.lat - from.lat) * Math.PI / 180;
  const dLng = (to.lng - from.lng) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * radius * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function bearingDegrees(from, to) {
  const lat1 = from.lat * Math.PI / 180;
  const lat2 = to.lat * Math.PI / 180;
  const dLng = (to.lng - from.lng) * Math.PI / 180;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2)
    - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function quantizeBearing(degrees) {
  return Math.round(degrees / 30) * 30 % 360;
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
