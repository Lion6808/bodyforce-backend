// 🔹 Fichier: intratone-sync.js
// Type: Node.js
// Dossier: /
// Date: 2026-01-27
// Description: Synchronisation automatique Intratone → Supabase (CRON-ready)

const https = require("https");
let webpush = null;
try { webpush = require("web-push"); } catch (_) {}

// --- Configuration (variables d'environnement) ---
const INTRATONE = {
  identifiant: process.env.INTRATONE_EMAIL || "",
  mdp: process.env.INTRATONE_PASSWORD || "",
  device: process.env.INTRATONE_DEVICE || "0d24dac0-647c-4853-bfab-deda515fd2a4",
  installationId: process.env.INTRATONE_INSTALLATION_ID || "114449",
  recupId: process.env.INTRATONE_RECUP_ID || "91857",
  host: "www.intratone.info",
};

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "";

const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY  || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_EMAIL       = process.env.VAPID_EMAIL       || "mailto:admin@bodyforce.fr";

if (webpush && VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// Délai d'attente après "Récupérer" avant de rafraîchir et lister (en ms)
const RECUP_WAIT_MS = parseInt(process.env.INTRATONE_RECUP_WAIT_MS || "180000", 10);

// --- Helpers HTTP ---
function httpsRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        })
      );
    });
    req.on("error", reject);
    req.setTimeout(30000, () => req.destroy(new Error("timeout")));
    if (postData) req.write(postData);
    req.end();
  });
}

function parseCookies(headers) {
  const cookies = {};
  for (const sc of headers["set-cookie"] || []) {
    const m = sc.match(/^([^=]+)=([^;]*)/);
    if (m) cookies[m[1]] = m[2];
  }
  return cookies;
}

function toCookieStr(obj) {
  return Object.entries(obj).map(([k, v]) => `${k}=${v}`).join("; ");
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function log(msg) {
  console.log(`[Intratone Sync] ${msg}`);
}

function intratonePost(session, path, body) {
  body = body || `SID=${session.sid}`;
  return httpsRequest(
    {
      hostname: INTRATONE.host,
      path: `${path}?SID=${session.sid}`,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "Content-Length": Buffer.byteLength(body),
        Cookie: toCookieStr(session.cookies),
        token: session.jwt,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
        "X-Requested-With": "XMLHttpRequest",
        Accept: "*/*",
        Origin: "https://www.intratone.info",
        Referer: "https://www.intratone.info/fr/",
      },
    },
    body
  );
}

// --- Étape 1 : Login ---
async function login() {
  const body = new URLSearchParams({
    identifiant: INTRATONE.identifiant,
    mdp: INTRATONE.mdp,
    device: INTRATONE.device,
  }).toString();

  const res = await httpsRequest(
    {
      hostname: INTRATONE.host,
      path: "/fr/connexion.php",
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
        Accept: "application/json, text/plain, */*",
        Origin: "https://www.intratone.info",
        Referer: "https://www.intratone.info/fr/",
      },
    },
    body
  );

  if (res.status !== 200) throw new Error(`Login HTTP ${res.status}`);

  const cookies = parseCookies(res.headers);
  const sid = cookies.PHPSESSID || cookies.Intratoneinfo;
  if (!sid) throw new Error(`Pas de session obtenue lors du login.`);

  let jwt = "";
  try {
    const loginJson = JSON.parse(res.body.toString("utf-8"));
    jwt = loginJson.session?.jwt || "";
  } catch {}

  const allCookies = {
    lng: "%2Ffr%2F",
    PHPSESSID: sid,
    Intratoneinfo: sid,
    ...cookies,
  };

  log(`Connecté (SID: ${sid.substring(0, 10)}...)`);
  return { sid, jwt, cookies: allCookies };
}

// --- Étape 2 : Initialiser la session ---
async function initSession(session) {
  await intratonePost(session, "/fr/data/connect.php");
  const evtsBody = `id=${INTRATONE.installationId}&SID=${session.sid}`;
  const evtsRes = await intratonePost(session, "/fr/data/events/evts.php", evtsBody);
  const evtsText = evtsRes.body.toString("utf-8");

  if (evtsRes.status !== 200 || evtsText.includes('"type":-1')) {
    throw new Error(`events/evts.php échoué`);
  }
  log("Module événements ouvert");
}

// --- Étape 3 : Déclencher la récupération ---
async function triggerRecup(session) {
  const body = `id=${INTRATONE.recupId}`;
  const res = await intratonePost(session, "/fr/data/events/evts_recup.php", body);
  const text = res.body.toString("utf-8");

  if (res.status === 200 && !text.includes('"type":-1')) {
    log("Récupération déclenchée depuis la centrale");
    return true;
  }
  log(`Avertissement evts_recup: ${text.substring(0, 100)}`);
  return false;
}

