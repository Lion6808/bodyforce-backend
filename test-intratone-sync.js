// Test ponctuel de la synchronisation Intratone
// Usage: node test-intratone-sync.js

try { require("dotenv").config(); } catch {}

if (!process.env.INTRATONE_EMAIL) {
  process.env.INTRATONE_EMAIL = "admin@bodyforce57";
  process.env.INTRATONE_PASSWORD = "BodyForce57&2022";
  process.env.INTRATONE_DEVICE = "0d24dac0-647c-4853-bfab-deda515fd2a4";
  process.env.INTRATONE_INSTALLATION_ID = "114449";
}

// Pas d'attente recup pour le test (les événements sont déjà en mémoire)
process.env.INTRATONE_RECUP_WAIT_MS = "5000";

const { syncIntratone } = require("./intratone-sync");

(async () => {
  console.log("=== TEST INTRATONE SYNC ===\n");
  console.log("SUPABASE_URL:", process.env.SUPABASE_URL ? "configuré" : "NON configuré (skip insertion)");
  console.log("");

  const result = await syncIntratone(null);

  console.log("\n=== RESULTAT ===");
  console.log(JSON.stringify(result, null, 2));
})();
