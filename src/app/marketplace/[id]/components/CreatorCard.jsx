"use client";

function CreatorCard({ author, creator, createdAt }) {
  const authorName = author?.name || creator || "Anonymous creator";
  const institution = author?.institution || "Independent educator";
  const level = author?.level || "All learners";
  const badgeText = author?.verified ? "Verified creator" : "Creator profile unverified";
  const badgeTone = author?.verified
    ? "text-emerald-700 bg-emerald-50 border border-emerald-200 dark:text-emerald-300 dark:bg-emerald-900/30 dark:border-emerald-800"
    : "text-amber-700 bg-amber-50 border border-amber-200 dark:text-amber-300 dark:bg-amber-900/30 dark:border-amber-800";

  return (
    <div className="bg-white dark:bg-surface-strong border border-gray-200 dark:border-border-strong rounded-3xl p-5 sm:p-6 shadow-sm h-full">
      <h2 className="text-base sm:text-lg font-semibold text-gray-900 dark:text-foreground mb-4">Creator</h2>
      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
        <div
          className="h-14 w-14 sm:h-16 sm:w-16 rounded-2xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 grid place-items-center text-xl font-semibold shrink-0"
          aria-hidden="true"
        >
          {authorName.charAt(0).toUpperCase()}
        </div>
        <div className="space-y-1 text-sm text-gray-600 dark:text-muted-foreground min-w-0">
          <p className="text-base font-semibold text-gray-900 dark:text-foreground break-words">{authorName}</p>
          <p className="break-words">{institution}</p>
          <p className="break-words">{level}</p>
          <p
            className={`mt-2 inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.2em] font-semibold px-2.5 py-1 rounded-full ${badgeTone}`}
          >
            {badgeText}
          </p>
        </div>
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl bg-slate-50 dark:bg-slate-800/50 px-4 py-3 text-sm text-slate-700 dark:text-slate-300">
          <strong className="block text-[10px] uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
            Uploaded
          </strong>
          <span className="mt-1 block">
            {createdAt ? new Date(createdAt).toLocaleDateString() : "Unknown date"}
          </span>
        </div>
        <div className="rounded-2xl bg-slate-50 dark:bg-slate-800/50 px-4 py-3 text-sm text-slate-700 dark:text-slate-300">
          <strong className="block text-[10px] uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
            Author type
          </strong>
          <span className="mt-1 block">{author?.department || "General"}</span>
        </div>
      </div>
    </div>
  );
}

export default CreatorCard;
