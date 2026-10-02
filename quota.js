/*
 * quota.js — Suivi des quotas d'utilisation par forfait (côté navigateur)
 *
 * ⚠️ IMPORTANT : tant qu'il n'y a pas de compte utilisateur + base de données
 * côté serveur pour cette partie, ce suivi est stocké dans localStorage. C'est
 * un garde-fou "honnête" pour l'utilisateur normal, mais PAS une sécurité
 * réelle : vider le cache, utiliser la navigation privée ou changer de
 * navigateur permet de contourner la limite. Dès qu'un vrai système de
 * comptes/paiement existera pour cette partie, cette logique devra être
 * déplacée côté serveur (et vérifiée à chaque appel API, pas seulement côté
 * client).
 *
 * Chaque page définit window.csCurrentPlanId (voir carrousel.html,
 * editor.html, visuel.html, index.html) à partir du vrai forfait Firestore
 * de l'utilisateur connecté. Ce fichier lit cette valeur pour appliquer les
 * bonnes limites.
 *
 * Cas particulier : le compte admin (voir firebase-shared.js / ADMIN_EMAIL)
 * doit avoir un accès illimité, quel que soit son planId Firestore. Chaque
 * page est responsable de positionner window.csCurrentPlanId = 'admin'
 * quand window.CS.isAdmin(user) est vrai (avant d'appliquer le planId
 * Firestore normal) — voir le plan 'admin' ci-dessous.
 */
