import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Database,
  Maximize2,
  Minimize2,
  Move,
  Network,
  RotateCcw,
  ShieldAlert,
  Users,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

import type { FirRecord } from "../../lib/cases";
import type { CriminalNetwork, NetworkCase, NetworkPerson } from "../../lib/criminalNetwork";

type Translate = (english: string, kannada: string) => string;

type Props = {
  network: CriminalNetwork;
  onBack: () => void;
  t: Translate;
};

type PositionedNode = {
  id: string;
  kind: "selected" | "accused" | "case" | "coAccused";
  x: number;
  y: number;
  label: string;
  subtitle: string;
};

type ActiveNode =
  | { kind: "selected" }
  | { kind: "accused"; key: string }
  | { kind: "case"; key: string }
  | { kind: "coAccused"; key: string };

type PanState = {
  pointerId: number;
  startX: number;
  startY: number;
  scrollLeft: number;
  scrollTop: number;
};

type NodeDragState = {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  nodeX: number;
  nodeY: number;
};

const NODE_WIDTH = 164;
const NODE_HEIGHT = 64;
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 1.6;
const ZOOM_STEP = 0.15;

const FIELD_LABELS: Record<string, readonly [string, string]> = {
  CaseMasterID: ["Case master ID", "ಪ್ರಕರಣ ಮಾಸ್ಟರ್ ಐಡಿ"],
  CrimeNo: ["Crime number", "ಅಪರಾಧ ಸಂಖ್ಯೆ"],
  CaseNo: ["Case number", "ಪ್ರಕರಣ ಸಂಖ್ಯೆ"],
  CrimeRegisteredDate: ["Crime registered date", "ಅಪರಾಧ ದಾಖಲಿಸಿದ ದಿನಾಂಕ"],
  CrimeHead: ["Crime head", "ಅಪರಾಧ ಶೀರ್ಷಿಕೆ"],
  CrimeSubHead: ["Crime sub-head", "ಅಪರಾಧ ಉಪಶೀರ್ಷಿಕೆ"],
  PoliceStation: ["Police station", "ಪೊಲೀಸ್ ಠಾಣೆ"],
  PoliceStationType: ["Police station type", "ಪೊಲೀಸ್ ಠಾಣೆಯ ಪ್ರಕಾರ"],
  District: ["District", "ಜಿಲ್ಲೆ"],
  Court: ["Court", "ನ್ಯಾಯಾಲಯ"],
  EmployeeID: ["Employee ID", "ಉದ್ಯೋಗಿ ಐಡಿ"],
  Officer: ["Investigating officer", "ತನಿಖಾಧಿಕಾರಿ"],
  OfficerRank: ["Officer rank", "ಅಧಿಕಾರಿಯ ಹುದ್ದೆ"],
  OfficerDesignation: ["Officer designation", "ಅಧಿಕಾರಿಯ ಪದನಾಮ"],
  Status: ["Status", "ಸ್ಥಿತಿ"],
  CaseCategory: ["Case category", "ಪ್ರಕರಣ ವರ್ಗ"],
  Gravity: ["Gravity", "ಗಂಭೀರತೆ"],
  AccusedCount: ["Accused count", "ಆರೋಪಿಗಳ ಸಂಖ್ಯೆ"],
  AccusedNames: ["Accused names", "ಆರೋಪಿಗಳ ಹೆಸರುಗಳು"],
  VictimCount: ["Victim count", "ಬಲಿಪಶುಗಳ ಸಂಖ್ಯೆ"],
  VictimNames: ["Victim names", "ಬಲಿಪಶುಗಳ ಹೆಸರುಗಳು"],
  Complainant: ["Complainant", "ದೂರುದಾರ"],
  ArrestCount: ["Arrest count", "ಬಂಧನಗಳ ಸಂಖ್ಯೆ"],
  ChargesheetCount: ["Chargesheet count", "ದೋಷಾರೋಪಪಟ್ಟಿಗಳ ಸಂಖ್ಯೆ"],
  LatestChargesheetDate: ["Latest chargesheet date", "ಇತ್ತೀಚಿನ ದೋಷಾರೋಪಪಟ್ಟಿ ದಿನಾಂಕ"],
  ChargesheetStatus: ["Chargesheet status", "ದೋಷಾರೋಪಪಟ್ಟಿ ಸ್ಥಿತಿ"],
  Acts: ["Acts", "ಕಾಯ್ದೆಗಳು"],
  Sections: ["Sections", "ಸೆಕ್ಷನ್‌ಗಳು"],
  InfoReceivedPSDate: ["Information received at station", "ಠಾಣೆಯಲ್ಲಿ ಮಾಹಿತಿ ಸ್ವೀಕರಿಸಿದ ದಿನಾಂಕ"],
  IncidentFromDate: ["Incident from date", "ಘಟನೆ ಪ್ರಾರಂಭ ದಿನಾಂಕ"],
  IncidentToDate: ["Incident to date", "ಘಟನೆ ಅಂತ್ಯ ದಿನಾಂಕ"],
  Latitude: ["Latitude", "ಅಕ್ಷಾಂಶ"],
  Longitude: ["Longitude", "ರೇಖಾಂಶ"],
  BriefFacts: ["Brief facts", "ಸಂಕ್ಷಿಪ್ತ ಸಂಗತಿಗಳು"],
  FiledBy: ["Filed by", "ದಾಖಲಿಸಿದವರು"],
};

