/**
 * Сквозная проверка студии в реальном Chrome (Playwright, channel: chrome).
 *
 * Проверяем то, что заявлено пользователю, а не «страница открылась»:
 *  1) граф рисуется и не двоится (атомарный засев комнаты);
 *  2) DuckDB-WASM реально считает SQL по цепочке узлов;
 *  3) перезагрузка не теряет работу (IndexedDB) и не засевает демо поверх неё;
 *  4) два ИЗОЛИРОВАННЫХ браузерных профиля синхронизируются — это путь «другая машина»,
 *     BroadcastChannel между ними не работает, значит синхронизация идёт через WebRTC;
 *  5) чужой курсор и имя участника видны;
 *  6) удаление узла кнопкой видно обоим.
 */
const { chromium } = require("playwright");

const URL = process.env.ETL_URL || "http://127.0.0.1:5173/";
const ROOM = `e2e-${Date.now().toString(36)}`;
const results = [];
const errors = [];

const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const sigError = (list) => list.filter((t) => /WebSocket|signaling|ICE|WebRTC/i.test(t)).length;

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const ctxA = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  const ctxB = await browser.newContext({ viewport: { width: 1400, height: 900 } }); // изолированный профиль
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();

  for (const [name, page] of [["A", A], ["B", B]]) {
    page.on("pageerror", (e) => errors.push(`${name} pageerror: ${e}`));
    page.on("console", (m) => m.type() === "error" && errors.push(`${name}: ${m.text()}`));
  }

  const url = `${URL}#room=${ROOM}`;
  await A.goto(url, { waitUntil: "domcontentloaded" });
  await A.waitForSelector(".react-flow__node", { timeout: 40000 });
  await A.waitForTimeout(3500); // окно засева — проверяем, что дублей нет

  const titles = await A.locator(".react-flow__node").allInnerTexts();
  check("демо-граф нарисован ровно один раз", titles.length === 3, `узлов: ${titles.length}`);

  // ── выполнение конвейера ────────────────────────────────────────────────
  await A.getByRole("button", { name: "Выполнить" }).click();
  await A.waitForFunction(() => document.body.innerText.includes("total"), { timeout: 150000 });
  await A.waitForTimeout(2000);
  const bodyA = await A.innerText("body");
  check(
    "DuckDB посчитал GROUP BY",
    bodyA.includes("Север") && bodyA.includes("Юг") && bodyA.includes("total"),
    /(\d+) строк · (\d+) колонок/.exec(bodyA)?.[0] || "нет сводки",
  );

  // ── persistence: перезагрузка не должна ничего терять ───────────────────
  await A.getByRole("button", { name: "+ SQL-трансформация" }).click();
  await A.waitForTimeout(1200);
  const beforeReload = await A.locator(".react-flow__node").count();
  await A.reload({ waitUntil: "domcontentloaded" });
  await A.waitForSelector(".react-flow__node", { timeout: 40000 });
  await A.waitForTimeout(4000); // если посев сработает повторно — увидим 7-8 узлов
  const afterReload = await A.locator(".react-flow__node").count();
  check(
    "перезагрузка сохраняет работу и не засевает демо заново",
    afterReload === beforeReload,
    `до ${beforeReload}, после ${afterReload}`,
  );

  // ── второй участник в изолированном профиле (другая «машина») ───────────
  await B.goto(url, { waitUntil: "domcontentloaded" });
  await B.waitForSelector(".react-flow__node", { timeout: 40000 });
  await B.waitForTimeout(6000);

  const syncOk = await B.waitForFunction(
    (expected) => window.__etl && window.__etl.nodes.size === expected,
    afterReload,
    { timeout: 60000 },
  ).then(() => true).catch(() => false);
  const nodesB = await B.evaluate(() => window.__etl?.nodes.size);
  const connectedB = await B.evaluate(() => window.__etl?.provider.connected);
  check(
    "второй браузер получил граф первого (WebRTC, без BroadcastChannel)",
    syncOk,
    `узлов у B: ${nodesB}, сигналинг: ${connectedB}`,
  );

  // ── курсор и присутствие ────────────────────────────────────────────────
  await B.mouse.move(700, 420);
  await B.mouse.move(800, 480);
  await B.mouse.move(880, 540);
  const cursorSeen = await A.waitForFunction(() => document.querySelectorAll(".cursor").length > 0, {
    timeout: 20000,
  }).then(() => true).catch(() => false);
  check("чужой курсор виден", cursorSeen, cursorSeen ? await A.locator(".cursor").first().innerText() : "не появился");

  const peersA = await A.locator(".peers__peer").count();
  check("присутствие второго участника", peersA >= 1, `участников: ${peersA}`);

  // ── удаление кнопкой видно обоим ────────────────────────────────────────
  // Узел ищем по id из документа: заголовок — это <input>, и текстовый селектор его не видит.
  const extraId = await B.evaluate(() =>
    [...window.__etl.nodes.keys()].find((k) => !k.endsWith("_seed")),
  );
  const target = B.locator(`.react-flow__node[data-id="${extraId}"]`);
  await target.locator(".node__del").click();
  await B.waitForTimeout(800);
  const goneInB = (await B.locator(".react-flow__node").count()) === afterReload - 1;
  const goneInA = await A
    .waitForFunction((n) => document.querySelectorAll(".react-flow__node").length === n, afterReload - 1, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check("удаление узла кнопкой видно обоим", goneInB && goneInA, `B: ${goneInB}, A: ${goneInA}`);

  const noise = sigError(errors);
  check(
    "ошибок в консоли нет (кроме сетевого шума сигналинга)",
    errors.length - noise === 0,
    errors.length - noise === 0 ? `сетевых сообщений: ${noise}` : errors.filter((e) => !/WebSocket|signaling|ICE/i.test(e)).slice(0, 2).join(" | "),
  );

  console.log("\nИТОГ:", results.filter((r) => r.ok).length, "из", results.length, "проверок пройдено");
  await browser.close();
  process.exit(results.every((r) => r.ok) ? 0 : 1);
})();
