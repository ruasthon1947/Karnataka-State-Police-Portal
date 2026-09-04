import React from "react";
import logoUrl from "../../KSPP_LOGO.jpeg";

export const KSPP_NAME = "Karnataka State Police Portal";
export const KSPP_SHORT_NAME = "KSPP";
export const KSPP_TAGLINE = "Secure Policing • Trusted Governance";
export const KSPP_TAGLINE_KANNADA = "ಸುರಕ್ಷಿತ ಪೊಲೀಸ್ ಸೇವೆ • ವಿಶ್ವಾಸಾರ್ಹ ಆಡಳಿತ";
export const KSPP_KANNADA_NAME = "ಕರ್ನಾಟಕ ರಾಜ್ಯ ಪೊಲೀಸ್ ಪೋರ್ಟಲ್";
export const KARNATAKA_GOVERNMENT = "Government of Karnataka";
export const KARNATAKA_GOVERNMENT_KANNADA = "ಕರ್ನಾಟಕ ಸರ್ಕಾರ";

type BrandMarkProps = {
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
  decorative?: boolean;
};

const sizeClasses = {
  sm: "h-9 w-9",
  md: "h-11 w-11",
  lg: "h-16 w-16",
  xl: "h-24 w-24",
};

export const KSPPBrandMark: React.FC<BrandMarkProps> = ({
  size = "md",
  className = "",
  decorative = false,
}) => (
  <span
    className={`kspp-brand-mark ${sizeClasses[size]} ${className}`}
    aria-hidden={decorative || undefined}
  >
    <img
      src={logoUrl}
      alt={decorative ? "" : "Karnataka State Police Portal emblem"}
      className="h-full w-full rounded-full object-cover"
    />
  </span>
);

type WordmarkProps = {
  compact?: boolean;
  className?: string;
};

export const KSPPWordmark: React.FC<WordmarkProps> = ({
  compact = false,
  className = "",
}) => (
  <div className={className}>
    <div className="flex items-baseline gap-2">
      <span className="font-semibold tracking-tight text-current">
        {compact ? KSPP_SHORT_NAME : KSPP_NAME}
      </span>
      {!compact && (
        <span className="rounded border border-current/20 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.16em] opacity-70">
          KSPP
        </span>
      )}
    </div>
    <div className="mt-0.5 text-[10px] font-medium tracking-wide text-muted">
      {KSPP_TAGLINE}
    </div>
  </div>
);
