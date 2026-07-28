"use client";

import { FaHistory } from "react-icons/fa";

function RevisionHistoryPanel({ history, currentVersion }) {
  return (
    <section className="bg-white dark:bg-surface-strong border border-gray-200 dark:border-border-strong rounded-2xl p-5 sm:p-6 shadow-sm">
      <div className="flex items-center gap-2 mb-4">
        <FaHistory className="text-blue-600" aria-hidden="true" />
        <h2 className="text-base sm:text-lg font-semibold text-gray-900 dark:text-foreground">Revision History</h2>
      </div>
      {history.length === 0 ? (
        <div className="text-sm text-gray-500 dark:text-muted-foreground py-3">
          No past edits recorded. This is the initial version (v1).
        </div>
      ) : (
        <div className="relative border-l border-gray-200 dark:border-border-strong pl-4 ml-2 space-y-6">
          <div className="relative">
            <span className="absolute -left-[22px] top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-blue-600 ring-4 ring-white dark:ring-surface-strong" />
            <div className="flex flex-col gap-1 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-bold text-blue-700 dark:text-blue-300 text-xs uppercase px-2 py-0.5 rounded bg-blue-50 dark:bg-blue-900/30 border border-blue-100 dark:border-blue-800">
                  v{currentVersion || 1} (Current)
                </span>
              </div>
            </div>
          </div>

          {history.map((entry, index) => {
            const revVersion = entry.version || history.length - index;
            return (
              <div key={entry._id || index} className="relative">
                <span className="absolute -left-[22px] top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-gray-300 ring-4 ring-white dark:ring-surface-strong" />
                <div className="flex flex-col gap-1 text-sm text-gray-600 dark:text-muted-foreground">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-bold text-gray-800 dark:text-foreground text-xs uppercase px-2 py-0.5 rounded bg-gray-100 dark:bg-surface-muted border border-gray-200 dark:border-border-strong">
                      v{revVersion}
                    </span>
                    <span className="text-xs text-gray-400 dark:text-muted-foreground">
                      {entry.updatedAt
                        ? new Date(entry.updatedAt).toLocaleDateString()
                        : "Unknown Date"}
                    </span>
                  </div>
                  {entry.changeReason && (
                    <p className="mt-1 text-gray-700 dark:text-foreground/80 bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-slate-700 rounded-lg p-2.5 italic text-xs leading-relaxed max-w-2xl">
                      &ldquo;{entry.changeReason}&rdquo;
                    </p>
                  )}
                  {entry.changes && Object.keys(entry.changes).length > 0 && (
                    <div className="mt-1 text-xs text-gray-400 dark:text-muted-foreground">
                      Modified: {Object.keys(entry.changes).join(", ")}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export default RevisionHistoryPanel;
