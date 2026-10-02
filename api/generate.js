// Fonction serverless Vercel — garde ta clé API Gemini côté serveur.
// Le site (carrousel-studio.html) appelle "/api/generate", jamais Gemini
// directement, donc la clé n'est JAMAIS visible dans le navigateur des visiteurs.
//
// Déploiement : place ce fichier dans un dossier /api à la racine de ton projet
// Vercel, ajoute la variable d'environnement GEMINI_API_KEY dans les
// paramètres du projet (Settings > Environment Variables), puis déploie.

const GEMINI_MODEL = 'gemini-3.6-flash';

// Limiteur basique en mémoire (best-effort, se réinitialise à chaque cold start).
// Protège contre un usage abusif qui ferait exploser ta facture API.
const requestLog = new Map();
const MAX_REQUESTS_PER_WINDOW = 8;
const WINDOW_MS = 10 * 60 * 1000; // 10 minutes

function isRateLimited(ip) {
  const now = Date.now();
  const entry = requestLog.get(ip) || { count: 0, windowStart: now };
  if (now - entry.windowStart > WINDOW_MS) {
    entry.count = 0;
    entry.windowStart = now;
  }
  entry.count += 1;
  requestLog.set(ip, entry);
  return entry.count > MAX_REQUESTS_PER_WINDOW;
}

// --- Quota "carrousel gratuit" (forfait Freemium) ---------------------------
// Tant qu'il n'existe pas de vrais comptes/paiement, on ne peut pas savoir
// avec certitude qui est un utilisateur payant : on applique donc un garde-fou
// serveur par adresse IP — 1 génération IA de carrousel offerte par mois glissant.
//
// ⚠️ Limites connues de cette approche (à corriger le jour où il y aura de
// vrais comptes) :
//   - Stockage en mémoire : remis à zéro à chaque redémarrage à froid de la
//     fonction Vercel (peut arriver plusieurs fois par jour sous faible trafic).
//   - Basé sur l'IP : plusieurs personnes derrière la même IP (bureau, box
//     familiale, 4G partagée) partageront le même quota, et une personne qui
//     change de réseau peut regénérer une IA "gratuite".
//   - Ne bloque QUE la génération automatique via l'IA. La création manuelle
//     d'un carrousel dans l'éditeur reste gérée côté client par quota.js.
// C'est donc un filet de sécurité en plus du contrôle client, pas un
// remplacement d'un vrai système d'abonnement.
const freeCarrouselLog = new Map();
const FREE_CARROUSEL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours

function hasUsedFreeCarrousel(ip) {
  const last = freeCarrouselLog.get(ip);
  if (!last) return false;
  return Date.now() - last < FREE_CARROUSEL_WINDOW_MS;
}

function markFreeCarrouselUsed(ip) {
  freeCarrouselLog.set(ip, Date.now());
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Un appel est retentable si Gemini est temporairement surchargé (503) ou
// bridé (429). Les autres erreurs (clé invalide, requête malformée, etc.)
// ne doivent pas être réessayées — elles échoueront de la même façon à
// chaque tentative.
function isRetryableStatus(status) {
  return status === 503 || status === 429;
}

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 700; // 700ms, puis ~1.4s, puis ~2.8s (backoff exponentiel + jitter)

async function callGeminiWithRetry(apiKey, body) {
  let lastResponse = null;
  let lastData = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(body),
      }
    );

    const data = await geminiResponse.json();

    if (geminiResponse.ok) {
      return { geminiResponse, data };
    }

    lastResponse = geminiResponse;
    lastData = data;

    const shouldRetry = attempt < MAX_ATTEMPTS && isRetryableStatus(geminiResponse.status);
    if (!shouldRetry) break;

    const delay = BASE_DELAY_MS * 2 ** (attempt - 1) + Math.random() * 250;
    console.warn(`Gemini surchargé (statut ${geminiResponse.status}), nouvelle tentative ${attempt + 1}/${MAX_ATTEMPTS} dans ${Math.round(delay)}ms...`);
    await sleep(delay);
  }

  return { geminiResponse: lastResponse, data: lastData };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Méthode non autorisée' });
    return;
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  if (isRateLimited(ip)) {
    res.status(429).json({ error: 'Trop de générations. Réessaie dans quelques minutes.' });
    return;
  }

  // Garde-fou serveur pour le forfait Freemium : 1 génération IA de carrousel
  // offerte par mois glissant, par IP (voir explications au-dessus de freeCarrouselLog).
  if (hasUsedFreeCarrousel(ip)) {
    res.status(403).json({
      error: 'Ton carrousel gratuit du mois généré par IA a déjà été utilisé. Réessaie le mois prochain, ou passe à un forfait payant pour en générer d\'autres dès maintenant.',
    });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Clé API non configurée côté serveur (GEMINI_API_KEY manquante)." });
    return;
  }

  try {
    const { system, messages } = req.body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: 'Requête invalide.' });
      return;
    }

    // Correctif sécurité (audit du 2 oct. 2026) : aucune limite de taille
    // n'existait sur le texte envoyé à Gemini. Même avec le rate-limit par
    // IP ci-dessus, 8 requêtes/10min avec un texte source énorme à chaque
    // fois reste un vecteur de coût/DoS sur la facture Gemini. 20 000
    // caractères couvre largement un article ou un thread long.
    const MAX_INPUT_CHARS = 20000;
    if (messages.some(m => typeof m.content !== 'string')) {
      res.status(400).json({ error: 'Requête invalide.' });
      return;
    }
    const userText = messages.map(m => m.content).join('\n');
    if (userText.length > MAX_INPUT_CHARS) {
      res.status(400).json({
        error: `Texte source trop long (${userText.length} caractères, ${MAX_INPUT_CHARS} max). Raccourcis-le et réessaie.`,
      });
      return;
    }

    const { geminiResponse, data } = await callGeminiWithRetry(apiKey, {
      system_instruction: system ? { parts: [{ text: system }] } : undefined,
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      generationConfig: {
        temperature: 0.9,
        // Gemini 3.6 Flash réfléchit par défaut (thinkingLevel "medium"),
        // et ces tokens de réflexion sont décomptés dans maxOutputTokens.
        // Sans ce réglage, la réflexion pouvait consommer tout le budget
        // avant même d'écrire le JSON, provoquant un finishReason
        // "MAX_TOKENS" avec une réponse vide à chaque génération.
        thinkingConfig: {
          thinkingLevel: 'low',
        },
        maxOutputTokens: 8192,
      },
    });

    if (!geminiResponse.ok) {
      const message = geminiResponse.status === 503
        ? 'Gemini est actuellement surchargé après plusieurs tentatives. Réessaie dans quelques instants.'
        : (data.error?.message || 'Erreur API Gemini');
      res.status(geminiResponse.status).json({ error: message });
      return;
    }

    const candidate = data.candidates?.[0];
    const text = candidate?.content?.parts?.map(p => p.text || '').join('') || '';

    if (candidate?.finishReason === 'MAX_TOKENS' || !text) {
      res.status(502).json({
        error: 'Réponse tronquée (trop de tokens) — réessaie avec un texte source plus court ou moins de slides.',
      });
      return;
    }

    // On normalise la réponse au même format que celui attendu par le site
    // (structure "content" façon Anthropic), pour ne rien changer côté client.
    markFreeCarrouselUsed(ip);
    res.status(200).json({
      content: [{ type: 'text', text }],
    });
  } catch (err) {
    console.error('Erreur /api/generate:', err);
    res.status(500).json({ error: 'Erreur serveur lors de la génération.' });
  }
}
