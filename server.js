const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const sqlite3 = require("sqlite3").verbose();
const multer = require("multer");
const path = require("path");
const bcrypt = require("bcrypt");
const fs = require("fs");
const xlsx = require("xlsx");
const { Resend } = require("resend");
const { startIntratoneSync, syncIntratone, getIntervalMinutes, setIntervalMinutes, getLastSync, getLastResult } = require("./intratone-sync");

const app = express();
const port = process.env.PORT || 3001;

// --- Middleware global ---
const allowedOrigins = [
  "http://localhost:3000",
  "https://bodyforce-frontend.onrender.com"
];

app.use(
  cors({
    origin: function (origin, callback) {
      // Autoriser les requêtes sans origin (comme les appels API directs)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("CORS non autorisé"), false);
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);
app.use(helmet());
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));
// Servir les fichiers avec en-tête CORS personnalisé
app.use(
  "/upload",
  (req, res, next) => {
    const origin = req.headers.origin;
    if (allowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization"
    );
    next();
  },
  express.static(path.join(__dirname, "upload"))
);

// --- Création des dossiers upload si inexistants ---
const ensureDir = (dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};
ensureDir(path.join(__dirname, "upload/photos"));
ensureDir(path.join(__dirname, "upload/files"));

// --- Connexions aux bases de données ---
const db = new sqlite3.Database("./club.db");
const usersDb = new sqlite3.Database("./users.db");

// --- Configuration Resend pour l'envoi d'emails ---
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

if (resend) {
  console.log("Service email Resend configuré et prêt");
} else {
  console.warn("Variable RESEND_API_KEY non définie - Email désactivé");
}

// --- Logging simple ---
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// --- Middleware pour injecter les infos user depuis Authorization ---
app.use((req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader) {
      req.user = JSON.parse(authHeader);
    } else {
      req.user = null;
    }
  } catch (e) {
    console.error("Erreur parsing Authorization:", e);
    req.user = null;
  }
  next();
});

// --- Middleware isAuthenticated ---
function isAuthenticated(req, res, next) {
  if (!req.user) {
    console.warn("Accès refusé. Aucun utilisateur authentifié.");
    return res.status(401).json({ error: "Authentification requise" });
  }
  next();
}

// --- Middleware isAdmin ---
function isAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    console.warn("Accès refusé à /api/users. Utilisateur :", req.user);
    return res.status(403).json({ error: "Accès interdit (admin uniquement)" });
  }
  next();
}

// --- Configuration Multer ---
const photoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "upload/photos/"),
  filename: (req, file, cb) => cb(null, `${Date.now()}_${file.originalname}`),
});
const fileStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "upload/files/"),
  filename: (req, file, cb) => cb(null, `${Date.now()}_${file.originalname}`),
});
const uploadPhoto = multer({
  storage: photoStorage,
  fileFilter: (req, file, cb) => {
    const allowedTypes = ["image/jpeg", "image/png", "image/gif"];
    if (!allowedTypes.includes(file.mimetype)) {
      return cb(
        new Error(
          "Type de fichier non supporté. Seuls JPG, PNG et GIF sont autorisés."
        )
      );
    }
    cb(null, true);
  },
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});
const uploadFile = multer({
  storage: fileStorage,
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/gif",
      "application/pdf",
    ];
    if (!allowedTypes.includes(file.mimetype)) {
      return cb(
        new Error(
          "Type de fichier non supporté. Seuls JPG, PNG, GIF et PDF sont autorisés."
        )
      );
    }
    cb(null, true);
  },
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

// --- Middleware de gestion des erreurs Multer ---
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: `Erreur Multer: ${err.message}` });
  }
  if (err) {
    return res.status(400).json({ error: err.message });
  }
  next();
});

// --- Routes Upload ---
app.post("/upload/photos", uploadPhoto.single("photo"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Aucun fichier reçu" });
  }
  console.log("Photo uploadée:", req.file.filename);
  res.json({ url: `/upload/photos/${req.file.filename}` });
});

app.post("/upload/files", uploadFile.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Aucun fichier reçu" });
  }
  console.log("Fichier uploadé:", req.file.filename);
  res.json({
    name: req.file.originalname,
    url: `/upload/files/${req.file.filename}`,
  });
});

