# Focused Entry Revalidation

Дата: 2026-10-13. Проект: `/Users/feliks/Projects/trading-data-chatgpt-proxy`.
Согласована архитектура; эта спецификация предназначена для проверки перед планом реализации.

## Цель и границы

Добавить слой `ENTRY_CANDIDATE → focused revalidation → ENTER_NOW / ENTER_REDUCED / WAIT_RETEST / INVALIDATED` после существующего watcher. Пересчитывать сделку от текущей цены, включая delayed-entry. Ни watcher, ни revalidation, ни journal не исполняют place/amend/cancel/close и не получают ключи биржи. Команда для ручного Terminal является строкой в результате, а не выполняемым действием pipeline.

Модуль принимает подготовленный аналитический context от вызывающей стороны. Этот этап не автоматизирует полный discovery, анализ всех рынков или запуск ChatGPT. Context содержит явные результаты thesis, структуры и общего риска; отсутствующие данные не заменяются предполагаемыми положительными значениями.

## Candidate и журнал

Новый модуль `entry-journal.js` хранит append-only JSONL в существующем stateDir вне репозитория. Записи имеют schemaVersion, event, timestamp, candidateId и setupId. Candidate содержит symbol, side, triggerPrice, observedPrice, detectedAt, копию microstructure snapshot и policy watcher на момент подтверждения.

SetupId детерминированно идентифицирует нормализованные параметры setup, включая symbol, side и trigger. CandidateId уникален для каждого нового подтверждения; повтор после rearm создаёт новый candidate с тем же setupId. Существующая форма persisted setup остаётся совместимой.

Watcher сначала сохраняет candidate, затем уведомляет и закрепляет latch. При ошибке записи candidate не теряется из-за latch: повторная попытка выполняется на следующем цикле. Уведомление обозначает ENTRY_CANDIDATE и не означает разрешение входа. Dual-side state key остаётся `symbol:side`.

Revalidation journal сохраняет candidateId/setupId, этап анализа, decision, entry, invalidation, targets, currentRR, reason, время свежего snapshot и freshness diagnostics. Ошибка journal запрещает выдачу ENTER и команды: результат должен быть сохранён до возврата вызывающей стороне.

## Контракт focused revalidation

`evaluateFocusedEntry(candidate, marketSnapshot, context)` — чистая оценка. Context привязан к symbol/side/setupId и содержит asOf, thesisValid, structure (`valid`, `broken` либо `unknown`), structural invalidationPrice, targets и разрешение общего market/event risk. Числа конечные и положительные. Невалидный контракт даёт диагностическую ошибку; недостающие аналитические подтверждения дают WAIT_RETEST.

Entry берётся из currentMid свежего snapshot, а не observedPrice candidate. Structural stop и targets берутся из нового context, а не механически переносятся на новое расстояние от entry. Для LONG риск = entry − stop, reward = target − entry; для SHORT риск = stop − entry, reward = entry − target. Основной R:R считается до ближайшего ещё не достигнутого target. Остальные targets и их R:R сохраняются в результате. Нельзя переставить stop или игнорировать достигнутый ближайший target только ради улучшения R:R: достижение исходного первого target требует нового context/setup.

Пересечение structural invalidation, явно сломанная структура или явно отменённый thesis дают INVALIDATED. Целая структура с недостаточным R:R, утраченным trigger, неподтверждённым flow либо недостаточными данными даёт WAIT_RETEST. При целой структуре и подтверждённом thesis: RR ≥ 2.0 → ENTER_NOW; 1.5 ≤ RR < 2.0 → ENTER_REDUCED; RR < 1.5 → WAIT_RETEST. Политика не объявляет сломанной структуру только из-за плохого R:R.

## Freshness и обязательный финальный этап

Возраст candidate записывается для диагностики и сам по себе не отменяет сигнал. Повторная оценка сравнивает изменение цены и R:R, trigger, структуру, imbalance, impact и absorption относительно исходного snapshot.

