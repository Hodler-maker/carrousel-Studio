# Carrousel Studio

Carrousel Studio est un générateur de carrousels LinkedIn avec un éditeur local simplifié de présentations. La page principale conserve le parcours rapide « texte vers carrousel ». La page `editor.html` propose un canevas libre pour créer et modifier une présentation dans le navigateur.

## Utilisation

Ouvre `carrousel.html` pour générer un carrousel avec Gemini, ou ouvre `editor.html` pour créer une présentation locale. Dans l’éditeur, tu peux ajouter des slides, du texte et des formes, déplacer ou redimensionner les objets, modifier leurs propriétés, relier deux objets et exporter une slide en SVG ou en PNG.

L’exemple fourni est explicitement nommé « Exemple — à supprimer ». Le bouton **Nouvelle présentation** permet de repartir d’un document vide, tandis que **Charger l’exemple** restaure les données de démonstration.

## Données et confidentialité

Les présentations de l’éditeur sont enregistrées automatiquement dans **IndexedDB**, sous le nom local `carrousel-studio-editor`, dans le profil du navigateur utilisé. Elles ne sont pas envoyées à un serveur par l’éditeur. Le site n’ajoute pas d’analytics, de publicité, de compte tiers ou de télémétrie pour cette partie.

Pour sauvegarder ou déplacer une présentation, utilise **Sauvegarder** afin de télécharger un fichier JSON. Le bouton **Importer** accepte un fichier JSON de 2 Mo maximum. Il est recommandé de conserver ces fichiers dans un emplacement privé, car ils peuvent contenir le contenu de tes présentations.

## Raccourcis

| Raccourci | Action |
|---|---|
| `Ctrl`/`⌘` + `S` | Sauvegarder localement |
| `Suppr.` ou `Retour arrière` | Supprimer l’objet sélectionné |
| Touches fléchées | Déplacer l’objet de 2 px |
| `Maj` + touche fléchée | Déplacer l’objet de 10 px |
| `Ctrl`/`⌘` + `Z` | Annuler |
| `Ctrl`/`⌘` + `Maj` + `Z` | Rétablir |
| Double-clic sur un texte | Modifier directement le texte |

## Développement local

Le projet est un site statique. Depuis le dossier du projet, tu peux utiliser un serveur local simple :

```bash
python3 -m http.server 4173
```

Puis ouvre `http://localhost:4173/editor.html`. Aucun paquet npm n’est requis pour l’éditeur local. Le déploiement existant sur Vercel sert directement les fichiers HTML, CSS et JavaScript.

## Limites actuelles

L’éditeur est volontairement plus simple qu’un produit comme Slides.com. Il est mono-utilisateur, local et sans collaboration. Il ne propose pas encore de bibliothèque importante de modèles, d’animations avancées, de tableaux, de graphiques, de commentaires, de curseurs partagés ou d’import haute fidélité depuis d’autres logiciels. Les connexions relient actuellement deux objets d’une même slide par une ligne fléchée.

L’export PNG et SVG concerne la slide active. Pour conserver une présentation complète et la rouvrir plus tard, utilise l’export JSON.
