import { logger } from '@/lib/logger';
import { validateWebhookDestination, safeFetch, SsrfError } from './ssrfGuard';

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
  try {
    await validateWebhookDestination(url, { requireHttps: true });
  } catch (error) {
    if (error instanceof SsrfError) {
      logger.error(`Discord webhook destination rejected by SSRF policy (${error.code})`);
      return false;
    }
    throw error;
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await safeFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        logger.info('Discord webhook sent successfully');
        return true;
      }

      logger.warn(`Discord webhook failed (Attempt ${attempt}/${retries}): ${response.status} ${response.statusText}`);
    } catch (error) {
      if (error instanceof SsrfError) {
        logger.error(`Discord webhook blocked by SSRF policy (${error.code})`);
        return false;
      }
      logger.error(`Discord webhook error (Attempt ${attempt}/${retries}): ${error.message}`);
    }

    if (attempt < retries) {
      const delay = Math.pow(2, attempt - 1) * 1000;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  logger.error(`Discord webhook failed permanently after ${retries} attempts`);
  return false;
}