`runFocusedRevalidation(candidate, context, options)` выполняет предварительную оценку, затем обязательно вызывает read-only `getLiveSnapshot(symbol)` после получения context. Финальный этап заново рассчитывает всё по live цене и текущему microstructure. Preliminary evaluation не возвращает разрешение исполнения или terminalCommand; ENTER доступен только через финальный orchestrator.

По умолчанию live fetch имеет timeout 2500 ms; допустимый возраст важных market families — 5000 ms, context — 15 минут. Эти параметры настраиваются и проверяются. Это ограничение входных данных, а не срок жизни candidate. Проверяется время получения snapshot, freshness по источникам и соответствие symbol; future timestamps, missing freshness, PARTIAL/WARMING/UNAVAILABLE и fetch failure запрещают ENTER. Общий maxAge всех families не используется слепо: редкие liquidation events не должны делать свежий order book устаревшим. Для final gate требуются актуальные trade/book данные primary market family.

Для ENTER сохраняются trigger и FULL_EVENT_STREAM, агрессорный imbalance соответствует направлению и порогу candidate, impact соответствует направлению, нет absorption против сделки. Missing/invalid feature quality блокирует ENTER. При изменении цены во время анализа final decision может отличаться от preliminary. Diagnostics сохраняют обе оценки и причины изменения.

## Terminal output

Context включает заранее заданный допустимый размер (`qty`, `qtyStep`) и коэффициент reducedSizeFactor (по умолчанию 0.5). Размер для ENTER_REDUCED округляется вниз по шагу; нулевой или неизвестный размер запрещает ENTER. Размеры не выводятся из leverage или неизвестного баланса.

Builder возвращает shell-quoted строку с symbol, side, entry, qty, SL и TP для ручного запуска через существующий локальный Bybit Demo client. Command использует фиксированный demo host, ключи только из окружения при ручном запуске и защищённый limit entry, чтобы не догонять цену после проверки. SL/TP входят в entry request. Pipeline не импортирует execution client для вызовов, не запускает shell и не отправляет ордер. Secrets не входят в output/journal. Долгоживущую строку нельзя считать новым подтверждением рынка: в документации указывается время финальной проверки.

## Изменения и проверка

Ожидаемые файлы: новые `entry-journal.js`, `focused-revalidation.js`, CLI `scripts/revalidate-entry.js`; targeted изменения `trigger-watcher.js`, `package.json`, `README.md`; новые unit/integration tests. CLI читает candidate из journal и context из JSON, выполняет только read-only запрос к локальному feed и печатает решение/команду. Без передачи нового context watcher лишь сохраняет candidate и уведомляет.

TDD: сначала tests для candidate persistence и retry, RR границ 2.0/1.5, LONG/SHORT, delayed-entry, broken/unknown structure, изменённых stop/targets, старого candidate со свежими данными, stale/malformed snapshots/context, финального изменения цены/flow, отказа journal и размера reduced. У каждого поведения наблюдается ожидаемое падение до минимальной реализации. Проверяется фактическое отсутствие order network requests и запуска command.

Regression: существующие tests dual-side watcher, stale Binance watchdog, subscription refresh и lifecycle shutdown остаются обязательными. Финально выполняются оба полных `npm test`, оба package check и корневой check. Не требуется запускать production daemon, smoke с живыми рынками или менять DEMO-аккаунт.

## Пример delayed-entry

Candidate SHORT NEARUSDT: observedPrice 4.93. Новый context: stop 4.98, target 4.78, thesis/structure valid. Финальная live цена 4.91: risk 0.07, reward 0.13, RR ≈ 1.857 → ENTER_REDUCED при подтверждённом microstructure и корректном размере. Цена 4.88: RR = 1.0 → WAIT_RETEST. Цена 4.99: structural invalidation пересечена → INVALIDATED. Длительность ожидания не является самостоятельной причиной отказа.

## Baseline

До изменения кода: entry-microstructure-feed 86/86 tests, bybit-demo-execution-cloud 24/24 tests; оба check и корневой check прошли. Tests требуют разрешения на локальные loopback servers; внутри стандартной среды соответствующие integration tests падают с listen EPERM, повтор с разрешением проходит.
