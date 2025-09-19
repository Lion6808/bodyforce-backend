// 📄 src/supabaseClient.js — BodyForce
// ------------------------------------------------------------
// ✅ Ce fichier centralise :
// - la création du client Supabase
// - des helpers d’upload "egress-friendly" (cacheControl long, upsert)
// - un cache mémoire pour les publicUrl (évite de régénérer à chaque rendu)
// - un ensemble de services organisés (members, presences, messages, payments, files, stats)
// ------------------------------------------------------------

import { createClient } from "@supabase/supabase-js";

/* ------------------------------------------------------------------
   1) Client Supabase (env)
------------------------------------------------------------------- */
export const supabase = createClient(
  process.env.REACT_APP_SUPABASE_URL,
  process.env.REACT_APP_SUPABASE_KEY
);

/* ------------------------------------------------------------------
   2) Helpers egress-friendly
      - Cache mémoire des publicUrl
      - Uploads avec cacheControl=1 an
      - Conventions buckets: "photo" (avatars), "documents" (certificats)
------------------------------------------------------------------- */

// Mémo simple des URLs publiques pour éviter de les recalculer/régénérer à chaque rendu.
const publicUrlCache = new Map(); // key: `${bucket}/${path}` -> url string

/**
 * getPublicUrlCached(bucket, path)
 * Retourne l'URL publique Supabase Storage avec un petit cache mémoire.
 */
export const getPublicUrlCached = (bucket, path) => {
  if (!bucket || !path) return "";
  const key = `${bucket}/${path}`;
  const cached = publicUrlCache.get(key);
  if (cached) return cached;

  const { data, error } = supabase.storage.from(bucket).getPublicUrl(path);
  if (error) {
    // On reste silencieux (on renvoie chaîne vide) pour ne pas casser l'UI
    return "";
  }
  const url = data?.publicUrl || "";
  if (url) publicUrlCache.set(key, url);
  return url;
};

/**
 * uploadWithCacheControl(bucket, path, fileOrBlob, opts?)
 * Upload générique avec upsert et cache long (1 an) par défaut.
 */
export const uploadWithCacheControl = async (bucket, path, fileOrBlob, opts = {}) => {
  const options = {
    upsert: true,
    cacheControl: "31536000", // 1 an
    ...opts,
  };
  const { data, error } = await supabase.storage.from(bucket).upload(path, fileOrBlob, options);
  if (error) throw error;

  // Invalide l'URL mémorisée si on réécrit le même objet
  publicUrlCache.delete(`${bucket}/${path}`);
  return data;
};

// Conventions projet
export const uploadPhoto = (path, file, opts) =>
  uploadWithCacheControl("photo", path, file, opts);
export const uploadDocument = (path, file, opts) =>
  uploadWithCacheControl("documents", path, file, opts);

// Raccourcis d’URL publiques
export const getPhotoUrl = (path) => getPublicUrlCached("photo", path);
export const getDocumentUrl = (path) => getPublicUrlCached("documents", path);

/* ------------------------------------------------------------------
   3) Utilitaires communs (pagination, sécurité)
------------------------------------------------------------------- */

/**
 * paginate(query, { page = 0, limit = 50 })
 * Applique .range() à une requête Supabase.
 */
const paginate = (query, { page = 0, limit = 50 } = {}) => {
  const from = page * limit;
  const to = from + limit - 1;
  return query.range(from, to);
};

/* ------------------------------------------------------------------
   4) Services : MEMBERS
      Table: "members" (id, firstName, lastName, sex, student, photo, ... )
------------------------------------------------------------------- */

