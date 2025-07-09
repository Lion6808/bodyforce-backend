const fs = require("fs");
const path = require("path");
const readline = require("readline");
const sqlite3 = require("sqlite3").verbose();
const xlsx = require("xlsx");

const db = new sqlite3.Database(path.join(__dirname, "club.db"));

// Chargement des fichiers Excel
const residentsWB = xlsx.readFile("residants_2025_07_05_03_31_41.xlsx");
const badgesWB = xlsx.readFile("badges_2025_07_05_03_32_24.xlsx");

const residentsSheet = residentsWB.Sheets[residentsWB.SheetNames[0]];
const badgesSheet = badgesWB.Sheets[badgesWB.SheetNames[0]];

const residents = xlsx.utils.sheet_to_json(residentsSheet);
const badges = xlsx.utils.sheet_to_json(badgesSheet);

// Construction d'une map des badges par Appartement
const badgeMap = {};
badges.forEach((row) => {
  if (row.Appartement && row["Badges ou Télécommandes"]) {
    badgeMap[row.Appartement.trim()] = String(row["Badges ou Télécommandes"]);
  }
});

// Construction des membres à insérer
const members = residents.map((row) => {
  const apartment = String(row.Appartement || "").trim();
  const badgeId = badgeMap[apartment] || "";

  // Séparation du nom et prénom
  let fullName = row.Nom || "";
  let name = fullName;
  let firstName = "";

  if (fullName.includes(" ")) {
    const parts = fullName.trim().split(" ");
    name = parts[0];
    firstName = parts.slice(1).join(" ");
  }

  // Interprétation du sexe
  const sexeCell = (row.Prénom || "").toString().trim().toUpperCase();
  const gender = sexeCell === "F" ? "Femme" : "Homme";

  return {
    name,
    firstName,
    address: row.Adresse || "",
    phone: row.Téléphone || "",
    mobile: row.Portable || "",
    email: row.Email || "",
    badgeId: badgeId,
    birthdate: row["Date de Naissance"]
      ? new Date(row["Date de Naissance"]).toISOString().slice(0, 10)
      : null,
    gender: gender,
    subscriptionType: "Année civile",
    startDate: "2025-01-01",
    endDate: "2025-12-31",
    photo: null,
    files: "[]",
  };
});

// Fonction pour insérer les données dans SQLite
function insertMembers() {
  const stmt = db.prepare(`
    INSERT INTO members 
    (name, firstName, address, phone, mobile, email, badgeId, birthdate, gender, subscriptionType, startDate, endDate, photo, files)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  members.forEach((m) => {
    stmt.run(
      m.name,
      m.firstName,
      m.address,
      m.phone,
      m.mobile,
      m.email,
      m.badgeId,
      m.birthdate,
      m.gender,
      m.subscriptionType,
      m.startDate,
      m.endDate,
      m.photo,
      m.files
    );
  });

  stmt.finalize(() => {
    console.log(`✅ ${members.length} membres importés avec succès.`);
    db.close();
  });
}

// Confirmation utilisateur pour suppression
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.question("❗ Supprimer tous les membres existants avant import ? (o/n) ", (answer) => {
  if (answer.toLowerCase() === "o") {
    db.run("DELETE FROM members", (err) => {
      if (err) {
        console.error("Erreur de suppression :", err.message);
        db.close();
      } else {
        console.log("⚠️ Membres existants supprimés.");
        insertMembers();
      }
    });
  } else {
    insertMembers();
  }
  rl.close();
});
