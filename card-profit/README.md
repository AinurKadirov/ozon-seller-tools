# Card profit — синк доходности по карточкам

Монолит без Rabbit: Mongo + Fastify + Vite.

```bash
# инфраструктура
docker compose up -d mongo

# API
cd card-profit && npm install && node src/index.js

# UI
cd frontend && npm install && npm run dev
```

Открыть http://localhost:3081

Кнопки:

- даты `minDate` / `maxDate`
- интервал: день / неделя / месяц / весь период
- **Синк начислений** — тянет `/v1/finance/accrual/by-day` и раскладывает расходы по SKU

Синк карточек каталога не входит: имена/себестоимость подмешиваются из seed Lumos и опционально `/v3/product/info/list`.