const MembersService = {
  async list({ page = 0, limit = 50, select = "id, firstName, lastName, sex, student, photo, startDate, endDate, subscriptionType" } = {}) {
    let q = supabase.from("members").select(select, { count: "exact", head: false }).order("lastName", { ascending: true });
    q = paginate(q, { page, limit });
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  },

  async getById(id, { select = "*" } = {}) {
    const { data, error } = await supabase.from("members").select(select).eq("id", id).single();
    if (error) throw error;
    return data;
  },

  async create(payload) {
    // ⚠️ Veille: certains schémas exigent .select().single() pour renvoyer la ligne
    const { data, error } = await supabase.from("members").insert(payload).select().single();
    if (error) throw error;
    return data;
  },

  async update(id, payload) {
    const { data, error } = await supabase.from("members").update(payload).eq("id", id).select().maybeSingle();
    if (error) throw error;
    return data;
  },

  async remove(id) {
    const { error } = await supabase.from("members").delete().eq("id", id);
    if (error) throw error;
    return true;
  },
};

/* ------------------------------------------------------------------
   5) Services : PRESENCES
      Table: "presences" (id, badgeId, timestamp) et/ou vue jointe
------------------------------------------------------------------- */

const PresencesService = {
  /**
   * getRange({ from, to, page, limit })
   * Récupère les presences entre deux dates ISO (incluses).
   */
  async getRange({ from, to, page = 0, limit = 500 }) {
    let q = supabase
      .from("presences")
      .select("id, badgeId, timestamp", { head: false })
      .gte("timestamp", from)
      .lte("timestamp", to)
      .order("timestamp", { ascending: true });

    q = paginate(q, { page, limit });
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  },
};

/* ------------------------------------------------------------------
   6) Services : MESSAGES
      - RPC "send_message" côté DB (si existant)
      - v_inbox / v_outbox (vues) pour lecture
      - table "message_recipients" pour le fallback d’envoi
------------------------------------------------------------------- */

const MessagesService = {
  /**
   * send({ sender_member_id, recipients: [memberId...], body, attachments? })
   * Utilise l'RPC "send_message" si dispo, sinon fallback insertion manuelle.
   */
  async send({ sender_member_id, recipients = [], body, attachments = null }) {
    // 1) Essai RPC (à privilégier)
    const { data, error } = await supabase.rpc("send_message", {
      p_sender_member_id: sender_member_id,
      p_recipient_member_ids: recipients,
      p_body: body,
      p_attachments: attachments,
    });

    if (!error) return data;

    // 2) Fallback manuel (si pas d'RPC ou RLS spécifique)
    //   a) insert "messages"
    const { data: msg, error: e1 } = await supabase
      .from("messages")
      .insert({ sender_member_id, body, attachments })
      .select("id")
      .single();
    if (e1) throw e1;

    //   b) insert "message_recipients"
    if (recipients?.length) {
      const rows = recipients.map((rid) => ({ message_id: msg.id, recipient_member_id: rid }));
      const { error: e2 } = await supabase.from("message_recipients").insert(rows);
      if (e2) throw e2;
    }
    return { id: msg.id };
  },

  async inbox(memberId, { page = 0, limit = 50 }) {
    // Utilise une vue "v_inbox" si elle existe, sinon jointure simple
    let q = supabase.from("v_inbox").select("*").eq("recipient_member_id", memberId).order("created_at", { ascending: false });
    q = paginate(q, { page, limit });
    const { data, error } = await q;
    if (!error && data) return data;

    // Fallback si pas de vue
    let q2 = supabase
      .from("messages")
      .select("id, created_at, body, sender_member_id, message_recipients (recipient_member_id)")
      .contains("message_recipients", [{ recipient_member_id: memberId }])
      .order("created_at", { ascending: false });
    q2 = paginate(q2, { page, limit });
    const { data: d2, error: e2 } = await q2;
    if (e2) throw e2;
    return d2 || [];
  },

  async outbox(memberId, { page = 0, limit = 50 }) {
    let q = supabase.from("v_outbox").select("*").eq("sender_member_id", memberId).order("created_at", { ascending: false });
    q = paginate(q, { page, limit });
    const { data, error } = await q;
    if (!error && data) return data;

    // Fallback si pas de vue
    let q2 = supabase
      .from("messages")
      .select("id, created_at, body, sender_member_id, message_recipients (recipient_member_id)")
      .eq("sender_member_id", memberId)
      .order("created_at", { ascending: false });
    q2 = paginate(q2, { page, limit });
    const { data: d2, error: e2 } = await q2;
    if (e2) throw e2;
    return d2 || [];
  },
};

