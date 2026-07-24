"use client";

const AVATAR_COLORS = [
  "bg-blue-600",
  "bg-emerald-600",
  "bg-violet-600",
  "bg-amber-600",
  "bg-rose-600",
  "bg-cyan-600",
  "bg-indigo-600",
  "bg-pink-600",
  "bg-teal-600",
  "bg-orange-600",
];

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function getInitials(displayName) {
  if (!displayName) return "?";
  const parts = displayName.trim().split(/\s+/);
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function getColorClass(displayName) {
  const name = displayName || "default";
  const index = hashString(name) % AVATAR_COLORS.length;
  return AVATAR_COLORS[index];
}

function getGravatarUrl(email) {
  if (!email) return null;
  let hash = 0;
  for (let i = 0; i < email.trim().toLowerCase().length; i++) {
    hash = (hash * 32 + email.trim().toLowerCase().charCodeAt(i)) | 0;
  }
  return `https://www.gravatar.com/avatar/${Math.abs(hash).toString(16)}?d=404`;
}

const SIZE_CLASSES = {
  xs: "w-6 h-6 text-[9px]",
  sm: "w-8 h-8 text-[10px]",
  md: "w-10 h-10 text-xs",
  lg: "w-14 h-14 text-base",
  xl: "w-20 h-20 text-xl",
};

export default function UserAvatar({
  displayName,
  avatarCid,
  email,
  size = "md",
  className = "",
}) {
  const sizeClass = SIZE_CLASSES[size] || SIZE_CLASSES.md;
  const initials = getInitials(displayName);
  const colorClass = getColorClass(displayName);

  const gravatarUrl = getGravatarUrl(email);

  if (avatarCid) {
    const src = avatarCid.startsWith("http")
      ? avatarCid
      : `https://ipfs.io/ipfs/${avatarCid}`;
    return (
      <div
        className={`${sizeClass} rounded-full overflow-hidden flex-shrink-0 ${className}`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={displayName || "User avatar"}
          className="w-full h-full object-cover"
          onError={(e) => {
            e.target.style.display = "none";
            e.target.nextSibling.style.display = "flex";
          }}
        />
        <div
          className={`${sizeClass} rounded-full ${colorClass} text-white font-bold items-center justify-center`}
          style={{ display: "none" }}
        >
          {initials}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`${sizeClass} rounded-full ${colorClass} text-white font-bold items-center justify-center flex-shrink-0 ${className}`}
      title={displayName || "User"}
    >
      {initials}
    </div>
  );
}
