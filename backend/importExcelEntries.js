
const XLSX = require("xlsx");
const sqlite3 = require("sqlite3").verbose();

/**
 * Importe les présences depuis un fichier Excel buffer
 * @param {Buffer} fileBuffer - Le contenu du fichier Excel
 * @param {string} dbPath - Chemin vers la base de données SQLite
 * @returns {Promise<number>} - Nombre de présences importées
 */
async function importExcelEntries(fileBuffer, dbPath) {
  const presenceWorkbook = XLSX.read(fileBuffer, { type: "buffer" });
  const presenceSheet = presenceWorkbook.Sheets[presenceWorkbook.SheetNames[0]];
  const presenceData = XLSX.utils.sheet_to_json(presenceSheet);

  const db = new sqlite3.Database(dbPath);

  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run(\`
        CREATE TABLE IF NOT EXISTS presences (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          badgeId TEXT,
          timestamp TEXT,
          UNIQUE(badgeId, timestamp)
        )
      \`);

      const insert = db.prepare(\`INSERT OR IGNORE INTO presences (badgeId, timestamp) VALUES (?, ?)\`);
      let inserted = 0;

      presenceData.forEach((entry) => {
        const badgeId = entry["Qui"]?.toString();
        const rawDate = entry["Quand"];
        if (!badgeId || !rawDate) return;

        const parts = rawDate.match(/(\d{2})\/(\d{2})\/(\d{2})\s(\d{2}):(\d{2})/);
        if (!parts) return;

        const [ , day, month, year, hour, minute ] = parts;
        const fullDate = new Date(\`20\${year}-\${month}-\${day}T\${hour}:\${minute}:00\`);
        if (isNaN(fullDate)) return;

        const timestamp = fullDate.toISOString();
        insert.run(badgeId, timestamp, function (err) {
          if (!err && this.changes > 0) inserted++;
        });
      });

      insert.finalize(() => {
        db.close();
        resolve(inserted);
      });
    });
  });
}

module.exports = importExcelEntries;
