import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(here, "dist");
const port = Number(process.env.PORT || 3000);
const accessPassword = process.env.APP_PASSWORD || "";
const cookieSecure = process.env.COOKIE_SECURE !== "false";
const sessionLifetimeMs = 12 * 60 * 60 * 1000;
const financeRequestIntervalMs = 60 * 1000;
const sessionCookie = "wb_tax_session";
const sessions = new Map();
const financeRequestTimes = new Map();
const loginAttempts = new Map();

if (accessPassword.length < 12) {
  throw new Error("APP_PASSWORD must contain at least 12 characters.");
}

const configuredPasswordHash = createHash("sha256")
  .update(accessPassword)
  .digest();

function securityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cache-Control", "no-store");
}

function sendJson(response, status, value, extraHeaders = {}) {
  securityHeaders(response);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
  response.end(JSON.stringify(value));
}

function readCookies(request) {
  const raw = request.headers.cookie || "";
  return Object.fromEntries(
    raw.split(";").map((part) => {
      const index = part.indexOf("=");
      if (index < 0) return ["", ""];
      return [part.slice(0, index).trim(), part.slice(index + 1).trim()];
    }),
  );
}

function currentSession(request) {
  const id = readCookies(request)[sessionCookie];
  if (!id) return null;
  const session = sessions.get(id);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(id);
    return null;
  }
  return { id, session };
}

function hasSession(request) {
  return Boolean(currentSession(request));
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  const forwardedHost = request.headers["x-forwarded-host"];
  const host = String(forwardedHost || request.headers.host || "").split(",")[0].trim();
  try {
    return new URL(origin).host === host;
  } catch (_error) {
    return false;
  }
}

async function readJson(request, maxBytes = 32 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error("Request body too large."), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (_error) {
    throw Object.assign(new Error("Invalid JSON request."), { status: 400 });
  }
}

function passwordMatches(candidate) {
  const candidateHash = createHash("sha256").update(String(candidate || "")).digest();
  return timingSafeEqual(configuredPasswordHash, candidateHash);
}

