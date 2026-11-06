/**
 * telegram.ts — отправка сообщений в Telegram.
 */
import { env } from './env';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodeFetch = require('node-fetch') as typeof import('node-fetch').default;

// Лимит длины одного сообщения Telegram — 4096 символов. Берём с запасом.
const MAX_MESSAGE_LEN = 4000;

async function send(payload: Record<string, unknown>): Promise<{ ok: boolean; description?: string }> {
  const res = await nodeFetch(`https://api.telegram.org/bot${env.telegramBotToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.telegramChatId, ...payload }),
  });
  return res.json() as Promise<{ ok: boolean; description?: string }>;
}

/** Режет текст на части ≤ max по границам строк (чтобы не рвать разметку/таблицы). */
function splitMessage(text: string, max = MAX_MESSAGE_LEN): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur && cur.length + 1 + line.length > max) { chunks.push(cur); cur = ''; }
    if (line.length > max) {
      if (cur) { chunks.push(cur); cur = ''; }
      for (let i = 0; i < line.length; i += max) chunks.push(line.slice(i, i + max));
      continue;
    }
    cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** Отправка в формате MarkdownV2 с fallback в plain-text при ошибке разметки. */
export async function sendMarkdown(text: string): Promise<void> {
  for (const part of splitMessage(text)) {
    const data = await send({ text: part, parse_mode: 'MarkdownV2' });
    if (data.ok) continue;

    console.error('  MarkdownV2 ошибка:', data.description, '— пробуем без форматирования');
    const plain = part.replace(/[*_\\]/g, '');
    const retry = await send({ text: plain });
    if (!retry.ok) throw new Error(`Telegram: ${retry.description}`);
  }
}

/** Отправка в формате HTML. */
export async function sendHtml(text: string): Promise<void> {
  for (const part of splitMessage(text)) {
    const data = await send({ text: part, parse_mode: 'HTML' });
    if (!data.ok) throw new Error(`Telegram: ${data.description}`);
  }
}
