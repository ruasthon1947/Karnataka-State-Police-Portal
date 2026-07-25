import React from "react";
import { useNavigate } from "react-router-dom";
import { KSPPBrandMark, KSPP_SHORT_NAME } from "../brand/KSPPBrand";

/**
 * Modal that fires after a successful first-time login.
 * It is rendered by RequireAuth when user.isFirstLogin === true,
 * BUT only once — the modal's primary action routes to /change-password
 * which clears the first-login flag upon successful submit.
 */
export const FirstLoginModal: React.FC<{ employeeId: string }> = ({ employeeId }) => {
  const navigate = useNavigate();
  return (
    <div className="modal-backdrop fixed inset-0 z-50 grid place-items-center overflow-y-auto px-3 py-5 sm:px-4" role="dialog" aria-modal="true" aria-labelledby="first-login-title">
      <div className="w-full max-w-md rounded-2xl border border-line bg-shell p-4 shadow-soft sm:p-6">
        <div className="flex items-start gap-3">
          <KSPPBrandMark size="md" decorative />
          <div className="flex-1">
            <h2 id="first-login-title" className="text-white font-schibsted text-lg font-semibold">
              {KSPP_SHORT_NAME} first-time login
            </h2>
            <p className="text-muted text-sm mt-1">
              Welcome, <span className="text-white">{employeeId}</span>. For your
              account security, please change your password immediately before
              continuing.
            </p>
          </div>
        </div>

        <ul className="mt-5 space-y-1.5 text-xs text-muted">
          <li className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-brand" />
            Your new password must be at least 8 characters.
          </li>
          <li className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-brand" />
            Use a mix of letters, numbers, and (optionally) a symbol.
          </li>
          <li className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-brand" />
            Don't reuse a password you've used before on this system.
          </li>
        </ul>

        <div className="mt-6 flex gap-2">
          <button
            onClick={() => navigate("/change-password", { replace: true })}
            className="flex-1 bg-brand hover:bg-brand/90 text-white rounded-lg py-2.5 font-medium shadow-glow"
          >
            Change password now
          </button>
        </div>
      </div>
    </div>
  );
};