(function (global) {
  const STORAGE_KEY = 'cs_usage_v2';

  // Limites par forfait et par fonctionnalité — reprend exactement ce qui
  // est écrit sur les cartes tarifaires d'index.html.
  const PLAN_LIMITS = {
    genesis:   { visuels: { limit: 1,        period: 'week'  }, carrousels: { limit: 1, period: 'month' }, ppt: { limit: 0, period: null } },
    node:      { visuels: { limit: 1,        period: 'day'   }, carrousels: { limit: 1, period: 'week'  }, ppt: { limit: 0, period: null } },
    validator: { visuels: { limit: Infinity, period: null    }, carrousels: { limit: 3, period: 'week'  }, ppt: { limit: 1, period: 'month' } },
    satoshi:   { visuels: { limit: Infinity, period: null    }, carrousels: { limit: 5, period: 'week'  }, ppt: { limit: 2, period: 'week'  } },
    // Compte admin (hodler1206@gmail.com) : aucune limite, sur aucune
    // fonctionnalité. Voir isAdmin() dans firebase-shared.js.
    admin:     { visuels: { limit: Infinity, period: null    }, carrousels: { limit: Infinity, period: null }, ppt: { limit: Infinity, period: null } },
  };

  const PLAN_NAMES = { genesis: 'Freemium', node: 'Basique', validator: 'Premium', satoshi: 'Premium+', admin: 'Admin' };

  const PERIOD_MS = {
    day: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000,
  };
  const PERIOD_LABEL = { day: 'jour', week: 'semaine', month: 'mois' };

  // Le vrai forfait Firestore de l'utilisateur connecté, positionné par
  // chaque page via window.csCurrentPlanId. 'genesis' par défaut (déconnecté
  // ou pas encore résolu = traité comme Freemium).
  // undefined = pas encore résolu (une page vient de charger et le vrai
  // forfait Firestore n'est pas encore arrivé). Ne PAS confondre avec
  // 'genesis' confirmé, sinon un utilisateur payant qui clique très vite
  // après avoir ouvert la page se voit appliquer par erreur les limites
  // Freemium. Chaque page positionne explicitement 'genesis' quand elle sait
  // avec certitude que la personne n'est pas connectée, et 'admin' quand
  // window.CS.isAdmin(user) est vrai.
  function getPlanId() {
    const v = global.csCurrentPlanId;
    if (v === undefined) return undefined;
    if (typeof v === 'string' && PLAN_LIMITS[v]) return v;
    return 'genesis';
  }

  function getStore() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function setStore(data) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); }
    catch (e) { /* stockage indisponible (navigation privée stricte, etc.) */ }
  }

  // Renvoie {count, periodStart} pour une métrique donnée, en réinitialisant
  // le compteur si la période glissante est écoulée.
  function getEntry(key, periodKind) {
    const store = getStore();
    const entry = store[key] || { count: 0, periodStart: Date.now() };
    if (periodKind && Date.now() - entry.periodStart >= PERIOD_MS[periodKind]) {
      entry.count = 0;
      entry.periodStart = Date.now();
    }
    return entry;
  }
  function saveEntry(key, entry) {
    const store = getStore();
    store[key] = entry;
    setStore(store);
  }

  function statusFor(key) {
    const planId = getPlanId();

    if (planId === undefined) {
      return {
        allowed: false, used: 0, limit: 0, remaining: 0, unlimited: false, period: null, pending: true,
        message: "Vérification de ton forfait en cours — patiente une seconde et réessaie."
      };
    }

    const spec = PLAN_LIMITS[planId][key];

    if (!spec || spec.limit === 0) {
      return {
        allowed: false, used: 0, limit: 0, remaining: 0, unlimited: false, period: null,
        message: `Cette fonctionnalité n'est pas incluse dans ton forfait ${PLAN_NAMES[planId]}. Passe à un forfait supérieur pour y accéder.`
      };
    }
    if (spec.limit === Infinity) {
      return { allowed: true, used: 0, limit: Infinity, remaining: Infinity, unlimited: true, period: null };
    }

    const entry = getEntry(key, spec.period);
    const remaining = Math.max(0, spec.limit - entry.count);
    const periodLabel = PERIOD_LABEL[spec.period];

    if (remaining <= 0) {
      return {
        allowed: false, used: entry.count, limit: spec.limit, remaining: 0, unlimited: false, period: periodLabel,
        message: `Limite atteinte : ${spec.limit} par ${periodLabel} sur le forfait ${PLAN_NAMES[planId]}. Réessaie plus tard, ou passe à un forfait supérieur pour continuer maintenant.`
      };
    }
    return { allowed: true, used: entry.count, limit: spec.limit, remaining, unlimited: false, period: periodLabel };
  }

  function record(key) {
    const planId = getPlanId();
    if (planId === undefined) return; // forfait pas encore connu, rien à compter
    const spec = PLAN_LIMITS[planId][key];
    if (!spec || spec.limit === 0 || spec.limit === Infinity) return;
    const entry = getEntry(key, spec.period);
    entry.count += 1;
    saveEntry(key, entry);
  }

  // Résumé complet, utile pour afficher un badge de forfait + des compteurs
  // "il te reste X" sur les pages qui le souhaitent (ex: index.html).
  function getSummary() {
    const planId = getPlanId();
    return {
      planId: planId === undefined ? 'pending' : planId,
      planName: planId === undefined ? '…' : PLAN_NAMES[planId],
      visuels: statusFor('visuels'),
      carrousels: statusFor('carrousels'),
      ppt: statusFor('ppt'),
    };
  }

  const CSQuota = {
    PLAN_NAMES,
    getPlanId,
    getSummary,

    // Visuel Studio
    canExportVisuel() { return statusFor('visuels'); },
    recordVisuelExport() { record('visuels'); },

    // Générateur de carrousels
    canUseCarrousel() { return statusFor('carrousels'); },
    recordCarrouselUsed() { record('carrousels'); },

    // Éditeur de présentations (export PNG/SVG = "slide" exportée)
    canExportPowerPoint() { return statusFor('ppt'); },
    recordPowerPointExport() { record('ppt'); },

    // Petit bandeau/alerte réutilisable
    notify(message) {
      if (typeof global.showToast === 'function') { global.showToast(message); return; }
      if (typeof global.csShowToast === 'function') { global.csShowToast(message); return; }
      alert(message);
    }
  };

  global.CSQuota = CSQuota;
})(window);
