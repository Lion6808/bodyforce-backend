// intratone-sync.js — Synchronisation automatique Intratone → Supabase
// Flux corrigé : Login → connect.php → evts.php → evts_recup → Attendre → evts_infos (Refresh) → evts_list → Parser → Supabase

const https = require("https");

// --- Configuration (variables d'environnement) ---
const INTRATONE = {
  identifiant: process.env.INTRATONE_EMAIL || "",
  mdp: process.env.INTRATONE_PASSWORD || "",
  device: process.env.INTRATONE_DEVICE || "0d24dac0-647c-4853-bfab-deda515fd2a4",
  installationId: process.env.INTRATONE_INSTALLATION_ID || "114449",
  recupId: process.env.INTRATONE_RECUP_ID || "91857", // ID du lecteur vu dans le HAR [cite: 26]
  host: "www.intratone.info",
};

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "";

// Délai d'attente après "Récupérer" avant de rafraîchir et lister (en ms)
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
    throw new Error(`Pas de session obtenue lors du login.`);
  }

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

// --- Etape 2 : Initialiser la session ---

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

// --- Etape 3 : Déclencher la récupération ---

async function triggerRecup(session) {
  const body = `id=${INTRATONE.recupId}`; // Utilise 918 [cite: 26]
  const res = await intratonePost(session, "/fr/data/events/evts_recup.php", body);
  const text = res.body.toString("utf-8");

  if (res.status === 200 && !text.includes('"type":-1')) {
    log("Récupération déclenchée depuis la centrale");
    return true;
  }
  log(`Avertissement evts_recup: ${text.substring(0, 100)}`);
  return false;
}

// --- Etape 4 : Rafraîchir le buffer (Action "Actualiser" du HAR) ---

async function refreshEventsBuffer(session) {
  // Simule l'appel vu dans le HAR qui déclenche Evts_Infos [cite: 46, 71]
  const res = await intratonePost(session, "/fr/data/events/evts_infos.php");
  const text = res.body.toString("utf-8");

  if (res.status === 200 && !text.includes('"type":-1')) {
    log("Buffer serveur actualisé (evts_infos OK)");
    return true;
  }
  return false;
}

// --- Etape 5 : Lister les événements ---

async function fetchEventsList(session) {
  const res = await intratonePost(session, "/fr/data/events/evts_list.php");
  if (res.status !== 200) throw new Error(`evts_list HTTP ${res.status}`);
  return res.body.toString("utf-8");
}

// --- Etape 6 : Parser le HTML ---

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
    while ((match = tdRegex.exec(row)) !== null) {
      tds.push(match[1]);
    }

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
      name: tds[4].replace(/<[^>]*>/g, "").replace(/\\n/g, "").trim() || null
    });
  }
  return events;
}

// --- Etape 7 : Supabase ---

async function insertToSupabase(events) {
  if (!events.length || !SUPABASE_URL || !SUPABASE_KEY) return { inserted: 0 };

  const batch = events.map((e) => ({ "badgeId": e.badgeId, "timestamp": e.timestamp }));
  const payload = JSON.stringify(batch);
  const parsedUrl = new URL(SUPABASE_URL);
  const restPath = parsedUrl.pathname.replace(/\/+$/, "") + "/rest/v1/presences";

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

  return { inserted: res.status >= 200 && res.status < 300 ? batch.length : 0 };
}

// --- Orchestrateur ---

async function syncIntratone(db, options = {}) {
  log("========== Début synchronisation ==========");
  try {
    const session = await login();
    await initSession(session);

    const recupOk = await triggerRecup(session);

    if (recupOk) {
      log(`Attente de ${RECUP_WAIT_MS / 1000}s...`);
      await wait(RECUP_WAIT_MS);
      
      // Nouvelle étape corrective issue du HAR 
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

    log("========== Fin synchronisation ==========");
    return { success: true, events: events.length, supabase: supaResult };
  } catch (err) {
    log(`ERREUR: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// --- Export & Planning ---

let _intervalHandle = null;

function startIntratoneSync(db, intervalMinutes = 5) {
  if (!INTRATONE.identifiant || !INTRATONE.mdp) return log("Config manquante.");
  
  log(`Sync planifiée: ${intervalMinutes} min`);
  
  // Premier lancement après 10s
  setTimeout(() => syncIntratone(db), 10000);

  _intervalHandle = setInterval(() => syncIntratone(db), intervalMinutes * 60 * 1000);
}

module.exports = { syncIntratone, startIntratoneSync };