function spread(count: number, height: number): number[] {
  if (count === 0) return [];
  const top = 72;
  const usable = height - top * 2;
  return Array.from({ length: count }, (_, index) => top + ((index + 0.5) * usable) / count);
}

function shortLabel(value: string, limit = 21): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function nodeColors(kind: PositionedNode["kind"]): { fill: string; stroke: string; text: string } {
  if (kind === "selected") return { fill: "#0b315f", stroke: "#e5b83f", text: "#ffffff" };
  if (kind === "accused") return { fill: "#6f262c", stroke: "#e78087", text: "#ffffff" };
  if (kind === "case") return { fill: "#174a7e", stroke: "#72a9d8", text: "#ffffff" };
  return { fill: "#4a3514", stroke: "#d8a14a", text: "#ffffff" };
}

function fieldLabel(field: string, t: Translate): string {
  const known = FIELD_LABELS[field];
  if (known) return t(known[0], known[1]);
  return field.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ");
}

const FirDatabaseDetails: React.FC<{
  record: FirRecord;
  relationship?: string;
  selected: boolean;
  t: Translate;
}> = ({ record, relationship, selected, t }) => {
  const fields = useMemo(
    () => Object.entries(record.raw).filter(([, value]) => String(value ?? "").trim().length > 0),
    [record.raw],
  );

  return (
    <div>
      <div className="border-b border-line pb-3">
        <span className="text-[10px] font-bold uppercase tracking-wider text-muted">
          {selected ? t("Selected FIR", "ಆಯ್ಕೆ ಮಾಡಿದ ಎಫ್‌ಐಆರ್") : t("Related FIR", "ಸಂಬಂಧಿತ ಎಫ್‌ಐಆರ್")}
        </span>
        <h3 className="mt-1 text-base font-semibold text-brand">{record.label}</h3>
        {relationship ? <p className="mt-2 text-xs leading-relaxed text-muted">{relationship}</p> : null}
        <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-brand/10 px-2.5 py-1 text-[10px] font-semibold text-brand">
          <Database size={11} aria-hidden="true" />
          {fields.length} {t("recorded database fields", "ದಾಖಲಾದ ಡೇಟಾಬೇಸ್ ಕ್ಷೇತ್ರಗಳು")}
        </div>
      </div>

      <dl className="mt-3 grid gap-2">
        {fields.map(([field, value]) => (
          <div key={field} className="rounded-lg border border-line bg-shell p-2.5 shadow-sm">
            <dt className="text-[10px] font-bold uppercase tracking-wide text-muted">
              {fieldLabel(field, t)}
            </dt>
            <dd className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed">
              {String(value)}
            </dd>
          </div>
        ))}
      </dl>

      <p className="mt-3 text-[10px] leading-relaxed text-muted">
        {t(
          "Only non-empty fields from this FIR's database record are displayed.",
          "ಈ ಎಫ್‌ಐಆರ್‌ನ ಡೇಟಾಬೇಸ್ ದಾಖಲೆಯ ಖಾಲಿಯಲ್ಲದ ಕ್ಷೇತ್ರಗಳನ್ನು ಮಾತ್ರ ತೋರಿಸಲಾಗಿದೆ.",
        )}
      </p>
    </div>
  );
};

