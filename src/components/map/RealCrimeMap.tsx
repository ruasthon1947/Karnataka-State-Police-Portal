import React, { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import mapWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import type {
  FillExtrusionLayerSpecification,
  GeoJSONSource,
  MapLayerMouseEvent,
  Map as MapLibreMap,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Language } from "../../context/LanguageContext";

export type CrimeMapPoint = {
  id: string;
  name: string;
  station: string;
  latitude: number;
  longitude: number;
  risk: number;
  category: string;
  selected: boolean;
};

type RealCrimeMapProps = {
  points: CrimeMapPoint[];
  tilted: boolean;
  language: Language;
  modeLabel: string;
  onSelect: (id: string) => void;
};

const BENGALURU_CENTER: [number, number] = [77.5946, 12.9716];
const MAP_STYLE = "/map-tiles/styles/liberty?kspp=3d-v1";
const BUILDING_SOURCE = "openfreemap-buildings";
const CRIME_SOURCE = "crime-intelligence-points";

maplibregl.setWorkerUrl(mapWorkerUrl);

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const localizeBaseLabels = (map: MapLibreMap, language: Language) => {
  if (language !== "kn") return;
  for (const layer of map.getStyle().layers || []) {
    if (layer.type !== "symbol" || !layer.layout?.["text-field"]) continue;
    try {
      map.setLayoutProperty(layer.id, "text-field", [
        "coalesce",
        ["get", "name:kn"],
        ["get", "name"],
        ["get", "ref"],
      ]);
    } catch {
      // Some icon-only or provider-specific symbol layers cannot be rewritten.
    }
  }
};

const featureCollection = (points: CrimeMapPoint[]) => ({
  type: "FeatureCollection" as const,
  features: points.map((point) => ({
    type: "Feature" as const,
    id: point.id,
    geometry: {
      type: "Point" as const,
      coordinates: [point.longitude, point.latitude],
    },
    properties: {
      id: point.id,
      name: point.name,
      station: point.station,
      category: point.category,
      risk: point.risk,
      selected: point.selected ? 1 : 0,
    },
  })),
});

const addBuildingLayer = (map: MapLibreMap) => {
  if (map.getLayer("kspp-3d-buildings")) return;
  if (!map.getSource(BUILDING_SOURCE)) {
    map.addSource(BUILDING_SOURCE, {
      type: "vector",
      url: "/map-tiles/planet",
    });
  }

  const labelLayer = map
    .getStyle()
    .layers?.find((layer) => layer.type === "symbol" && layer.layout?.["text-field"]);

  const buildingLayer: FillExtrusionLayerSpecification = {
    id: "kspp-3d-buildings",
    source: BUILDING_SOURCE,
    "source-layer": "building",
    type: "fill-extrusion" as const,
    minzoom: 14,
    filter: ["!=", ["get", "hide_3d"], true],
    paint: {
      "fill-extrusion-color": [
        "interpolate",
        ["linear"],
        ["coalesce", ["get", "render_height"], 8],
        0,
        "#143451",
        60,
        "#1d6184",
        160,
        "#54d7ff",
      ],
      "fill-extrusion-height": [
        "interpolate",
        ["linear"],
        ["zoom"],
        14,
        0,
        15.2,
        ["coalesce", ["get", "render_height"], 8],
      ],
      "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
      "fill-extrusion-opacity": 0.72,
    },
  };

  if (labelLayer?.id) map.addLayer(buildingLayer, labelLayer.id);
  else map.addLayer(buildingLayer);
};

const addCrimeLayers = (map: MapLibreMap, points: CrimeMapPoint[]) => {
  map.addSource(CRIME_SOURCE, {
    type: "geojson",
    data: featureCollection(points),
  });

  map.addLayer({
    id: "kspp-crime-heat",
    type: "heatmap",
    source: CRIME_SOURCE,
    maxzoom: 15.5,
    paint: {
      "heatmap-weight": ["interpolate", ["linear"], ["get", "risk"], 0, 0, 100, 1],
      "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 9, 0.8, 15, 2.4],
      "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 9, 42, 15, 82],
      "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], 11, 0.9, 15.5, 0.38],
      "heatmap-color": [
        "interpolate",
        ["linear"],
        ["heatmap-density"],
        0,
        "rgba(84,215,255,0)",
        0.18,
        "rgba(84,215,255,.35)",
        0.42,
        "rgba(77,226,167,.62)",
        0.64,
        "rgba(255,181,71,.78)",
        0.82,
        "rgba(255,93,104,.9)",
        1,
        "rgba(208,28,50,1)",
      ],
    },
  });

  map.addLayer({
    id: "kspp-crime-pulse",
    type: "circle",
    source: CRIME_SOURCE,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["get", "risk"], 0, 20, 100, 48],
      "circle-color": ["step", ["get", "risk"], "#25d895", 45, "#ffb547", 70, "#ff4458"],
      "circle-opacity": ["case", ["==", ["get", "selected"], 1], 0.34, 0.2],
      "circle-blur": 0.72,
      "circle-pitch-alignment": "map",
    },
  });

  map.addLayer({
    id: "kspp-crime-halo",
    type: "circle",
    source: CRIME_SOURCE,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["get", "risk"], 0, 13, 100, 29],
      "circle-color": ["step", ["get", "risk"], "#25d895", 45, "#ffb547", 70, "#ff4458"],
      "circle-opacity": ["case", ["==", ["get", "selected"], 1], 0.5, 0.32],
      "circle-stroke-width": 2,
      "circle-stroke-color": "rgba(255,255,255,.78)",
      "circle-blur": 0.2,
    },
  });

  map.addLayer({
    id: "kspp-crime-points",
    type: "circle",
    source: CRIME_SOURCE,
    paint: {
      "circle-radius": [
        "case",
        ["==", ["get", "selected"], 1],
        16,
        ["interpolate", ["linear"], ["get", "risk"], 0, 9, 100, 14],
      ],
      "circle-color": ["step", ["get", "risk"], "#19c987", 45, "#ffad2f", 70, "#ff3249"],
      "circle-stroke-width": ["case", ["==", ["get", "selected"], 1], 5, 3],
      "circle-stroke-color": "#ffffff",
      "circle-opacity": 1,
    },
  });

  map.addLayer({
    id: "kspp-crime-selected-ring",
    type: "circle",
    source: CRIME_SOURCE,
    paint: {
      "circle-radius": 25,
      "circle-color": "rgba(0,0,0,0)",
      "circle-opacity": 0,
      "circle-stroke-width": 3,
      "circle-stroke-color": "#54d7ff",
      "circle-stroke-opacity": ["case", ["==", ["get", "selected"], 1], 1, 0],
    },
  });

  map.addLayer({
    id: "kspp-crime-labels",
    type: "symbol",
    source: CRIME_SOURCE,
    minzoom: 10.4,
    filter: ["!=", ["get", "selected"], 1],
    layout: {
      "text-field": ["concat", ["get", "name"], "  ·  ", ["to-string", ["get", "risk"]], "%"],
      "text-size": 11.5,
      "text-offset": [0, 1.85],
      "text-anchor": "top",
      "text-allow-overlap": false,
    },
    paint: {
      "text-color": "#ffffff",
      "text-halo-color": "rgba(3,12,22,.98)",
      "text-halo-width": 3,
      "text-halo-blur": 0.5,
    },
  });

  map.addLayer({
    id: "kspp-crime-selected-label",
    type: "symbol",
    source: CRIME_SOURCE,
    minzoom: 9.5,
    filter: ["==", ["get", "selected"], 1],
    layout: {
      "text-field": ["concat", ["get", "name"], "  ·  ", ["to-string", ["get", "risk"]], "%"],
      "text-size": 13,
      "text-offset": [0, 1.85],
      "text-anchor": "top",
      "text-allow-overlap": true,
    },
    paint: {
      "text-color": "#ffffff",
      "text-halo-color": "rgba(3,12,22,.98)",
      "text-halo-width": 3,
      "text-halo-blur": 0.5,
    },
  });
};

