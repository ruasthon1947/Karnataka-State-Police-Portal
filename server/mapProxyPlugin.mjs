import https from "node:https";

const LOCAL_PREFIX = "/map-tiles";
const TILE_ORIGIN = "https://tiles.openfreemap.org";

const proxyMapRequest = (request, response, next) => {
  if (!String(request.url || "").startsWith(`${LOCAL_PREFIX}/`)) {
    next();
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.statusCode = 405;
    response.end("Method not allowed");
    return;
  }

  const localUrl = new URL(request.url || "/", "http://localhost");
  const upstreamPath = `${localUrl.pathname.slice(LOCAL_PREFIX.length)}${localUrl.search}`;
  const upstream = https.get(`${TILE_ORIGIN}${upstreamPath}`, {
    headers: {
      "User-Agent": "KSPP-Crime-Intelligence/1.0",
      Accept: request.headers.accept || "*/*",
    },
  }, (upstreamResponse) => {
    const statusCode = upstreamResponse.statusCode || 502;
    const contentType = String(upstreamResponse.headers["content-type"] || "application/octet-stream");
    response.statusCode = statusCode;
    response.setHeader("Content-Type", contentType);
    response.setHeader("Cache-Control", contentType.includes("json") ? "public, max-age=300" : "public, max-age=86400");

    if (request.method === "HEAD") {
      upstreamResponse.resume();
      response.end();
      return;
    }

    if (contentType.includes("json")) {
      const chunks = [];
      upstreamResponse.on("data", (chunk) => chunks.push(chunk));
      upstreamResponse.on("end", () => {
        const forwardedProtocol = String(request.headers["x-forwarded-proto"] || "http")
          .split(",")[0]
          .trim();
        const protocol = forwardedProtocol === "https" ? "https" : "http";
        const requestedHost = String(request.headers.host || "127.0.0.1");
        const host = /^[a-z0-9.:[\]-]+$/i.test(requestedHost) ? requestedHost : "127.0.0.1";
        const localTileOrigin = `${protocol}://${host}${LOCAL_PREFIX}`;
        const payload = Buffer.concat(chunks)
          .toString("utf8")
          .replaceAll(TILE_ORIGIN, localTileOrigin);
        response.end(payload);
      });
      return;
    }

    upstreamResponse.pipe(response);
  });

  upstream.setTimeout(15_000, () => upstream.destroy(new Error("Map tile request timed out")));
  upstream.on("error", (error) => {
    console.error("[Map Tiles] Upstream request failed.", error.message);
    if (!response.headersSent) response.statusCode = 502;
    if (!response.writableEnded) response.end("Map tile unavailable");
  });
};

const mapProxyPlugin = () => ({
  name: "kspp-map-tile-proxy",
  configureServer(server) {
    server.middlewares.use(proxyMapRequest);
  },
  configurePreviewServer(server) {
    server.middlewares.use(proxyMapRequest);
  },
});

export default mapProxyPlugin;
