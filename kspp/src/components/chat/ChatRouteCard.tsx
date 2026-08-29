import React, { useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import mapWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import type { Map as MapLibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { ChatMapContext, ChatMapPoint } from "../../lib/chatApi";
import { displayIdentifier } from "../../lib/taskEngine";

maplibregl.setWorkerUrl(mapWorkerUrl);

type RouteResult = {
  distanceMeters: number;
  durationSeconds: number;
  geometry: { type: "LineString"; coordinates: number[][] };
};

type PlaceSuggestion = {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
};

type Props = {
  context: ChatMapContext;
  tr: (en: string, kn: string) => string;
};

const coordinates = (point: ChatMapPoint): [number, number] => [point.longitude, point.latitude];
const distanceLabel = (meters: number) => meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`;
const durationLabel = (seconds: number) => {
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} hr ${minutes % 60} min`;
};

const readRoute = async (response: Response): Promise<RouteResult> => {
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error || "Route unavailable");

  if (data?.ok && data?.geometry) {
    return { distanceMeters: data.distanceMeters, durationSeconds: data.durationSeconds, geometry: data.geometry };
  }

  const fallbackRoute = data?.routes?.[0];
  if (!fallbackRoute?.geometry || !Number.isFinite(fallbackRoute.distance) || !Number.isFinite(fallbackRoute.duration)) {
    throw new Error("Route unavailable");
  }
  return { distanceMeters: fallbackRoute.distance, durationSeconds: fallbackRoute.duration, geometry: fallbackRoute.geometry };
};

const fetchRoute = async (origin: ChatMapPoint, destination: ChatMapPoint, signal: AbortSignal) => {
  const start = `${origin.longitude},${origin.latitude}`;
  const end = `${destination.longitude},${destination.latitude}`;
  const localQuery = new URLSearchParams({ start, end });
  try {
    return await readRoute(await fetch(`/api/route?${localQuery}`, { signal, credentials: "same-origin" }));
  } catch (error) {
    if ((error as { name?: string })?.name === "AbortError") throw error;
    const publicQuery = new URLSearchParams({ alternatives: "false", steps: "false", overview: "full", geometries: "geojson" });
    return readRoute(await fetch(`https://router.project-osrm.org/route/v1/driving/${start};${end}?${publicQuery}`, { signal }));
  }
};

