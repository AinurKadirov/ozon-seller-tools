# Ozon seller tools

Personal TypeScript tools I use to run Ozon shops: unit economics, min prices, promo exit, ads, FBO supply, and a card-profit UI.

Not a SaaS and not an employer codebase. Seller API keys stay in `.env`. The public catalog is a **demo** — real SKUs and cost prices are not in git.

## What’s in the repo

| Path | What it does |
| --- | --- |
| `backend/tools/sale` | CLI: P&amp;L, min prices, promo monitor, ads, SEO snapshots, supply XLSX |
| `card-profit` | Fastify + Mongo: Ozon accruals flattened onto SKU margin |
| `frontend` | Vite UI for card-profit |
| `docker-compose.yml` | Mongo + API + UI |

Look here first: `backend/tools/sale/lib/economics.ts` (money in rubles), `backend/tools/sale/lib/ozon.ts` (Seller API), `card-profit/src/sync.js` (accrual → SKU).

## Card profit (local demo)

```bash
cp .env.example .env
cp .env.example backend/.env.development
# fill OZON_SELLER_CLIENT_ID / OZON_SELLER_API_KEY to sync live data

docker compose up --build
```

- UI: http://localhost:3081
- API: http://localhost:3080

Without keys the UI still boots against empty Mongo.

## Shop CLI

```bash
cd backend
cp ../.env.example .env.development
npm ci
npx ts-node --transpile-only tools/sale/unit-economics.ts
npx ts-node --transpile-only tools/sale/run-daily-report.ts -- --dry
```

Put your offer ids and costs in `backend/tools/sale/lib/catalog.ts`. Demo rows are placeholders.

Useful commands (from `backend/package.json`): `ozon:unit-economics`, `ozon:daily-report`, `ozon:monitor-promos`, `ozon:ads-analysis`, `ozon:supply-plan`.

Pricing and promo scripts default to **dry run** unless you pass `--apply`.

## Secrets

Do not commit `.env`, cookies, xlsx/csv with barcodes or cost, or Mongo dumps. Example variables: `.env.example`.
