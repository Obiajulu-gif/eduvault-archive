"use client";

import { FaTwitter, FaGithub, FaGlobe, FaDiscord, FaTelegram } from "react-icons/fa";

const SOCIAL_CONFIG = [
  { key: "twitterUrl", icon: FaTwitter, label: "Twitter", pattern: /^https?:\/\/(www\.)?(twitter\.com|x\.com)\/.+/ },
  { key: "githubUrl", icon: FaGithub, label: "GitHub", pattern: /^https?:\/\/(www\.)?github\.com\/.+/ },
  { key: "websiteUrl", icon: FaGlobe, label: "Website", pattern: /^https?:\/\/.+/ },
  { key: "discordUrl", icon: FaDiscord, label: "Discord", pattern: /^https?:\/\/(www\.)?(discord\.gg|discord\.com)\/.+/ },
  { key: "telegramUrl", icon: FaTelegram, label: "Telegram", pattern: /^https?:\/\/(t\.me|telegram\.me)\/.+/ },
];

export function isValidSocialUrl(url, pattern) {
  if (!url || !url.trim()) return false;
  return pattern.test(url.trim());
}

export default function SocialLinks({ profile, className = "" }) {
  const links = SOCIAL_CONFIG.filter(({ key, pattern }) =>
    isValidSocialUrl(profile?.[key], pattern)
  );

  if (links.length === 0) return null;

  return (
    <div className={`flex items-center gap-3 ${className}`}>
      {links.map(({ key, icon: Icon, label }) => (
        <a
          key={key}
          href={profile[key]}
          target="_blank"
          rel="noopener noreferrer"
          title={label}
          className="text-gray-500 hover:text-stellar-blue transition-colors"
        >
          <Icon size={18} />
        </a>
      ))}
    </div>
  );
}

export { SOCIAL_CONFIG };
