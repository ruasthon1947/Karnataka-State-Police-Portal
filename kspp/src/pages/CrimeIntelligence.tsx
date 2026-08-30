import React, { useEffect, useMemo, useState } from "react";
import { useLanguage } from "../context/LanguageContext";
import { sendPatrolAlert, useFirRecords } from "../lib/cases";
import { buildIntelligenceDataset, hotspotScore, Hotspot, MapMode } from "../lib/crimeIntelligence";
import { displayPlaceName } from "../lib/kannadaPlaces";
import { displayKnownValue } from "../lib/kannadaValues";
import type { HotspotTrainingResult } from "../lib/hotspotModel";

const RealCrimeMap = React.lazy(() => import("../components/map/RealCrimeMap"));
const ALL_CRIMES = "__all_crimes__";
type RiskLevel = "low" | "medium" | "high";
type PatrolState = { status: "idle" | "sending" | "sent" | "error"; message: string };
const EMPTY_TRAINING: HotspotTrainingResult = {
  model: null,
  reason: "Neural training has not completed.",
  datedGeocodedRecords: 0,
  historyDays: 0,
};

const riskLevel = (risk: number): RiskLevel => risk >= 70 ? "high" : risk >= 45 ? "medium" : "low";
const dateValue = (value: string | undefined) => {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
};

const dailySignalBars = (records: ReturnType<typeof useFirRecords>["records"]) => {
  const counts = Array.from({ length: 7 }, () => 0);
  const now = Date.now();
  for (const record of records) {
    const occurredAt = dateValue(record.raw.IncidentFromDate || record.raw.CrimeRegisteredDate || record.date);
    if (occurredAt === null) continue;
    const daysAgo = Math.floor((now - occurredAt) / 86_400_000);
    if (daysAgo >= 0 && daysAgo < 7) counts[6 - daysAgo] += 1;
  }
  const maximum = Math.max(...counts, 1);
  return counts.map((count) => ({ count, height: count ? Math.max(18, Math.round((count / maximum) * 100)) : 5 }));
};

const RiskRing: React.FC<{ risk: number; label: string }> = ({ risk, label }) => (
  <div className={`risk-ring risk-${riskLevel(risk)}`} style={{ "--risk": `${risk * 3.6}deg` } as React.CSSProperties}>
    <div><strong>{risk}%</strong><span>{label}</span></div>
  </div>
);

