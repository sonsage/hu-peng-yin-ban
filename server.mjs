import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = process.cwd();
const port = Number(process.env.PORT || 5173);
const usagePath = join(root, "usage.json");

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

function sendJson(response, body) {
  response.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...securityHeaders,
  });
  response.end(JSON.stringify(body));
}