function sessionCookieHeader(value, maxAge) {
  const secure = cookieSecure ? "; Secure" : "";
  return `${sessionCookie}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}

function rateLimitLogin(request) {
  const key = request.socket.remoteAddress || "unknown";
  const now = Date.now();
  const attempt = loginAttempts.get(key);
  if (!attempt || attempt.resetAt <= now) {
    loginAttempts.set(key, { count: 1, resetAt: now + 10 * 60 * 1000 });
    return 0;
  }
  attempt.count += 1;
  return attempt.count > 8 ? Math.ceil((attempt.resetAt - now) / 1000) : 0;
}

function validateFinanceRequest(body) {
  if (!body || typeof body !== "object") return "Invalid request body.";
  if (typeof body.token !== "string" || body.token.trim().length < 10 || body.token.length > 4096) {
    return "Укажите действующий токен категории «Финансы».";
  }
  if (typeof body.dateFrom !== "string" || typeof body.dateTo !== "string") {
    return "Нужны даты начала и окончания периода.";
  }
  if (!Number.isFinite(Date.parse(body.dateFrom)) || !Number.isFinite(Date.parse(body.dateTo))) {
    return "Неверный формат дат.";
  }
  if (body.period && !["daily", "weekly"].includes(body.period)) {
    return "Период должен быть daily или weekly.";
  }
  return null;
}

async function handleFinanceRequest(request, response) {
  if (!hasSession(request)) return sendJson(response, 401, { error: "Сеанс истёк. Войдите снова." });
  if (!sameOrigin(request)) return sendJson(response, 403, { error: "Недопустимый источник запроса." });

  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    return sendJson(response, error.status || 400, { error: error.message });
  }
  const validationError = validateFinanceRequest(body);
  if (validationError) return sendJson(response, 400, { error: validationError });

  const tokenKey = createHash("sha256").update(body.token.trim()).digest("hex");
  const now = Date.now();
  for (const [key, timestamp] of financeRequestTimes) {
    if (now - timestamp >= financeRequestIntervalMs) financeRequestTimes.delete(key);
  }
  const lastRequestAt = financeRequestTimes.get(tokenKey) || 0;
  const waitSeconds = Math.ceil((financeRequestIntervalMs - (now - lastRequestAt)) / 1000);
  if (lastRequestAt && waitSeconds > 0) {
    return sendJson(
      response,
      429,
      { error: `Лимит WB: повторите запрос через ${waitSeconds} с.` },
      { "Retry-After": String(waitSeconds) },
    );
  }
  financeRequestTimes.set(tokenKey, now);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    const wbResponse = await fetch(
      "https://finance-api.wildberries.ru/api/finance/v1/sales-reports/detailed",
      {
        method: "POST",
        headers: {
          Authorization: body.token.trim(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          dateFrom: body.dateFrom,
          dateTo: body.dateTo,
          limit: Math.min(Math.max(Number(body.limit) || 99_000, 1), 100_000),
          rrdId: Math.max(Number(body.rrdid) || 0, 0),
          period: body.period || "daily",
        }),
        signal: controller.signal,
      },
    );
    if (wbResponse.status === 204) {
      securityHeaders(response);
      response.writeHead(204);
      return response.end();
    }
    const text = await wbResponse.text();
    securityHeaders(response);
    response.writeHead(wbResponse.status, {
      "Content-Type": wbResponse.headers.get("content-type") || "application/json; charset=utf-8",
    });
    return response.end(text);
  } catch (error) {
    const aborted = error.name === "AbortError";
    return sendJson(response, aborted ? 504 : 502, {
      error: aborted ? "WB API не ответил за 90 секунд." : `Не удалось связаться с WB API: ${error.message}`,
    });
  } finally {
    clearTimeout(timeout);
  }
}

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

async function serveStatic(request, response, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (_error) {
    return sendJson(response, 400, { error: "Invalid URL path." });
  }
  const requestedPath = decoded === "/" ? "/index.html" : decoded;
  const filePath = path.resolve(webRoot, `.${requestedPath}`);
  if (!filePath.startsWith(`${webRoot}${path.sep}`)) {
    return sendJson(response, 403, { error: "Forbidden." });
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("Not a file");
    securityHeaders(response);
    response.setHeader("Content-Type", mimeTypes[path.extname(filePath)] || "application/octet-stream");
    response.writeHead(200);
    if (request.method === "HEAD") return response.end();
    return createReadStream(filePath).pipe(response);
  } catch (_error) {
    return sendJson(response, 404, { error: "Not found." });
  }
}

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const { pathname } = requestUrl;
  if (pathname.startsWith("/api/")) {
    if (request.method === "OPTIONS") {
      securityHeaders(response);
      response.writeHead(204, { Allow: "GET, POST, OPTIONS" });
      return response.end();
    }
    if (pathname === "/api/session" && request.method === "GET") {
      return sendJson(response, 200, { authenticated: hasSession(request) });
    }
    if (pathname === "/api/login" && request.method === "POST") {
      if (!sameOrigin(request)) return sendJson(response, 403, { error: "Недопустимый источник запроса." });
      const wait = rateLimitLogin(request);
      if (wait) return sendJson(response, 429, { error: `Слишком много попыток. Повторите через ${wait} с.` });
      let body;
      try {
        body = await readJson(request, 4096);
      } catch (error) {
        return sendJson(response, error.status || 400, { error: error.message });
      }
      if (!passwordMatches(body.password)) {
        return sendJson(response, 401, { error: "Неверный пароль." });
      }
      loginAttempts.delete(request.socket.remoteAddress || "unknown");
      const id = randomBytes(32).toString("base64url");
      sessions.set(id, { expiresAt: Date.now() + sessionLifetimeMs });
      return sendJson(response, 200, { authenticated: true }, {
        "Set-Cookie": sessionCookieHeader(id, sessionLifetimeMs / 1000),
      });
    }
    if (pathname === "/api/logout" && request.method === "POST") {
      if (!sameOrigin(request)) return sendJson(response, 403, { error: "Недопустимый источник запроса." });
      const session = currentSession(request);
      if (session) sessions.delete(session.id);
      return sendJson(response, 200, { authenticated: false }, {
        "Set-Cookie": sessionCookieHeader("", 0),
      });
    }
    if (pathname === "/api/wb/report-detail" && request.method === "POST") {
      return handleFinanceRequest(request, response);
    }
    return sendJson(response, 404, { error: "Unknown API endpoint." });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return sendJson(response, 405, { error: "Method not allowed." }, { Allow: "GET, HEAD" });
  }
  return serveStatic(request, response, pathname);
});

server.listen(port, "0.0.0.0", () => {
  console.log(`WB tax-base web app listening on port ${port}.`);
});
