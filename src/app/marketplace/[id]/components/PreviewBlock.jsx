"use client";

function PreviewBlock({ title, emptyLabel, items, icon: Icon }) {
  const hasItems = Array.isArray(items) && items.length > 0;

  return (
    <section className="bg-white dark:bg-surface-strong border border-gray-200 dark:border-border-strong rounded-2xl p-5 shadow-sm sm:p-6 h-full">
      <div className="flex items-center gap-2 mb-3">
        {Icon ? <Icon className="text-blue-600" aria-hidden="true" /> : null}
        <h2 className="text-base sm:text-lg font-semibold text-gray-900 dark:text-foreground">{title}</h2>
      </div>
      {hasItems ? (
        <ul role="list" className="space-y-2 sm:space-y-3">
          {items.map((item) => (
            <li
              key={item}
              role="listitem"
              className="rounded-xl border border-gray-100 dark:border-border-subtle bg-gray-50 dark:bg-surface-muted px-3 py-2.5 sm:px-4 sm:py-3 text-sm text-gray-700 dark:text-foreground/80"
            >
              {item}
            </li>
          ))}
        </ul>
      ) : (
        <div className="rounded-xl border border-dashed border-gray-200 dark:border-border-strong bg-gray-50 dark:bg-surface-muted px-4 py-5 text-sm text-gray-500 dark:text-muted-foreground">
          {emptyLabel}
        </div>
      )}
    </section>
  );
}

export default PreviewBlock;
