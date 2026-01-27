// intratone-sync.js — Synchronisation automatique Intratone → Supabase
// Flux : Login → connect.php → evts.php (id=114449) → evts_recup →
//        Attendre → evts_list → Parser HTML → Insérer dans Supabase
// Tourne en boucle (setInterval) sur Render, sans navigateur.

const https = require("https");

// --- Configuration (variables d'environnement) ---
const INTRATONE = {
  identifiant: process.env.INTRATONE_EMAIL || "",
  mdp: process.env.INTRATONE_PASSWORD || "",
  device: process.env.INTRATONE_DEVICE || "0d24dac0-647c-4853-bfab-deda515fd2a4",
  installationId: process.env.INTRATONE_INSTALLATION_ID || "114449",
  host: "www.intratone.info",
};

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "";

// Délai d'attente après "Récupérer" avant de lister (en ms)
const RECUP_WAIT_MS = parseInt(process.env.INTRATONE_RECUP_WAIT_MS || "45000", 10);

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

// Helper pour faire un POST authentifié vers Intratone
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
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
        "X-Requested-With": "XMLHttpRequest",
        Accept: "*/*",
        Origin: "https://www.intratone.info",
        Referer: "https://www.intratone.info/fr/",
      },
    },
    body
  );
}

// --- Etape 1 : Login ---

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
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
        Accept: "application/json, text/plain, */*",
        Origin: "https://www.intratone.info",
        Referer: "https://www.intratone.info/fr/",
      },
    },
    body
  );

  if (res.status !== 200) {
    throw new Error(`Login HTTP ${res.status}`);
  }

  const cookies = parseCookies(res.headers);
  const sid = cookies.PHPSESSID || cookies.Intratoneinfo;

  if (!sid) {
    const text = res.body.toString("utf-8").substring(0, 300);
    throw new Error(`Pas de session. Réponse: ${text}`);
  }

  // Extraire le JWT depuis la réponse JSON
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

  const rawLogin = res.body.toString("utf-8").substring(0, 500);
  log(`Connecté (SID: ${sid.substring(0, 10)}...)`);
  return { sid, jwt, cookies: allCookies, _rawLogin: rawLogin };
}

// --- Etape 2 : Initialiser la session (connect.php + evts.php) ---

async function initSession(session) {
  // 2a. connect.php — initialise la session côté serveur
  const connectRes = await intratonePost(session, "/fr/data/connect.php");
  const connectText = connectRes.body.toString("utf-8");
  if (connectRes.status !== 200 || connectText.includes('"type":-1')) {
    log(`Avertissement connect.php: ${connectText.substring(0, 200)}`);
  } else {
    log("Session initialisée (connect.php OK)");
  }

  // 2b. events/evts.php — ouvre le module événements avec l'ID d'installation
  const evtsBody = `id=${INTRATONE.installationId}&SID=${session.sid}`;
  const evtsRes = await intratonePost(session, "/fr/data/events/evts.php", evtsBody);
  const evtsText = evtsRes.body.toString("utf-8");

  if (evtsRes.status !== 200 || evtsText.includes('"type":-1')) {
    throw new Error(`events/evts.php échoué: ${evtsText.substring(0, 200)}`);
  }

  log("Module événements ouvert (evts.php OK)");
}

// --- Etape 3 : Déclencher la récupération depuis la centrale ---

async function triggerRecup(session) {
  const res = await intratonePost(session, "/fr/data/events/evts_recup.php");
  const text = res.body.toString("utf-8");

  if (res.status === 200 && !text.includes('"type":-1')) {
    log("Récupération déclenchée depuis la centrale");
    return true;
  }

  // Pas critique si ça échoue — les événements déjà remontés seront quand même listés
  log(`Avertissement evts_recup: ${text.substring(0, 150)} (non bloquant)`);
  return false;
}

// --- Etape 4 : Lister les événements ---

async function fetchEventsList(session) {
  const res = await intratonePost(session, "/fr/data/events/evts_list.php");

  if (res.status !== 200) {
    throw new Error(`evts_list HTTP ${res.status}`);
  }

  return res.body.toString("utf-8");
}

