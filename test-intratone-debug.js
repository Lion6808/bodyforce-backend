// Debug v4 : utiliser le JWT token retourné par le login
try { require("dotenv").config(); } catch {}
if (!process.env.INTRATONE_EMAIL) {
  process.env.INTRATONE_EMAIL = "admin@bodyforce57";
  process.env.INTRATONE_PASSWORD = "BodyForce57&2022";
  process.env.INTRATONE_DEVICE = "0d24dac0-647c-4853-bfab-deda515fd2a4";
}

const https = require("https");

function httpReq(options, postData) {
  return new Promise((resolve, reject) => {
    const r = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
      );
    });
    r.on("error", reject);
    r.setTimeout(30000, () => r.destroy(new Error("timeout")));
    if (postData) r.write(postData);
    r.end();
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

(async () => {
  // 1. Login
  console.log("--- 1. Login ---");
  const loginBody = new URLSearchParams({
    identifiant: process.env.INTRATONE_EMAIL,
    mdp: process.env.INTRATONE_PASSWORD,
    device: process.env.INTRATONE_DEVICE,
  }).toString();

  const loginRes = await httpReq({
    hostname: "www.intratone.info",
    path: "/fr/connexion.php",
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(loginBody),
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
      Accept: "application/json, text/plain, */*",
      Origin: "https://www.intratone.info",
      Referer: "https://www.intratone.info/fr/",
    },
  }, loginBody);

  const cookies = parseCookies(loginRes.headers);
  const sid = cookies.PHPSESSID || cookies.Intratoneinfo;
  const cookieStr = `lng=%2Ffr%2F; PHPSESSID=${sid}; Intratoneinfo=${sid}`;

  // Parser la réponse login pour extraire le JWT
  const loginJson = JSON.parse(loginRes.body.toString("utf-8"));
  const jwt = loginJson.session?.jwt;
  console.log("SID:", sid);
  console.log("JWT:", jwt ? jwt.substring(0, 50) + "..." : "ABSENT");
  console.log("Login keys:", Object.keys(loginJson));
  console.log("Session keys:", loginJson.session ? Object.keys(loginJson.session) : "N/A");

  // 2. connect.php (initialise la session côté serveur)
  console.log("\n--- 2. connect.php ---");
  const connectBody = `SID=${sid}`;
  const connectRes = await httpReq({
    hostname: "www.intratone.info",
    path: `/fr/data/connect.php?SID=${sid}`,
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "Content-Length": Buffer.byteLength(connectBody),
      Cookie: cookieStr,
      token: jwt,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
      "X-Requested-With": "XMLHttpRequest",
      Accept: "*/*",
      Origin: "https://www.intratone.info",
      Referer: "https://www.intratone.info/fr/",
    },
  }, connectBody);
  const connectText = connectRes.body.toString("utf-8");
  console.log("connect.php:", connectRes.status);
  console.log(connectText.substring(0, 400));

  // Tester avec le header "token" contenant le JWT
  function makePost(path, body) {
    body = body || `SID=${sid}`;
    return httpReq({
      hostname: "www.intratone.info",
      path: `${path}?SID=${sid}`,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "Content-Length": Buffer.byteLength(body),
        Cookie: cookieStr,
        token: jwt,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
        "X-Requested-With": "XMLHttpRequest",
        Accept: "*/*",
        Origin: "https://www.intratone.info",
        Referer: "https://www.intratone.info/fr/",
      },
    }, body);
  }

  // 3. Naviguer vers événements (avec JWT + id installation)
  console.log("\n--- 3. events/evts.php (avec JWT + id=114449) ---");
  const evtsRes = await makePost("/fr/data/events/evts.php", `id=114449&SID=${sid}`);
  const evtsText = evtsRes.body.toString("utf-8");
  console.log("evts.php:", evtsRes.status, "len:", evtsText.length);
  console.log(evtsText.substring(0, 800));

  // 4. Récupérer
  console.log("\n--- 4. events/evts_recup.php (avec JWT) ---");
  const recupRes = await makePost("/fr/data/events/evts_recup.php");
  const recupText = recupRes.body.toString("utf-8");
  console.log("evts_recup:", recupRes.status, recupText.substring(0, 300));

  console.log("\nAttente 15s...");
  await new Promise(r => setTimeout(r, 15000));

  // 5. Lister
  console.log("\n--- 5. events/evts_list.php (avec JWT) ---");
  const listRes = await makePost("/fr/data/events/evts_list.php");
  const listText = listRes.body.toString("utf-8");
  console.log("evts_list:", listRes.status, "len:", listText.length);
  console.log(listText.substring(0, 2000));
})();