// --- Étape 4 : Rafraîchir le buffer ---
async function refreshEventsBuffer(session) {
  const res = await intratonePost(session, "/fr/data/events/evts_infos.php");
  const text = res.body.toString("utf-8");

  if (res.status === 200 && !text.includes('"type":-1')) {
    log("Buffer serveur actualisé (evts_infos OK)");
    return true;
  }
  return false;
}

// --- Étape 5 : Lister les événements ---
async function fetchEventsList(session) {
  const res = await intratonePost(session, "/fr/data/events/evts_list.php");
  if (res.status !== 200) throw new Error(`evts_list HTTP ${res.status}`);
  return res.body.toString("utf-8");
}

// --- Étape 6 : Parser le HTML ---
function parseEventsHTML(rawJson) {
  let html = "";
  try {
    const json = JSON.parse(rawJson);
    html = json.html || "";
  } catch {
    html = rawJson;
  }
  if (!html) return [];

  const events = [];
  const rows = html.split(/<tr[\s>]/i).slice(1);
  for (const row of rows) {
    if (row.includes("<th")) continue;

    const tds = [];
    const tdRegex = /<td[^>]*>([\s\S]*?)(?:<\/td>|<\\\/td>)/gi;
    let match;
    while ((match = tdRegex.exec(row)) !== null) tds.push(match[1]);
    if (tds.length < 5) continue;

    const badgeId = tds[3].replace(/<[^>]*>/g, "").replace(/\\n/g, "").trim();
    const dateRaw = tds[1].replace(/<[^>]*>/g, "").replace(/\\n/g, "").replace(/\\\//g, "/").trim();

    const dateParts = dateRaw.match(/(\d{2})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/);
    if (!dateParts) continue;
    const [, day, month, year, hour, minute] = dateParts;
    const yr = parseInt(`20${year}`);
    const mo = parseInt(month);
    const dy = parseInt(day);
    const hr = parseInt(hour);
    const mi = parseInt(minute);

    const isSummer = mo >= 4 && mo <= 10;
    const offsetHours = isSummer ? 2 : 1;
    const fullDate = new Date(Date.UTC(yr, mo - 1, dy, hr - offsetHours, mi, 0));
    if (isNaN(fullDate.getTime())) continue;

    events.push({
      badgeId,
      timestamp: fullDate.toISOString(),
      name: tds[4].replace(/<[^>]*>/g, "").replace(/\\n/g, "").trim() || null,
    });
  }
  return events;
}

// --- Helpers Supabase REST (GET / DELETE) ---
function supabaseRestRequest(method, path, queryString, body) {
  const parsedUrl = new URL(SUPABASE_URL);
  const restPath =
    parsedUrl.pathname.replace(/\/+$/, "") + "/rest/v1/" + path + (queryString ? "?" + queryString : "");
  const payload = body ? JSON.stringify(body) : undefined;
  return httpsRequest(
    {
      hostname: parsedUrl.hostname,
      path: restPath,
      method,
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Accept: "application/json",
        ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
      },
    },
    payload
  );
}

