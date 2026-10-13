# Focused Entry Revalidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сохранять ENTRY_CANDIDATE и выдавать одно из четырёх решений от текущей цены после обязательной свежей проверки, без автоматического исполнения ордеров.

**Architecture:** Journal обеспечивает сохранение candidate и решения. Чистый evaluator рассчитывает сделку, final orchestrator запрашивает свежий feed и только после сохранения результата разрешает ENTER. Command builder создаёт строку для ручного Terminal; CLI выполняет исключительно чтение feed и запись journal.

**Tech Stack:** Node.js >=20, ES modules, node:test, встроенные fs/crypto/fetch; без новых зависимостей.

**Spec:** `docs/superpowers/specs/2026-10-13-focused-entry-revalidation-design.md` (согласована).

## Global Constraints

- Ветка `feat/focused-entry-revalidation`; spec commit `75541e1` уже существует. По просьбе пользователя код слоя получает один отдельный итоговый commit после полного verification; промежуточные task commits не нужны.
- RR ≥ 2.0 → ENTER_NOW; 1.5 ≤ RR < 2.0 → ENTER_REDUCED; RR < 1.5 при целой структуре → WAIT_RETEST.
- Candidate не отменяется только из-за возраста. Live timeout 2500 ms, возраст trade/book 5000 ms, возраст context 15 минут; policy overrides проверяются.
- reducedSizeFactor по умолчанию 0.5; размер округляется вниз по qtyStep.
- FULL_EVENT_STREAM, соответствующий направлению imbalance/impact, отсутствие absorption против сделки обязательны для ENTER.
- Никаких автоматических place/amend/cancel/close, запуска command, production daemon или smoke с живым рынком.
- Существующие dual-side keys, Binance stale watchdog, subscription refresh и lifecycle shutdown сохраняются.

## Review Focus

- Ошибка записи candidate после подтверждения: следующий watcher poll должен повторить сохранение, без потерянного latch (Task 1).
- Свежий book при старых trades: FULL label не должен разрешать вход на устаревшем aggressor flow (Task 2/4).
- Дальняя вторая цель при достигнутой первой: нельзя подменять основной target ради высокого RR (Task 3).
- Размер reduced на десятичном шаге, цена вне tickSize: округление не должно увеличивать риск либо создать нулевой размер (Task 3/4).
- CLI получает JSON с shell metacharacters или чужим symbol/setupId: вход блокируется без выполнения строки и без утечки секретов (Task 4/5).

## Общие контракты

Все timestamps — целые миллисекунды Unix. Snapshot добавляет `asOf` и `freshness.eventsByFamily[family] = {lastTradeAt,lastBookAt}`; старые поля сохраняются. Context: `{symbol,side,setupId,asOf,thesisValid,structure,invalidationPrice,targets,marketRiskAllowed,qty,qtyStep,tickSize,positionIdx?,reducedSizeFactor?}`. `structure`: valid/broken/unknown. Targets — массив цен; ближайшая цель определяется относительно observedPrice candidate и направления, затем проверяется от текущего entry. `positionIdx` default 0; hedge index должен соответствовать стороне.

Candidate: `{schemaVersion:1,candidateId,setupId,symbol,side,triggerPrice,observedPrice,detectedAt,microstructure,watcherPolicy}`. Нет credentials или произвольных дополнительных context полей в journal.

Evaluator result: `{decision,eligibleDecision,currentRR,entry,invalidationPrice,targets,reason,freshness}`. `eligibleDecision` обозначает предварительную возможность ENTER, но `decision` чистого evaluator остаётся WAIT_RETEST/INVALIDATED. Только orchestrator продвигает eligibleDecision до публичного ENTER после fresh fetch и journal write. Не-ENTER никогда не содержит terminalCommand.

Тестовые fixtures живут в `test/helpers/entry-fixtures.js` (не `.test.js`), экспортируют `candidate()`, `context()`, `snapshot(price, overrides)`. Используют фиксированный NOW; context defaults SHORT: trigger/observed 4.93, stop 4.98, target 4.78; micro imbalance -0.5, impact sell_more_efficient, refill sell, quality ok; актуальные timestamps и оба event вида primary family.

### Task 1: Candidate journal и сохранение watcher перед latch

**Files:** создать `entry-microstructure-feed/entry-journal.js`, `test/entry-journal.test.js`, fixture helper; изменить `trigger-watcher.js`, `test/trigger-watcher.test.js`.

**Interfaces:**
- `createCandidate(setup,snapshot,{now=Date.now,randomUUID}) → Candidate`; stable setupId из canonical normalized setup, candidateId UUID.
- `appendEntryEvent(event,{journalFile,fsImpl}) → Promise<void>`; mkdir 0700, appendFile 0600, JSONL schemaVersion/timestamp.
- `readCandidate(candidateId,{journalFile,fsImpl}) → Promise<Candidate>`; искать только ENTRY_CANDIDATE записи, неизвестный ID — ошибка, повреждённый JSONL — ошибка.
- `processSetupSnapshot(setup,snapshot,state,{now,writeCandidate,notify}) → Promise<watcherResult>`; использует существующий evaluateSetup; при alert сохраняет candidate до notify/latch. При failed write возвращает retryable незакреплённое состояние и ошибку для лога.