// --- Supprimer un fichier uploadé ---
app.delete("/api/files", isAuthenticated, (req, res) => {
  const { path: filePath } = req.body;
  if (!filePath) {
    console.warn("Requête DELETE /api/files sans chemin de fichier");
    return res.status(400).json({ error: "Chemin du fichier requis" });
  }

  const fullPath = path.join(__dirname, filePath);
  console.log(
    `Requête DELETE reçue - Chemin: ${filePath}, Chemin complet: ${fullPath}, Utilisateur: ${JSON.stringify(
      req.user
    )}`
  );

  // Vérifier que le chemin est dans le dossier "upload"
  if (!fullPath.startsWith(path.join(__dirname, "upload"))) {
    console.warn(`Chemin invalide: ${fullPath}`);
    return res.status(400).json({ error: "Chemin invalide" });
  }

  // Vérifier si le fichier existe
  if (!fs.existsSync(fullPath)) {
    console.warn(`Fichier introuvable: ${fullPath}`);
    return res.status(404).json({ error: "Fichier introuvable" });
  }

  fs.unlink(fullPath, (err) => {
    if (err) {
      console.error("Erreur suppression fichier:", err.message);
      return res
        .status(500)
        .json({
          error: `Erreur lors de la suppression du fichier: ${err.message}`,
        });
    }
    console.log(`Fichier supprimé: ${fullPath}`);
    res.json({
      success: true,
      message: `Fichier ${path.basename(filePath)} supprimé`,
    });
  });
});

// --- Authentification ---
app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Champs requis manquants" });
  }

  usersDb.get(
    "SELECT * FROM users WHERE username = ?",
    [username],
    (err, user) => {
      if (err || !user) {
        return res.status(401).json({ error: "Utilisateur inconnu" });
      }

      bcrypt.compare(password, user.passwordHash, (err, match) => {
        if (err || !match) {
          return res.status(401).json({ error: "Mot de passe incorrect" });
        }
        res.json({ id: user.id, username: user.username, role: user.role });
      });
    }
  );
});