const ChatRouteCard: React.FC<Props> = ({ context, tr }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [destinationId, setDestinationId] = useState(context.destinations[0]?.id || "");
  const [origin, setOrigin] = useState<ChatMapPoint | undefined>(context.stationOrigin);
  const [manualOpen, setManualOpen] = useState(false);
  const [placeInput, setPlaceInput] = useState("");
  const [placeSearching, setPlaceSearching] = useState(false);
  const [resolvedPlace, setResolvedPlace] = useState("");
  const [placeSuggestions, setPlaceSuggestions] = useState<PlaceSuggestion[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [route, setRoute] = useState<RouteResult | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [message, setMessage] = useState("");

  const destination = context.destinations.find((item) => item.id === destinationId) || context.destinations[0];
  const suggestionListId = `chat-place-suggestions-${String(destinationId || "location").replace(/[^a-z0-9_-]/gi, "-")}`;

  useEffect(() => {
    const query = placeInput.trim();
    if (!manualOpen || !suggestionsOpen || query.length < 2 || query === resolvedPlace) {
      setPlaceSuggestions([]);
      setSuggestionsLoading(false);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSuggestionsLoading(true);
      void fetch(`/api/place-suggestions?query=${encodeURIComponent(query)}`, {
        signal: controller.signal,
        credentials: "same-origin",
      })
        .then(async (response) => {
          const data = await response.json();
          if (!response.ok || !data?.ok) throw new Error(data?.error || "Suggestions unavailable");
          setPlaceSuggestions(Array.isArray(data.suggestions) ? data.suggestions : []);
        })
        .catch((error) => {
          if (error?.name !== "AbortError") setPlaceSuggestions([]);
        })
        .finally(() => {
          if (!controller.signal.aborted) setSuggestionsLoading(false);
        });
    }, 400);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [manualOpen, placeInput, resolvedPlace, suggestionsOpen]);

  useEffect(() => {
    if (!origin || !destination) {
      setRoute(null);
      return;
    }
    const controller = new AbortController();
    setRouteLoading(true);
    void fetchRoute(origin, destination, controller.signal)
      .then((result) => {
        setRoute(result);
        setMessage("");
      })
      .catch((error) => {
        if (error?.name !== "AbortError") {
          setRoute(null);
          setMessage(tr("Route unavailable. The case location is still shown.", "ಮಾರ್ಗ ಲಭ್ಯವಿಲ್ಲ. ಪ್ರಕರಣದ ಸ್ಥಳವನ್ನು ಇನ್ನೂ ತೋರಿಸಲಾಗಿದೆ."));
        }
      })
      .finally(() => setRouteLoading(false));
    return () => controller.abort();
  }, [origin, destination, tr]);

  const mapData = useMemo(() => ({ origin, destination, route }), [origin, destination, route]);

  useEffect(() => {
    if (!containerRef.current || !mapData.destination) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: "/map-tiles/styles/liberty?kspp=chat-map-v3",
      center: coordinates(mapData.destination),
      zoom: 13,
      attributionControl: false,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");

    map.on("load", () => {
      const points = [
        ...(mapData.origin ? [{ ...mapData.origin, kind: "start" }] : []),
        { ...mapData.destination, kind: "destination" },
      ];
      map.addSource("chat-map-points", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: points.map((point) => ({
            type: "Feature",
            geometry: { type: "Point", coordinates: coordinates(point) },
            properties: { kind: point.kind },
          })),
        },
      });
      map.addLayer({
        id: "chat-map-points",
        type: "circle",
        source: "chat-map-points",
        paint: {
          "circle-radius": 9,
          "circle-color": ["match", ["get", "kind"], "start", "#14b8a6", "#fb7185"],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 3,
        },
      });

      if (mapData.route) {
        map.addSource("chat-map-route", {
          type: "geojson",
          data: { type: "Feature", geometry: mapData.route.geometry, properties: {} },
        });
        map.addLayer({
          id: "chat-map-route",
          type: "line",
          source: "chat-map-route",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "#0284c7", "line-width": 6, "line-opacity": 0.9 },
        }, "chat-map-points");
      }

      const bounds = new maplibregl.LngLatBounds();
      points.forEach((point) => bounds.extend(coordinates(point)));
      mapData.route?.geometry.coordinates.forEach((point) => bounds.extend(point as [number, number]));
      if (points.length > 1) map.fitBounds(bounds, { padding: { top: 48, right: 72, bottom: 52, left: 72 }, maxZoom: 15, duration: 0 });
    });
    return () => map.remove();
  }, [mapData]);

  const useLiveLocation = () => {
    if (!navigator.geolocation) {
      setMessage(tr("Location is unavailable on this device.", "ಈ ಸಾಧನದಲ್ಲಿ ಸ್ಥಳ ಲಭ್ಯವಿಲ್ಲ."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setOrigin({
          id: "live-location",
          label: tr("My location", "ನನ್ನ ಸ್ಥಳ"),
          station: "",
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        });
        setMessage("");
      },
      () => setMessage(tr("Location permission was denied or unavailable.", "ಸ್ಥಳ ಅನುಮತಿಯನ್ನು ನಿರಾಕರಿಸಲಾಗಿದೆ ಅಥವಾ ಲಭ್ಯವಿಲ್ಲ.")),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
    );
  };

  const usePlace = async (selectedPlace?: string) => {
    const query = String(selectedPlace || placeInput).trim();
    if (query.length < 2 || placeSearching) {
      if (query.length < 2) setMessage(tr("Enter a place, landmark, or address.", "ಸ್ಥಳ, ಹೆಗ್ಗುರುತು ಅಥವಾ ವಿಳಾಸವನ್ನು ನಮೂದಿಸಿ."));
      return;
    }
    setPlaceSearching(true);
    setPlaceInput(query);
    setSuggestionsOpen(false);
    setMessage("");
    setResolvedPlace("");
    try {
      const response = await fetch(`/api/geocode?query=${encodeURIComponent(query)}`, { credentials: "same-origin" });
      const data = await response.json();
      if (!response.ok || !data?.ok || !Number.isFinite(data.latitude) || !Number.isFinite(data.longitude)) {
        throw new Error(data?.error || tr("Location not found.", "ಸ್ಥಳ ಕಂಡುಬಂದಿಲ್ಲ."));
      }
      const label = String(data.label || query);
      setOrigin({ id: "searched-location", label, station: "", latitude: data.latitude, longitude: data.longitude });
      setResolvedPlace(label);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : tr("Location search is unavailable.", "ಸ್ಥಳ ಹುಡುಕಾಟ ಲಭ್ಯವಿಲ್ಲ."));
    } finally {
      setPlaceSearching(false);
    }
  };

  const selectSuggestion = (suggestion: PlaceSuggestion) => {
    setPlaceInput(suggestion.label);
    setResolvedPlace(suggestion.label);
    setPlaceSuggestions([]);
    setSuggestionsOpen(false);
    setMessage("");
    setOrigin({
      id: `searched-location-${suggestion.id}`,
      label: suggestion.label,
      station: "",
      latitude: suggestion.latitude,
      longitude: suggestion.longitude,
    });
  };

  if (!destination && context.unavailableReason === "missing_case_location") {
    return (
      <section className="mt-3 rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3" role="status">
        <p className="text-xs font-semibold text-amber-200">{tr("Incident location not recorded", "ಘಟನೆಯ ಸ್ಥಳ ದಾಖಲಾಗಿಲ್ಲ")}</p>
        <p className="mt-1 text-[11px] leading-relaxed text-slate-300">{tr(
          "This case has no police station, place, latitude, or longitude in the source record, so a reliable map or route cannot be generated. Add the incident coordinates to the FIR record and ask again.",
          "ಈ ಪ್ರಕರಣದ ಮೂಲ ದಾಖಲೆಯಲ್ಲಿ ಪೊಲೀಸ್ ಠಾಣೆ, ಸ್ಥಳ, ಅಕ್ಷಾಂಶ ಅಥವಾ ರೇಖಾಂಶ ಇಲ್ಲ, ಆದ್ದರಿಂದ ವಿಶ್ವಾಸಾರ್ಹ ನಕ್ಷೆ ಅಥವಾ ಮಾರ್ಗವನ್ನು ರಚಿಸಲಾಗುವುದಿಲ್ಲ. ಎಫ್‌ಐಆರ್ ದಾಖಲೆಗೆ ಘಟನೆಯ ನಿರ್ದೇಶಾಂಕಗಳನ್ನು ಸೇರಿಸಿ ಮತ್ತೆ ಕೇಳಿ.",
        )}</p>
      </section>
    );
  }
  if (!destination) return null;
  const navigationUrl = origin
    ? `https://www.google.com/maps/dir/?api=1&origin=${origin.latitude},${origin.longitude}&destination=${destination.latitude},${destination.longitude}&travelmode=driving`
    : `https://www.google.com/maps/search/?api=1&query=${destination.latitude},${destination.longitude}`;

  return (
    <section className="chat-map-card mt-3 overflow-hidden rounded-xl border" aria-label={tr("Case location map", "ಪ್ರಕರಣದ ಸ್ಥಳ ನಕ್ಷೆ")}>
      <div className="chat-map-header flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="chat-map-eyebrow text-[10px] font-semibold uppercase tracking-[0.16em]">{tr("Case location", "ಪ್ರಕರಣದ ಸ್ಥಳ")}</p>
          <p className="chat-map-title mt-0.5 truncate text-xs font-semibold">{displayIdentifier(destination.label)} · {destination.station}</p>
        </div>
        {route && <div className="flex gap-1.5 text-[11px]"><span className="chat-map-metric is-primary rounded-md px-2.5 py-1.5 font-semibold">{durationLabel(route.durationSeconds)}</span><span className="chat-map-metric rounded-md px-2.5 py-1.5 font-semibold">{distanceLabel(route.distanceMeters)}</span></div>}
      </div>

      {context.destinations.length > 1 && <div className="chat-map-selector border-b px-3 py-2">
        <select aria-label={tr("Case destination", "ಪ್ರಕರಣದ ಗಮ್ಯಸ್ಥಾನ")} value={destination.id} onChange={(event) => setDestinationId(event.target.value)} className="w-full rounded-md border px-2.5 py-2 text-xs">
          {context.destinations.map((item) => <option key={item.id} value={item.id}>{displayIdentifier(item.label)} · {item.station}</option>)}
        </select>
      </div>}

      <div className="relative">
        <div ref={containerRef} className="h-64 w-full bg-panel" />
        {routeLoading && <div className="absolute left-3 top-3 rounded-md bg-slate-950/85 px-2.5 py-1.5 text-[11px] text-white">{tr("Finding route…", "ಮಾರ್ಗ ಹುಡುಕಲಾಗುತ್ತಿದೆ…")}</div>}
      </div>

      <div className="chat-map-footer space-y-2 border-t p-3">
        <div className="flex flex-wrap gap-2">
          {context.stationOrigin && <button type="button" onClick={() => setOrigin(context.stationOrigin)} className="chat-map-button rounded-md border px-3 py-2 text-[11px] font-medium">{tr("From my station", "ನನ್ನ ಠಾಣೆಯಿಂದ")}</button>}
          <button type="button" onClick={useLiveLocation} className="chat-map-button rounded-md border px-3 py-2 text-[11px] font-medium">{tr("Use live location", "ಲೈವ್ ಸ್ಥಳ ಬಳಸಿ")}</button>
          <button type="button" onClick={() => setManualOpen((open) => !open)} className="chat-map-button rounded-md border px-3 py-2 text-[11px] font-medium">{tr("Enter location", "ಸ್ಥಳ ನಮೂದಿಸಿ")}</button>
          <a href={navigationUrl} target="_blank" rel="noreferrer" className="chat-map-navigation ml-auto rounded-md px-3.5 py-2 text-[11px] font-semibold">{tr("Open navigation ↗", "ನ್ಯಾವಿಗೇಶನ್ ತೆರೆಯಿರಿ ↗")}</a>
        </div>
        {manualOpen && <div className="flex flex-wrap gap-2">
          <div className="relative min-w-[230px] flex-1">
            <input value={placeInput} onFocus={() => setSuggestionsOpen(true)} onBlur={() => setSuggestionsOpen(false)} onChange={(event) => { setPlaceInput(event.target.value); setResolvedPlace(""); setSuggestionsOpen(true); }} onKeyDown={(event) => { if (event.key === "Enter") void usePlace(); }} placeholder={tr("Search a place, landmark, or address", "ಸ್ಥಳ, ಹೆಗ್ಗುರುತು ಅಥವಾ ವಿಳಾಸವನ್ನು ಹುಡುಕಿ")} role="combobox" aria-autocomplete="list" aria-expanded={suggestionsOpen && (suggestionsLoading || placeSuggestions.length > 0)} aria-controls={suggestionListId} className="chat-map-input w-full rounded-md border px-3 py-2 text-xs outline-none" />
            {suggestionsOpen && placeInput.trim().length >= 2 && (suggestionsLoading || placeSuggestions.length > 0) && <div id={suggestionListId} role="listbox" className="chat-map-suggestions mt-1 max-h-64 overflow-y-auto rounded-lg border shadow-xl">
              {suggestionsLoading && <div className="px-3 py-2.5 text-xs text-slate-500">{tr("Searching places…", "ಸ್ಥಳಗಳನ್ನು ಹುಡುಕಲಾಗುತ್ತಿದೆ…")}</div>}
              {!suggestionsLoading && placeSuggestions.map((suggestion) => <button key={`${suggestion.id}-${suggestion.latitude}-${suggestion.longitude}`} type="button" role="option" onMouseDown={(event) => event.preventDefault()} onClick={() => selectSuggestion(suggestion)} className="block w-full border-b px-3 py-2.5 text-left text-xs last:border-b-0">
                <span className="mr-2 text-sky-500">⌖</span>{suggestion.label}
              </button>)}
            </div>}
          </div>
          <button type="button" onClick={() => void usePlace()} disabled={placeSearching || placeInput.trim().length < 2} className="self-start rounded-md border border-sky-400/40 bg-sky-600 px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">{placeSearching ? tr("Finding…", "ಹುಡುಕಲಾಗುತ್ತಿದೆ…") : tr("Find route", "ಮಾರ್ಗ ಹುಡುಕಿ")}</button>
        </div>}
        {resolvedPlace && <p className="text-[10px] text-emerald-300">{tr("Starting from:", "ಇಲ್ಲಿಂದ ಪ್ರಾರಂಭ:")} {resolvedPlace}</p>}
        {message && <p className="text-[11px] text-amber-300">{message}</p>}
      </div>
    </section>
  );
};

export default ChatRouteCard;
