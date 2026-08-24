import React from "react";
import { useAuth } from "../context/AuthContext";

type Props = {
  title: string;
  description?: string;
};

const Stub: React.FC<Props> = ({ title, description }) => {
  const { user } = useAuth();
  return (
    <div className="space-y-5">
      <div className="relative text-center">
        <div>
          <h1 className="text-white font-schibsted text-2xl font-semibold">
            {title}
          </h1>
          {description && (
            <p className="text-muted text-sm mt-1">{description}</p>
          )}
        </div>
        <div className="mt-2 text-xs text-muted">
          Signed in as{" "}
          <span className="text-white">
            {user?.name} ({user?.employeeId})
          </span>
        </div>
      </div>

      <div className="bg-shell border border-line rounded-xl p-6 text-muted text-sm">
        Preview space - content for this screen lives in its page component.
      </div>
    </div>
  );
};

export default Stub;
