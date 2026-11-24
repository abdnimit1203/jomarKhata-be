/**
 * Owner alerts on Telegram (new account, payment, request). Fire-and-forget: a Telegram problem
 * never blocks or fails the user's request. Off when TELEGRAM_BOT_TOKEN or chat ID is empty.
 */
import { list, type Config } from '../config.js';

export function makeTelegram(config: Pick<Config, 'TELEGRAM_BOT_TOKEN' | 'TELEGRAM_ADMIN_CHAT_ID'>) {
  const chats = list(config.TELEGRAM_ADMIN_CHAT_ID);
  const enabled = Boolean(config.TELEGRAM_BOT_TOKEN && chats.length);
  return {
    enabled,
    notify(text: string): void {
      if (!enabled) return;
      for (const chat_id of chats) {
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
