import React, { useEffect, useMemo, useState } from "react";
import { useLanguage } from "../context/LanguageContext";
import { sendPatrolAlert, useFirRecords } from "../lib/cases";
import { buildIntelligenceDataset, hotspotScore, Hotspot, MapMode } from "../lib/crimeIntelligence";
import { displayPlaceName } from "../lib/kannadaPlaces";
import { displayKnownValue } from "../lib/kannadaValues";
import { predictHotspotForecast } from "../lib/hotspotModel";
import type { HotspotForecastFactor, HotspotTrainingResult } from "../lib/hotspotModel";

const RealCrimeMap = React.lazy(() => import("../components/map/RealCrimeMap"));
const ALL_CRIMES = "__all_crimes__";
type RiskLevel = "low" | "medium" | "high";
type PatrolState = { status: "idle" | "sending" | "sent" | "error"; message: string };
const EMPTY_TRAINING: HotspotTrainingResult = {
  model: null,
  evaluation: null,
  status: "insufficient_data",
  reason: "Neural training has not completed.",
  datedGeocodedRecords: 0,
  modelRecordsUsed: 0,
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
  const evaluation = training.evaluation;
  const forecastReady = Boolean(trainedModel);
  const activeMode: MapMode = mode === "forecast" && forecastReady ? "forecast" : "live";
  const categories = useMemo(() => Array.from(new Set(dataset.hotspots.map((item) => item.category))).sort(), [dataset.hotspots]);
  const filteredHotspots = useMemo(
    () => dataset.hotspots.filter((item) => crimeFilter === ALL_CRIMES || item.category === crimeFilter),
    [crimeFilter, dataset.hotspots],
  );
  const selected = filteredHotspots.find((item) => item.id === selectedId) || filteredHotspots[0] || null;
  const selectedForecast = useMemo(() => selected && activeMode === "forecast" && trainedModel
    ? predictHotspotForecast(trainedModel, {
      liveRisk: selected.liveRisk,
      recentCases: selected.recentCases,
      trend: selected.trend,
      category: selected.category,
      hour,
      horizonDays,
    })
    : null, [activeMode, horizonDays, hour, selected, trainedModel]);
  const selectedRisk = selectedForecast?.risk ?? (selected ? hotspotScore(selected, activeMode, hour, horizonDays, trainedModel) : 0);
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
  const validationRange = evaluation
    ? `${new Date(evaluation.validationFrom).toLocaleDateString(locale)} – ${new Date(evaluation.validationThrough).toLocaleDateString(locale)}`
    : "";
  const confidenceLabel = evaluation?.confidenceLevel === "high"
    ? tr("High", "ಹೆಚ್ಚು")
    : evaluation?.confidenceLevel === "medium"
      ? tr("Medium", "ಮಧ್ಯಮ")
      : tr("Low", "ಕಡಿಮೆ");
  const forecastUnavailableReason = trainingPending
    ? tr("Forecast validation is running.", "ಮುನ್ಸೂಚನೆ ಮೌಲ್ಯೀಕರಣ ನಡೆಯುತ್ತಿದೆ.")
    : training.status === "below_baseline"
      ? tr("Forecast withheld because it did not reliably beat the historical benchmark.", "ಐತಿಹಾಸಿಕ ಮಾನದಂಡವನ್ನು ವಿಶ್ವಾಸಾರ್ಹವಾಗಿ ಮೀರದ ಕಾರಣ ಮುನ್ಸೂಚನೆಯನ್ನು ತಡೆಹಿಡಿಯಲಾಗಿದೆ.")
      : tr(
        `${training.datedGeocodedRecords} usable FIRs covering ${training.historyDays} days are available; more dated history is required.`,
        `${training.historyDays} ದಿನಗಳನ್ನು ಒಳಗೊಂಡ ${training.datedGeocodedRecords} ಬಳಸಬಹುದಾದ ಎಫ್‌ಐಆರ್‌ಗಳು ಲಭ್ಯವಿವೆ; ಹೆಚ್ಚಿನ ದಿನಾಂಕದ ಇತಿಹಾಸ ಅಗತ್ಯವಿದೆ.`,
      );

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
    : tr(`VALIDATED FORECAST · Next ${horizonDays} day${horizonDays === 1 ? "" : "s"}`, `ಮೌಲ್ಯೀಕರಿಸಿದ ಮುನ್ಸೂಚನೆ · ಮುಂದಿನ ${horizonDays} ದಿನಗಳು`);

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
        mode: activeMode === "live"
          ? tr("Live FIR density", "ಲೈವ್ ಎಫ್‌ಐಆರ್ ಸಾಂದ್ರತೆ")
          : tr(`${horizonDays}-day AI forecast`, `${horizonDays} ದಿನಗಳ ಎಐ ಮುನ್ಸೂಚನೆ`),
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
        message: language === "kn"
          ? tr("Patrol alert failed.", "ಗಸ್ತು ಎಚ್ಚರಿಕೆ ವಿಫಲವಾಗಿದೆ. ದಯವಿಟ್ಟು ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.")
          : alertError instanceof Error ? alertError.message : "Patrol alert failed.",
      });
    }
  };

  const factorName = (factor: HotspotForecastFactor) => ({
    density: tr("Recorded crime density", "ದಾಖಲಾದ ಅಪರಾಧ ಸಾಂದ್ರತೆ"),
    recentCases: tr("Recent nearby FIR count", "ಇತ್ತೀಚಿನ ಹತ್ತಿರದ ಎಫ್‌ಐಆರ್ ಸಂಖ್ಯೆ"),
    trend: tr("Recent incident trend", "ಇತ್ತೀಚಿನ ಘಟನೆ ಪ್ರವೃತ್ತಿ"),
    crimePattern: tr("Recorded crime pattern", "ದಾಖಲಾದ ಅಪರಾಧ ಮಾದರಿ"),
    time: tr("Selected time of day", "ಆಯ್ದ ದಿನದ ಸಮಯ"),
    window: tr("Selected forecast period", "ಆಯ್ದ ಮುನ್ಸೂಚನೆ ಅವಧಿ"),
  }[factor.id]);

  const selectedDrivers = (hotspot: Hotspot) => selectedForecast
    ? selectedForecast.factors.map((factor) => factor.impactPoints === 0
      ? tr(`${factorName(factor)} had little measurable effect on this result.`, `${factorName(factor)} ಈ ಫಲಿತಾಂಶದ ಮೇಲೆ ಅಲ್ಪ ಪರಿಣಾಮ ಬೀರಿದೆ.`)
      : tr(
        `${factorName(factor)} ${factor.direction === "raises" ? "raised" : "lowered"} this area-and-time score by about ${factor.impactPoints} point${factor.impactPoints === 1 ? "" : "s"}.`,
        `${factorName(factor)} ಈ ಪ್ರದೇಶ ಮತ್ತು ಸಮಯದ ಅಂಕವನ್ನು ಸುಮಾರು ${factor.impactPoints} ಅಂಕ ${factor.direction === "raises" ? "ಹೆಚ್ಚಿಸಿದೆ" : "ಕಡಿಮೆ ಮಾಡಿದೆ"}.`,
      ))
    : [
    tr(`${hotspot.nearbyCases} geocoded FIRs within 1.5 km of this area centre`, `ಈ ಪ್ರದೇಶದ ಕೇಂದ್ರದ 1.5 ಕಿ.ಮೀ ಒಳಗೆ ${hotspot.nearbyCases} ಜಿಯೋ-ಕೋಡ್ ಮಾಡಿದ ಎಫ್‌ಐಆರ್‌ಗಳು`),
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
          <p>{tr("Recorded FIR activity and validated area-and-time forecasts in one simple operational view.", "ದಾಖಲಾದ ಎಫ್‌ಐಆರ್ ಚಟುವಟಿಕೆ ಮತ್ತು ಮೌಲ್ಯೀಕರಿಸಿದ ಪ್ರದೇಶ-ಸಮಯ ಮುನ್ಸೂಚನೆಗಳು ಒಂದೇ ಸರಳ ಕಾರ್ಯಾಚರಣೆಯ ನೋಟದಲ್ಲಿ.")}</p>
        </div>
        <div className="model-signal" aria-label={activeMode === "forecast" ? tr("Neural network validation result", "ನ್ಯೂರಲ್ ನೆಟ್‌ವರ್ಕ್ ಮೌಲ್ಯೀಕರಣ ಫಲಿತಾಂಶ") : tr("Seven-day FIR activity and geocoding coverage", "ಏಳು ದಿನಗಳ ಎಫ್‌ಐಆರ್ ಚಟುವಟಿಕೆ ಮತ್ತು ಜಿಯೋ-ಕೋಡಿಂಗ್ ವ್ಯಾಪ್ತಿ")}>
          {signalBars.map((signal, index) => <span key={index} title={`${signal.count}`} style={{ height: `${signal.height}%` }} />)}
          <div><strong>{activeMode === "forecast" && evaluation ? evaluation.balancedAccuracy : dataset.coveragePercentage}%</strong><small>{activeMode === "forecast" && evaluation ? tr("NEWER-PERIOD ACCURACY", "ಹೊಸ ಅವಧಿಯ ನಿಖರತೆ") : tr("GEOCODED FIRs", "ಜಿಯೋ-ಕೋಡ್ ಎಫ್‌ಐಆರ್‌ಗಳು")}</small></div>
        </div>
      </section>

      <section className="intelligence-toolbar" aria-label={tr("Crime intelligence filters", "ಅಪರಾಧ ಗುಪ್ತಚರ ಫಿಲ್ಟರ್‌ಗಳು")}>
        <div className="mode-switch" role="group" aria-label={tr("Map mode", "ನಕ್ಷೆ ವಿಧಾನ")}>
          <button type="button" aria-pressed={activeMode === "live"} onClick={() => setMode("live")}>● {tr("Live crime", "ಲೈವ್ ಅಪರಾಧ")}</button>
          <button type="button" disabled={!forecastReady || trainingPending} title={forecastReady ? undefined : forecastUnavailableReason} aria-pressed={activeMode === "forecast"} onClick={() => setMode("forecast")}>✦ {trainingPending ? tr("Checking…", "ಪರಿಶೀಲಿಸಲಾಗುತ್ತಿದೆ…") : tr("Validated forecast", "ಮೌಲ್ಯೀಕರಿಸಿದ ಮುನ್ಸೂಚನೆ")}</button>
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

      {activeMode === "live" && (trainingPending || !forecastReady) ? <div className={`forecast-availability-note ${training.status === "below_baseline" ? "is-warning" : ""}`} role="status">
        <strong>{trainingPending
          ? tr("Forecast quality check is running", "ಮುನ್ಸೂಚನೆ ಗುಣಮಟ್ಟ ಪರಿಶೀಲನೆ ನಡೆಯುತ್ತಿದೆ")
          : training.status === "below_baseline"
            ? tr("Forecast is not available yet", "ಮುನ್ಸೂಚನೆ ಇನ್ನೂ ಲಭ್ಯವಿಲ್ಲ")
            : tr("More dated FIR history is needed for forecasting", "ಮುನ್ಸೂಚನೆಗೆ ಹೆಚ್ಚಿನ ದಿನಾಂಕದ ಎಫ್‌ಐಆರ್ ಇತಿಹಾಸ ಅಗತ್ಯ")}</strong>
        <span>{trainingPending
          ? tr("You can continue using Live Crime while it completes.", "ಇದು ಪೂರ್ಣಗೊಳ್ಳುವವರೆಗೆ ಲೈವ್ ಅಪರಾಧವನ್ನು ಬಳಸಬಹುದು.")
          : training.status === "below_baseline" && evaluation
            ? tr(`The model is hidden because it did not beat the historical baseline on both accuracy and probability reliability. Model error ${evaluation.brierScore}; baseline ${evaluation.baselineBrierScore} (lower is better).`, `ಮಾದರಿಯು ನಿಖರತೆ ಮತ್ತು ಸಂಭವನೀಯತೆಯ ವಿಶ್ವಾಸಾರ್ಹತೆ ಎರಡರಲ್ಲೂ ಐತಿಹಾಸಿಕ ಮೂಲಮಟ್ಟವನ್ನು ಮೀರದ ಕಾರಣ ಅದನ್ನು ಮರೆಮಾಡಲಾಗಿದೆ. ಮಾದರಿ ದೋಷ ${evaluation.brierScore}; ಮೂಲಮಟ್ಟ ${evaluation.baselineBrierScore} (ಕಡಿಮೆ ಉತ್ತಮ).`)
            : tr(`${training.datedGeocodedRecords} usable FIRs covering ${training.historyDays} days are currently available. Live Crime is unaffected.`, `ಪ್ರಸ್ತುತ ${training.historyDays} ದಿನಗಳನ್ನು ಒಳಗೊಂಡ ${training.datedGeocodedRecords} ಬಳಸಬಹುದಾದ ಎಫ್‌ಐಆರ್‌ಗಳು ಲಭ್ಯವಿವೆ. ಲೈವ್ ಅಪರಾಧಕ್ಕೆ ಪರಿಣಾಮವಿಲ್ಲ.`)}</span>
      </div> : null}

      {!loading && (error || dataset.geocodedRecords === 0) ? <div className="intelligence-notice data-warning" role="alert">
        <span>{tr("NO LIVE MAP DATA", "ಲೈವ್ ನಕ್ಷೆ ದತ್ತಾಂಶವಿಲ್ಲ")}</span>
        {error
          ? language === "kn"
            ? tr("FIR data could not be loaded.", "ಎಫ್‌ಐಆರ್ ದತ್ತಾಂಶವನ್ನು ಲೋಡ್ ಮಾಡಲು ಸಾಧ್ಯವಾಗಲಿಲ್ಲ. ದಯವಿಟ್ಟು ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.")
            : `FIR data could not be loaded: ${error}`
          : tr("No Karnataka FIR row currently contains a valid latitude and longitude.", "ಯಾವುದೇ ಕರ್ನಾಟಕ ಎಫ್‌ಐಆರ್ ಸಾಲಿನಲ್ಲಿ ಪ್ರಸ್ತುತ ಮಾನ್ಯ ಅಕ್ಷಾಂಶ ಮತ್ತು ರೇಖಾಂಶ ಇಲ್ಲ.")}
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
            <div className="panel-eyebrow">{activeMode === "forecast" ? tr("SELECTED FORECAST AREA", "ಆಯ್ದ ಮುನ್ಸೂಚನೆ ಪ್ರದೇಶ") : tr("SELECTED FIR AREA", "ಆಯ್ದ ಎಫ್‌ಐಆರ್ ಪ್ರದೇಶ")}</div>
            <h2>{displayPlaceName(selected.name, language)}</h2><p>{displayPlaceName(selected.station, language)} · {selected.latitude.toFixed(6)}, {selected.longitude.toFixed(6)}</p>
            <RiskRing risk={selectedRisk} label={scoreLabel(selectedRisk)} />
            {selectedForecast ? <div className="forecast-confidence" role="status">
              <div><span>{tr("BACK-TEST ERROR BAND", "ಹಿಂದಿನ-ಪರೀಕ್ಷಾ ದೋಷದ ವ್ಯಾಪ್ತಿ")}</span><strong>{selectedForecast.lowerBound}%–{selectedForecast.upperBound}%</strong></div>
              <div><span>{tr("CONFIDENCE", "ವಿಶ್ವಾಸ")}</span><strong>{confidenceLabel}</strong></div>
              <p>{tr("Range comes from errors in newer back-test periods. For this area and selected time only—never a prediction about a person.", "ಹೊಸ ಹಿಂದಿನ-ಪರೀಕ್ಷಾ ಅವಧಿಗಳ ದೋಷಗಳಿಂದ ಈ ವ್ಯಾಪ್ತಿ ಬರುತ್ತದೆ. ಈ ಪ್ರದೇಶ ಮತ್ತು ಆಯ್ದ ಸಮಯಕ್ಕೆ ಮಾತ್ರ—ಎಂದಿಗೂ ವ್ಯಕ್ತಿಯ ಕುರಿತ ಮುನ್ಸೂಚನೆಯಲ್ಲ.")}</p>
            </div> : null}
            <div className="prediction-primary"><span>{tr("Dominant recorded pattern", "ಪ್ರಮುಖ ದಾಖಲಾದ ಮಾದರಿ")}</span><strong>{displayKnownValue(selected.category, language)}</strong><div><span>{tr("Peak recorded window", "ಗರಿಷ್ಠ ದಾಖಲಾದ ಅವಧಿ")}</span><b>{displayKnownValue(selected.peakWindow, language)}</b></div></div>
            <div className="prediction-metrics"><div><span>{tr("Nearby FIRs", "ಹತ್ತಿರದ ಎಫ್‌ಐಆರ್‌ಗಳು")}</span><strong>{selected.nearbyCases}</strong></div><div><span>{tr("7-day trend", "7 ದಿನಗಳ ಪ್ರವೃತ್ತಿ")}</span><strong className={selected.trend > 0 ? "trend-up" : ""}>{selected.trend > 0 ? "↗" : "↘"} {Math.abs(selected.trend)}%</strong></div></div>
            <div className="prediction-drivers"><h3>{tr("How this score was calculated", "ಈ ಅಂಕವನ್ನು ಹೇಗೆ ಲೆಕ್ಕ ಹಾಕಲಾಗಿದೆ")}</h3>{selectedDrivers(selected).map((driver, index) => <div key={driver}><span>{index + 1}</span><p>{driver}</p></div>)}</div>
            <button type="button" onClick={() => setPatrolConfirmOpen(true)} disabled={patrol.status === "sending"} className="mt-4 w-full rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
              {patrol.status === "sending" ? tr("Sending SMS…", "SMS ಕಳುಹಿಸಲಾಗುತ್ತಿದೆ…") : tr("Notify verified patrol officers by SMS", "ದೃಢೀಕೃತ ಗಸ್ತು ಅಧಿಕಾರಿಗಳಿಗೆ SMS ತಿಳಿಸಿ")}
            </button>
            {patrol.message && <p className={`mt-3 rounded-lg border px-3 py-2 text-xs ${patrol.status === "sent" ? "border-sage/30 bg-sage/10 text-sage" : patrol.status === "error" ? "border-rose/30 bg-rose/10 text-rose" : "border-line bg-panel text-muted"}`} role={patrol.status === "error" ? "alert" : "status"}>{patrol.message}</p>}
          </> : <div className="empty-intelligence-panel"><div className="panel-eyebrow">{tr("NO LOCATION SELECTED", "ಯಾವುದೇ ಸ್ಥಳ ಆಯ್ಕೆ ಮಾಡಿಲ್ಲ")}</div><h2>{tr("Waiting for geocoded FIR data", "ಜಿಯೋ-ಕೋಡ್ ಎಫ್‌ಐಆರ್ ದತ್ತಾಂಶಕ್ಕಾಗಿ ಕಾಯಲಾಗುತ್ತಿದೆ")}</h2><p>{tr("Add valid Karnataka latitude and longitude values to the connected FIR register, then refresh this page.", "ಸಂಪರ್ಕಿತ ಎಫ್‌ಐಆರ್ ದಾಖಲೆಗೆ ಮಾನ್ಯ ಕರ್ನಾಟಕ ಅಕ್ಷಾಂಶ ಮತ್ತು ರೇಖಾಂಶ ಮೌಲ್ಯಗಳನ್ನು ಸೇರಿಸಿ, ನಂತರ ಈ ಪುಟವನ್ನು ನವೀಕರಿಸಿ.")}</p></div>}
        </aside>
      </section>

      {activeMode === "forecast" && evaluation ? <section className="forecast-validation-panel validation-validated" aria-live="polite">
        <header>
          <div>
            <span className="validation-eyebrow">{tr("FORECAST SAFETY CHECK", "ಮುನ್ಸೂಚನೆ ಸುರಕ್ಷತಾ ಪರಿಶೀಲನೆ")}</span>
            <h2>{tr("Forecast quality verified on newer FIR periods", "ಹೊಸ ಎಫ್‌ಐಆರ್ ಅವಧಿಗಳಲ್ಲಿ ಮುನ್ಸೂಚನೆ ಗುಣಮಟ್ಟ ಪರಿಶೀಲಿಸಲಾಗಿದೆ")}</h2>
          </div>
          <strong className="validation-status">{tr("✓ Passed · ready to use", "✓ ಉತ್ತೀರ್ಣ · ಬಳಸಲು ಸಿದ್ಧ")}</strong>
        </header>

          <p className="validation-message">{tr(`On later, unseen FIR periods, this model scored ${evaluation.accuracyUplift} point${evaluation.accuracyUplift === 1 ? "" : "s"} above the historical benchmark and produced more reliable probabilities.`, `ನಂತರದ, ಕಾಣದ ಎಫ್‌ಐಆರ್ ಅವಧಿಗಳಲ್ಲಿ ಈ ಮಾದರಿಯು ಐತಿಹಾಸಿಕ ಮಾನದಂಡಕ್ಕಿಂತ ${evaluation.accuracyUplift} ಅಂಕ ಹೆಚ್ಚು ಗಳಿಸಿದೆ ಮತ್ತು ಹೆಚ್ಚು ವಿಶ್ವಾಸಾರ್ಹ ಸಂಭವನೀಯತೆಗಳನ್ನು ನೀಡಿದೆ.`)}</p>
          <div className="validation-metrics">
            <div><span>{tr("Balanced accuracy", "ಸಮತೋಲಿತ ನಿಖರತೆ")}</span><strong>{evaluation.balancedAccuracy}%</strong><small>{tr("Balances detected and missed activity", "ಗುರುತಿಸಿದ ಮತ್ತು ತಪ್ಪಿಸಿದ ಚಟುವಟಿಕೆಯನ್ನು ಸಮತೋಲನಗೊಳಿಸುತ್ತದೆ")}</small></div>
            <div><span>{tr("Historical benchmark", "ಐತಿಹಾಸಿಕ ಮಾನದಂಡ")}</span><strong>{evaluation.baselineBalancedAccuracy}%</strong><small>{tr("Same period and density comparison", "ಅದೇ ಅವಧಿ ಮತ್ತು ಸಾಂದ್ರತೆಯ ಹೋಲಿಕೆ")}</small></div>
            <div><span>{tr("Improvement", "ಸುಧಾರಣೆ")}</span><strong className={evaluation.accuracyUplift > 0 ? "is-positive" : "is-negative"}>{evaluation.accuracyUplift > 0 ? "+" : ""}{evaluation.accuracyUplift} {tr("points", "ಅಂಕಗಳು")}</strong><small>{tr("Model minus baseline", "ಮಾದರಿ ಮೈನಸ್ ಮೂಲಮಟ್ಟ")}</small></div>
            <div><span>{tr("Weekly accuracy range", "ವಾರದ ನಿಖರತೆಯ ವ್ಯಾಪ್ತಿ")}</span><strong>{evaluation.balancedAccuracyLow}%–{evaluation.balancedAccuracyHigh}%</strong><small>{confidenceLabel} {tr("confidence", "ವಿಶ್ವಾಸ")}</small></div>
          </div>
          <details className="validation-details">
            <summary>{tr("See back-test details", "ಹಿಂದಿನ ಪರೀಕ್ಷೆಯ ವಿವರಗಳನ್ನು ನೋಡಿ")}</summary>
            <div>
              <dl>
                <div><dt>{tr("Older area-time samples", "ಹಳೆಯ ಪ್ರದೇಶ-ಸಮಯ ಮಾದರಿಗಳು")}</dt><dd>{evaluation.trainingSamples.toLocaleString(locale)}</dd></div>
                <div><dt>{tr("Newer area-time samples", "ಹೊಸ ಪ್ರದೇಶ-ಸಮಯ ಮಾದರಿಗಳು")}</dt><dd>{evaluation.validationSamples.toLocaleString(locale)}</dd></div>
                <div><dt>{tr("Held-out weekly windows", "ಪ್ರತ್ಯೇಕಿಸಿದ ವಾರದ ಅವಧಿಗಳು")}</dt><dd>{evaluation.backtestWindows}</dd></div>
                <div><dt>{tr("Newer test period", "ಹೊಸ ಪರೀಕ್ಷಾ ಅವಧಿ")}</dt><dd>{validationRange}</dd></div>
                <div><dt>{tr("Precision", "ನಿಖರತೆ (ಪ್ರಿಸಿಷನ್)")}</dt><dd>{evaluation.precision}%</dd></div>
                <div><dt>{tr("Precision lift", "ಪ್ರಿಸಿಷನ್ ಏರಿಕೆ")}</dt><dd>{evaluation.precisionLift}× {tr("vs test event rate", "ಪರೀಕ್ಷಾ ಘಟನೆ ದರಕ್ಕೆ ಹೋಲಿಕೆ")}</dd></div>
                <div><dt>{tr("F1 score", "ಎಫ್‌1 ಅಂಕ")}</dt><dd>{evaluation.f1Score}%</dd></div>
                <div><dt>{tr("Recall", "ರಿಕಾಲ್")}</dt><dd>{evaluation.recall}%</dd></div>
                <div><dt>{tr("Specificity", "ಸ್ಪೆಸಿಫಿಸಿಟಿ")}</dt><dd>{evaluation.specificity}%</dd></div>
                <div><dt>{tr("Operational alert threshold", "ಕಾರ್ಯಾಚರಣೆಯ ಎಚ್ಚರಿಕೆ ಮಿತಿ")}</dt><dd>{evaluation.alertThreshold}%</dd></div>
                <div><dt>{tr("Newer-period event rate", "ಹೊಸ ಅವಧಿಯ ಘಟನೆ ದರ")}</dt><dd>{evaluation.validationEventRate}%</dd></div>
                <div><dt>{tr("Probability error (lower is better)", "ಸಂಭವನೀಯತೆ ದೋಷ (ಕಡಿಮೆ ಉತ್ತಮ)")}</dt><dd>{evaluation.brierScore} · {tr("baseline", "ಮೂಲಮಟ್ಟ")} {evaluation.baselineBrierScore}</dd></div>
              </dl>
              <p>{tr(`These are area × time × forecast-window samples generated from authorized FIR history—not additional FIR records. There is no time leakage: every training outcome ended before testing began. The alert threshold is selected only on older training periods to reduce false alerts while retaining useful recall. The accuracy range resamples the ${evaluation.backtestWindows} held-out weekly periods, keeping related samples together. The map's error band gives incident and no-incident errors equal weight so common quiet periods cannot make uncertainty look artificially small.`, `ಇವು ಅಧಿಕೃತ ಎಫ್‌ಐಆರ್ ಇತಿಹಾಸದಿಂದ ರಚಿಸಲಾದ ಪ್ರದೇಶ × ಸಮಯ × ಮುನ್ಸೂಚನೆ-ಅವಧಿಯ ಮಾದರಿಗಳು—ಹೆಚ್ಚುವರಿ ಎಫ್‌ಐಆರ್ ದಾಖಲೆಗಳಲ್ಲ. ಸಮಯ ಸೋರಿಕೆ ಇಲ್ಲ: ಪರೀಕ್ಷೆ ಆರಂಭವಾಗುವ ಮೊದಲು ಪ್ರತಿಯೊಂದು ತರಬೇತಿ ಫಲಿತಾಂಶವೂ ಅಂತ್ಯಗೊಂಡಿದೆ. ತಪ್ಪು ಎಚ್ಚರಿಕೆಗಳನ್ನು ಕಡಿಮೆ ಮಾಡಿ ಉಪಯುಕ್ತ ರಿಕಾಲ್ ಉಳಿಸಲು ಎಚ್ಚರಿಕೆ ಮಿತಿಯನ್ನು ಹಳೆಯ ತರಬೇತಿ ಅವಧಿಗಳಲ್ಲಿ ಮಾತ್ರ ಆಯ್ಕೆ ಮಾಡಲಾಗಿದೆ. ನಿಖರತೆಯ ವ್ಯಾಪ್ತಿಯು ಸಂಬಂಧಿತ ಮಾದರಿಗಳನ್ನು ಒಟ್ಟಿಗೆ ಇಟ್ಟು ${evaluation.backtestWindows} ಪ್ರತ್ಯೇಕಿಸಿದ ವಾರದ ಅವಧಿಗಳನ್ನು ಮರುಮಾದರಿಗೊಳಿಸುತ್ತದೆ. ಸಾಮಾನ್ಯ ಶಾಂತ ಅವಧಿಗಳು ಅನಿಶ್ಚಿತತೆಯನ್ನು ಕೃತಕವಾಗಿ ಕಡಿಮೆ ತೋರಿಸದಂತೆ ನಕ್ಷೆಯ ದೋಷದ ವ್ಯಾಪ್ತಿಯು ಘಟನೆ ಮತ್ತು ಘಟನೆ-ಇಲ್ಲದ ದೋಷಗಳಿಗೆ ಸಮಾನ ತೂಕ ನೀಡುತ್ತದೆ.`)}</p>
            </div>
          </details>
      </section> : null}

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
        <div><span>{tr("High-score areas", "ಹೆಚ್ಚಿನ ಅಂಕದ ಪ್ರದೇಶಗಳು")}</span><strong>{highRiskCount}</strong><small>{tr("aggregated patrol areas requiring attention", "ಗಮನ ಅಗತ್ಯವಿರುವ ಒಟ್ಟುಗೂಡಿಸಿದ ಗಸ್ತು ಪ್ರದೇಶಗಳು")}</small></div>
        <div><span>{tr("Average score", "ಸರಾಸರಿ ಅಂಕ")}</span><strong>{averageRisk}%</strong><small>{activeMode === "forecast" ? tr(`${horizonDays}-day neural forecast`, `${horizonDays} ದಿನಗಳ ನ್ಯೂರಲ್ ಮುನ್ಸೂಚನೆ`) : tr("recorded relative density", "ದಾಖಲಾದ ಸಂಬಂಧಿತ ಸಾಂದ್ರತೆ")}</small></div>
        <div><span>{tr("FIR rows analysed", "ವಿಶ್ಲೇಷಿಸಿದ ಎಫ್‌ಐಆರ್ ಸಾಲುಗಳು")}</span><strong>{records.length.toLocaleString(locale)}</strong><small>{tr(`${dataset.geocodedRecords.toLocaleString(locale)} valid Karnataka coordinates · ${dataset.totalHotspotAreas.toLocaleString(locale)} aggregated areas`, `${dataset.geocodedRecords.toLocaleString(locale)} ಮಾನ್ಯ ಕರ್ನಾಟಕ ನಿರ್ದೇಶಾಂಕಗಳು · ${dataset.totalHotspotAreas.toLocaleString(locale)} ಒಟ್ಟುಗೂಡಿಸಿದ ಪ್ರದೇಶಗಳು`)}</small></div>
        <div><span>{activeMode === "forecast" && evaluation ? tr("Newer-period back-test", "ಹೊಸ ಅವಧಿಯ ಹಿಂದಿನ ಪರೀಕ್ಷೆ") : tr("Latest FIR date", "ಇತ್ತೀಚಿನ ಎಫ್‌ಐಆರ್ ದಿನಾಂಕ")}</span><strong className={activeMode === "forecast" ? "model-ready" : ""}>{activeMode === "forecast" && evaluation ? `${evaluation.balancedAccuracy}%` : latestDate}</strong><small>{activeMode === "forecast" && evaluation ? tr(`${evaluation.accuracyUplift > 0 ? "+" : ""}${evaluation.accuracyUplift} points vs historical baseline · ${evaluation.backtestWindows} weekly windows`, `ಐತಿಹಾಸಿಕ ಮೂಲಮಟ್ಟಕ್ಕಿಂತ ${evaluation.accuracyUplift > 0 ? "+" : ""}${evaluation.accuracyUplift} ಅಂಕಗಳು · ${evaluation.backtestWindows} ವಾರದ ಅವಧಿಗಳು`) : tr(`Case register synced at ${lastSyncLabel}`, `ಪ್ರಕರಣ ದಾಖಲೆ ${lastSyncLabel}ಕ್ಕೆ ಸಿಂಕ್ ಆಗಿದೆ`)}</small></div>
      </section>
      <p className="intelligence-disclaimer">{tr("Area-and-time forecasts use only authorized, dated and geocoded FIR history. They do not predict individual behaviour, do not identify a person, and never replace officer judgment.", "ಪ್ರದೇಶ ಮತ್ತು ಸಮಯದ ಮುನ್ಸೂಚನೆಗಳು ಅಧಿಕೃತ, ದಿನಾಂಕ ಮತ್ತು ಜಿಯೋ-ಕೋಡ್ ಮಾಡಿದ ಎಫ್‌ಐಆರ್ ಇತಿಹಾಸವನ್ನು ಮಾತ್ರ ಬಳಸುತ್ತವೆ. ಅವು ವ್ಯಕ್ತಿಯ ನಡವಳಿಕೆಯನ್ನು ಊಹಿಸುವುದಿಲ್ಲ, ವ್ಯಕ್ತಿಯನ್ನು ಗುರುತಿಸುವುದಿಲ್ಲ ಮತ್ತು ಅಧಿಕಾರಿಯ ನಿರ್ಣಯವನ್ನು ಎಂದಿಗೂ ಬದಲಿಸುವುದಿಲ್ಲ.")}</p>
    </div>
  );
};

export default CrimeIntelligence;
