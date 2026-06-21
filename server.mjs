import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = process.cwd();
const port = Number(process.env.PORT || 5173);
const usagePath = join(root, "usage.json");
const nearbyPath = join(root, "nearby-users.json");
const cardsPath = join(root, "nearby-cards.json");
const repliesPath = join(root, "card-replies.json");
const nearbyTtlMs = 30 * 60 * 1000;
const cardTtlMs = 120 * 60 * 1000;
const allowedVehicles = new Set(["機車", "自行車", "重機", "徒步"]);
const allowedStatuses = new Set(["我已出發", "休息中", "已抵達", "需要協助"]);
const allowedCardTypes = new Set(["找同騎", "問路況", "補給詢問", "需要協助", "模板訊息"]);

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "geolocation=(self)",
};

createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://localhost:${port}`);

    if (url.pathname === "/api/usage/visit" && request.method === "POST") {
      const usage = await readUsage();
      usage.visits += 1;
      usage.updatedAt = new Date().toISOString();
      await writeUsage(usage);
      sendJson(response, usage);
      return;
    }

    if (url.pathname === "/api/usage" && request.method === "GET") {
      sendJson(response, await readUsage());
      return;
    }

    if (url.pathname === "/api/nearby" && request.method === "POST") {
      const payload = await readJsonBody(request);
      const user = normalizeNearbyUser(payload);
      if (!user) {
        sendJson(response, { error: "invalid_payload" }, 400);
        return;
      }

      const now = Date.now();
      const records = await readNearbyRecords();
      const active = records.filter((item) => isActiveNearby(item, now) && item.id !== user.id);
      active.push({ ...user, updatedAt: now, expiresAt: now + nearbyTtlMs });

      const people = active
        .filter((item) => item.id !== user.id)
        .map((item) => ({
          id: item.id,
          nickname: item.nickname,
          vehicle: item.vehicle,
          status: item.status,
          distanceMeters: Math.round(distanceMeters(user, item) / 100) * 100,
          bearingDegrees: quantizeBearing(bearingDegrees(user, item)),
          updatedAt: item.updatedAt,
        }))
        .filter((item) => item.distanceMeters <= user.radiusKm * 1000)
        .sort((a, b) => a.distanceMeters - b.distanceMeters)
        .slice(0, 30);

      await writeFile(nearbyPath, `${JSON.stringify(active, null, 2)}\n`, "utf8");
      sendJson(response, {
        configured: true,
        updatedAt: new Date(now).toISOString(),
        ttlMinutes: Math.round(nearbyTtlMs / 60000),
        people,
      });
      return;
    }

    if (url.pathname === "/api/cards" && request.method === "GET") {
      const viewer = normalizeSharedLocation({
        lat: url.searchParams.get("lat"),
        lng: url.searchParams.get("lng"),
        radiusKm: url.searchParams.get("radiusKm"),
      });
      const viewerId = normalizeId(url.searchParams.get("viewerId"));
      if (!viewer) {
        sendJson(response, { error: "invalid_location" }, 400);
        return;
      }

      const now = Date.now();
      const active = (await readSharedCards()).filter((card) => isActiveCard(card, now));
      const activeIds = new Set(active.map((card) => card.id));
      const replies = (await readSharedReplies()).filter((reply) => isActiveReply(reply, now, activeIds));
      await writeFile(cardsPath, `${JSON.stringify(active, null, 2)}\n`, "utf8");
      await writeFile(repliesPath, `${JSON.stringify(replies, null, 2)}\n`, "utf8");
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
        .slice(0, 50);
      sendJson(response, { configured: true, ttlMinutes: Math.round(cardTtlMs / 60000), cards });
      return;
    }

    if (url.pathname === "/api/cards/reply" && request.method === "POST") {
      const payload = await readJsonBody(request);
      const reply = normalizeSharedReply(payload);
      if (!reply) {
        sendJson(response, { error: "invalid_payload" }, 400);
        return;
      }

      const now = Date.now();
      const cards = (await readSharedCards()).filter((card) => isActiveCard(card, now));
      const target = cards.find((card) => card.id === reply.cardId);
      if (!target) {
        sendJson(response, { error: "card_not_found" }, 404);
        return;
      }

      if (target.ownerId === reply.ownerId) {
        sendJson(response, { error: "cannot_reply_self" }, 400);
        return;
      }

      const activeIds = new Set(cards.map((card) => card.id));
      const replies = (await readSharedReplies()).filter((item) => isActiveReply(item, now, activeIds));
      replies.unshift({
        ...reply,
        id: createId("reply"),
        targetOwnerId: target.ownerId,
        createdAt: now,
        expiresAt: Math.min(target.expiresAt, now + cardTtlMs),
      });
      await writeFile(repliesPath, `${JSON.stringify(replies.slice(0, 200), null, 2)}\n`, "utf8");
      sendJson(response, { configured: true });
      return;
    }

    if (url.pathname === "/api/cards" && request.method === "POST") {
      const payload = await readJsonBody(request);
      const card = normalizeSharedCard(payload);
      if (!card) {
        sendJson(response, { error: "invalid_payload" }, 400);
        return;
      }

      const now = Date.now();
      const active = (await readSharedCards()).filter((item) => isActiveCard(item, now));
      active.unshift({
        ...card,
        id: createId("shared-card"),
        createdAt: now,
        expiresAt: now + cardTtlMs,
      });
      await writeFile(cardsPath, `${JSON.stringify(active.slice(0, 50), null, 2)}\n`, "utf8");
      sendJson(response, { configured: true, ttlMinutes: Math.round(cardTtlMs / 60000) });
      return;
    }

    if (url.pathname === "/api/cards" && request.method === "DELETE") {
      const payload = await readJsonBody(request);
      const cardId = String(payload.cardId || "");
      const ownerId = normalizeId(payload.ownerId);
      if (!cardId || !ownerId) {
        sendJson(response, { error: "invalid_payload" }, 400);
        return;
      }

      const now = Date.now();
      const active = (await readSharedCards())
        .filter((card) => isActiveCard(card, now))
        .filter((card) => !(card.id === cardId && card.ownerId === ownerId));
      await writeFile(cardsPath, `${JSON.stringify(active, null, 2)}\n`, "utf8");
      sendJson(response, { configured: true });
      return;
    }

    const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = normalize(join(root, requestedPath));

    if (!filePath.startsWith(root)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

      const data = await readFile(filePath);
      response.writeHead(200, {
        "Content-Type": types[extname(filePath)] || "application/octet-stream",
        "Cache-Control": "no-store",
        ...securityHeaders,
      });
    response.end(data);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}).listen(port, "0.0.0.0");

