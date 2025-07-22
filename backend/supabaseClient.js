// src/supabaseClient.js - Adapté à votre structure existante
import { createClient } from '@supabase/supabase-js';

// Variables d'environnement
const supabaseUrl = process.env.REACT_APP_SUPABASE_URL || 'https://hpgcqrsxttflutdsasar.supabase.co';
const supabaseKey = process.env.REACT_APP_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhwZ2NxcnN4dHRmbHV0ZHNhc2FyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTI0MjEzMTYsImV4cCI6MjA2Nzk5NzMxNn0.7gecaEShO4oUStTcL9Xi-sJni9Pkb4d3mV5OVWxxiyM';

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true
  }
});

// Services adaptés à votre structure de base de données
export const supabaseServices = {
  // === MEMBRES ===
  async getMembers() {
    const { data, error } = await supabase
      .from('members')
      .select('*')
      .order('name', { ascending: true });
    
    if (error) {
      console.error('Erreur getMembers:', error);
      throw error;
    }
    
    // Transformer les données pour compatibilité avec le frontend
    return (data || []).map(member => ({
      ...member,
      // Assurer la compatibilité avec les fichiers JSON
      files: member.files || [],
      etudiant: !!member.etudiant
    }));
  },

  async getMemberById(id) {
    const { data, error } = await supabase
      .from('members')
      .select('*')
      .eq('id', id)
      .single();
    
    if (error) {
      if (error.code === 'PGRST116') {
        return null; // Pas trouvé
      }
      console.error('Erreur getMemberById:', error);
      throw error;
    }
    
    return {
      ...data,
      files: data.files || [],
      etudiant: !!data.etudiant
    };
  },

  async getMemberByBadgeId(badgeId) {
    const { data, error } = await supabase
      .from('members')
      .select('*')
      .eq('badgeId', badgeId)
      .single();
    
    if (error) {
      if (error.code === 'PGRST116') {
        return null; // Pas trouvé
      }
      console.error('Erreur getMemberByBadgeId:', error);
      throw error;
    }
    
    return {
      ...data,
      files: data.files || [],
      etudiant: !!data.etudiant
    };
  },

  async createMember(memberData) {
    const { data, error } = await supabase
      .from('members')
      .insert([memberData])
      .select()
      .single();
    
    if (error) {
      console.error('Erreur createMember:', error);
      throw error;
    }
    
    return data;
  },

  async updateMember(id, memberData) {
    const { data, error } = await supabase
      .from('members')
      .update(memberData)
      .eq('id', id)
      .select()
      .single();
    
    if (error) {
      console.error('Erreur updateMember:', error);
      throw error;
    }
    
    return data;
  },

  async deleteMember(id) {
    // Supprimer d'abord les paiements liés (cascade devrait le faire automatiquement)
    const { error } = await supabase
      .from('members')
      .delete()
      .eq('id', id);
    
    if (error) {
      console.error('Erreur deleteMember:', error);
      throw error;
    }
  },

  // === PRÉSENCES ===
  async getPresences(startDate = null, endDate = null, badgeId = null) {
    let query = supabase
      .from('presences')
      .select('*')
      .order('timestamp', { ascending: false });

    // Filtres de dates
    if (startDate) {
      query = query.gte('timestamp', startDate.toISOString());
    }
    if (endDate) {
      query = query.lte('timestamp', endDate.toISOString());
    }
    if (badgeId) {
      query = query.eq('badgeId', badgeId);
    }

    const { data, error } = await query;
    
    if (error) {
      console.error('Erreur getPresences:', error);
      throw error;
    }
    
    return data || [];
  },

  async getPresencesWithMembers(startDate = null, endDate = null) {
    // Récupérer les présences
    const presences = await this.getPresences(startDate, endDate);
    
    // Récupérer tous les membres pour faire le mapping
    const members = await this.getMembers();
    const membersMap = {};
    members.forEach(m => {
      if (m.badgeId) {
        membersMap[m.badgeId] = m;
      }
    });
    
    // Enrichir les présences avec les données membres
    return presences.map(presence => ({
      ...presence,
      member: membersMap[presence.badgeId] || null
    }));
  },

  async createPresence(badgeId, timestamp = new Date()) {
    const { data, error } = await supabase
      .from('presences')
      .insert([{
        badgeId,
        timestamp: timestamp.toISOString()
      }])
      .select()
      .single();

    if (error) {
      // Gerer le cas de doublons (contrainte unique)
      if (error.code === '23505') {
        console.warn('Présence déjà enregistrée:', badgeId, timestamp);
        return null;
      }
      console.error('Erreur createPresence:', error);
      throw error;
    }
    
    return data;
  },

  async deletePresence(id) {
    const { error } = await supabase
      .from('presences')
      .delete()
      .eq('id', id);
    
    if (error) {
      console.error('Erreur deletePresence:', error);
      throw error;
    }
  },

  async deletePresencesByBadgeId(badgeId) {
    const { error } = await supabase
      .from('presences')
      .delete()
      .eq('badgeId', badgeId);
    
    if (error) {
      console.error('Erreur deletePresencesByBadgeId:', error);
      throw error;
    }
  },

  // === PAIEMENTS ===
  async getPayments(memberId = null) {
    let query = supabase
      .from('payments')
      .select(`
        *,
        member:members(id, name, firstName, badgeId)
      `)
      .order('date_paiement', { ascending: false });

    if (memberId) {
      query = query.eq('member_id', memberId);
    }

    const { data, error } = await query;
    
    if (error) {
      console.error('Erreur getPayments:', error);
      throw error;
    }
    
    return data || [];
  },

  async createPayment(paymentData) {
    const { data, error } = await supabase
      .from('payments')
      .insert([paymentData])
      .select(`
        *,
        member:members(id, name, firstName, badgeId)
      `)
      .single();

    if (error) {
      console.error('Erreur createPayment:', error);
      throw error;
    }
    
    return data;
  },

  async updatePayment(id, paymentData) {
    const { data, error } = await supabase
      .from('payments')
      .update(paymentData)
      .eq('id', id)
      .select(`
        *,
        member:members(id, name, firstName, badgeId)
      `)
      .single();

    if (error) {
      console.error('Erreur updatePayment:', error);
      throw error;
    }
    
    return data;
  },

  async deletePayment(id) {
    const { error } = await supabase
      .from('payments')
      .delete()
      .eq('id', id);
    
    if (error) {
      console.error('Erreur deletePayment:', error);
      throw error;
    }
  },

  async togglePaymentStatus(id, isPaid) {
    return this.updatePayment(id, { is_paid: isPaid });
  },

  // === STORAGE (pour fichiers et photos) ===
  async uploadFile(bucket, path, file) {
    const { data, error } = await supabase.storage
      .from(bucket)
      .upload(path, file, {
        cacheControl: '3600',
        upsert: false
      });

    if (error) {
      console.error('Erreur uploadFile:', error);
      throw error;
    }
    
    // Retourner l'URL publique
    const { data: urlData } = supabase.storage
      .from(bucket)
      .getPublicUrl(data.path);

    return {
      path: data.path,
      publicUrl: urlData.publicUrl
    };
  },

  async deleteFile(bucket, path) {
    const { error } = await supabase.storage
      .from(bucket)
      .remove([path]);

    if (error) {
      console.error('Erreur deleteFile:', error);
      throw error;
    }
  },

  getPublicUrl(bucket, path) {
    const { data } = supabase.storage
      .from(bucket)
      .getPublicUrl(path);
    
    return data.publicUrl;
  },

  // === STATISTIQUES ===
  async getStatistics() {
    try {
      // Récupérer toutes les données en parallèle
      const [membersResult, presencesResult, paymentsResult] = await Promise.all([
        supabase.from('members').select('*'),
        supabase.from('presences').select('*'),
        supabase.from('payments').select('*')
      ]);

      if (membersResult.error) throw membersResult.error;
      if (presencesResult.error) throw presencesResult.error;
      if (paymentsResult.error) throw paymentsResult.error;

      const members = membersResult.data || [];
      const presences = presencesResult.data || [];
      const payments = paymentsResult.data || [];

      // Calculer les statistiques
      const today = new Date();
      const stats = {
        total: members.length,
        actifs: 0,
        expirés: 0,
        hommes: 0,
        femmes: 0,
        etudiants: 0,
        membresExpirés: []
      };

      members.forEach(member => {
        // Statut d'abonnement (dates stockées en text)
        if (member.endDate) {
          try {
            const endDate = new Date(member.endDate);
            if (endDate > today) {
              stats.actifs++;
            } else {
              stats.expirés++;
              stats.membresExpirés.push({
                id: member.id,
                name: member.name,
                firstName: member.firstName,
                endDate: member.endDate
              });
            }
          } catch (e) {
            // Date invalide, considérer comme expiré
            stats.expirés++;
          }
        } else {
          stats.expirés++;
        }

        // Genre
        if (member.gender === 'Homme') stats.hommes++;
        else if (member.gender === 'Femme') stats.femmes++;

        // Étudiants
        if (member.etudiant) stats.etudiants++;
      });

      return { 
        stats, 
        members, 
        presences, 
        payments,
        // Statistiques supplémentaires
        totalPresences: presences.length,
        totalPayments: payments.reduce((sum, p) => sum + parseFloat(p.amount), 0),
        unpaidPayments: payments.filter(p => !p.is_paid).length
      };
    } catch (error) {
      console.error('Erreur getStatistics:', error);
      throw error;
    }
  },

  // === UTILITAIRES ===
  async testConnection() {
    try {
      const { data, error } = await supabase
        .from('members')
        .select('count(*)')
        .single();
      
      if (error) throw error;
      
      console.log('✅ Connexion Supabase OK - Membres:', data.count);
      return true;
    } catch (error) {
      console.error('❌ Erreur connexion Supabase:', error);
      return false;
    }
  },

  // Fonction pour nettoyer les présences en double (utilitaire)
  async cleanDuplicatePresences() {
    try {
      // Cette fonction peut être appelée pour nettoyer les doublons
      const { data, error } = await supabase.rpc('clean_duplicate_presences');
      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Erreur cleanDuplicatePresences:', error);
      throw error;
    }
  }
};