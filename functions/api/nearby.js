const NEARBY_KEY = "nearby-users";
const NEARBY_TTL_MS = 30 * 60 * 1000;
const MAX_PEOPLE = 30;
const ALLOWED_VEHICLES = new Set(["機車", "自行車", "重機", "徒步"]);
const ALLOWED_STATUSES = new Set(["我已出發", "休息中", "已抵達", "需要協助"]);

export async function onRequestPost({ request, env }) {
  if (!env.USAGE_KV) {
    return json({ configured: false, people: [], updatedAt: null }, 503);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const user = normalizeUser(payload);
  if (!user) return json({ error: "invalid_payload" }, 400);

  const now = Date.now();
  const records = await readRecords(env);
  const active = records.filter((item) => isActive(item, now) && item.id !== user.id);

  if (user.status !== "關閉位置") {
    active.push({ ...user, updatedAt: now, expiresAt: now + NEARBY_TTL_MS });
  }

  const nearby = active
    .filter((item) => item.id !== user.id)
    .map((item) => ({
      id: item.id,
      nickname: item.nickname,
      vehicle: item.vehicle,
      status: item.status,
      distanceMeters: Math.round(distanceMeters(user, item) / 100) * 100,
      updatedAt: item.updatedAt,
    }))
    .filter((item) => item.distanceMeters <= user.radiusKm * 1000)
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, MAX_PEOPLE);

  await env.USAGE_KV.put(NEARBY_KEY, JSON.stringify(active));

  return json({
    configured: true,
    updatedAt: new Date(now).toISOString(),
    ttlMinutes: Math.round(NEARBY_TTL_MS / 60000),
    people: nearby,
  });
}

async function readRecords(env) {
  const raw = await env.USAGE_KV.get(NEARBY_KEY);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeUser(payload) {
  const lat = Number(payload?.location?.lat);
  const lng = Number(payload?.location?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  const id = String(payload.id || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  if (!id) return null;

  const vehicle = ALLOWED_VEHICLES.has(payload.vehicle) ? payload.vehicle : "機車";
  const status = ALLOWED_STATUSES.has(payload.status) ? payload.status : "我已出發";
  const radiusKm = Math.min(50, Math.max(1, Number(payload.radiusKm || 30)));

  return {
    id,
    nickname: sanitizeText(payload.nickname || "匿名", 16),
    vehicle,
    status,
    radiusKm,
    lat: roundCoord(lat),
    lng: roundCoord(lng),
  };
}

function sanitizeText(value, maxLength) {
  return String(value)
    .replace(/[<>{}[\]()`"'\\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength) || "匿名";
}

function roundCoord(value) {
  return Number(value.toFixed(3));
}

function isActive(item, now) {
  return item
    && typeof item.id === "string"
    && Number.isFinite(item.lat)
    && Number.isFinite(item.lng)
    && Number(item.expiresAt || 0) > now
    && ALLOWED_STATUSES.has(item.status);
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

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
