/**
 * Owner alerts on Telegram (new account, payment, request). Fire-and-forget: a Telegram problem
 * never blocks or fails the user's request.
 * - Bot TOKEN: .env (secret, set once).
 * - Chat IDs (who receives): dashboard settings (`telegramChatIds`), passed in per message;
 *   TELEGRAM_ADMIN_CHAT_ID in .env is only the fallback until set in the dashboard.
 */
import type { Config } from '../config.js';

export function makeTelegram(config: Pick<Config, 'TELEGRAM_BOT_TOKEN'>) {
  return {
    enabled: Boolean(config.TELEGRAM_BOT_TOKEN),
    notify(text: string, chatIds: string[]): void {
      if (!config.TELEGRAM_BOT_TOKEN || chatIds.length === 0) return;
      for (const chat_id of chatIds) {
        fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id, text, disable_web_page_preview: true }),
          signal: AbortSignal.timeout(8000),
        }).catch((err: unknown) => console.warn('[telegram] send failed:', err instanceof Error ? err.message : err));
      }
    },
  };
}
export type Telegram = ReturnType<typeof makeTelegram>;
