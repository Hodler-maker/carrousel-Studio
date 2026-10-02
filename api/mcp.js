// Serveur MCP (Model Context Protocol) pour Carrousel Studio.
//
// Ce endpoint permet à Claude (ou tout autre client MCP) de générer des
// carrousels LinkedIn directement depuis une conversation, en réutilisant
// la même logique et le même prompt que le site (voir api/generate.js et
// index.html). La clé GEMINI_API_KEY reste côté serveur, comme pour le
// reste du projet.
//
// Déploiement : place ce fichier dans /api à la racine du projet Vercel,
// ajoute @modelcontextprotocol/sdk et zod à package.json (voir package.json
// fourni), puis déploie. L'URL du connecteur à donner à Claude sera :
//   https://carrousel-studio.vercel.app/api/mcp

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const GEMINI_MODEL = 'gemini-3.6-flash';
const AVAILABLE_TEMPLATES = ['sunset', 'editorial', 'midnight', 'signal', 'yellow-black'];

// --- Appel Gemini (même logique que api/generate.js) ---------------------

async function callGemini(system, userText) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Clé API non configurée côté serveur (GEMINI_API_KEY manquante).');
  }

  const geminiResponse = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: userText }] }],
        generationConfig: { temperature: 0.9, maxOutputTokens: 4096 },
      }),
    }
  );

  const data = await geminiResponse.json();
  if (!geminiResponse.ok) {
    throw new Error(data.error?.message || 'Erreur API Gemini');
  }

  const candidate = data.candidates?.[0];
  if (candidate?.finishReason === 'MAX_TOKENS') {
    throw new Error('Réponse tronquée (trop de tokens) — réessaie avec un texte source plus court ou moins de slides.');
  }

  const raw = candidate?.content?.parts?.map(p => p.text || '').join('') || '';
  return raw.replace(/```json/g, '').replace(/```/g, '').trim();
}

// --- Définition du serveur MCP et de ses outils ---------------------------

function buildServer() {
  const server = new McpServer({ name: 'carrousel-studio', version: '1.0.0' });

  server.registerTool(
    'generer_carrousel',
    {
      title: 'Générer un carrousel LinkedIn',
      description:
        "Transforme un texte source en carrousel LinkedIn structuré (couverture, slides de contenu, appel à l'action) " +
        'pour l\'écosystème Web3/Bitcoin francophone africain. Retourne un JSON avec "cover", "slides" et "cta".',
      inputSchema: {
        // Plafond ajouté (audit sécurité du 2 oct. 2026) : ce endpoint MCP
        // n'a aucun rate-limit par IP contrairement à /api/generate — un
        // texte sans limite de taille est un vecteur de coût sur la
        // facture Gemini à chaque appel.
        texte: z.string().min(40, 'Le texte source doit faire au moins 40 caractères.')
          .max(20000, 'Le texte source ne doit pas dépasser 20 000 caractères.')
          .describe('Le texte source (article, notes, thread) à transformer en carrousel.'),
        titre: z.string().optional()
          .describe("Titre souhaité, utilisé comme inspiration pour la couverture."),
        ton: z.enum(['educatif', 'opinion', 'storytelling']).default('educatif')
          .describe('Ton du carrousel : educatif, opinion (avis tranché), ou storytelling.'),
        nombre_slides: z.union([z.literal('auto'), z.number().int().min(3).max(10)]).default('auto')
          .describe('Nombre de slides de contenu (3 à 10), ou "auto" pour laisser le modèle choisir (5 à 8).'),
      },
    },
    async ({ texte, titre, ton, nombre_slides }) => {
      const toneLabel = {
        educatif: 'éducatif, clair, pédagogique',
        opinion: 'avis tranché, point de vue affirmé, incisif',
        storytelling: 'narratif, storytelling personnel, immersif',
      }[ton];

      const countInstruction = nombre_slides === 'auto'
        ? 'Choisis toi-même le nombre idéal de slides de contenu (entre 5 et 8) selon la richesse du texte.'
        : `Crée exactement ${nombre_slides} slides de contenu.`;

      const system = `Tu es un expert en carrousels LinkedIn pour l'écosystème Web3/Bitcoin francophone africain. À partir du texte fourni, tu structures un carrousel LinkedIn complet.

Réponds UNIQUEMENT avec un objet JSON valide, sans texte avant ni après, sans balises markdown, au format exact suivant :
{
  "cover": {"title": "titre accrocheur, court, percutant (max 8 mots)", "subtitle": "une phrase d'accroche complémentaire, max 14 mots"},
  "slides": [
    {"title": "titre court de la slide (max 7 mots)", "body": "2 à 4 phrases courtes ou puces séparées par des sauts de ligne, allant à l'essentiel"}
  ],
  "cta": {"title": "phrase de clôture engageante (max 8 mots)", "body": "2 phrases max : une synthèse + un appel à s'abonner/commenter/partager"}
}

Contraintes :
- Ton : ${toneLabel}.
- ${countInstruction}
- Langue : français.
- Chaque slide de contenu doit apporter UNE idée claire, pas un résumé générique.
- Pas de hashtags, pas d'emoji excessif (1 maximum par slide si pertinent).
- Le texte doit être écrit pour être lu en quelques secondes par slide.`;

      const userPrompt = `${titre ? 'Titre souhaité (à utiliser comme inspiration pour la cover) : ' + titre + '\n\n' : ''}Texte source :\n${texte}`;

      const raw = await callGemini(system, userPrompt);

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error("La réponse du modèle n'était pas un JSON valide — réessaie.");
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(parsed, null, 2) }],
        structuredContent: parsed,
      };
    }
  );

  server.registerTool(
    'lister_templates',
    {
      title: 'Lister les templates visuels disponibles',
      description: 'Retourne la liste des templates visuels disponibles sur Carrousel Studio pour la mise en forme des slides.',
      inputSchema: {},
    },
    async () => ({
      content: [{ type: 'text', text: JSON.stringify(AVAILABLE_TEMPLATES) }],
      structuredContent: { templates: AVAILABLE_TEMPLATES },
    })
  );

  return server;
}

// --- Handler Vercel (mode "stateless" : une instance par requête) --------

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Méthode non autorisée. Ce endpoint MCP accepte uniquement POST.' });
    return;
  }

  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on('close', () => {
      transport.close();
      server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('Erreur serveur MCP:', err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Erreur interne du serveur MCP.' },
        id: null,
      });
    }
  }
}