// --- Etape 5 : Parser le HTML des événements ---

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

  // Découper par <tr (chaque ligne du tableau)
  const rows = html.split(/<tr[\s>]/i).slice(1);

  for (const row of rows) {
    // Ignorer l'en-tête
    if (row.includes("<th")) continue;

    // Extraire data-serial du badge
    const serialMatch = row.match(/data-serial="([^"]+)"/);
    if (!serialMatch) continue;

    const badgeId = serialMatch[1].trim();
    if (!badgeId) continue;

    // Extraire tous les <td>...</td>
    // Le HTML Intratone utilise <\/td> (JSON-escaped) ou </td>
    const tds = [];
    const tdRegex = /<td[^>]*>([\s\S]*?)(?:<\/td>|<\\\/td>)/gi;
    let match;
    while ((match = tdRegex.exec(row)) !== null) {
      tds.push(match[1]);
    }

    if (tds.length < 5) continue;

    // td[0] = icône, td[1] = date, td[2] = type, td[3] = serial, td[4] = nom
    const dateRaw = tds[1]
      .replace(/<[^>]*>/g, "")
      .replace(/\\n/g, "")
      .replace(/\\\//g, "/")
      .trim();

    const dateParts = dateRaw.match(/(\d{2})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/);
    if (!dateParts) continue;

    const [, day, month, year, hour, minute] = dateParts;
    const fullDate = new Date(`20${year}-${month}-${day}T${hour}:${minute}:00`);
    if (isNaN(fullDate.getTime())) continue;

    const name = tds[4]
      .replace(/<[^>]*>/g, "")
      .replace(/\\n/g, "")
      .trim();

    events.push({
      badgeId,
      timestamp: fullDate.toISOString(),
      name: name || null,
    });
  }

  return events;
}

// --- Etape 6 : Insérer dans Supabase (dédoublonnage) ---

async function insertToSupabase(events) {
  if (!events.length) return { inserted: 0 };
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    log("SUPABASE_URL ou SUPABASE_KEY manquant, skip insertion");
    return { inserted: 0, error: "config manquante" };
  }

  const BATCH_SIZE = 50;
  let totalInserted = 0;
  let totalErrors = 0;

  for (let i = 0; i < events.length; i += BATCH_SIZE) {
    const batch = events.slice(i, i + BATCH_SIZE).map((e) => ({
      badgeId: e.badgeId,
      timestamp: e.timestamp,
    }));

    const payload = JSON.stringify(batch);
    const parsedUrl = new URL(SUPABASE_URL);
    const restPath = parsedUrl.pathname.replace(/\/+$/, "") + "/rest/v1/presences";

    if (i === 0) {
      log(`Supabase POST → ${parsedUrl.hostname}${restPath} (${batch.length} lignes)`);
    }

    const res = await httpsRequest(
      {
        hostname: parsedUrl.hostname,
        path: restPath,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          Prefer: "resolution=ignore-duplicates,return=minimal",
        },
      },
      payload
    );

    if (res.status >= 200 && res.status < 300) {
      totalInserted += batch.length;
    } else {
      totalErrors += batch.length;
      const errText = res.body.toString("utf-8");
      log(`Erreur Supabase lot ${i / BATCH_SIZE + 1}: HTTP ${res.status} - URL: ${parsedUrl.hostname}${restPath} - ${errText.substring(0, 300)}`);
    }
  }

  return { inserted: totalInserted, errors: totalErrors };
}

// --- Etape 7 (optionnel) : Insérer dans SQLite local ---

function insertToSQLite(db, events) {
  return new Promise((resolve) => {
    if (!db || !events.length) return resolve({ inserted: 0 });
    // Vérifier que la table existe avant d'insérer
    db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='presences'", (err, row) => {
      if (err || !row) {
        log("SQLite ignoré: table presences inexistante");
        return resolve({ inserted: 0, error: "table presences inexistante" });
      }
      let inserted = 0;
      const stmt = db.prepare("INSERT OR IGNORE INTO presences (badgeId, timestamp) VALUES (?, ?)");
      for (const e of events) {
        stmt.run(e.badgeId, e.timestamp, (runErr) => { if (!runErr) inserted++; });
      }
      stmt.finalize(() => resolve({ inserted }));
    });
  });
}

// --- Orchestrateur principal ---