// --- Gestion des utilisateurs ---
app.get("/api/users", isAdmin, (req, res) => {
  console.log("Route GET /api/users appelée par :", req.user);
  usersDb.all("SELECT id, username, role FROM users", (err, rows) => {
    if (err) {
      console.error("Erreur SQL /api/users:", err.message);
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

app.post("/api/users", isAdmin, async (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password || !role) {
    return res.status(400).json({ error: "Tous les champs sont requis" });
  }

  const hash = await bcrypt.hash(password, 10);
  usersDb.run(
    "INSERT INTO users (username, passwordHash, role) VALUES (?, ?, ?)",
    [username, hash, role],
    function (err) {
      if (err) {
        return res.status(400).json({ error: err.message });
      }
      res.json({ id: this.lastID, username, role });
    }
  );
});

app.put("/api/users/:id", async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  const userId = parseInt(req.params.id);
  const currentUserId = parseInt(req.user?.id);
  const isAdminUser = req.user?.role === "admin";

  usersDb.get(
    "SELECT * FROM users WHERE id = ?",
    [userId],
    async (err, user) => {
      if (err || !user) {
        return res.status(404).json({ error: "Utilisateur non trouvé" });
      }

      if (!isAdminUser && userId !== currentUserId) {
        return res.status(403).json({ error: "Non autorisé" });
      }

      const isValid = await bcrypt.compare(oldPassword, user.passwordHash);
      if (!isValid) {
        return res.status(401).json({ error: "Ancien mot de passe incorrect" });
      }

      const newHash = await bcrypt.hash(newPassword, 10);
      usersDb.run(
        "UPDATE users SET passwordHash = ? WHERE id = ?",
        [newHash, userId],
        (err) => {
          if (err) {
            return res.status(500).json({ error: err.message });
          }
          res.json({ success: true });
        }
      );
    }
  );
});

app.delete("/api/users/:id", isAdmin, (req, res) => {
  usersDb.run(
    "DELETE FROM users WHERE id = ?",
    [req.params.id],
    function (err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ success: true });
    }
  );
});

// --- Route GET /api/members ---
app.get("/api/members", (req, res) => {
  db.all("SELECT * FROM members", (err, rows) => {
    if (err) {
      console.error("Erreur requête SQL :", err.message);
      return res.status(500).json({ error: err.message });
    }
    const members = rows.map((row) => ({
      ...row,
      files: JSON.parse(row.files || "[]"),
      etudiant: !!row.etudiant,
    }));
    res.json(members);
  });
});

// --- Route GET /api/presences ---
app.get("/api/presences", (req, res) => {
  db.all("SELECT * FROM presences", (err, rows) => {
    if (err) {
      console.error(
        "Erreur lors de la récupération des présences :",
        err.message
      );
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// --- Route POST /api/members ---
app.post("/api/members", (req, res) => {
  const {
    name,
    firstName,
    birthdate,
    gender,
    address,
    phone,
    mobile,
    email,
    subscriptionType,
    startDate,
    endDate,
    badgeId,
    files,
    photo,
    etudiant,
  } = req.body;

  const sql = `
    INSERT INTO members (
      name, firstName, birthdate, gender,
      address, phone, mobile, email,
      subscriptionType, startDate, endDate,
      badgeId, files, photo, etudiant
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  db.run(
    sql,
    [
      name,
      firstName,
      birthdate,
      gender,
      address,
      phone,
      mobile,
      email,
      subscriptionType,
      startDate,
      endDate,
      badgeId,
      JSON.stringify(files || []),
      photo,
      etudiant ? 1 : 0,
    ],
    function (err) {
      if (err) {
        console.error("Erreur INSERT membre :", err.message);
        return res
          .status(500)
          .json({ error: "Erreur lors de la création du membre." });
      }
      res.json({ id: this.lastID });
    }
  );
});

// --- Route PUT /api/members/:id ---
app.put("/api/members/:id", (req, res) => {
  const id = req.params.id;
  const {
    name,
    firstName,
    birthdate,
    gender,
    address,
    phone,
    mobile,
    email,
    subscriptionType,
    startDate,
    endDate,
    badgeId,
    files,
    photo,
    etudiant,
  } = req.body;

  const sql = `
    UPDATE members SET
      name = ?, firstName = ?, birthdate = ?, gender = ?,
      address = ?, phone = ?, mobile = ?, email = ?,
      subscriptionType = ?, startDate = ?, endDate = ?,
      badgeId = ?, files = ?, photo = ?, etudiant = ?
    WHERE id = ?
  `;

  db.run(
    sql,
    [
      name,
      firstName,
      birthdate,
      gender,
      address,
      phone,
      mobile,
      email,
      subscriptionType,
      startDate,
      endDate,
      badgeId,
      JSON.stringify(files || []),
      photo,
      etudiant ? 1 : 0,
      id,
    ],
    function (err) {
      if (err) {
        console.error("Erreur UPDATE membre :", err.message);
        return res
          .status(500)
          .json({ error: "Erreur lors de la mise à jour du membre." });
      }
      res.json({ success: true });
    }
  );
});

// --- Route POST /api/import-events ---
app.post("/api/import-events", isAdmin, (req, res) => {
  const excelPath = path.join(__dirname, "upload", "presences.xlsx");
  if (!fs.existsSync(excelPath)) {
    return res
      .status(404)
      .json({ error: "Fichier Excel non trouvé (upload/presences.xlsx)" });
  }

  const workbook = xlsx.readFile(excelPath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = xlsx.utils.sheet_to_json(sheet);

  let inserted = 0;
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO presences (badgeId, timestamp) VALUES (?, ?)"
  );

  for (const row of data) {
    if (row.badgeId && row.timestamp) {
      stmt.run(row.badgeId, row.timestamp, (err) => {
        if (!err) inserted++;
      });
    }
  }

  stmt.finalize(() => {
    res.json({ success: true, imported: inserted });
  });
});

// --- Route temporaire pour télécharger la base club.db ---
app.get("/download/clubdb", (req, res) => {
  const dbPath = path.join(__dirname, "club.db");
  if (fs.existsSync(dbPath)) {
    res.download(dbPath, "club.db");
  } else {
    res.status(404).json({ error: "Base club.db introuvable" });
  }
});

// Route DANGEREUSE — à utiliser temporairement
app.delete("/api/cleanup", (req, res) => {
  const folders = ["./upload/files", "./upload/photos"];

  try {
    folders.forEach((folderPath) => {
      if (fs.existsSync(folderPath)) {
        const files = fs.readdirSync(folderPath);
        files.forEach((file) => {
          const fullPath = path.join(folderPath, file);
          if (fs.lstatSync(fullPath).isFile()) {
            fs.unlinkSync(fullPath);
          }
        });
      }
    });

    res.json({ message: "Tous les fichiers supprimés avec succès." });
  } catch (error) {
    console.error("Erreur lors du nettoyage :", error);
    res.status(500).json({ error: "Échec de la suppression des fichiers." });
  }
});

// --- Route pour lister les fichiers dans upload/photos et upload/files ---
app.get("/api/list-files", (req, res) => {
  const result = {};
  const folders = ["./upload/files", "./upload/photos"];

  try {
    folders.forEach((folder) => {
      const files = fs.existsSync(folder) ? fs.readdirSync(folder) : [];
      result[folder] = files;
    });
    res.json(result);
  } catch (err) {
    console.error("Erreur lors du listing des fichiers :", err);
    res.status(500).json({ error: "Erreur lors du listing des fichiers." });
  }
});

// --- Routes Email (Resend) ---

// Fonction utilitaire pour le throttling (respect limite Resend: 2 emails/seconde)
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

app.post("/api/email/send", isAdmin, async (req, res) => {
  const { recipients, subject, body } = req.body;

  // Validation
  if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
    return res.status(400).json({ error: "Liste de destinataires requise" });
  }
  if (!subject || !body) {
    return res.status(400).json({ error: "Sujet et contenu requis" });
  }

  // Vérifier configuration Resend
  if (!resend) {
    return res.status(500).json({ error: "Configuration email non définie sur le serveur" });
  }

  const results = {
    sent: [],
    failed: [],
  };

  console.log(`Début envoi de ${recipients.length} email(s) avec throttling (2/sec)...`);

  // Envoyer les emails avec throttling (2 par seconde max)
  for (let i = 0; i < recipients.length; i++) {
    const recipient = recipients[i];

    try {
      const htmlContent = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; text-align: center;">
            <h1 style="color: white; margin: 0;">BodyForce</h1>
          </div>
          <div style="padding: 20px; background: #f9f9f9;">
            <p>Bonjour ${recipient.firstName || recipient.name || ""},</p>
            ${body.replace(/\n/g, "<br>")}
          </div>
          <div style="padding: 15px; background: #333; color: #999; text-align: center; font-size: 12px;">
            <p style="margin: 0;">BodyForce Club - Votre salle de sport</p>
          </div>
        </div>
      `;

      await resend.emails.send({
        from: "BodyForce Club <contact@at7.fr>",
        to: recipient.email,
        subject: subject,
        html: htmlContent,
      });

      results.sent.push({ email: recipient.email, name: recipient.firstName || recipient.name });
      console.log(`[${i + 1}/${recipients.length}] Email envoyé à: ${recipient.email}`);
    } catch (error) {
      console.error(`[${i + 1}/${recipients.length}] Erreur envoi email à ${recipient.email}:`, error.message);
      results.failed.push({ email: recipient.email, error: error.message });
    }

    // Throttling: attendre 550ms après chaque email (≈ 1.8 emails/sec, sous la limite de 2/sec)
    // On attend sauf si c'est le dernier email
    if (i < recipients.length - 1) {
      await delay(550);
    }
  }

  console.log(`Envoi terminé: ${results.sent.length} succès, ${results.failed.length} échec(s)`);

  res.json({
    success: results.failed.length === 0,
    message: `${results.sent.length} email(s) envoyé(s), ${results.failed.length} échec(s)`,
    results,
  });
});

// Route pour tester la configuration email
app.get("/api/email/status", isAdmin, (req, res) => {
  const configured = !!resend;
  res.json({
    configured,
    service: configured ? "Resend" : null,
  });
});

// --- Routes Intratone ---
app.post("/api/intratone/sync", isAdmin, async (req, res) => {
  try {
    const debug = req.query.debug === "1" || req.body?.debug === true;
    const result = await syncIntratone(db, { debug });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/intratone/status", isAdmin, (req, res) => {
  res.json({
    intervalMinutes: getIntervalMinutes(),
    lastSync: getLastSync(),
    lastResult: getLastResult(),
  });
});

app.put("/api/intratone/interval", isAdmin, (req, res) => {
  const { minutes } = req.body;
  if (!minutes || typeof minutes !== "number" || minutes < 5 || minutes > 120) {
    return res.status(400).json({ error: "Intervalle invalide (5-120 minutes)" });
  }
  setIntervalMinutes(minutes);
  res.json({ success: true, intervalMinutes: minutes });
});

// --- Lancement Render-compatible ---
app.listen(port, () => {
  console.log(`Serveur lancé sur le port ${port}`);

  // Démarrer la sync automatique Intratone (toutes les 15 min)
  startIntratoneSync(db, 15);
});
