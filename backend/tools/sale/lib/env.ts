/**
 * Загрузка переменных окружения для всех ozon-скриптов.
 * Импортируется первым из lib/ozon.ts и lib/telegram.ts.
 *
 * Читает .env, затем .env.development (перекрывает .env).
 */
import { join } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { ACTIVE_SHOP } from './shop-config';

const repoRoot = join(__dirname, '../../..');
loadDotenv({ path: join(repoRoot, '.env') });
loadDotenv({ path: join(repoRoot, '.env.development'), override: true });

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Не задана переменная окружения ${name} (см. .env.development)`);
  return v;
}

/** Возвращает переменную для активного магазина: сначала ищет FOO_TEST / FOO_MAIN, потом FOO. */
function shopVar(name: string): string {
  const suffix = ACTIVE_SHOP === 'test' ? '_TEST' : '_MAIN';
  return process.env[name + suffix]?.trim() || required(name);
}

export const env = {
  get ozonApiKey(): string    { return shopVar('OZON_SELLER_API_KEY'); },
  get ozonClientId(): string  { return shopVar('OZON_SELLER_CLIENT_ID'); },
  /** Performance API (реклама) — отдельные OAuth-креды (client_credentials). */
  get ozonPerfClientId(): string     { return shopVar('OZON_PERFORMANCE_CLIENT_ID'); },
  get ozonPerfClientSecret(): string { return shopVar('OZON_PERFORMANCE_CLIENT_SECRET'); },
  get telegramBotToken(): string { return required('TELEGRAM_BOT_TOKEN'); },
  get telegramChatId(): string   { return required('TELEGRAM_CHAT_ID'); },
  /** Браузерные куки для seller.ozon.ru (протухают ~1 сутки, нужно обновлять вручную). */
  get ozonSellerCookies(): string { return shopVar('OZON_SELLER_COOKIES'); },
  get mongoUrl(): string { return required('MONGO_URL'); },
};