async function syncIntratone(db, options = {}) {
  const debug = options.debug || false;
  const debugInfo = { steps: [] };
  const step = (name, detail) => {
    log(`[${name}] ${typeof detail === "string" ? detail : JSON.stringify(detail).substring(0, 300)}`);
    if (debug) debugInfo.steps.push({ name, detail: typeof detail === "string" ? detail : JSON.stringify(detail).substring(0, 500) });
  };

  log("========== Début synchronisation ==========");
  log(new Date().toISOString());

  try {
    // 1. Login
    step("config", `identifiant: [${INTRATONE.identifiant}] (len=${INTRATONE.identifiant.length}) mdp: [${INTRATONE.mdp.length} chars] device: ${INTRATONE.device.substring(0, 8)}...`);
    const session = await login();
    step("login", `SID: ${session.sid.substring(0, 10)}... JWT: ${session.jwt ? "oui" : "non"} loginBody: ${session._rawLogin || "N/A"}`);

    // 2. Initialiser la session (connect.php + ouvrir module événements)
    await initSession(session);
    step("initSession", "OK");

    // 3. Déclencher la récupération depuis la centrale physique
    const recupOk = await triggerRecup(session);
    step("triggerRecup", recupOk ? "OK" : "échoué (non bloquant)");

    // 4. Attendre que la centrale remonte les données (seulement si recup OK)
    if (recupOk) {
      log(`Attente ${RECUP_WAIT_MS / 1000}s pour la remontée des données...`);
      await wait(RECUP_WAIT_MS);
      step("wait", `${RECUP_WAIT_MS / 1000}s`);
    }

    // 5. Lister les événements
    const rawResponse = await fetchEventsList(session);
    step("fetchEventsList", `Réponse brute: ${rawResponse.substring(0, 500)}`);

    // 6. Parser le HTML
    const events = parseEventsHTML(rawResponse);
    log(`${events.length} passage(s) badge détecté(s)`);
    step("parseEventsHTML", `${events.length} événement(s) parsé(s)`);

    if (events.length > 0) {
      const lastEvent = events[events.length - 1];
      const firstEvent = events[0];
      log(`Premier: ${firstEvent.badgeId} → ${firstEvent.timestamp} (${firstEvent.name || "?"})`);
      log(`Dernier: ${lastEvent.badgeId} → ${lastEvent.timestamp} (${lastEvent.name || "?"})`);
      if (debug) {
        debugInfo.firstEvent = firstEvent;
        debugInfo.lastEvent = lastEvent;
        debugInfo.sampleEvents = events.slice(0, 5);
      }
    }

    if (events.length === 0) {
      log("Rien à insérer.");
      return { success: true, events: 0, ...(debug ? { debug: debugInfo } : {}) };
    }

    // 7. Insérer dans Supabase
    const supaResult = await insertToSupabase(events);
    log(`Supabase: ${supaResult.inserted} inséré(s), ${supaResult.errors || 0} erreur(s)`);
    step("insertToSupabase", supaResult);

    // 8. Insérer dans SQLite (si db fournie)
    const sqliteResult = await insertToSQLite(db, events);
    if (db) log(`SQLite: ${sqliteResult.inserted} inséré(s)`);

    log("========== Synchronisation terminée ==========");
    return { success: true, events: events.length, supabase: supaResult, sqlite: sqliteResult, ...(debug ? { debug: debugInfo } : {}) };
  } catch (err) {
    log(`ERREUR: ${err.message}`);
    step("error", err.message);
    return { success: false, error: err.message, ...(debug ? { debug: debugInfo } : {}) };
  }
}

// --- Démarrage planifié ---

let _currentIntervalMinutes = 15;
let _intervalHandle = null;
let _db = null;
let _lastSync = null;
let _lastResult = null;

function startIntratoneSync(db, intervalMinutes = 15) {
  _db = db;
  _currentIntervalMinutes = intervalMinutes;

  if (!INTRATONE.identifiant || !INTRATONE.mdp) {
    log("INTRATONE_EMAIL / INTRATONE_PASSWORD non configurés. Sync désactivée.");
    return;
  }

  log(`Synchronisation planifiée toutes les ${intervalMinutes} min`);

  // Première exécution 15s après le démarrage du serveur
  setTimeout(async () => {
    _lastSync = new Date().toISOString();
    _lastResult = await syncIntratone(db);
  }, 15000);

  // Puis toutes les X minutes
  _intervalHandle = setInterval(async () => {
    _lastSync = new Date().toISOString();
    _lastResult = await syncIntratone(db);
  }, intervalMinutes * 60 * 1000);
}

function getIntervalMinutes() {
  return _currentIntervalMinutes;
}

function setIntervalMinutes(minutes) {
  _currentIntervalMinutes = minutes;

  // Relancer le timer avec le nouvel intervalle
  if (_intervalHandle) {
    clearInterval(_intervalHandle);
  }

  log(`Intervalle changé à ${minutes} min`);

  _intervalHandle = setInterval(async () => {
    _lastSync = new Date().toISOString();
    _lastResult = await syncIntratone(_db);
  }, minutes * 60 * 1000);
}

function getLastSync() {
  return _lastSync;
}

function getLastResult() {
  return _lastResult;
}

module.exports = { syncIntratone, startIntratoneSync, getIntervalMinutes, setIntervalMinutes, getLastSync, getLastResult };
