/**
 * Cron worker for daily platform statistics alerts to Discord.
 *
 * Compiles sales stats and dispatches them via Discord webhook.
 * Usage:
 *   node scripts/discord-stats-alert.mjs
 *
 * Environment variables:
 *   DISCORD_WEBHOOK_URL — required; Discord webhook endpoint URL
 *   MONGODB_URI         — required; MongoDB connection string
 *   MONGODB_DB          — optional; database name (default: "eduvault")
 */

import { getDb } from '../src/lib/mongodb.js';
import { sendDiscordWebhook, createStatsEmbed } from '../src/lib/webhooks/discord.js';
import { getDailyStats } from '../src/lib/webhooks/sender.js';
import { logger } from '../src/lib/logger.js';

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

if (!DISCORD_WEBHOOK_URL) {
  logger.error('DISCORD_WEBHOOK_URL is not set. Aborting.');
  process.exit(1);
}

async function run() {
  logger.info('Starting daily stats collection...');

  const db = await getDb();

  const stats = await getDailyStats(db);
  logger.info({ stats }, 'Collected daily stats');

  const payload = createStatsEmbed(stats);
  const success = await sendDiscordWebhook(DISCORD_WEBHOOK_URL, payload);

  if (success) {
    logger.info('Discord stats alert sent successfully');
  } else {
    logger.error('Failed to send Discord stats alert');
    process.exit(1);
  }
}

run().catch((err) => {
  logger.error({ err }, 'Fatal error in discord-stats-alert');
  process.exit(1);
});