const RealCrimeMap: React.FC<RealCrimeMapProps> = ({
  points,
  tilted,
  language,
  modeLabel,
  onSelect,
}) => {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const onSelectRef = useRef(onSelect);
  const initialPointsRef = useRef(points);
  const initialTiltRef = useRef(tilted);
  const initialLanguageRef = useRef(language);
  const tiltedRef = useRef(tilted);
  const [mapState, setMapState] = useState<"loading" | "ready" | "error">("loading");
  initialPointsRef.current = points;

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE,
      center: BENGALURU_CENTER,
      zoom: 11.35,
      pitch: initialTiltRef.current ? 52 : 0,
      bearing: initialTiltRef.current ? -18 : 0,
      maxPitch: 75,
      maxZoom: 19,
      minZoom: 9.5,
      rollEnabled: true,
      canvasContextAttributes: { antialias: true },
      attributionControl: false,
    });

    mapRef.current = map;
    map.addControl(
      new maplibregl.NavigationControl({
        showZoom: true,
        showCompass: true,
        visualizePitch: true,
        visualizeRoll: true,
      }),
      "top-right",
    );
    map.addControl(new maplibregl.FullscreenControl({ container: shellRef.current || undefined }), "top-right");
    map.addControl(new maplibregl.ScaleControl({ unit: "metric", maxWidth: 110 }), "bottom-left");
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");

    const translateControls = () => {
      const container = containerRef.current;
      if (!container || initialLanguageRef.current !== "kn") return;
      const translatedControls = [
        [".maplibregl-ctrl-zoom-in", "ಜೂಮ್ ಇನ್"],
        [".maplibregl-ctrl-zoom-out", "ಜೂಮ್ ಔಟ್"],
        [".maplibregl-ctrl-compass", "ಉತ್ತರ ದಿಕ್ಕನ್ನು ಮರುಹೊಂದಿಸಿ"],
        [".maplibregl-ctrl-fullscreen", "ಪೂರ್ಣ ಪರದೆಗೆ ಪ್ರವೇಶಿಸಿ"],
        [".maplibregl-ctrl-shrink", "ಪೂರ್ಣ ಪರದೆಯಿಂದ ನಿರ್ಗಮಿಸಿ"],
      ];
      for (const [selector, label] of translatedControls) {
        const button = container.querySelector<HTMLButtonElement>(selector);
        if (!button) continue;
        button.title = label;
        button.setAttribute("aria-label", label);
      }
    };

    const handleLoad = () => {
      localizeBaseLabels(map, initialLanguageRef.current);
      addBuildingLayer(map);
      addCrimeLayers(map, initialPointsRef.current);
      translateControls();
      setMapState("ready");
    };

    const handlePointClick = (event: MapLayerMouseEvent) => {
      const id = event.features?.[0]?.properties?.id;
      if (id) onSelectRef.current(String(id));
    };
    const handleMouseEnter = () => { map.getCanvas().style.cursor = "pointer"; };
    const handleMouseLeave = () => { map.getCanvas().style.cursor = ""; };
    const handleError = (event: { error?: unknown }) => {
      console.error("Bengaluru map resource error", event.error || "Unknown map error");
      if (!map.isStyleLoaded()) setMapState("error");
    };

    map.on("load", handleLoad);
    map.on("click", "kspp-crime-points", handlePointClick);
    map.on("mouseenter", "kspp-crime-points", handleMouseEnter);
    map.on("mouseleave", "kspp-crime-points", handleMouseLeave);
    map.on("error", handleError);

    const canvas = map.getCanvas();
    let dragStart: { x: number; y: number; pitch: number; bearing: number; pointerId: number } | null = null;
    const handlePointerDown = (event: PointerEvent) => {
      if (!tiltedRef.current || event.button !== 0) return;
      dragStart = {
        x: event.clientX,
        y: event.clientY,
        pitch: map.getPitch(),
        bearing: map.getBearing(),
        pointerId: event.pointerId,
      };
      canvas.setPointerCapture(event.pointerId);
      canvas.style.cursor = "grabbing";
    };
    const handlePointerMove = (event: PointerEvent) => {
      if (!dragStart || event.pointerId !== dragStart.pointerId || !tiltedRef.current) return;
      map.jumpTo({
        pitch: clamp(dragStart.pitch - ((event.clientY - dragStart.y) * 0.32), 0, 75),
        bearing: dragStart.bearing + ((event.clientX - dragStart.x) * 0.22),
      });
    };
    const stopPointerDrag = (event: PointerEvent) => {
      if (!dragStart || event.pointerId !== dragStart.pointerId) return;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      dragStart = null;
      canvas.style.cursor = "grab";
    };
    canvas.addEventListener("pointerdown", handlePointerDown);
    canvas.addEventListener("pointermove", handlePointerMove);
    canvas.addEventListener("pointerup", stopPointerDrag);
    canvas.addEventListener("pointercancel", stopPointerDrag);
    document.addEventListener("fullscreenchange", translateControls);
    if (initialTiltRef.current) {
      map.dragPan.disable();
      canvas.style.cursor = "grab";
    }

    const resizeObserver = new ResizeObserver(() => map.resize());
    if (shellRef.current) resizeObserver.observe(shellRef.current);
    const loadTimeout = window.setTimeout(() => {
      if (!map.isStyleLoaded()) setMapState("error");
    }, 12000);

    return () => {
      window.clearTimeout(loadTimeout);
      canvas.removeEventListener("pointerdown", handlePointerDown);
      canvas.removeEventListener("pointermove", handlePointerMove);
      canvas.removeEventListener("pointerup", stopPointerDrag);
      canvas.removeEventListener("pointercancel", stopPointerDrag);
      document.removeEventListener("fullscreenchange", translateControls);
      resizeObserver.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const source = map.getSource(CRIME_SOURCE) as GeoJSONSource | undefined;
    source?.setData(featureCollection(points));
  }, [points]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    tiltedRef.current = tilted;
    if (tilted) {
      map.dragPan.disable();
      map.getCanvas().style.cursor = "grab";
    } else {
      map.dragPan.enable();
      map.getCanvas().style.cursor = "";
    }
    map.easeTo({
      pitch: tilted ? 52 : 0,
      bearing: tilted ? -18 : 0,
      duration: 900,
    });
  }, [tilted]);

  return (
    <div className="real-crime-map-shell" ref={shellRef}>
      <div className="real-map-mode-badge"><i /> {modeLabel}</div>
      <div className="real-map-city-badge">
        <span>{language === "kn" ? "ಬೆಂಗಳೂರು" : "BENGALURU"}</span>
        <small>12.9716° N · 77.5946° E</small>
      </div>
      <div ref={containerRef} className="real-crime-map" aria-label={language === "kn" ? "ಬೆಂಗಳೂರಿನ ಸಂವಾದಾತ್ಮಕ 3D ಅಪರಾಧ ಗುಪ್ತಚರ ನಕ್ಷೆ" : "Interactive 3D crime intelligence map of Bengaluru"} />
      {mapState === "loading" ? <div className="real-map-state">{language === "kn" ? "ಬೆಂಗಳೂರು 3D ನಕ್ಷೆ ಲೋಡ್ ಆಗುತ್ತಿದೆ…" : "Loading Bengaluru 3D map…"}</div> : null}
      {mapState === "error" ? (
        <div className="real-map-state is-error">
          <strong>{language === "kn" ? "ನಕ್ಷೆ ಟೈಲ್‌ಗಳು ಲಭ್ಯವಿಲ್ಲ" : "Map tiles are unavailable"}</strong>
          <span>{language === "kn" ? "ಇಂಟರ್ನೆಟ್ ಸಂಪರ್ಕ ಪರಿಶೀಲಿಸಿ ಮತ್ತು ಗುಪ್ತಚರ ನಕ್ಷೆಯನ್ನು ಮರುಲೋಡ್ ಮಾಡಿ." : "Check the internet connection and reload the intelligence map."}</span>
        </div>
      ) : null}
      <div className="real-map-help">{tilted
        ? (language === "kn" ? "ಜೂಮ್ ಮಾಡಲು ಸ್ಕ್ರಾಲ್ ಮಾಡಿ · ತಿರುಗಿಸಲು ಮತ್ತು ಓರೆಯಾಗಿಸಲು ಎಳೆಯಿರಿ" : "Scroll to zoom · Drag to rotate and tilt")
        : (language === "kn" ? "ಜೂಮ್ ಮಾಡಲು ಸ್ಕ್ರಾಲ್ ಮಾಡಿ · ನಕ್ಷೆಯನ್ನು ಸರಿಸಲು ಎಳೆಯಿರಿ" : "Scroll to zoom · Drag to move")}</div>
    </div>
  );
};

export default RealCrimeMap;