export const CriminalNetworkGraph: React.FC<Props> = ({ network, onBack, t }) => {
  const [showCoAccused, setShowCoAccused] = useState(true);
  const [active, setActive] = useState<ActiveNode>({ kind: "selected" });
  const [zoom, setZoom] = useState(1);
  const [isPanning, setIsPanning] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [nodePositions, setNodePositions] = useState<Record<string, { x: number; y: number }>>({});
  const viewportRef = useRef<HTMLDivElement>(null);
  const detailsRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<PanState | null>(null);
  const nodeDragRef = useRef<NodeDragState | null>(null);

  useEffect(() => {
    setActive({ kind: "selected" });
    setShowCoAccused(true);
    setNodePositions({});
  }, [network.selected.id]);

  useEffect(() => {
    if (!isFullscreen) return;
    const previousOverflow = document.body.style.overflow;
    const exitOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsFullscreen(false);
    };
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", exitOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", exitOnEscape);
    };
  }, [isFullscreen]);

  const layout = useMemo(() => {
    const visibleCoAccused = showCoAccused ? network.coAccused : [];
    const largestColumn = Math.max(1, network.accused.length, network.relatedCases.length, visibleCoAccused.length);
    const height = Math.max(480, largestColumn * 92 + 120);
    const width = showCoAccused && visibleCoAccused.length > 0 ? 1160 : 870;
    const columns = { selected: 105, accused: 350, case: 650, coAccused: 1025 };
    const accusedY = spread(network.accused.length, height);
    const relatedCaseY = spread(network.relatedCases.length, height);
    const coAccusedY = spread(visibleCoAccused.length, height);

    const baseNodes: PositionedNode[] = [
      { id: "selected", kind: "selected", x: columns.selected, y: height / 2, label: network.selected.label, subtitle: t("Selected FIR", "ಆಯ್ಕೆ ಮಾಡಿದ ಎಫ್‌ಐಆರ್") },
      ...network.accused.map((person, index) => ({ id: `accused:${person.key}`, kind: "accused" as const, x: columns.accused, y: accusedY[index], label: person.name, subtitle: t("Accused", "ಆರೋಪಿ") })),
      ...network.relatedCases.map((relatedCase, index) => ({ id: `case:${relatedCase.key}`, kind: "case" as const, x: columns.case, y: relatedCaseY[index], label: relatedCase.record.label, subtitle: t("Related FIR", "ಸಂಬಂಧಿತ ಎಫ್‌ಐಆರ್") })),
      ...visibleCoAccused.map((person, index) => ({ id: `co:${person.key}`, kind: "coAccused" as const, x: columns.coAccused, y: coAccusedY[index], label: person.name, subtitle: t("Co-accused", "ಸಹ-ಆರೋಪಿ") })),
    ];
    const nodes = baseNodes.map((node) => {
      const custom = nodePositions[node.id];
      return custom ? { ...node, x: custom.x, y: custom.y } : node;
    });

    const positions = new Map(nodes.map((node) => [node.id, node]));
    const edges: Array<{ id: string; from: PositionedNode; to: PositionedNode; kind: "direct" | "match" | "co" }> = [];

    for (const person of network.accused) {
      const from = positions.get("selected");
      const to = positions.get(`accused:${person.key}`);
      if (from && to) edges.push({ id: `selected-${person.key}`, from, to, kind: "direct" });
    }
    for (const relatedCase of network.relatedCases) {
      for (const personKey of relatedCase.sharedAccusedKeys) {
        const from = positions.get(`accused:${personKey}`);
        const to = positions.get(`case:${relatedCase.key}`);
        if (from && to) edges.push({ id: `${personKey}-${relatedCase.key}`, from, to, kind: "match" });
      }
      if (showCoAccused) {
        for (const personKey of relatedCase.coAccusedKeys) {
          const from = positions.get(`case:${relatedCase.key}`);
          const to = positions.get(`co:${personKey}`);
          if (from && to) edges.push({ id: `${relatedCase.key}-${personKey}`, from, to, kind: "co" });
        }
      }
    }
    return { width, height, nodes, edges };
  }, [network, nodePositions, showCoAccused, t]);

  const accusedByKey = useMemo(() => new Map(network.accused.map((person) => [person.key, person])), [network.accused]);
  const coAccusedByKey = useMemo(() => new Map(network.coAccused.map((person) => [person.key, person])), [network.coAccused]);
  const caseByKey = useMemo(() => new Map(network.relatedCases.map((item) => [item.key, item])), [network.relatedCases]);

  const activePerson: NetworkPerson | undefined = active.kind === "accused"
    ? accusedByKey.get(active.key)
    : active.kind === "coAccused"
      ? coAccusedByKey.get(active.key)
      : undefined;
  const activeCase: NetworkCase | undefined = active.kind === "case" ? caseByKey.get(active.key) : undefined;

  const linkedCases = useMemo(() => {
    if (!activePerson) return [];
    const linked = new Set(activePerson.linkedCaseKeys);
    return network.relatedCases.filter((item) => linked.has(item.key));
  }, [activePerson, network.relatedCases]);

  const revealDetailsOnSmallScreen = useCallback(() => {
    if (!window.matchMedia("(max-width: 1535px)").matches) return;
    window.requestAnimationFrame(() => detailsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, []);

  const activate = useCallback((next: ActiveNode) => {
    setActive(next);
    revealDetailsOnSmallScreen();
  }, [revealDetailsOnSmallScreen]);

  const selectNode = (node: PositionedNode) => {
    if (node.kind === "selected") activate({ kind: "selected" });
    if (node.kind === "accused") activate({ kind: "accused", key: node.id.slice(8) });
    if (node.kind === "case") activate({ kind: "case", key: node.id.slice(5) });
    if (node.kind === "coAccused") activate({ kind: "coAccused", key: node.id.slice(3) });
  };

  const fitView = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const availableWidth = Math.max(240, viewport.clientWidth - 24);
    const nextZoom = Math.min(1, Math.max(MIN_ZOOM, availableWidth / layout.width));
    setZoom(Number(nextZoom.toFixed(2)));
    window.requestAnimationFrame(() => viewport.scrollTo({ left: 0, top: 0 }));
  }, [layout.width]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(fitView);
    observer.observe(viewport);
    fitView();
    return () => observer.disconnect();
  }, [fitView]);

  const changeZoom = (amount: number) => {
    setZoom((current) => Number(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current + amount)).toFixed(2)));
  };

  const startPan = (event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest("[data-network-node]")) return;
    const viewport = event.currentTarget;
    panRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop };
    viewport.setPointerCapture(event.pointerId);
    setIsPanning(true);
  };

  const movePan = (event: React.PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    event.currentTarget.scrollLeft = pan.scrollLeft - (event.clientX - pan.startX);
    event.currentTarget.scrollTop = pan.scrollTop - (event.clientY - pan.startY);
  };

  const endPan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (panRef.current?.pointerId !== event.pointerId) return;
    panRef.current = null;
    setIsPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const startNodeDrag = (event: React.PointerEvent<SVGGElement>, node: PositionedNode) => {
    event.stopPropagation();
    nodeDragRef.current = {
      id: node.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      nodeX: node.x,
      nodeY: node.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveNode = (event: React.PointerEvent<SVGGElement>) => {
    const drag = nodeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.stopPropagation();
    const x = Math.min(
      layout.width - NODE_WIDTH / 2,
      Math.max(NODE_WIDTH / 2, drag.nodeX + (event.clientX - drag.startX) / zoom),
    );
    const y = Math.min(
      layout.height - NODE_HEIGHT / 2,
      Math.max(NODE_HEIGHT / 2, drag.nodeY + (event.clientY - drag.startY) / zoom),
    );
    setNodePositions((current) => ({ ...current, [drag.id]: { x, y } }));
  };

  const endNodeDrag = (event: React.PointerEvent<SVGGElement>) => {
    if (nodeDragRef.current?.pointerId !== event.pointerId) return;
    nodeDragRef.current = null;
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const resetLayout = () => {
    setNodePositions({});
    setActive({ kind: "selected" });
    setShowCoAccused(true);
    const viewport = viewportRef.current;
    if (!viewport) return;
    const resetWidth = network.coAccused.length > 0 ? 1160 : 870;
    const availableWidth = Math.max(240, viewport.clientWidth - 24);
    const resetZoom = Math.min(1, Math.max(MIN_ZOOM, availableWidth / resetWidth));
    setZoom(Number(resetZoom.toFixed(2)));
    window.requestAnimationFrame(() => viewport.scrollTo({ left: 0, top: 0, behavior: "smooth" }));
  };

  const activeCaseRelationship = activeCase
    ? `${t("Linked through accused", "ಆರೋಪಿಯ ಮೂಲಕ ಸಂಬಂಧಿಸಲಾಗಿದೆ")}: ${activeCase.sharedAccusedKeys.map((key) => accusedByKey.get(key)?.name).filter(Boolean).join(", ")}`
    : "";

  return (
    <section className="space-y-4" aria-labelledby="criminal-network-title">
      <div className="flex flex-col gap-3 border-b border-line pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <button type="button" onClick={onBack} className="mb-3 inline-flex items-center gap-2 text-xs font-semibold text-brand hover:underline">
            <ArrowLeft size={14} aria-hidden="true" />
            {t("Back to FIR details", "ಎಫ್‌ಐಆರ್ ವಿವರಗಳಿಗೆ ಹಿಂತಿರುಗಿ")}
          </button>
          <div className="flex items-center gap-2">
            <Network size={19} className="text-brand" aria-hidden="true" />
            <h2 id="criminal-network-title" className="text-lg font-semibold">{t("Criminal Network Graph", "ಅಪರಾಧ ಜಾಲ ನಕ್ಷೆ")}</h2>
          </div>
          <p className="mt-1 text-xs text-muted">
            {t("Select any node to inspect its database evidence here without leaving Advanced Search.", "ಸುಧಾರಿತ ಹುಡುಕಾಟದಿಂದ ಹೊರಹೋಗದೆ ಡೇಟಾಬೇಸ್ ಸಾಕ್ಷ್ಯವನ್ನು ಇಲ್ಲಿ ಪರಿಶೀಲಿಸಲು ಯಾವುದೇ ನೋಡ್ ಆಯ್ಕೆಮಾಡಿ.")}
          </p>
        </div>

        {network.coAccused.length > 0 ? (
          <label className="flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border border-line bg-panel px-3 text-xs font-semibold">
            <input type="checkbox" checked={showCoAccused} onChange={(event) => {
              setShowCoAccused(event.target.checked);
              if (!event.target.checked && active.kind === "coAccused") setActive({ kind: "selected" });
            }} className="accent-brand" />
            {t("Show co-accused", "ಸಹ-ಆರೋಪಿಗಳನ್ನು ತೋರಿಸಿ")}
          </label>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          [t("Accused in FIR", "ಎಫ್‌ಐಆರ್‌ನ ಆರೋಪಿಗಳು"), network.accused.length],
          [t("Names in other FIRs", "ಇತರ ಎಫ್‌ಐಆರ್‌ಗಳಲ್ಲಿರುವ ಹೆಸರುಗಳು"), network.repeatAccusedCount],
          [t("Related FIRs", "ಸಂಬಂಧಿತ ಎಫ್‌ಐಆರ್‌ಗಳು"), network.relatedCases.length],
          [t("Co-accused", "ಸಹ-ಆರೋಪಿಗಳು"), network.coAccused.length],
        ].map(([label, value]) => (
          <div key={String(label)} className="rounded-lg border border-line bg-panel p-3">
            <span className="text-[10px] uppercase tracking-wider text-muted">{label}</span>
            <strong className="mt-1 block text-lg">{value}</strong>
          </div>
        ))}
      </div>

      {network.accused.length === 0 ? (
        <div className="rounded-xl border border-amber/30 bg-amber/10 px-5 py-10 text-center" role="status">
          <ShieldAlert className="mx-auto mb-3 text-amber" aria-hidden="true" />
          <p className="text-sm font-semibold">{t("This FIR has no usable AccusedNames value in the database, so no network can be generated.", "ಈ ಎಫ್‌ಐಆರ್‌ನ ಡೇಟಾಬೇಸ್‌ನಲ್ಲಿ ಬಳಸಬಹುದಾದ AccusedNames ಮೌಲ್ಯವಿಲ್ಲ; ಆದ್ದರಿಂದ ಜಾಲವನ್ನು ರಚಿಸಲಾಗುವುದಿಲ್ಲ.")}</p>
        </div>
      ) : (
        <>
          {network.relatedCases.length === 0 ? (
            <div className="rounded-lg border border-line bg-panel px-4 py-3 text-xs text-muted" role="status">{t("No linked FIRs were found from exact normalized AccusedNames matches in the FIR records available to your role and station.", "ನಿಮ್ಮ ಪಾತ್ರ ಮತ್ತು ಠಾಣೆಗೆ ಲಭ್ಯವಿರುವ ಎಫ್‌ಐಆರ್ ದಾಖಲೆಗಳಲ್ಲಿ ಸಾಮಾನ್ಯೀಕೃತ AccusedNames ನಿಖರ ಹೊಂದಾಣಿಕೆಯಿಂದ ಯಾವುದೇ ಸಂಬಂಧಿತ ಎಫ್‌ಐಆರ್ ಕಂಡುಬಂದಿಲ್ಲ.")}</div>
          ) : null}

          <div className={isFullscreen
            ? "fixed inset-0 z-[10000] grid gap-4 overflow-auto bg-shell p-3 sm:p-4 2xl:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]"
            : "grid gap-4 2xl:grid-cols-[minmax(0,1fr)_minmax(320px,380px)]"}
          >
            <div className={`min-w-0 overflow-hidden rounded-xl border border-line bg-panel/50 ${isFullscreen ? "flex min-h-[70vh] flex-col 2xl:h-[calc(100vh-2rem)]" : ""}`}>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-shell/80 px-3 py-2">
                <div className="flex items-center gap-2 text-[11px] text-muted"><Move size={13} aria-hidden="true" />{t("Drag canvas to pan · drag nodes to arrange", "ಪ್ಯಾನ್ ಮಾಡಲು ಕ್ಯಾನ್ವಾಸ್ ಎಳೆಯಿರಿ · ಜೋಡಿಸಲು ನೋಡ್‌ಗಳನ್ನು ಎಳೆಯಿರಿ")}</div>
                <div className="flex items-center gap-1" aria-label={t("Graph zoom controls", "ಜಾಲ ನಕ್ಷೆ ಜೂಮ್ ನಿಯಂತ್ರಣಗಳು")}>
                  <button type="button" onClick={() => changeZoom(-ZOOM_STEP)} disabled={zoom <= MIN_ZOOM} className="grid h-9 w-9 place-items-center rounded-lg border border-line bg-panel disabled:opacity-35" aria-label={t("Zoom out", "ಜೂಮ್ ಔಟ್")} title={t("Zoom out", "ಜೂಮ್ ಔಟ್")}><ZoomOut size={15} aria-hidden="true" /></button>
                  <span className="min-w-12 text-center text-[10px] font-semibold text-muted">{Math.round(zoom * 100)}%</span>
                  <button type="button" onClick={() => changeZoom(ZOOM_STEP)} disabled={zoom >= MAX_ZOOM} className="grid h-9 w-9 place-items-center rounded-lg border border-line bg-panel disabled:opacity-35" aria-label={t("Zoom in", "ಜೂಮ್ ಇನ್")} title={t("Zoom in", "ಜೂಮ್ ಇನ್")}><ZoomIn size={15} aria-hidden="true" /></button>
                  <button type="button" onClick={() => setIsFullscreen((current) => !current)} aria-pressed={isFullscreen} className="grid h-9 w-9 place-items-center rounded-lg border border-line bg-panel" aria-label={isFullscreen ? t("Exit full screen", "ಪೂರ್ಣ ಪರದೆಯಿಂದ ನಿರ್ಗಮಿಸಿ") : t("Open full screen", "ಪೂರ್ಣ ಪರದೆ ತೆರೆಯಿರಿ")} title={isFullscreen ? t("Exit full screen", "ಪೂರ್ಣ ಪರದೆಯಿಂದ ನಿರ್ಗಮಿಸಿ") : t("Open full screen", "ಪೂರ್ಣ ಪರದೆ ತೆರೆಯಿರಿ")}>{isFullscreen ? <Minimize2 size={14} aria-hidden="true" /> : <Maximize2 size={14} aria-hidden="true" />}</button>
                  <button type="button" onClick={resetLayout} className="grid h-9 w-9 place-items-center rounded-lg border border-line bg-panel" aria-label={t("Reset graph", "ಜಾಲ ನಕ್ಷೆಯನ್ನು ಮರುಹೊಂದಿಸಿ")} title={t("Reset graph", "ಜಾಲ ನಕ್ಷೆಯನ್ನು ಮರುಹೊಂದಿಸಿ")}><RotateCcw size={14} aria-hidden="true" /></button>
                </div>
              </div>

              <div ref={viewportRef} className={`${isFullscreen ? "min-h-[calc(100vh-5rem)] max-h-none 2xl:min-h-0 2xl:flex-1" : "min-h-[480px] max-h-[70vh]"} overflow-auto overscroll-contain ${isPanning ? "cursor-grabbing select-none" : "cursor-grab"}`} style={{ touchAction: "none" }} onPointerDown={startPan} onPointerMove={movePan} onPointerUp={endPan} onPointerCancel={endPan} role="group" aria-label={t(`Interactive relationship graph for ${network.selected.label}`, `${network.selected.label} ಗಾಗಿ ಸಂವಾದಾತ್ಮಕ ಸಂಬಂಧ ಜಾಲ ನಕ್ಷೆ`)}>
                <svg width={layout.width * zoom} height={layout.height * zoom} viewBox={`0 0 ${layout.width} ${layout.height}`} className="block max-w-none">
                  <defs>
                    <marker id="network-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#507da9" /></marker>
                    <pattern id="network-grid" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M 24 0 L 0 0 0 24" fill="none" stroke="#507da9" strokeOpacity="0.12" strokeWidth="1" /></pattern>
                  </defs>
                  <rect width="100%" height="100%" fill="url(#network-grid)" />

                  {layout.edges.map((edge) => {
                    const startX = edge.from.x + NODE_WIDTH / 2;
                    const endX = edge.to.x - NODE_WIDTH / 2;
                    const control = (startX + endX) / 2;
                    return <path key={edge.id} d={`M ${startX} ${edge.from.y} C ${control} ${edge.from.y}, ${control} ${edge.to.y}, ${endX} ${edge.to.y}`} fill="none" stroke={edge.kind === "co" ? "#c77b18" : "#507da9"} strokeWidth={edge.kind === "match" ? 2.4 : 1.6} strokeOpacity={0.76} markerEnd="url(#network-arrow)" />;
                  })}

                  {layout.nodes.map((node) => {
                    const colors = nodeColors(node.kind);
                    const isActive = (active.kind === "selected" && node.kind === "selected") || (active.kind === "accused" && node.id === `accused:${active.key}`) || (active.kind === "case" && node.id === `case:${active.key}`) || (active.kind === "coAccused" && node.id === `co:${active.key}`);
                    return (
                      <g key={node.id} data-network-node="true" transform={`translate(${node.x} ${node.y})`} role="button" tabIndex={0} aria-label={`${node.subtitle}: ${node.label}`} onPointerDown={(event) => startNodeDrag(event, node)} onPointerMove={moveNode} onPointerUp={endNodeDrag} onPointerCancel={endNodeDrag} onClick={() => selectNode(node)} onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectNode(node); }
                      }} className="cursor-pointer outline-none transition-opacity hover:opacity-90">
                        <title>{`${node.subtitle}: ${node.label}`}</title>
                        <rect x={-NODE_WIDTH / 2} y={-NODE_HEIGHT / 2} width={NODE_WIDTH} height={NODE_HEIGHT} rx={10} fill={colors.fill} stroke={isActive ? "#ffffff" : colors.stroke} strokeWidth={isActive ? 3 : 1.5} />
                        <line x1={-NODE_WIDTH / 2} x2={NODE_WIDTH / 2} y1={-10} y2={-10} stroke={colors.stroke} strokeOpacity="0.55" />
                        <circle cx={-NODE_WIDTH / 2} cy="0" r="5" fill={colors.stroke} /><circle cx={NODE_WIDTH / 2} cy="0" r="5" fill={colors.stroke} />
                        <text x="0" y="-18" fill={colors.text} fillOpacity="0.74" fontSize="9" fontWeight="700" textAnchor="middle">{node.subtitle.toUpperCase()}</text>
                        <text x="0" y="12" fill={colors.text} fontSize="13" fontWeight="700" textAnchor="middle">{shortLabel(node.label)}</text>
                      </g>
                    );
                  })}
                </svg>
              </div>
            </div>

            <aside ref={detailsRef} className={`scroll-mt-4 rounded-xl border border-line bg-panel p-4 2xl:overflow-y-auto ${isFullscreen ? "2xl:max-h-[calc(100vh-2rem)]" : "2xl:max-h-[calc(70vh+54px)]"}`} aria-live="polite" aria-label={t("Selected node details", "ಆಯ್ಕೆ ಮಾಡಿದ ನೋಡ್ ವಿವರಗಳು")}>
              {active.kind === "selected" ? <FirDatabaseDetails record={network.selected} selected t={t} /> : null}
              {activePerson ? (
                <div>
                  <div className="flex items-center gap-2"><Users size={16} className="text-amber" aria-hidden="true" /><h3 className="font-semibold">{activePerson.name}</h3></div>
                  <p className="mt-2 text-xs leading-relaxed text-muted">{active.kind === "accused" ? t("This exact normalized name is recorded in the selected FIR's AccusedNames field.", "ಆಯ್ಕೆ ಮಾಡಿದ ಎಫ್‌ಐಆರ್‌ನ AccusedNames ಕ್ಷೇತ್ರದಲ್ಲಿ ಇದೇ ಸಾಮಾನ್ಯೀಕೃತ ಹೆಸರು ದಾಖಲಾಗಿದೆ.") : t("This name is recorded as a co-accused in a linked FIR's AccusedNames field.", "ಸಂಬಂಧಿತ ಎಫ್‌ಐಆರ್‌ನ AccusedNames ಕ್ಷೇತ್ರದಲ್ಲಿ ಈ ಹೆಸರು ಸಹ-ಆರೋಪಿಯಾಗಿ ದಾಖಲಾಗಿದೆ.")}</p>
                  <div className="mt-4 grid gap-2">
                    {active.kind === "accused" ? <button type="button" onClick={() => activate({ kind: "selected" })} className="min-h-10 rounded-lg border border-line bg-shell px-3 text-left text-xs font-semibold hover:border-brand">{network.selected.label} · {t("show details here", "ವಿವರಗಳನ್ನು ಇಲ್ಲಿ ತೋರಿಸಿ")}</button> : null}
                    {linkedCases.map((item) => <button key={item.key} type="button" onClick={() => activate({ kind: "case", key: item.key })} className="min-h-10 rounded-lg border border-line bg-shell px-3 text-left text-xs font-semibold hover:border-brand">{item.record.label} · {t("show details here", "ವಿವರಗಳನ್ನು ಇಲ್ಲಿ ತೋರಿಸಿ")}</button>)}
                  </div>
                </div>
              ) : null}
              {activeCase ? <FirDatabaseDetails record={activeCase.record} relationship={activeCaseRelationship} selected={false} t={t} /> : null}
            </aside>
          </div>

          {network.relatedCases.length > 0 ? (
            <div className="rounded-lg border border-amber/30 bg-amber/10 px-4 py-3 text-xs leading-relaxed" role="note"><strong>{t("Verification required:", "ಪರಿಶೀಲನೆ ಅಗತ್ಯ:")}</strong>{" "}{t("A matching name is an investigative lead, not proof that two records refer to the same person. Confirm identity from the linked FIR details before taking action.", "ಹೊಂದಾಣಿಕೆಯ ಹೆಸರು ತನಿಖಾ ಸುಳಿವು ಮಾತ್ರ; ಎರಡು ದಾಖಲೆಗಳು ಒಂದೇ ವ್ಯಕ್ತಿಯನ್ನು ಸೂಚಿಸುತ್ತವೆ ಎಂಬುದಕ್ಕೆ ಪುರಾವೆಯಲ್ಲ. ಕ್ರಮ ಕೈಗೊಳ್ಳುವ ಮೊದಲು ಸಂಬಂಧಿತ ಎಫ್‌ಐಆರ್ ವಿವರಗಳಿಂದ ಗುರುತನ್ನು ದೃಢಪಡಿಸಿ.")}</div>
          ) : null}
          <p className="text-[11px] leading-relaxed text-muted">{t("Data boundary: this view uses only FIR records available to the signed-in officer. It does not infer aliases or extract entities from narrative text.", "ಡೇಟಾ ಮಿತಿ: ಈ ನೋಟವು ಲಾಗಿನ್ ಮಾಡಿದ ಅಧಿಕಾರಿಗೆ ಲಭ್ಯವಿರುವ ಎಫ್‌ಐಆರ್ ದಾಖಲೆಗಳನ್ನು ಮಾತ್ರ ಬಳಸುತ್ತದೆ. ಇದು ಅಲಿಯಾಸ್‌ಗಳನ್ನು ಊಹಿಸುವುದಿಲ್ಲ ಅಥವಾ ವಿವರಣಾತ್ಮಕ ಪಠ್ಯದಿಂದ ಘಟಕಗಳನ್ನು ತೆಗೆದುಕೊಳ್ಳುವುದಿಲ್ಲ.")}</p>
        </>
      )}
    </section>
  );
};
