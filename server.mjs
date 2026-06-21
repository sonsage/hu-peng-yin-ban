import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = process.cwd();
const port = Number(process.env.PORT || 5173);
const usagePath = join(root, "usage.json");
const nearbyPath = join(root, "nearby-users.json");
const nearbyTtlMs = 30 * 60 * 1000;
const allowedVehicles = new Set(["機車", "自行車", "重機", "徒步"]);
const allowedStatuses = new Set(["我已出發", "休息中", "已抵達", "需要協助"]);

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
  const lat = Number(payload?.location?.lat);
  const lng = Number(payload?.location?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  const id = String(payload.id || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  if (!id) return null;

  return {
    id,
    nickname: sanitizeNearbyText(payload.nickname || "匿名", 16),
    vehicle: allowedVehicles.has(payload.vehicle) ? payload.vehicle : "機車",
    status: allowedStatuses.has(payload.status) ? payload.status : "我已出發",
    radiusKm: Math.min(50, Math.max(1, Number(payload.radiusKm || 30))),
    lat: Number(lat.toFixed(3)),
    lng: Number(lng.toFixed(3)),
  };
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
