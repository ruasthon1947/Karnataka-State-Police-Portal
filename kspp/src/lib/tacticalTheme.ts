// src/lib/tacticalTheme.ts

/**
 * Tactical Design Tokens for KSPP Dashboard
 * 
 * Base Palette:
 * - Backgrounds: Dark Navy/Charcoal (Tailwind slate-900 / zinc-900 hybrid)
 * - Accents (Reserved for status):
 *   - Critical: Rose/Red
 *   - Urgent: Amber
 *   - Action: Brand Blue
 *   - Success: Sage/Green
 */

export const tacticalTheme = {
  colors: {
    // Backgrounds
    bg: "bg-slate-950",
    panel: "bg-slate-900",
    card: "bg-slate-800/60",
    
    // Borders/Lines
    border: "border-slate-700/50",
    
    // Typography
    textPrimary: "text-slate-100",
    textSecondary: "text-slate-400",
    textMuted: "text-slate-500",
    
    // Status Accents (Glow/Pulse)
    critical: "text-rose-500",
    urgent: "text-amber-500",
    action: "text-sky-400",
    success: "text-emerald-500",
  },
  
  shadows: {
    soft: "shadow-[0_4px_20px_rgba(0,0,0,0.3)]",
    glow: "shadow-[0_0_15px_rgba(14,165,233,0.15)]", // Sky/Brand glow
    criticalGlow: "shadow-[0_0_15px_rgba(244,63,94,0.2)]", // Rose glow
  },
  
  gradients: {
    cardAccent: "bg-gradient-to-r from-sky-500 via-sky-400 to-transparent",
    criticalAccent: "bg-gradient-to-r from-rose-500 via-rose-400 to-transparent",
    urgentAccent: "bg-gradient-to-r from-amber-500 via-amber-400 to-transparent",
  },
  
  // Custom utility classes to be applied in Tailwind
  classes: {
    card: "bg-slate-900/80 backdrop-blur-md border border-slate-700/50 rounded-lg shadow-sm hover:border-slate-600 transition-all duration-300",
    statTile: "relative overflow-hidden bg-slate-900/60 border border-slate-800 rounded-lg p-5 flex flex-col gap-2",
  }
};