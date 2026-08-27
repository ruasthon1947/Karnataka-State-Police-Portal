import https from "node:https";
import { requireSession } from "./security.mjs";

const LOCAL_PREFIX = "/map-tiles";
const TILE_ORIGIN = "https://tiles.openfreemap.org";
const ROUTING_ORIGIN = String(process.env.ROUTING_BASE_URL || "https://router.project-osrm.org").replace(/\/$/, "");
const GEOCODING_ORIGIN = String(process.env.GEOCODING_BASE_URL || "https://nominatim.openstreetmap.org").replace(/\/$/, "");
const PLACE_SUGGESTION_ORIGIN = String(process.env.PLACE_SUGGESTION_BASE_URL || "https://photon.komoot.io").replace(/\/$/, "");
const geocodeCache = new Map();
const placeSuggestionCache = new Map();
let lastGeocodeRequestAt = 0;

const parseCoordinatePair = (value) => {
  const match = String(value || "").match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const longitude = Number(match[1]);
  const latitude = Number(match[2]);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) return null;
  return { longitude, latitude };
};

const sendRouteJson = (response, status, payload) => {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(payload));
};

const buildPlaceLabel = (properties = {}) => {
  const parts = [
    properties.name,
    properties.street,
    properties.district,
    properties.city || properties.town || properties.village,
    properties.county,
    properties.state,
    properties.country,
  ];
  const seen = new Set();
  return parts
    .map((part) => String(part || "").trim())
    .filter((part) => {
      const key = part.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(", ");
};

export const proxyPlaceSuggestionRequest = async (request, response, next) => {
  const localUrl = new URL(request.url || "/", "http://localhost");
  if (localUrl.pathname !== "/api/place-suggestions") {
    next();
    return;
  }
  if (request.method !== "GET") {
    sendRouteJson(response, 405, { ok: false, error: "Method not allowed." });
    return;
  }
  if (!requireSession(request, response)) return;

  const query = String(localUrl.searchParams.get("query") || "").trim().replace(/\s+/g, " ").slice(0, 120);
  if (query.length < 2) {
    sendRouteJson(response, 200, { ok: true, suggestions: [] });
    return;
  }
  console.log("[Place Suggestions] Request received.", { queryLength: query.length });
  const cacheKey = query.toLocaleLowerCase("en-IN");
  const cached = placeSuggestionCache.get(cacheKey);
  if (cached) {
    console.log("[Place Suggestions] Cache hit.", { resultCount: cached.suggestions.length });
    sendRouteJson(response, 200, cached);
    return;
  }

  const upstreamQuery = new URLSearchParams({
    q: query,
    limit: "7",
    lang: "en",
    lat: "12.9716",
    lon: "77.5946",
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const upstream = await fetch(`${PLACE_SUGGESTION_ORIGIN}/api/?${upstreamQuery}`, {
      signal: controller.signal,
      headers: { "User-Agent": "KSPP-Operational-Map/1.0", Accept: "application/json" },
    });
    if (!upstream.ok) throw new Error(`Place service returned ${upstream.status}`);
    const data = await upstream.json();
    const suggestions = (Array.isArray(data?.features) ? data.features : [])
      .map((feature, index) => {
        const longitude = Number(feature?.geometry?.coordinates?.[0]);
        const latitude = Number(feature?.geometry?.coordinates?.[1]);
        const label = buildPlaceLabel(feature?.properties);
        if (!label || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
        return {
          id: String(feature?.properties?.osm_id || `${longitude}-${latitude}-${index}`),
          label: label.slice(0, 240),
          latitude,
          longitude,
        };
      })
      .filter(Boolean);
    const payload = { ok: true, suggestions, attribution: "OpenStreetMap contributors" };
    if (placeSuggestionCache.size >= 1_000) placeSuggestionCache.delete(placeSuggestionCache.keys().next().value);
    placeSuggestionCache.set(cacheKey, payload);
    console.log("[Place Suggestions] Search completed.", { resultCount: suggestions.length });
    sendRouteJson(response, 200, payload);
  } catch (error) {
    console.error("[Place Suggestions] Upstream request failed.", error?.message || error);
    sendRouteJson(response, 502, { ok: false, error: "Place suggestions are temporarily unavailable.", suggestions: [] });
  } finally {
    clearTimeout(timeout);
  }
};

export const proxyGeocodeRequest = async (request, response, next) => {
  const localUrl = new URL(request.url || "/", "http://localhost");
  if (localUrl.pathname !== "/api/geocode") {
    next();
    return;
  }
  if (request.method !== "GET") {
    sendRouteJson(response, 405, { ok: false, error: "Method not allowed." });
    return;
  }
  if (!requireSession(request, response)) return;

  const query = String(localUrl.searchParams.get("query") || "").trim().replace(/\s+/g, " ").slice(0, 160);
  if (query.length < 2) {
    sendRouteJson(response, 400, { ok: false, error: "Enter a place or address." });
    return;
  }
  const cacheKey = query.toLowerCase();
  const cached = geocodeCache.get(cacheKey);
  if (cached) {
    sendRouteJson(response, 200, cached);
    return;
  }

  const waitMs = Math.max(0, 1_050 - (Date.now() - lastGeocodeRequestAt));
  if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
  lastGeocodeRequestAt = Date.now();

  const upstreamQuery = new URLSearchParams({
    q: `${query}, Karnataka, India`,
    format: "jsonv2",
    limit: "1",
    countrycodes: "in",
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const upstream = await fetch(`${GEOCODING_ORIGIN}/search?${upstreamQuery}`, {
      signal: controller.signal,
      headers: { "User-Agent": "KSPP-Operational-Map/1.0", Accept: "application/json" },
    });
    const results = await upstream.json();
    const latitude = Number.parseFloat(results?.[0]?.lat);
    const longitude = Number.parseFloat(results?.[0]?.lon);
    if (!upstream.ok || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      sendRouteJson(response, 404, { ok: false, error: "That location could not be found. Add a city or landmark and try again." });
      return;
    }
    const payload = {
      ok: true,
      latitude,
      longitude,
      label: String(results[0].display_name || query).slice(0, 240),
      attribution: "OpenStreetMap contributors",
    };
    if (geocodeCache.size >= 1_000) geocodeCache.delete(geocodeCache.keys().next().value);
    geocodeCache.set(cacheKey, payload);
    sendRouteJson(response, 200, payload);
  } catch (error) {
    console.error("[Location Search] Upstream request failed.", error?.message || error);
    sendRouteJson(response, 502, { ok: false, error: "Location search is temporarily unavailable." });
  } finally {
    clearTimeout(timeout);
  }
};

export const proxyRouteRequest = async (request, response, next) => {
  const localUrl = new URL(request.url || "/", "http://localhost");
  if (localUrl.pathname !== "/api/route") {
    next();
    return;
  }
  if (request.method !== "GET") {
    sendRouteJson(response, 405, { ok: false, error: "Method not allowed." });
    return;
  }
  if (!requireSession(request, response)) return;

  const start = parseCoordinatePair(localUrl.searchParams.get("start"));
  const end = parseCoordinatePair(localUrl.searchParams.get("end"));
  if (!start || !end) {
    sendRouteJson(response, 400, { ok: false, error: "Valid start and end coordinates are required." });
    return;
  }

  const path = `/route/v1/driving/${start.longitude},${start.latitude};${end.longitude},${end.latitude}`;
  const query = new URLSearchParams({ alternatives: "false", steps: "false", overview: "full", geometries: "geojson" });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const upstream = await fetch(`${ROUTING_ORIGIN}${path}?${query}`, {
      signal: controller.signal,
      headers: { "User-Agent": "KSPP-Operational-Routing/1.0", Accept: "application/json" },
    });
    const payload = await upstream.json();
    const candidates = Array.isArray(payload?.routes)
      ? payload.routes.filter((candidate) => candidate?.geometry && Number.isFinite(candidate.distance) && Number.isFinite(candidate.duration))
      : [];
    candidates.sort((left, right) => left.duration - right.duration || left.distance - right.distance);
    const route = candidates[0];
    if (!upstream.ok || !route?.geometry || !Number.isFinite(route.distance) || !Number.isFinite(route.duration)) {
      sendRouteJson(response, 502, { ok: false, error: "A road route could not be calculated." });
      return;
    }
    sendRouteJson(response, 200, {
      ok: true,
      distanceMeters: route.distance,
      durationSeconds: route.duration,
      geometry: route.geometry,
      alternativesEvaluated: candidates.length,
      selectionMethod: "minimum_travel_time",
    });
  } catch (error) {
    console.error("[Routing] Upstream request failed.", error?.message || error);
    sendRouteJson(response, 502, { ok: false, error: "The road-routing service is unavailable." });
  } finally {
    clearTimeout(timeout);
  }
};

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
    server.middlewares.use(proxyPlaceSuggestionRequest);
    server.middlewares.use(proxyGeocodeRequest);
    server.middlewares.use(proxyRouteRequest);
    server.middlewares.use(proxyMapRequest);
  },
  configurePreviewServer(server) {
    server.middlewares.use(proxyPlaceSuggestionRequest);
    server.middlewares.use(proxyGeocodeRequest);
    server.middlewares.use(proxyRouteRequest);
    server.middlewares.use(proxyMapRequest);
  },
});

export default mapProxyPlugin;
