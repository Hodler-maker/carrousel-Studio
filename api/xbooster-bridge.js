// Pont d'authentification XBooster → Carrousel Studio (2 oct. 2026).
//
// Reçoit un jeton signé par XBooster (voir
// src/modules/integrations/carrousel-studio-bridge.ts côté XBooster),
// vérifie sa signature et sa fraîcheur, puis :
//   1. connecte automatiquement le membre sur Carrousel Studio (jeton
//      personnalisé Firebase, même sans mot de passe à créer) ;
//   2. aligne son forfait Carrousel Studio sur son palier réel XBooster
//      (Basique → Basique, Premium → Premium, Premium+ → Premium+).
//
// Sécurité : la vérification de signature (jose) ET l'écriture Firestore
// passent ici par le SDK Admin, côté serveur — jamais par le SDK client
// (qui, lui, reste soumis à firestore.rules). Le jeton est à usage unique
// (jti vérifié dans la collection bridgeTokens) pour fermer la fenêtre de
// rejeu, même courte (2 minutes de validité).
//
// Déploiement : place ce fichier dans /api (déjà fait), ajoute
// firebase-admin et jose à package.json (déjà fait), puis configure sur
// Vercel (Settings > Environment Variables) :
//   - XBOOSTER_BRIDGE_SECRET : IDENTIQUE à CARROUSEL_STUDIO_BRIDGE_SECRET
//     côté XBooster.
//   - FIREBASE_SERVICE_ACCOUNT_JSON : le contenu JSON complet d'une clé de
//     compte de service (Firebase Console > Paramètres du projet > Comptes
//     de service > Générer une nouvelle clé privée), collé tel quel.
// Voir BRIDGE_XBOOSTER_CARROUSEL_STUDIO.md pour la procédure pas à pas.

import { jwtVerify } from 'jose';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const ISSUER = 'xbooster';
const AUDIENCE = 'carrousel-studio';

// Palier XBooster (PlanTier côté Prisma) → identifiant de forfait Carrousel
// Studio (voir PLAN_NAMES dans quota.js). Garder cette correspondance
// synchronisée avec quota.js si de nouveaux paliers sont ajoutés un jour.
const TIER_TO_PLAN_ID = {
  FREEMIUM: 'genesis',
  BASIQUE: 'node',
  PREMIUM: 'validator',
  PREMIUM_PLUS: 'satoshi',
};

function getAdminApp() {
  if (getApps().length) return getApps()[0];

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON manquant côté serveur.');
  }
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON invalide (JSON non parsable).');
  }
  return initializeApp({ credential: cert(serviceAccount) });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Méthode non autorisée.' });
    return;
  }

  const secret = process.env.XBOOSTER_BRIDGE_SECRET;
  if (!secret) {
    res.status(500).json({ error: "Pont non configuré côté serveur (XBOOSTER_BRIDGE_SECRET manquant)." });
    return;
  }

  const { token } = req.body || {};
  if (!token || typeof token !== 'string') {
    res.status(400).json({ error: 'Jeton manquant.' });
    return;
  }

  let payload;
  try {
    const result = await jwtVerify(token, new TextEncoder().encode(secret), {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    payload = result.payload;
  } catch (err) {
    // Signature invalide, jeton expiré (> 2 min), issuer/audience
    // incorrects... dans tous les cas, on ne fait pas confiance au jeton.
    res.status(401).json({ error: 'Jeton de pont invalide ou expiré.' });
    return;
  }

  const xboosterUserId = payload.sub;
  const email = typeof payload.email === 'string' ? payload.email : '';
  const tier = typeof payload.tier === 'string' ? payload.tier : '';
  const jti = payload.jti;
  const planId = TIER_TO_PLAN_ID[tier];

  if (!xboosterUserId || !planId || !jti) {
    res.status(400).json({ error: 'Jeton de pont incomplet.' });
    return;
  }

  let app;
  try {
    app = getAdminApp();
  } catch (err) {
    console.error('Erreur init Firebase Admin:', err);
    res.status(500).json({ error: 'Configuration serveur incomplète.' });
    return;
  }

  const db = getFirestore(app);
  const auth = getAuth(app);

  // Rejeu : un jeton ne peut servir qu'une seule fois, même dans sa
  // fenêtre de validité de 2 minutes (ex: si quelqu'un le récupère depuis
  // l'historique réseau avant qu'il n'expire).
  const usedTokenRef = db.collection('bridgeTokensUsed').doc(jti);
  try {
    await db.runTransaction(async (tx) => {
      const existing = await tx.get(usedTokenRef);
      if (existing.exists) {
        throw new Error('TOKEN_ALREADY_USED');
      }
      tx.set(usedTokenRef, { usedAt: FieldValue.serverTimestamp(), xboosterUserId });
    });
  } catch (err) {
    if (err.message === 'TOKEN_ALREADY_USED') {
      res.status(401).json({ error: 'Ce jeton de pont a déjà été utilisé.' });
      return;
    }
    console.error('Erreur vérification anti-rejeu:', err);
    res.status(500).json({ error: 'Erreur serveur.' });
    return;
  }

  // Identité stable, distincte des comptes email/mot de passe créés en
  // direct sur Carrousel Studio (préfixe xb_ pour éviter toute collision).
  const uid = `xb_${xboosterUserId}`;

  try {
    // S'assure que le compte Firebase Auth existe (sinon createCustomToken
    // fonctionne quand même, mais l'email n'apparaîtrait pas dans la
    // console Firebase Auth — utile pour le support/debug).
    try {
      await auth.getUser(uid);
    } catch {
      await auth.createUser({ uid, email: email || undefined, emailVerified: true });
    }

    // Admin SDK = accès total, ignore firestore.rules (normal et voulu :
    // c'est précisément le chemin de confiance que les règles laissent de
    // côté pour l'admin/le serveur).
    await db.collection('users').doc(uid).set(
      {
        email,
        planId,
        planSource: 'xbooster',
        xboosterUserId,
        xboosterTier: tier,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    const customToken = await auth.createCustomToken(uid, { xboosterLinked: true });
    res.status(200).json({ customToken });
  } catch (err) {
    console.error('Erreur pont XBooster:', err);
    res.status(500).json({ error: "Impossible d'établir la connexion depuis XBooster." });
  }
}