async function supabaseGet(table, queryString) {
  const res = await supabaseRestRequest("GET", table, queryString);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Supabase GET ${table} HTTP ${res.status}: ${res.body.toString("utf-8").substring(0, 200)}`);
  }
  return JSON.parse(res.body.toString("utf-8"));
}

async function supabaseDelete(table, queryString) {
  await supabaseRestRequest("DELETE", table, queryString);
}

// --- Étape 7 : Supabase ---
async function insertToSupabase(events) {
  if (!events.length) {
    log("Aucun événement à insérer");
    return { inserted: 0 };
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    log("ERREUR: SUPABASE_URL ou SUPABASE_KEY non configuré !");
    log(`  SUPABASE_URL: ${SUPABASE_URL ? "OK (" + SUPABASE_URL.substring(0, 30) + "...)" : "VIDE"}`);
    log(`  SUPABASE_KEY: ${SUPABASE_KEY ? "OK (" + SUPABASE_KEY.substring(0, 10) + "...)" : "VIDE"}`);
    return { inserted: 0 };
  }

  // Dédupliquer par badgeId+timestamp (PostgreSQL refuse les doublons internes au même batch)
  const seen = new Set();
  const batch = [];
  for (const e of events) {
    const key = `${e.badgeId}|${e.timestamp}`;
    if (!seen.has(key)) {
      seen.add(key);
      batch.push({ badgeId: e.badgeId, timestamp: e.timestamp });
    }
  }
  if (batch.length < events.length) {
    log(`${events.length - batch.length} doublons internes retirés du batch`);
  }
  const payload = JSON.stringify(batch);
  const parsedUrl = new URL(SUPABASE_URL);
  const restPath = parsedUrl.pathname.replace(/\/+$/, "") + "/rest/v1/presences";

  log(`Insertion Supabase: ${batch.length} événements vers ${parsedUrl.hostname}${restPath}`);

  const res = await httpsRequest(
    {
      hostname: parsedUrl.hostname,
      path: restPath + "?on_conflict=badgeId,timestamp",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
    },
    payload
  );

  const responseBody = res.body.toString("utf-8");
  if (res.status < 200 || res.status >= 300) {
    log(`ERREUR Supabase HTTP ${res.status}: ${responseBody.substring(0, 300)}`);
    return { inserted: 0 };
  }

  log(`Supabase HTTP ${res.status} OK`);
  return { inserted: batch.length };
}

// --- Notifications push : rappel de fin d'entraînement (1h30) ---
async function sendWorkoutNotifications() {
  if (!webpush || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  if (!SUPABASE_URL || !SUPABASE_KEY) return;

  try {
    const now = new Date();
    const from = new Date(now.getTime() - 95 * 60 * 1000).toISOString();
    const to   = new Date(now.getTime() - 85 * 60 * 1000).toISOString();

    // Présences sans end_time dans la fenêtre 85-95 min
    const presences = await supabaseGet(
      "presences",
      `timestamp=gte.${encodeURIComponent(from)}&timestamp=lte.${encodeURIComponent(to)}&end_time=is.null&select=badgeId,timestamp`
    );

    if (!presences.length) {
      log("Notifications: aucune présence dans la fenêtre 85-95 min");
      return;
    }

    log(`Notifications: ${presences.length} présence(s) à traiter`);

    for (const presence of presences) {
      const { badgeId, timestamp } = presence;
      if (!badgeId) continue;

      // Trouver le membre via badge_history avec filtre date (règle critique)
      const bhRows = await supabaseGet(
        "badge_history",
        `badge_real_id=eq.${encodeURIComponent(badgeId)}&date_attribution=lte.${encodeURIComponent(timestamp)}&select=member_id,date_fin&order=date_attribution.desc&limit=10`
      );
      const ts = new Date(timestamp).getTime();
      const bh = bhRows.find(
        (row) => !row.date_fin || new Date(row.date_fin).getTime() >= ts
      );
      if (!bh) {
        log(`Notifications: aucun membre trouvé pour badge ${badgeId}`);
        continue;
      }

      // Subscriptions push du membre
      const subs = await supabaseGet(
        "push_subscriptions",
        `member_id=eq.${bh.member_id}&select=endpoint,p256dh,auth`
      );
      if (!subs.length) continue;

      const payload = JSON.stringify({
        title: "BodyForce — Fin d'entraînement ?",
        body: "Tu es en salle depuis 1h30. C'est terminé ?",
        data: { badgeId, timestamp },
      });

      for (const sub of subs) {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload
          );
          log(`Notification envoyée → membre ${bh.member_id}`);
        } catch (err) {
          log(`Erreur push membre ${bh.member_id}: ${err.message}`);
          if (err.statusCode === 410) {
            await supabaseDelete(
              "push_subscriptions",
              `endpoint=eq.${encodeURIComponent(sub.endpoint)}`
            );
          }
        }
      }
    }
  } catch (err) {
    log(`Erreur sendWorkoutNotifications: ${err.message}`);
  }
}

// --- Orchestrateur principal ---
async function syncIntratone() {
  log("========== Début synchronisation ==========");
  try {
    const session = await login();
    await initSession(session);

    const recupOk = await triggerRecup(session);
    if (recupOk) {
      log(`Attente de ${RECUP_WAIT_MS / 1000}s...`);
      await wait(RECUP_WAIT_MS);
      await refreshEventsBuffer(session);
    }

    const rawResponse = await fetchEventsList(session);
    const events = parseEventsHTML(rawResponse);
    log(`${events.length} événements trouvés`);

    let supaResult = { inserted: 0 };
    if (events.length > 0) {
      supaResult = await insertToSupabase(events);
      log(`Supabase: ${supaResult.inserted} traités`);
    }

    await sendWorkoutNotifications();
    log("========== Fin synchronisation ==========");
    return { success: true, events: events.length, supabase: supaResult };
  } catch (err) {
    log(`ERREUR: ${err.message}`);
    return { success: false, error: err.message };
  }
}


// --- Execution automatique ---
if (require.main === module) {
  syncIntratone()
    .then((res) => {
      if (res.success) {
        console.log("✅ Synchronisation réussie");
        process.exit(0);
      } else {
        console.error("❌ Échec de la synchronisation:", res.error);
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error("💥 Erreur fatale:", err);
      process.exit(1);
    });
}



// --- Export pour CRON ---
module.exports = { syncIntratone };