- [ ] Написать failing tests `candidate_is_detached_and_ids_preserve_side`: `assert.notEqual(long.setupId,short.setupId)`; одинаковый setup даёт одинаковый setupId; каждый rearm даёт новый candidateId; mutation исходного snapshot не меняет candidate.
- [ ] Написать failing tests `journal_roundtrip` и `failed_append_does_not_latch`: real temporary JSONL возвращает snapshot/ID; failed append затем success сохраняет ровно один candidate до notification; промежуточный state.latched false.
- [ ] Запустить `node --test test/entry-journal.test.js test/trigger-watcher.test.js`; подтвердить падение на отсутствии новых exports/поведения, а не на setup опечатке.
- [ ] Реализовать минимальные journal/helpers и подключить helper к daemon. Config добавляет journalFile; notification title включает ENTRY_CANDIDATE; state key остаётся symbol:side. JSONL reader проверяет envelope и candidate ID.
- [ ] Повторить targeted tests до PASS; existing watcher tests остаются зелёными.

### Task 2: Доказуемая свежесть feed

**Files:** изменить `entry-microstructure-feed/collector.js`, `test/collector.test.js`.

**Interfaces:** `collector.getSnapshot(symbol)` сохраняет прежний контракт, добавляя `asOf` и event timestamps по каждой market family. Last trade timestamp берётся из eventTs, last book — из book event ts. При invalidation/unsubscribe metadata удаляется вместе с историей. Missing events представлены null.

- [ ] Написать failing test `snapshot_tracks_trade_and_book_freshness_separately`: после emit trades at 1000 и book at 7000 snapshot.asOf=7000, lastTradeAt=1000, lastBookAt=7000; future event timestamp не обрезается в zero age.
- [ ] Написать failing test `invalidation_clears_event_freshness`: после book invalidation timestamps обоих видов null; новая warmup не наследует прошлую историю.
- [ ] Запустить `node --test test/collector.test.js`; увидеть expected assertion failures на новых полях.
- [ ] Добавить metadata по существующим buffers/state, не меняя runtime/warmup/watchdog политику.
- [ ] Повторить collector tests до PASS.

### Task 3: Чистый focused evaluator

**Files:** создать `entry-microstructure-feed/focused-revalidation.js`, `test/focused-revalidation.test.js`.

**Interfaces:** `evaluateFocusedEntry(candidate,snapshot,context,{now=Date.now,policy={}}={}) → Evaluation`; не выполняет IO. Policy содержит maxSnapshotAgeMs=5000, maxContextAgeMs=900000, liveTimeoutMs=2500. Все overrides finite positive integers.

- [ ] Написать таблицу failing tests для SHORT и LONG: RR 2 → eligibleDecision ENTER_NOW; 1.5 → ENTER_REDUCED; 1.49 → WAIT_RETEST; public decision до финального этапа не ENTER.
- [ ] Написать `delayed_short_recalculates_current_rr`: price 4.91 даёт RR ≈ 13/7; price 4.88 → WAIT_RETEST/RR 1; price 4.99 → INVALIDATED. Обновлённые context stop/targets используются вместо старых значений.
- [ ] Написать tests: broken structure/thesis false → INVALIDATED; unknown structure/missing risk permission/lost trigger → WAIT_RETEST; candidate возрастом сутки + свежие данные остаётся eligible.
- [ ] Написать `first_target_reached_blocks_second_target_chase`: targets [4.78,4.60], price 4.77 запрещает ENTER. Stop/target wrong-side geometry, NaN, Infinity, future candidate timestamps и context identity mismatch отвергаются.
- [ ] Написать `conservative_tick_rounding_rechecks_rr`: LONG entry округляется вниз, SHORT вверх, stop наружу, target к entry; eligibility считается по округлённым значениям. `qty=1.1,qtyStep=0.1,factor=0.5` → reduced qty 0.5; qty ниже шага блокирует вход. tickSize/qtyStep обязательны для команды.
- [ ] Запустить `node --test test/focused-revalidation.test.js`, подтвердить expected missing evaluator failures.
- [ ] Реализовать validation и расчёт risk/reward, текущей структуры и diagnostics. Decimal quantities обрабатывать без повышения размера из-за float error. RR comparisons учитывать численную погрешность только на exact thresholds.
- [ ] Повторить targeted tests до PASS.

### Task 4: Final live gate и строка команды

**Files:** дополнить `focused-revalidation.js`/tests; создать `entry-command.js`, `test/entry-command.test.js`.

