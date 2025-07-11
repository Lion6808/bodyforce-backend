const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const XLSX = require("xlsx");
const fileDialog = require("node-file-dialog");

// Ouvrir l'explorateur pour sélectionner le fichier Excel
fileDialog({ type: "open-file", accept: ".xlsx" })
  .then((files) => {
    const excelFilePath = files[0];
    console.log("Fichier sélectionné :", excelFilePath);

    // Charger le fichier Excel des présences
    const presenceWorkbook = XLSX.readFile(excelFilePath);
    const presenceSheet = presenceWorkbook.Sheets[presenceWorkbook.SheetNames[0]];
    const presenceData = XLSX.utils.sheet_to_json(presenceSheet);

    // Connexion à la base
    const db = new sqlite3.Database("./club.db");

    const createTable = `
      CREATE TABLE IF NOT EXISTS presences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        badgeId TEXT,
        timestamp TEXT
      )
    `;

    db.run(createTable, (err) => {
      if (err) {
        console.error("Erreur création table presences:", err.message);
        db.close();
        return;
      }

      const insertPresenceStmt = db.prepare(
        `INSERT OR IGNORE INTO presences (badgeId, timestamp) VALUES (?, ?)`
      );

      let presenceInserted = 0;

      presenceData.forEach((entry) => {
        const badgeId = entry["Qui"]?.toString();
        const rawDate = entry["Quand"];

        if (!badgeId || !rawDate) return;

        const parts = rawDate.match(/(\d{2})\/(\d{2})\/(\d{2})\s(\d{2}):(\d{2})/);
        if (!parts) {
          console.warn("Date invalide ignorée :", rawDate);
          return;
        }

        const [, day, month, year, hour, minute] = parts;
        const fullDate = new Date(`20${year}-${month}-${day}T${hour}:${minute}:00`);

        if (isNaN(fullDate)) {
          console.warn("Date invalide ignorée :", rawDate);
          return;
        }

        const timestamp = fullDate.toISOString();

        insertPresenceStmt.run(badgeId, timestamp, function (err) {
          if (!err && this.changes > 0) presenceInserted++;
        });
      });

      insertPresenceStmt.finalize(() => {
        console.log(`Présences réellement insérées: ${presenceInserted}`);
        db.close();
      });
    });
  })
  .catch((err) => {
    console.error("Aucun fichier sélectionné ou erreur:", err.message);
  });
