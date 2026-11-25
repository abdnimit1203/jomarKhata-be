/**
 * Owner alerts on Telegram (new account, payment, report …). A Telegram problem never fails the
 * user's request (errors are swallowed; 4 s timeout).
 * - Bot TOKEN: .env (secret, set once).
 * - Chat IDs (who receives): dashboard settings (`telegramChatIds`), passed in per message;
 *   TELEGRAM_ADMIN_CHAT_ID in .env is only the fallback until set in the dashboard.
 *
 * Message look (owner, 2026-11-25): English, one fact per line, bold title, and a "View …" button
 * that opens the right dashboard page in one tap:
 *
 *   🆕 NEW USER
 *
 *   Name: Rahim Store
 *   User ID: JK-4821-0937
 *   Email: rahim@example.com
 *   Login: Google
 *   [ View user ↗ ]
 */
import type { Config } from '../config.js';

export interface Alert {
  /** e.g. "🆕 NEW USER" */
  title: string;
  /** [label, value] rows; empty values are skipped. */
  rows: Array<[string, string | number | null | undefined]>;
  /** Free text under the rows (e.g. the report message). */
  body?: string;
  button?: { text: string; url: string };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Telegram refuses inline buttons that point at localhost; there the link goes in the text instead. */
const buttonAllowed = (url: string) => /^https:\/\//.test(url) && !/localhost|127\.0\.0\.1/.test(url);

export function renderAlert(a: Alert): { text: string; reply_markup?: unknown } {
  const lines = [`<b>${esc(a.title)}</b>`, ''];
  for (const [label, value] of a.rows) {
    if (value === null || value === undefined || value === '') continue;
    lines.push(`${esc(label)}: <b>${esc(String(value))}</b>`);
  }
  if (a.body) lines.push('', esc(a.body));
  if (a.button && !buttonAllowed(a.button.url)) lines.push('', `${esc(a.button.text)}: ${esc(a.button.url)}`);
  const withButton = a.button && buttonAllowed(a.button.url);
  return {
    text: lines.join('\n'),
    ...(withButton ? { reply_markup: { inline_keyboard: [[{ text: `${a.button!.text} ↗`, url: a.button!.url }]] } } : {}),
  };
}

/** "Email" or "Phone" row for a person, whichever exists. */
export function contactRow(u: { email?: string; phone?: string }): [string, string] {
  return u.email ? ['Email', u.email] : ['Phone', u.phone || '—'];
}

export function makeTelegram(config: Pick<Config, 'TELEGRAM_BOT_TOKEN'>) {
  return {
    enabled: Boolean(config.TELEGRAM_BOT_TOKEN),
    /** Resolves when sent or failed (never throws); awaited so serverless hosts don't drop it. */
    async notify(alert: Alert, chatIds: string[]): Promise<void> {
      if (!config.TELEGRAM_BOT_TOKEN || chatIds.length === 0) return;
      const msg = renderAlert(alert);
      await Promise.allSettled(
        chatIds.map((chat_id) =>
          fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chat_id, parse_mode: 'HTML', disable_web_page_preview: true, ...msg }),
            signal: AbortSignal.timeout(4000),
          }).catch((err: unknown) => console.warn('[telegram] send failed:', err instanceof Error ? err.message : err)),
        ),
      );
    },
  };
}
export type Telegram = ReturnType<typeof makeTelegram>;
