// Lancer : npm test (pas "node --test" seul : il exécuterait aussi test-intratone-sync.js, une vraie synchro)
const test = require("node:test");
const assert = require("node:assert");
const { parseEventsHTML } = require("./intratone-sync");

const row = (icon, date, badge) =>
  `<tr><td><img src="${icon}"></td><td>${date}</td><td>Porte</td><td>${badge}</td><td>Nom</td></tr>`;
const parse = (...rows) => parseEventsHTML(JSON.stringify({ html: "<table>" + rows.join("") + "</table>" }));

test("heure de Paris convertie en UTC autour du changement d'heure", () => {
  const ev = parse(
    row("ok.gif", "24/10/26 18:00", "A"), // été : UTC+2
    row("ok.gif", "26/10/26 18:00", "B"), // hiver : UTC+1 (avant : +2 jusqu'au 31/10)
    row("ok.gif", "30/03/26 18:00", "C"), // été depuis le 29/03 (avant : +1 jusqu'au 31/03)
    row("ok.gif", "15/01/26 08:05", "D")
  );
  assert.deepStrictEqual(ev.map((e) => e.timestamp), [
    "2026-10-24T16:00:00.000Z",
    "2026-10-26T17:00:00.000Z",
    "2026-03-30T16:00:00.000Z",
    "2026-01-15T07:05:00.000Z",
  ]);
});

test("ko.png = refusé, toute autre icône = accepté", () => {
  const ev = parse(row("ko.png", "15/01/26 08:05", "A"), row("ok.gif", "15/01/26 08:06", "B"));
  assert.deepStrictEqual(ev.map((e) => [e.badgeId, e.accepte]), [["A", false], ["B", true]]);
});