**Interfaces:**
- `runFocusedRevalidation(candidate,context,{initialSnapshot,getLiveSnapshot,appendEvent,now=Date.now,policy={}}) → Promise<Decision>`; getLiveSnapshot получает `(symbol,{signal})`; fetch обязателен после предварительного context, timeout работает даже если callback игнорирует signal.
- `buildTerminalCommand(finalDecision,{clientPath}) → string`; finalDecision содержит qty и validated price/SL/TP; все данные проверяются и shell-quoted. Client import используется только внутри напечатанного script text.
- Decision содержит stage final, checkedAt, preliminary, currentRR, reason, freshness diagnostics и terminalCommand только для ENTER. Journal write завершается до return. Journal failure выбрасывает ошибку без ENTER output.

- [ ] Написать failing test `final_price_overrides_preliminary_entry`: preliminary price 4.93, final 4.88 → WAIT_RETEST; при final 4.91 → ENTER_REDUCED, новый RR/price сохранены в journal.
- [ ] Написать таблицу final veto tests: stale/future snapshot.asOf, old primary trade при fresh book, absent timestamps, invalid feature quality, flipped imbalance, opposite absorption, PARTIAL runtime, mismatched symbol, stale context. Каждый result не ENTER и без terminalCommand.
- [ ] Написать tests для fetch reject/timeout и append reject; отсутствие ордерных POST и child_process вызовов проверять через реальные CLI/output tests с перехватом IO границ, не через source-text assertions.
- [ ] Написать command tests: output содержит Limit + IOC, qty/entry/stopLoss/takeProfit, positionIdx; long/short mapping корректен; не-ENTER не даёт command; arbitrary invalid fields отвергаются. Generated script парсится через node --check без запуска; secrets отсутствуют в строке.
- [ ] Запустить `node --test test/focused-revalidation.test.js test/entry-command.test.js`; наблюдать expected failures.
- [ ] Реализовать final orchestrator и builder. Command script вызывает существующий createBybitClient только при ручном запуске, fixed api-demo host. `/v5/order/create`: category linear, orderType Limit, timeInForce IOC, reduceOnly false, tpslMode Partial, tpOrderType/slOrderType Market, SL/TP в одном request. Ссылка для полей: https://bybit-exchange.github.io/docs/v5/order/create-order.
- [ ] Повторить targeted tests до PASS; проверить, что audit журнал содержит кандидат/decision/RR/reason и не содержит credentials.

### Task 5: CLI и полная проверка

**Files:** создать `entry-microstructure-feed/scripts/revalidate-entry.js`, `test/revalidate-entry.test.js`; изменить `package.json`, `README.md`.

**Interfaces:** `runRevalidationCli(args,{fsImpl,fetchImpl,now,stdout,config}) → Promise<void>`; CLI flags `--candidate-id ID --context FILE`, config из getWatcherConfig; candidate читается из journal. Единственный market request — GET локального `/v1/microstructure/SYMBOL` с cache:no-store, ограниченный timeout. Никакого автоматического start/ensure, подписки или execution API calls.

- [ ] Написать failing CLI integration tests с real temp journal/context: final ENTER output/строка, WAIT без command, чужие symbol/setupId, malformed JSON и missing candidate, terminal string остаётся текстом. Local fake feed фиксирует только GET; child CLI запускается с fake execution credentials и без доступа к order host.
- [ ] Запустить `node --test test/revalidate-entry.test.js`; наблюдать expected missing CLI failures.
- [ ] Реализовать CLI и package script `entry:revalidate`; включить все новые production JS в check. README: JSON context example, поиск candidateId в journal, запуск CLI, meaning решений, время финальной проверки, ручная команда и требование повторной проверки при задержке. Credentials в примеры не вставлять.
- [ ] Запустить targeted CLI tests до PASS.
- [ ] Выполнить полный `npm test` и `npm run check` в entry-microstructure-feed; то же в bybit-demo-execution-cloud; корневой `npm run check`. Loopback tests при необходимости запускать с разрешением среды, не менять tests ради sandbox.
- [ ] Review diff against spec: live-only ENTER, journal-before-return, retry-after-journal-failure, no orders, candidate age не TTL, dual-side/watchdog/shutdown сохранены. Исправления поведения делать через новый failing test.
- [ ] Выполнить `git diff --check`; убедиться, что journal/temp files не staged. Создать один implementation commit `feat: add focused entry revalidation after watcher`.
- [ ] Отчёт: архитектура, изменённые файлы, RED/GREEN evidence, итоговые test counts/check, branch/commit hash, пример delayed-entry 4.91 → RR≈1.857 → ENTER_REDUCED; ограничения context/ручного исполнения указать явно.

## Execution handoff

Рекомендуется **Native**: выполнить задачи последовательно в этом чате, поскольку journal, feed metadata и final gate тесно зависят от общих контрактов. В конце — независимое review всей ветки. Перед реализацией пользователь проверяет план и выбирает Native либо Subagent-driven.