const CrimeIntelligence: React.FC = () => {
  const { language, tr } = useLanguage();
  const { records, loading, refreshing, lastUpdatedAt, error, reload } = useFirRecords();
  const [mode, setMode] = useState<MapMode>("live");
  const [crimeFilter, setCrimeFilter] = useState(ALL_CRIMES);
  const [horizonDays, setHorizonDays] = useState(7);
  const [hour, setHour] = useState(20);
  const [tilted, setTilted] = useState(true);
  const [selectedId, setSelectedId] = useState("");
  const [patrol, setPatrol] = useState<PatrolState>({ status: "idle", message: "" });
  const [patrolConfirmOpen, setPatrolConfirmOpen] = useState(false);
  const [training, setTraining] = useState<HotspotTrainingResult>(EMPTY_TRAINING);
  const [trainingPending, setTrainingPending] = useState(false);

  const dataset = useMemo(() => buildIntelligenceDataset(records), [records]);

  useEffect(() => {
    setTrainingPending(true);
    setTraining(EMPTY_TRAINING);
    const worker = new Worker(new URL("../workers/hotspotTrainingWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<HotspotTrainingResult>) => {
      setTraining(event.data);
      setTrainingPending(false);
    };
    worker.onerror = () => {
      setTraining({ ...EMPTY_TRAINING, reason: "The neural training worker could not complete." });
      setTrainingPending(false);
    };
    worker.postMessage(records);
    return () => worker.terminate();
  }, [records]);

  const trainedModel = training.model;
  const forecastReady = Boolean(trainedModel);
  const activeMode: MapMode = mode === "forecast" && forecastReady ? "forecast" : "live";
  const categories = useMemo(() => Array.from(new Set(dataset.hotspots.map((item) => item.category))).sort(), [dataset.hotspots]);
  const filteredHotspots = useMemo(
    () => dataset.hotspots.filter((item) => crimeFilter === ALL_CRIMES || item.category === crimeFilter),
    [crimeFilter, dataset.hotspots],
  );
  const selected = filteredHotspots.find((item) => item.id === selectedId) || filteredHotspots[0] || null;
  const selectedRisk = selected ? hotspotScore(selected, activeMode, hour, horizonDays, trainedModel) : 0;
  const averageRisk = filteredHotspots.length
    ? Math.round(filteredHotspots.reduce((sum, item) => sum + hotspotScore(item, activeMode, hour, horizonDays, trainedModel), 0) / filteredHotspots.length)
    : 0;
  const highRiskCount = filteredHotspots.filter((item) => hotspotScore(item, activeMode, hour, horizonDays, trainedModel) >= 70).length;
  const signalBars = useMemo(() => dailySignalBars(records), [records]);
  const latestDate = dataset.latestRecordDate
    ? new Date(dataset.latestRecordDate).toLocaleDateString(language === "kn" ? "kn-IN" : "en-IN")
    : tr("Not available", "ಲಭ್ಯವಿಲ್ಲ");
  const locale = language === "kn" ? "kn-IN" : "en-IN";
  const lastSyncLabel = lastUpdatedAt
    ? new Date(lastUpdatedAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : tr("Not synced", "ಸಿಂಕ್ ಆಗಿಲ್ಲ");
  const validationRange = trainedModel
    ? `${new Date(trainedModel.metrics.validationFrom).toLocaleDateString(locale)} – ${new Date(trainedModel.metrics.validationThrough).toLocaleDateString(locale)}`
    : "";

  const mapPoints = useMemo(() => filteredHotspots.map((hotspot) => ({
    id: hotspot.id,
    name: displayPlaceName(hotspot.name, language),
    station: displayPlaceName(hotspot.station, language),
    latitude: hotspot.latitude,
    longitude: hotspot.longitude,
    risk: hotspotScore(hotspot, activeMode, hour, horizonDays, trainedModel),
    category: hotspot.category,
    selected: hotspot.id === selected?.id,
  })), [activeMode, filteredHotspots, horizonDays, hour, language, selected?.id, trainedModel]);

  const modeLabel = activeMode === "live"
    ? tr("LIVE · Recorded FIR density", "ಲೈವ್ · ದಾಖಲಾದ ಎಫ್‌ಐಆರ್ ಸಾಂದ್ರತೆ")
    : tr(`AI FORECAST · Next ${horizonDays} day${horizonDays === 1 ? "" : "s"}`, `ಎಐ ಮುನ್ಸೂಚನೆ · ಮುಂದಿನ ${horizonDays} ದಿನಗಳು`);

  const scoreLabel = (risk: number) => {
    const level = riskLevel(risk);
    if (level === "high") return tr("High score", "ಹೆಚ್ಚಿನ ಅಂಕ");
    if (level === "medium") return tr("Medium score", "ಮಧ್ಯಮ ಅಂಕ");
    return tr("Low score", "ಕಡಿಮೆ ಅಂಕ");
  };

  const sendSelectedPatrolAlert = async () => {
    if (!selected || patrol.status === "sending") return;
    setPatrolConfirmOpen(false);
    setPatrol({ status: "sending", message: tr("Sending Twilio alert…", "Twilio ಎಚ್ಚರಿಕೆ ಕಳುಹಿಸಲಾಗುತ್ತಿದೆ…") });
    try {
      const result = await sendPatrolAlert({
        station: selected.station,
        zone: selected.name,
        risk: selectedRisk,
        mode: activeMode === "live" ? "Live FIR density" : `${horizonDays}-day AI forecast`,
        peakWindow: selected.peakWindow,
      });
      const { sent, failed, eligible } = result.notifications;
      if (sent > 0) {
        setPatrol({
          status: "sent",
          message: tr(
            `Twilio SMS sent to ${sent} verified officer${sent === 1 ? "" : "s"}${failed ? `; ${failed} failed` : ""}.`,
            `${sent} ದೃಢೀಕೃತ ಅಧಿಕಾರಿಗಳಿಗೆ Twilio SMS ಕಳುಹಿಸಲಾಗಿದೆ${failed ? `; ${failed} ವಿಫಲವಾಗಿದೆ` : ""}.`,
          ),
        });
      } else {
        setPatrol({
          status: "error",
          message: eligible
            ? tr("Twilio could not deliver the patrol SMS.", "Twilio ಗಸ್ತು SMS ಅನ್ನು ತಲುಪಿಸಲು ಸಾಧ್ಯವಾಗಲಿಲ್ಲ.")
            : tr("No verified, opted-in officer was found for this station.", "ಈ ಠಾಣೆಗೆ ದೃಢೀಕೃತ, ಒಪ್ಪಿಗೆ ನೀಡಿದ ಅಧಿಕಾರಿ ಕಂಡುಬಂದಿಲ್ಲ."),
        });
      }
    } catch (alertError) {
      setPatrol({
        status: "error",
        message: alertError instanceof Error ? alertError.message : tr("Patrol alert failed.", "ಗಸ್ತು ಎಚ್ಚರಿಕೆ ವಿಫಲವಾಗಿದೆ."),
      });
    }
  };

  const selectedDrivers = (hotspot: Hotspot) => [
    tr(`${hotspot.nearbyCases} geocoded FIRs within 1.5 km of this exact coordinate`, `ಈ ನಿಖರ ನಿರ್ದೇಶಾಂಕದ 1.5 ಕಿ.ಮೀ ಒಳಗೆ ${hotspot.nearbyCases} ಜಿಯೋ-ಕೋಡ್ ಮಾಡಿದ ಎಫ್‌ಐಆರ್‌ಗಳು`),
    tr(`${hotspot.recentCases} nearby FIRs recorded in the latest 30-day data window`, `ಇತ್ತೀಚಿನ 30 ದಿನಗಳ ದತ್ತಾಂಶ ಅವಧಿಯಲ್ಲಿ ${hotspot.recentCases} ಹತ್ತಿರದ ಎಫ್‌ಐಆರ್‌ಗಳು ದಾಖಲಾಗಿವೆ`),
    hotspot.trend > 0
      ? tr(`Seven-day incident trend increased ${hotspot.trend}%`, `ಏಳು ದಿನಗಳ ಘಟನೆ ಪ್ರವೃತ್ತಿ ${hotspot.trend}% ಹೆಚ್ಚಾಗಿದೆ`)
      : tr(`Seven-day incident trend is ${Math.abs(hotspot.trend)}% lower or unchanged`, `ಏಳು ದಿನಗಳ ಘಟನೆ ಪ್ರವೃತ್ತಿ ${Math.abs(hotspot.trend)}% ಕಡಿಮೆ ಅಥವಾ ಬದಲಾಗಿಲ್ಲ`),
  ];

  return (
    <div className="crime-intelligence-page mx-auto w-full max-w-[1700px] p-4 sm:p-5 lg:p-6">
      <section className="crime-intelligence-hero">
        <div>
          <h1>{tr("Crime Intelligence Map", "ಅಪರಾಧ ಗುಪ್ತಚರ ನಕ್ಷೆ")}</h1>
          <p>{tr("Exact FIR coordinates, recorded crime density, and a clearly separated experimental forecast.", "ನಿಖರ ಎಫ್‌ಐಆರ್ ನಿರ್ದೇಶಾಂಕಗಳು, ದಾಖಲಾದ ಅಪರಾಧ ಸಾಂದ್ರತೆ ಮತ್ತು ಸ್ಪಷ್ಟವಾಗಿ ಪ್ರತ್ಯೇಕಿಸಿದ ಪ್ರಾಯೋಗಿಕ ಮುನ್ಸೂಚನೆ.")}</p>
        </div>
        <div className="model-signal" aria-label={forecastReady ? tr("Neural network validation result", "ನ್ಯೂರಲ್ ನೆಟ್‌ವರ್ಕ್ ಮೌಲ್ಯೀಕರಣ ಫಲಿತಾಂಶ") : tr("Seven-day FIR activity and geocoding coverage", "ಏಳು ದಿನಗಳ ಎಫ್‌ಐಆರ್ ಚಟುವಟಿಕೆ ಮತ್ತು ಜಿಯೋ-ಕೋಡಿಂಗ್ ವ್ಯಾಪ್ತಿ")}>
          {signalBars.map((signal, index) => <span key={index} title={`${signal.count}`} style={{ height: `${signal.height}%` }} />)}
          <div><strong>{trainedModel ? trainedModel.metrics.balancedAccuracy : dataset.coveragePercentage}%</strong><small>{trainedModel ? tr("HOLDOUT BALANCED ACCURACY", "ಹೋಲ್ಡ್‌ಔಟ್ ಸಮತೋಲಿತ ನಿಖರತೆ") : tr("GEOCODED FIRs", "ಜಿಯೋ-ಕೋಡ್ ಎಫ್‌ಐಆರ್‌ಗಳು")}</small></div>
        </div>
      </section>

      <section className="intelligence-toolbar" aria-label={tr("Crime intelligence filters", "ಅಪರಾಧ ಗುಪ್ತಚರ ಫಿಲ್ಟರ್‌ಗಳು")}>
        <div className="mode-switch" role="group" aria-label={tr("Map mode", "ನಕ್ಷೆ ವಿಧಾನ")}>
          <button type="button" aria-pressed={activeMode === "live"} onClick={() => setMode("live")}>● {tr("Live crime", "ಲೈವ್ ಅಪರಾಧ")}</button>
          <button type="button" disabled={!forecastReady || trainingPending} title={forecastReady ? undefined : training.reason} aria-pressed={activeMode === "forecast"} onClick={() => setMode("forecast")}>✦ {trainingPending ? tr("Training…", "ತರಬೇತಿ…") : tr("AI forecast", "ಎಐ ಮುನ್ಸೂಚನೆ")}</button>
        </div>
        <label><span>{tr("Crime type", "ಅಪರಾಧ ಪ್ರಕಾರ")}</span><select value={crimeFilter} onChange={(event) => setCrimeFilter(event.target.value)}>
          <option value={ALL_CRIMES}>{tr("All crime types", "ಎಲ್ಲಾ ಅಪರಾಧ ಪ್ರಕಾರಗಳು")}</option>
          {categories.map((category) => <option key={category} value={category}>{displayKnownValue(category, language)}</option>)}
        </select></label>
        <label><span>{tr("Prediction window", "ಮುನ್ಸೂಚನೆ ಅವಧಿ")}</span><select value={horizonDays} onChange={(event) => setHorizonDays(Number(event.target.value))} disabled={activeMode === "live"}>
          <option value={1}>{tr("Next 24 hours", "ಮುಂದಿನ 24 ಗಂಟೆಗಳು")}</option>
          <option value={7}>{tr("Next 7 days", "ಮುಂದಿನ 7 ದಿನಗಳು")}</option>
          <option value={30}>{tr("Next 30 days", "ಮುಂದಿನ 30 ದಿನಗಳು")}</option>
        </select></label>
        <button type="button" className={`live-sync-control ${refreshing ? "is-syncing" : ""}`} disabled={loading || refreshing} onClick={() => void reload(true)} title={tr("Automatically checks the connected FIR register every 60 seconds", "ಸಂಪರ್ಕಿತ ಎಫ್‌ಐಆರ್ ದಾಖಲೆಯನ್ನು ಪ್ರತಿ 60 ಸೆಕೆಂಡಿಗೆ ಸ್ವಯಂಚಾಲಿತವಾಗಿ ಪರಿಶೀಲಿಸುತ್ತದೆ")}><i /> <span>{refreshing ? tr("Syncing…", "ಸಿಂಕ್ ಆಗುತ್ತಿದೆ…") : tr(`Live sync · ${lastSyncLabel}`, `ಲೈವ್ ಸಿಂಕ್ · ${lastSyncLabel}`)}</span></button>
        <button type="button" className="tilt-toggle" aria-pressed={tilted} onClick={() => setTilted((value) => !value)}><span>◇</span> {tilted ? tr("3D explore", "3D ಅನ್ವೇಷಣೆ") : tr("2D overview", "2D ಅವಲೋಕನ")}</button>
      </section>

      {!loading && (error || dataset.geocodedRecords === 0) ? <div className="intelligence-notice data-warning" role="alert">
        <span>{tr("NO LIVE MAP DATA", "ಲೈವ್ ನಕ್ಷೆ ದತ್ತಾಂಶವಿಲ್ಲ")}</span>
        {error ? tr(`Google Sheets data could not be loaded: ${error}`, `Google Sheets ದತ್ತಾಂಶವನ್ನು ಲೋಡ್ ಮಾಡಲು ಸಾಧ್ಯವಾಗಲಿಲ್ಲ: ${error}`) : tr("No Bengaluru FIR row currently contains a valid latitude and longitude.", "ಯಾವುದೇ ಬೆಂಗಳೂರು ಎಫ್‌ಐಆರ್ ಸಾಲಿನಲ್ಲಿ ಪ್ರಸ್ತುತ ಮಾನ್ಯ ಅಕ್ಷಾಂಶ ಮತ್ತು ರೇಖಾಂಶ ಇಲ್ಲ.")}
      </div> : null}

      <section className="intelligence-layout">
        <div className="crime-map-card">
          <div className="map-status-row"><div><i className={activeMode === "forecast" ? "forecast-dot" : "live-dot"} /> {modeLabel}</div><div className="map-legend"><span className="legend-low" /> {tr("Low", "ಕಡಿಮೆ")} <span className="legend-medium" /> {tr("Medium", "ಮಧ್ಯಮ")} <span className="legend-high" /> {tr("High", "ಹೆಚ್ಚು")}</div></div>
          <div className="crime-map-viewport real-map-viewport">
            <React.Suspense fallback={<div className="real-map-state">{tr("Preparing interactive 3D map…", "ಸಂವಾದಾತ್ಮಕ 3D ನಕ್ಷೆ ಸಿದ್ಧಪಡಿಸಲಾಗುತ್ತಿದೆ…")}</div>}>
              <RealCrimeMap key={language} points={mapPoints} tilted={tilted} language={language} modeLabel={modeLabel} onSelect={(id) => { setSelectedId(id); setPatrol({ status: "idle", message: "" }); setPatrolConfirmOpen(false); }} />
            </React.Suspense>
            {loading ? <div className="map-data-loading">{tr("Connecting to Google Sheets FIR data…", "Google Sheets ಎಫ್‌ಐಆರ್ ದತ್ತಾಂಶಕ್ಕೆ ಸಂಪರ್ಕಿಸಲಾಗುತ್ತಿದೆ…")}</div> : null}
            {!loading && !mapPoints.length ? <div className="map-data-empty">{tr("Map ready · waiting for valid FIR coordinates", "ನಕ್ಷೆ ಸಿದ್ಧವಾಗಿದೆ · ಮಾನ್ಯ ಎಫ್‌ಐಆರ್ ನಿರ್ದೇಶಾಂಕಗಳಿಗಾಗಿ ಕಾಯಲಾಗುತ್ತಿದೆ")}</div> : null}
          </div>
          <div className={`time-intelligence ${activeMode === "live" ? "is-disabled" : ""}`}>
            <div className="time-readout"><span>{tr("FORECAST TIME", "ಮುನ್ಸೂಚನೆ ಸಮಯ")}</span><strong>{String(hour).padStart(2, "0")}:00</strong></div>
            <div className="time-track"><input type="range" min="0" max="23" value={hour} disabled={activeMode === "live"} onChange={(event) => setHour(Number(event.target.value))} aria-label={tr("Forecast time of day", "ದಿನದ ಮುನ್ಸೂಚನೆ ಸಮಯ")} /><div><span>{tr("12 AM", "ರಾತ್ರಿ 12")}</span><span>{tr("6 AM", "ಬೆಳಗ್ಗೆ 6")}</span><span>{tr("12 PM", "ಮಧ್ಯಾಹ್ನ 12")}</span><span>{tr("6 PM", "ಸಂಜೆ 6")}</span><span>{tr("11 PM", "ರಾತ್ರಿ 11")}</span></div></div>
          </div>
        </div>

        <aside className="hotspot-intelligence-panel" aria-live="polite">
          {selected ? <>
            <div className="panel-eyebrow">{tr("SELECTED EXACT FIR LOCATION", "ಆಯ್ದ ನಿಖರ ಎಫ್‌ಐಆರ್ ಸ್ಥಳ")}</div>
            <h2>{displayPlaceName(selected.name, language)}</h2><p>{displayPlaceName(selected.station, language)} · {selected.latitude.toFixed(6)}, {selected.longitude.toFixed(6)}</p>
            <RiskRing risk={selectedRisk} label={scoreLabel(selectedRisk)} />
            <div className="prediction-primary"><span>{tr("Dominant recorded pattern", "ಪ್ರಮುಖ ದಾಖಲಾದ ಮಾದರಿ")}</span><strong>{displayKnownValue(selected.category, language)}</strong><div><span>{tr("Peak recorded window", "ಗರಿಷ್ಠ ದಾಖಲಾದ ಅವಧಿ")}</span><b>{selected.peakWindow}</b></div></div>
            <div className="prediction-metrics"><div><span>{tr("Nearby FIRs", "ಹತ್ತಿರದ ಎಫ್‌ಐಆರ್‌ಗಳು")}</span><strong>{selected.nearbyCases}</strong></div><div><span>{tr("7-day trend", "7 ದಿನಗಳ ಪ್ರವೃತ್ತಿ")}</span><strong className={selected.trend > 0 ? "trend-up" : ""}>{selected.trend > 0 ? "↗" : "↘"} {Math.abs(selected.trend)}%</strong></div></div>
            <div className="prediction-drivers"><h3>{tr("How this score was calculated", "ಈ ಅಂಕವನ್ನು ಹೇಗೆ ಲೆಕ್ಕ ಹಾಕಲಾಗಿದೆ")}</h3>{selectedDrivers(selected).map((driver, index) => <div key={driver}><span>{index + 1}</span><p>{driver}</p></div>)}</div>
            <button type="button" onClick={() => setPatrolConfirmOpen(true)} disabled={patrol.status === "sending"} className="mt-4 w-full rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
              {patrol.status === "sending" ? tr("Sending SMS…", "SMS ಕಳುಹಿಸಲಾಗುತ್ತಿದೆ…") : tr("Notify verified patrol officers by SMS", "ದೃಢೀಕೃತ ಗಸ್ತು ಅಧಿಕಾರಿಗಳಿಗೆ SMS ತಿಳಿಸಿ")}
            </button>
            {patrol.message && <p className={`mt-3 rounded-lg border px-3 py-2 text-xs ${patrol.status === "sent" ? "border-sage/30 bg-sage/10 text-sage" : patrol.status === "error" ? "border-rose/30 bg-rose/10 text-rose" : "border-line bg-panel text-muted"}`} role={patrol.status === "error" ? "alert" : "status"}>{patrol.message}</p>}
          </> : <div className="empty-intelligence-panel"><div className="panel-eyebrow">{tr("NO LOCATION SELECTED", "ಯಾವುದೇ ಸ್ಥಳ ಆಯ್ಕೆ ಮಾಡಿಲ್ಲ")}</div><h2>{tr("Waiting for geocoded FIR data", "ಜಿಯೋ-ಕೋಡ್ ಎಫ್‌ಐಆರ್ ದತ್ತಾಂಶಕ್ಕಾಗಿ ಕಾಯಲಾಗುತ್ತಿದೆ")}</h2><p>{tr("Add valid Bengaluru latitude and longitude values to the Google Sheet, then refresh this page.", "Google Sheet ಗೆ ಮಾನ್ಯ ಬೆಂಗಳೂರು ಅಕ್ಷಾಂಶ ಮತ್ತು ರೇಖಾಂಶ ಮೌಲ್ಯಗಳನ್ನು ಸೇರಿಸಿ, ನಂತರ ಈ ಪುಟವನ್ನು ರಿಫ್ರೆಶ್ ಮಾಡಿ.")}</p></div>}
        </aside>
      </section>

      {patrolConfirmOpen && selected && (
        <div className="modal-backdrop fixed inset-0 z-50 grid place-items-center p-4" role="dialog" aria-modal="true" aria-labelledby="patrol-sms-title">
          <div className="w-full max-w-md rounded-2xl border border-line bg-shell p-5 text-white shadow-soft">
            <h2 id="patrol-sms-title" className="text-lg font-semibold">{tr("Confirm patrol SMS", "ಗಸ್ತು SMS ದೃಢೀಕರಿಸಿ")}</h2>
            <p className="mt-2 text-sm text-muted">{tr(`Send the ${selectedRisk}% risk alert for ${displayPlaceName(selected.name, language)} to verified, opted-in officers at ${displayPlaceName(selected.station, language)}?`, `${displayPlaceName(selected.name, language)} ನ ${selectedRisk}% ಅಪಾಯ ಎಚ್ಚರಿಕೆಯನ್ನು ${displayPlaceName(selected.station, language)} ನ ದೃಢೀಕೃತ, ಒಪ್ಪಿಗೆ ನೀಡಿದ ಅಧಿಕಾರಿಗಳಿಗೆ ಕಳುಹಿಸುವುದೇ?`)}</p>
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" onClick={() => setPatrolConfirmOpen(false)} className="rounded-lg border border-line px-4 py-2.5 text-sm font-semibold text-muted">{tr("Cancel", "ರದ್ದು")}</button>
              <button type="button" onClick={() => void sendSelectedPatrolAlert()} className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white">{tr("Send SMS alert", "SMS ಎಚ್ಚರಿಕೆ ಕಳುಹಿಸಿ")}</button>
            </div>
          </div>
        </div>
      )}

      <section className="intelligence-summary">
        <div><span>{tr("High-score locations", "ಹೆಚ್ಚಿನ ಅಂಕದ ಸ್ಥಳಗಳು")}</span><strong>{highRiskCount}</strong><small>{tr("exact coordinates requiring attention", "ಗಮನ ಅಗತ್ಯವಿರುವ ನಿಖರ ನಿರ್ದೇಶಾಂಕಗಳು")}</small></div>
        <div><span>{tr("Average score", "ಸರಾಸರಿ ಅಂಕ")}</span><strong>{averageRisk}%</strong><small>{activeMode === "forecast" ? tr(`${horizonDays}-day neural forecast`, `${horizonDays} ದಿನಗಳ ನ್ಯೂರಲ್ ಮುನ್ಸೂಚನೆ`) : tr("recorded relative density", "ದಾಖಲಾದ ಸಂಬಂಧಿತ ಸಾಂದ್ರತೆ")}</small></div>
        <div><span>{tr("FIR rows analysed", "ವಿಶ್ಲೇಷಿಸಿದ ಎಫ್‌ಐಆರ್ ಸಾಲುಗಳು")}</span><strong>{records.length.toLocaleString(language === "kn" ? "kn-IN" : "en-IN")}</strong><small>{dataset.geocodedRecords.toLocaleString(language === "kn" ? "kn-IN" : "en-IN")} {tr("valid Bengaluru coordinates", "ಮಾನ್ಯ ಬೆಂಗಳೂರು ನಿರ್ದೇಶಾಂಕಗಳು")}</small></div>
        <div><span>{trainedModel ? tr("Real holdout validation", "ನೈಜ ಹೋಲ್ಡ್‌ಔಟ್ ಮೌಲ್ಯೀಕರಣ") : tr("Latest FIR date", "ಇತ್ತೀಚಿನ ಎಫ್‌ಐಆರ್ ದಿನಾಂಕ")}</span><strong className="model-ready">{trainedModel ? `${trainedModel.metrics.balancedAccuracy}%` : latestDate}</strong><small>{trainedModel ? tr(`${validationRange} · ${trainedModel.metrics.validationSamples} matured outcomes · Brier ${trainedModel.metrics.brierScore}`, `${validationRange} · ${trainedModel.metrics.validationSamples} ಪೂರ್ಣಗೊಂಡ ಫಲಿತಾಂಶಗಳು · ಬ್ರೈಯರ್ ${trainedModel.metrics.brierScore}`) : tr(`Case register synced at ${lastSyncLabel}`, `ಪ್ರಕರಣ ದಾಖಲೆ ${lastSyncLabel}ಕ್ಕೆ ಸಿಂಕ್ ಆಗಿದೆ`)}</small></div>
      </section>
      <p className="intelligence-disclaimer">{tr("The case register auto-syncs every 60 seconds and retrains only from dated, geocoded FIR outcomes. Displayed validation metrics come exclusively from later, matured, non-overlapping historical outcomes. AI forecasts remain operational aids and never replace officer judgment.", "ಪ್ರಕರಣ ದಾಖಲೆ ಪ್ರತಿ 60 ಸೆಕೆಂಡಿಗೆ ಸ್ವಯಂ-ಸಿಂಕ್ ಆಗುತ್ತದೆ ಮತ್ತು ದಿನಾಂಕ ಹೊಂದಿರುವ, ಜಿಯೋ-ಕೋಡ್ ಮಾಡಿದ ಎಫ್‌ಐಆರ್ ಫಲಿತಾಂಶಗಳಿಂದ ಮಾತ್ರ ಮರುತರಬೇತಿ ಪಡೆಯುತ್ತದೆ. ಪ್ರದರ್ಶಿಸಲಾದ ಮೌಲ್ಯೀಕರಣ ಅಳತೆಗಳು ನಂತರದ, ಪೂರ್ಣಗೊಂಡ, ಅತಿಕ್ರಮಿಸದ ಐತಿಹಾಸಿಕ ಫಲಿತಾಂಶಗಳಿಂದ ಮಾತ್ರ ಬರುತ್ತವೆ. ಎಐ ಮುನ್ಸೂಚನೆಗಳು ಅಧಿಕಾರಿಯ ನಿರ್ಣಯವನ್ನು ಬದಲಿಸುವುದಿಲ್ಲ.")}</p>
    </div>
  );
};

export default CrimeIntelligence;