/* ------------------------------------------------------------------
   7) Services : PAYMENTS (basique)
      Table: "payments" (id, member_id, amount, due_date, paid, method, ...)
------------------------------------------------------------------- */

const PaymentsService = {
  async list({ page = 0, limit = 50, select = "id, member_id, amount, due_date, paid, method, created_at" } = {}) {
    let q = supabase.from("payments").select(select).order("due_date", { ascending: true });
    q = paginate(q, { page, limit });
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  },

  async forMember(memberId, { page = 0, limit = 100, select = "id, member_id, amount, due_date, paid, method, created_at" } = {}) {
    let q = supabase.from("payments").select(select).eq("member_id", memberId).order("due_date", { ascending: true });
    q = paginate(q, { page, limit });
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  },
};

/* ------------------------------------------------------------------
   8) Services : FILES (lecture URL, suppression)
------------------------------------------------------------------- */

const FilesService = {
  photoUrl(path) {
    return getPhotoUrl(path);
  },
  documentUrl(path) {
    return getDocumentUrl(path);
  },
  async removePhoto(path) {
    const { error } = await supabase.storage.from("photo").remove([path]);
    if (error) throw error;
    publicUrlCache.delete(`photo/${path}`);
    return true;
  },
  async removeDocument(path) {
    const { error } = await supabase.storage.from("documents").remove([path]);
    if (error) throw error;
    publicUrlCache.delete(`documents/${path}`);
    return true;
  },
};

/* ------------------------------------------------------------------
   9) Services : STATS (exemple simple, à compléter selon tes besoins)
------------------------------------------------------------------- */

const StatsService = {
  /**
   * getDashboard()
   * Exemple minimal: compte membres, présences période récente.
   */
  async getDashboard({ from, to } = {}) {
    // Compte membres (estimation plus rapide qu'exact)
    const { count: membersCount, error: e1 } = await supabase.from("members").select("*", { count: "estimated", head: true });
    if (e1) throw e1;

    // Compte presences sur la période si fournie
    let presencesCount = 0;
    if (from && to) {
      const { count, error: e2 } = await supabase
        .from("presences")
        .select("*", { count: "estimated", head: true })
        .gte("timestamp", from)
        .lte("timestamp", to);
      if (e2) throw e2;
      presencesCount = count || 0;
    }

    return { membersCount: membersCount || 0, presencesCount };
  },
};

/* ------------------------------------------------------------------
   10) supabaseServices — agrégateur exporté (compatibilité)
------------------------------------------------------------------- */

export const supabaseServices = {
  members: MembersService,
  presences: PresencesService,
  messages: MessagesService,
  payments: PaymentsService,
  files: FilesService,
  stats: StatsService,

  // Raccourcis utiles déjà prêts si tu préfères un import unique
  uploadPhoto,
  uploadDocument,
  getPhotoUrl,
  getDocumentUrl,
  getPublicUrlCached,
};

/* ------------------------------------------------------------------
   NOTES D’INTÉGRATION :
   - Remplace dans le code appelant les uploads directs par les helpers :
       await supabase.storage.from('photo').upload(path, file, { upsert: true })
         → await uploadPhoto(path, file)
       await supabase.storage.from('documents').upload(path, file, { upsert: true })
         → await uploadDocument(path, file)
   - Ne pas ajouter de query params type ?t=Date.now() aux URLs d’images.
   - Pour les listes longues : limiter les colonnes (pas de select('*')), paginer.
   - Les publicUrl sont mémorisées en mémoire (publicUrlCache)
------------------------------------------------------------------- */
