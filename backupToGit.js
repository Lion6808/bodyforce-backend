// backupToGit.js
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// === CONFIGURATIONS ===
const BACKUP_FOLDER = "C:\\Body\\BackupGit"; // ✅ double antislash sinon erreur
const DB_FILE = path.join(__dirname, "backend", "club.db");
const UPLOAD_DIR = path.join(__dirname, "backend", "upload"); // ✅ Chemin absolu du dossier upload

// Crée le dossier principal de backup s'il n'existe pas
if (!fs.existsSync(BACKUP_FOLDER)) {
  fs.mkdirSync(BACKUP_FOLDER, { recursive: true });
}

// Création d'un sous-dossier horodaté
const now = new Date();
const timestamp = now.toISOString().replace(/[:.]/g, "-");
const backupSubfolder = path.join(BACKUP_FOLDER, `backup-${timestamp}`);
fs.mkdirSync(backupSubfolder, { recursive: true });

// === COPIE DE LA BASE DE DONNÉES ===
const dbTargetPath = path.join(backupSubfolder, "club.db");
fs.copyFileSync(DB_FILE, dbTargetPath);
console.log("📦 club.db copié dans", dbTargetPath);

// === COPIE DU DOSSIER UPLOAD (récursif) ===
function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  fs.readdirSync(src).forEach((item) => {
    const srcPath = path.join(src, item);
    const destPath = path.join(dest, item);
    if (fs.statSync(srcPath).isDirectory()) {
      copyRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  });
}

const uploadTargetPath = path.join(backupSubfolder, "upload");
copyRecursive(UPLOAD_DIR, uploadTargetPath);
console.log("📁 Dossier upload/ copié dans", uploadTargetPath);

// === SAUVEGARDE DANS GIT ===
console.log("➡️  Ajout des modifications dans Git...");
execSync("git add .");

try {
  execSync(`git commit -m "Sauvegarde du ${now.toLocaleString()}"`);
  console.log("✅ Commit des changements...");
} catch (error) {
  console.log("ℹ️ Aucun changement à committer.");
}

console.log("⬆️  Push vers GitHub...");
execSync("git push");

console.log("🎉 Sauvegarde complète terminée !");
