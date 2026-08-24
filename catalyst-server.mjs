import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import localDbPlugin from "./server/localDbPlugin.mjs";
import chatPlugin from "./server/chatPlugin.mjs";
import mapProxyPlugin from "./server/mapProxyPlugin.mjs";

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));
const staticDirectory = path.join(rootDirectory, "dist");
const middleware = [];

const previewServer = {
  middlewares: {
    use(handler) {
      middleware.push(handler);
    },
  },
};

localDbPlugin().configurePreviewServer(previewServer);
chatPlugin().configurePreviewServer(previewServer);
mapProxyPlugin().configurePreviewServer(previewServer);

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function setSecurityHeaders(request, response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader(
    "Permissions-Policy",
    "camera=(), geolocation=(), payment=(), usb=()",
  );
  const protocol = String(request.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  if (protocol === "https") {
    response.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  }
}

function sendJson(response, status, payload) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(payload));
}

function serveFile(request, response, filePath) {
  const extension = path.extname(filePath).toLowerCase();
  response.statusCode = 200;
  response.setHeader(
    "Content-Type",
    mimeTypes.get(extension) || "application/octet-stream",
  );
  response.setHeader(
    "Cache-Control",
    filePath.includes(`${path.sep}assets${path.sep}`)
      ? "public, max-age=31536000, immutable"
      : "no-cache",
  );

  if (request.method === "HEAD") {
    response.end();
    return;
  }

  const stream = fs.createReadStream(filePath);
  stream.on("error", (error) => {
    console.error("[Static Server] File read failed.", error);
    if (!response.headersSent) {
      sendJson(response, 500, {
        ok: false,
        error: "Unable to read the requested file.",
      });
    } else {
      response.destroy(error);
    }
  });
  stream.pipe(response);
}

function serveStatic(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { ok: false, error: "Method not allowed." });
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(
      new URL(request.url || "/", "http://appsail").pathname,
    );
  } catch {
    sendJson(response, 400, { ok: false, error: "Invalid request path." });
    return;
  }

  const resolvedPath = path.resolve(staticDirectory, `.${pathname}`);
  const root = path.resolve(staticDirectory);
  if (resolvedPath !== root && !resolvedPath.startsWith(`${root}${path.sep}`)) {
    sendJson(response, 403, { ok: false, error: "Forbidden." });
    return;
  }

  if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile()) {
    serveFile(request, response, resolvedPath);
    return;
  }
  if (path.extname(pathname)) {
    sendJson(response, 404, { ok: false, error: "Not found." });
    return;
  }
  serveFile(request, response, path.join(staticDirectory, "index.html"));
}

async function runMiddleware(index, request, response) {
  if (response.writableEnded) return;
  if (index >= middleware.length) {
    serveStatic(request, response);
    return;
  }
  try {
    await middleware[index](request, response, () =>
      runMiddleware(index + 1, request, response),
    );
  } catch (error) {
    console.error("[Request Handler] Unhandled error.", error);
    if (!response.writableEnded) {
      sendJson(response, 500, { ok: false, error: "Internal server error." });
    }
  }
}

const server = http.createServer((request, response) => {
  setSecurityHeaders(request, response);
  if (request.url === "/healthz") {
    sendJson(response, 200, { ok: true, service: "kspp-portal" });
    return;
  }
  void runMiddleware(0, request, response);
});

server.requestTimeout = 35_000;
server.headersTimeout = 40_000;
server.keepAliveTimeout = 5_000;

const port = Number(
  process.env.X_ZOHO_CATALYST_LISTEN_PORT || process.env.PORT || 9000,
);
server.listen(port, "0.0.0.0", () => {
  console.log(`KSPP service listening on port ${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
