import React, { useCallback, useEffect, useRef, useState } from "react";
import { caseKey } from "../lib/cases";
import type { CaseRecord } from "../lib/cases";

/** Build the token used in the public URL — just base64 of the CaseMasterID */
export function buildPassToken(record: CaseRecord): string {
  const id = caseKey(record);
  return btoa(id);
}

export function buildPassUrl(record: CaseRecord): string {
  const token = buildPassToken(record);
  return `${window.location.origin}/case-pass/${encodeURIComponent(token)}`;
}

type Props = {
  record: CaseRecord;
  onClose: () => void;
};

const CasePassQR: React.FC<Props> = ({ record, onClose }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [copied, setCopied] = useState(false);
  const [qrReady, setQrReady] = useState(false);
  const [qrError, setQrError] = useState("");
  const url = buildPassUrl(record);

  /* Draw QR on canvas as soon as the component mounts */
  useEffect(() => {
    let cancelled = false;
    import("qrcode").then((QRCode) => {
      if (cancelled || !canvasRef.current) return;
      QRCode.toCanvas(canvasRef.current, url, {
        width: 220,
        margin: 2,
        color: { dark: "#0e0f11", light: "#f9fafb" },
      })
        .then(() => { if (!cancelled) setQrReady(true); })
        .catch((err: unknown) => { if (!cancelled) setQrError(String(err)); });
    });
    return () => { cancelled = true; };
  }, [url]);

  /** Copy the QR as a PNG image to the clipboard */
  const copyQR = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("Canvas to blob failed");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      /* Fallback: copy link text */
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }
  }, [url]);

  /** Copy just the link */
  const copyLink = useCallback(async () => {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }, [url]);

  const id = caseKey(record);
  const label = record.CrimeNo || (record.CaseNo ? `CR-${record.CaseNo}` : `Case ${id}`);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 px-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-sm rounded-2xl border border-[#ffffff]/10 bg-[#17181c] shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#ffffff]/10">
          <div>
            <div className="text-[#ffffff] font-semibold text-sm">Citizen Case Pass</div>
            <div className="text-[#6b7280] text-xs">{label}</div>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-full bg-[#ffffff]/10 hover:bg-[#ffffff]/20 text-[#9ca3af] text-sm flex items-center justify-center transition-colors"
          >
            ✕
          </button>
        </div>

        {/* QR area */}
        <div className="flex flex-col items-center py-6 px-5 gap-4">
          <div className="rounded-xl bg-[#f9fafb] p-3 shadow-inner">
            <canvas ref={canvasRef} width={220} height={220} />
            {!qrReady && !qrError && (
              <div className="w-[220px] h-[220px] flex items-center justify-center text-sm text-[#6b7280]">
                Generating QR…
              </div>
            )}
            {qrError && (
              <div className="w-[220px] h-[220px] flex items-center justify-center text-xs text-rose-500 text-center p-4">
                Could not generate QR: {qrError}
              </div>
            )}
          </div>

          <p className="text-[#6b7280] text-xs text-center leading-relaxed">
            Share this QR with the complainant. They can scan it to check case status — no login needed.
          </p>

          {/* Action buttons */}
          <div className="w-full flex gap-2">
            <button
              id="case-pass-copy-qr"
              onClick={copyQR}
              disabled={!qrReady}
              className="flex-1 h-9 rounded-lg bg-[#1a4fcf] text-[#ffffff] text-xs font-semibold hover:bg-[#1a4fcf]/90 disabled:opacity-40 transition-all"
            >
              {copied ? "✓ Copied!" : "📋 Copy QR"}
            </button>
            <button
              id="case-pass-copy-link"
              onClick={copyLink}
              className="flex-1 h-9 rounded-lg border border-[#ffffff]/15 text-[#9ca3af] text-xs font-medium hover:bg-[#ffffff]/5 transition-all"
            >
              🔗 Copy Link
            </button>
          </div>

          {/* URL display */}
          <div className="w-full bg-[#ffffff]/5 rounded-lg px-3 py-2 text-[10px] text-[#4b5563] font-mono break-all">
            {url}
          </div>
        </div>
      </div>
    </div>
  );
};

export default CasePassQR;
