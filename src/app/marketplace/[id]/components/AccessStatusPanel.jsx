"use client";

import { getAccessCopy } from "./utils";

function AccessStatusPanel({ status, isLoading }) {
  const copy = getAccessCopy(status, isLoading);
  const Icon = copy.icon;

  return (
    <div className={`rounded-2xl border px-4 py-3 text-sm ${copy.className}`}>
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 shrink-0" aria-hidden="true" />
        <div className="min-w-0">
          <p className="font-semibold">{copy.label}</p>
          <p className="mt-1 leading-5 break-words">{copy.message}</p>
        </div>
      </div>
    </div>
  );
}

export default AccessStatusPanel;
