"use client";

/**
 * Renders a sandboxed preview descriptor (#638) as plain text and badges.
 *
 * The descriptor is safe by construction — the sandbox builds it field by field
 * and `previewValidation.js` re-checks every string before storage — but this
 * component still renders values as text only: no anchors, no
 * `dangerouslySetInnerHTML`, no `src`/`href` from descriptor data. Entry names
 * and flags are shown, never linked or fetched.
 */

const FLAG_LABEL = {
  encrypted: "Encrypted",
  macro: "Contains macros",
  "executable-entry": "Contains an executable",
  "nested-archive": "Contains a nested archive",
  "path-traversal": "Unsafe path in archive",
  "symlink-entry": "Contains a symlink",
  "zip-bomb": "Decompression-bomb risk",
  "overlapping-entries": "Overlapping archive entries",
  zip64: "ZIP64 archive",
  "too-many-entries": "Very large number of entries",
  "truncated-central-directory": "Truncated archive index",
  "embedded-pdf": "Embedded PDF payload",
  "embedded-archive": "Embedded archive payload",
  "embedded-script": "Embedded script",
  "embedded-pe": "Embedded Windows executable",
  polyglot: "Polyglot file",
  "parse-error": "Could not be parsed",
  oversized: "Exceeds size limits",
};

function Badge({ children, tone = "neutral" }) {
  const tones = {
    neutral: "bg-gray-100 text-gray-700 dark:bg-surface-muted dark:text-foreground/80",
    warn: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
    danger: "bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-300",
  };
  return (
    <span className={`inline-block rounded-full px-2.5 py-1 text-xs font-medium ${tones[tone] || tones.neutral}`}>
      {children}
    </span>
  );
}

const DANGER_FLAGS = new Set(["polyglot", "embedded-pe", "embedded-script", "zip-bomb", "path-traversal", "symlink-entry"]);

export default function PreviewDescriptor({ descriptor }) {
  if (!descriptor || typeof descriptor !== "object") return null;

  const flags = Array.isArray(descriptor.flags) ? descriptor.flags : [];
  const entries = Array.isArray(descriptor.entries) ? descriptor.entries : [];

  return (
    <section
      className="rounded-2xl border border-gray-200 dark:border-border-strong bg-white dark:bg-surface-strong p-5 sm:p-6"
      aria-label="File preview"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-foreground">Preview</h3>
        <Badge>{String(descriptor.kind || "unknown")}</Badge>
        {descriptor.sniffedType ? <Badge>{String(descriptor.sniffedType)}</Badge> : null}
        {descriptor.polyglot ? <Badge tone="danger">Polyglot file</Badge> : null}
      </div>

      {descriptor.kind === "archive" ? (
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm text-gray-700 dark:text-foreground/80">
          <dt className="text-gray-500 dark:text-muted-foreground">Entries</dt>
          <dd>{Number(descriptor.entryCount || 0)}</dd>
          <dt className="text-gray-500 dark:text-muted-foreground">Declared uncompressed</dt>
          <dd>{formatBytes(descriptor.totalDeclaredUncompressedBytes)}</dd>
          <dt className="text-gray-500 dark:text-muted-foreground">Max compression ratio</dt>
          <dd>{Number(descriptor.maxCompressionRatio || 0).toFixed(1)}:1</dd>
        </dl>
      ) : null}

      {descriptor.kind === "document" && descriptor.pdfVersion ? (
        <p className="mt-3 text-sm text-gray-700 dark:text-foreground/80">PDF {String(descriptor.pdfVersion)}</p>
      ) : null}

      {descriptor.kind === "text" && descriptor.textHead ? (
        <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-gray-50 dark:bg-surface-muted p-3 text-xs text-gray-700 dark:text-foreground/80">
          {String(descriptor.textHead)}
          {descriptor.truncated ? "\n…" : ""}
        </pre>
      ) : null}

      {flags.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {flags.map((f) => (
            <Badge key={f} tone={DANGER_FLAGS.has(f) ? "danger" : "warn"}>
              {FLAG_LABEL[f] || String(f)}
            </Badge>
          ))}
        </div>
      ) : null}

      {entries.length > 0 ? (
        <ul className="mt-3 space-y-1 text-xs text-gray-600 dark:text-foreground/70">
          {entries.slice(0, 20).map((e, i) => (
            <li key={i} className="flex justify-between gap-3">
              <span className="truncate">{String(e.name || "")}</span>
              <span className="shrink-0 tabular-nums">{formatBytes(e.size)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function formatBytes(n) {
  const b = Number(n);
  if (!Number.isFinite(b) || b < 0) return "—";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