async function readUsage() {
  try {
    const raw = await readFile(usagePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      visits: Number(parsed.visits || 0),
      updatedAt: parsed.updatedAt || null,
    };
  } catch {
    return { visits: 0, updatedAt: null };
  }
}

async function writeUsage(usage) {
  await writeFile(usagePath, `${JSON.stringify(usage, null, 2)}\n`, "utf8");
}

function sendJson(response, body, status = 200) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...securityHeaders,
  });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function readNearbyRecords() {
  try {
    const raw = await readFile(nearbyPath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeNearbyUser(payload) {
  const location = normalizeSharedLocation(payload?.location);
  if (!location) return null;

  const id = normalizeId(payload.id);
  if (!id) return null;

  return {
    id,
    nickname: sanitizeNearbyText(payload.nickname || "匿名", 16),
    vehicle: allowedVehicles.has(payload.vehicle) ? payload.vehicle : "機車",
    status: allowedStatuses.has(payload.status) ? payload.status : "我已出發",
    radiusKm: location.radiusKm,
    lat: location.lat,
    lng: location.lng,
  };
}

async function readSharedCards() {
  try {
    const raw = await readFile(cardsPath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function readSharedReplies() {
  try {
    const raw = await readFile(repliesPath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeSharedCard(payload) {
  const location = normalizeSharedLocation(payload?.location);
  const ownerId = normalizeId(payload?.ownerId);
  if (!location || !ownerId) return null;

  return {
    ownerId,
    nickname: sanitizeNearbyText(payload.nickname || "匿名", 16),
    vehicle: allowedVehicles.has(payload.vehicle) ? payload.vehicle : "機車",
    type: allowedCardTypes.has(payload.type) ? payload.type : "模板訊息",
    note: sanitizeNearbyText(payload.note || "", 80),
    lat: location.lat,
    lng: location.lng,
  };
}

function normalizeSharedReply(payload) {
  const location = normalizeSharedLocation(payload?.location);
  const cardId = String(payload?.cardId || "").slice(0, 80);
  const ownerId = normalizeId(payload?.ownerId);
  const message = sanitizeNearbyText(payload.message || "", 80);
  if (!location || !cardId || !ownerId || !message) return null;

  return {
    cardId,
    ownerId,
    nickname: sanitizeNearbyText(payload.nickname || "匿名", 16) || "匿名",
    vehicle: allowedVehicles.has(payload.vehicle) ? payload.vehicle : "機車",
    message,
    lat: location.lat,
    lng: location.lng,
  };
}

function normalizeSharedLocation(payload) {
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

function sanitizeNearbyText(value, maxLength) {
  return String(value)
    .replace(/[<>{}[\]()`"'\\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength) || "匿名";
}

function isActiveNearby(item, now) {
  return item
    && typeof item.id === "string"
    && Number.isFinite(item.lat)
    && Number.isFinite(item.lng)
    && Number(item.expiresAt || 0) > now
    && allowedStatuses.has(item.status);
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

function createId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
