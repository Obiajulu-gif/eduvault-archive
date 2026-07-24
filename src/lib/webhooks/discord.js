import { logger } from '@/lib/logger';
import { dispatchWebhook } from '@/lib/webhooks/dispatcher';

export function createStatsEmbed(stats) {
  return {
    embeds: [
      {
        title: 'EduVault Daily Stats',
        color: 0x00bfff,
        timestamp: new Date().toISOString(),
        fields: [
          {
            name: 'Sales Volume (24h)',
            value: `$${stats.volume?.toFixed(2) ?? 0}`,
            inline: true,
          },
          {
            name: 'Total Sales',
            value: String(stats.totalSales ?? 0),
            inline: true,
          },
          {
            name: 'New Signups',
            value: String(stats.signups ?? 0),
            inline: true,
          },
          {
            name: 'Active Materials',
            value: String(stats.activeMaterials ?? 0),
            inline: true,
          },
        ],
        footer: {
          text: 'EduVault Platform Statistics',
        },
      },
    ],
  };
}

export async function sendDiscordWebhook(url, payload, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await dispatchWebhook(url, JSON.stringify(payload), null);

      if (response.status >= 200 && response.status < 300) {
        logger.info('Discord webhook sent successfully');
        return true;
      }

      logger.warn(`Discord webhook failed (Attempt ${attempt}/${retries}): ${response.status}`);
    } catch (error) {
      logger.error(`Discord webhook error (Attempt ${attempt}/${retries}): ${error.message}`);
    }

    if (attempt < retries) {
      const delay = Math.pow(2, attempt - 1) * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  logger.error(`Discord webhook failed permanently after ${retries} attempts`);
  return false;
}
