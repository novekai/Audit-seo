# 🔍 Smart Audit — Robot d'Audit SEO Automatisé

**Smart Audit** est un robot qui automatise la génération de rapports d'audit SEO. Il capture, filtre, rogne et envoie automatiquement les données dans Airtable — prêtes à être exploitées par le workflow N8N pour produire le rapport final (Google Slides).

---

## 🏗️ Architecture

```
┌───────────────────────────────────────────────────────────┐
│                    FRONTEND (React)                       │
│  Inscription / Connexion / Dashboard / Suivi en temps réel│
└────────────────────┬──────────────────────────────────────┘
                     │ WebSocket + REST API
┌────────────────────▼──────────────────────────────────────┐
│                  BACKEND (Express.js)                     │
│   • API REST (auth, audits, sessions)                     │
│   • BullMQ Worker (30 étapes d'audit)                     │
│   • Airtable Poller (sync bidirectionnel)                 │
└────────────────────┬──────────────────────────────────────┘
                     │
   ┌─────────────────┼──────────────────┐
   ▼                 ▼                  ▼
┌────────┐   ┌────────────┐   ┌──────────────┐
│ Redis  │   │ Cloudinary │   │  Airtable    │
│(BullMQ)│   │ (images)   │   │ (résultats)  │
└────────┘   └────────────┘   └──────────────┘
```

## 📦 Stack Technique

| Composant | Technologie |
|---|---|
| Frontend | React 19 + Vite + TailwindCSS |
| Backend | Express.js (ESM) |
| File d'attente | BullMQ + Redis |
| Base de données | PostgreSQL |
| Navigateur | Playwright (captures écran) |
| IA (rognage) | OpenAI GPT-4o Vision |
| Stockage images | Cloudinary |
| Destination | Airtable |

## 🔄 Les 30 Étapes de l'Audit

Le robot exécute automatiquement les étapes suivantes pour chaque site :

### Modules sans authentification
| # | Module | Champ Airtable | Description |
|---|---|---|---|
| 1 | **Robots.txt** | `Img_Robots_Txt` | Capture le fichier robots.txt avec focus sur la ligne Sitemap |
| 2 | **Sitemap** | `Img_Sitemap` | Capture le fichier sitemap.xml |
| 3 | **Logo** | `Img_Logo` | Extrait le logo via Google Favicon / Clearbit |
| 4 | **Am I Responsive** | `Img_AmIResponsive` | Capture le rendu multi-écrans du site |
| 5 | **SSL Labs** | `Img_SSL` | Note SSL (A, A+, B…) via l'API SSL Labs v4 |
| 6 | **PSI Mobile** | `Img_PSI_Mobile` + `pourcentage smartphone` | Score et capture PageSpeed Mobile |
| 7 | **PSI Desktop** | `Img_PSI_Desktop` + `pourcentage desktop` | Score et capture PageSpeed Desktop |

### Google Sheets — Audit (8 onglets)
| # | Onglet | Champ Airtable | Filtre / Tri appliqué |
|---|---|---|---|
| 8 | Images | `Img_Poids_image` | Taille ≥ 100 Ko, décroissant, 2 colonnes |
| 9 | Même title | `Img_meme_title` | Capture simple, rognée |
| 10 | Même balise meta desc | `Img_meta_description_double` | Capture simple, rognée |
| 11 | Doublons H1 | `Img_balise_h1_double` | Capture simple, rognée |
| 12-17 | Balises H1-H6 | 6 sous-champs `Img_*` | Filtre oui/non + tri, 2 colonnes par capture |
| 18 | Nb mots body | `Img_longeur_page` | Top 10 gravité décroissant |
| 19 | Meta desc | `Img_meta_description` | Caractères = 0 uniquement |
| 20 | Balise title | `Img_balises_title` | Filtre "trop longue" |

### Google Sheets — Plan d'action (4 onglets)
| # | Onglet | Champ Airtable |
|---|---|---|
| 21 | Synthèse Audit | `Img_planD'action` |
| 22 | Requêtes Clés | `Img_Requetes_cles` |
| 23 | Données Images | `Img_donnee image` |
| 24 | Longueur de page | `Img_longeur_page_plan` |

### Modules avec authentification
| # | Module | Champ Airtable |
|---|---|---|
| 25-26 | Google Search Console | `Img_sitemap_declaré` + `Img_https` |
| 27 | My Ranking Metrics | `Img_profondeur_clics` |
| 28 | Ubersuggest | `Img_autorité_domaine_UBERSUGGEST` |
| 29 | Semrush | `Img_autorité_domaine_SEMRUSH` |
| 30 | Ahrefs | `Img_autorité_domaine_AHREF` |

## ⚙️ Variables d'Environnement

Créez un fichier `.env` à la racine :

```env
# Serveur
PORT=3000
JWT_SECRET=votre_secret_jwt
SESSION_ENCRYPT_KEY=cle_aes_256_pour_les_sessions

# PostgreSQL (requis)
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/smart_audit

# Redis (requis pour BullMQ)
REDIS_URL=redis://localhost:6379

# Cloudinary (stockage des captures)
CLOUDINARY_CLOUD_NAME=votre_cloud_name
CLOUDINARY_API_KEY=votre_api_key
CLOUDINARY_API_SECRET=votre_api_secret

# OpenAI (rognage IA des captures)
OPENAI_API_KEY=sk-votre_cle_openai

# Google APIs (Sheets + Search Console)
GOOGLE_CLIENT_ID=votre_google_client_id
GOOGLE_CLIENT_SECRET=votre_google_client_secret
GOOGLE_REFRESH_TOKEN=votre_google_refresh_token

# Airtable (destination des résultats)
AIRTABLE_API_KEY=pat_votre_token
AIRTABLE_BASE_ID=appXXXXXXXXXX
AIRTABLE_TABLE_ID=tblXXXXXXXXXX
```

## 🚀 Déploiement sur Railway

### Prérequis Railway
1. **Créer un projet** sur [railway.app](https://railway.app)
2. **Ajouter un service Redis** (plugin gratuit)
3. **Connecter le dépôt Git** du projet

### Variables d'environnement Railway
Définissez au minimum `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `SESSION_ENCRYPT_KEY`, les clés Cloudinary/OpenAI/Airtable et les identifiants Google OAuth.

### Commandes
Le `Dockerfile` gère automatiquement :
- Installation des dépendances Node.js
- Installation de Playwright + navigateur Chromium
- Build du frontend React
- Démarrage du serveur Express

## 🧪 Développement Local

```bash
# Installer les dépendances
npm install

# Installer Playwright
npx playwright install chromium

# Démarrer PostgreSQL en local
docker run --name smart-audit-postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=smart_audit -p 5432:5432 -d postgres:16

# Démarrer Redis en local
docker run --name smart-audit-redis -p 6379:6379 -d redis:7

# Lancer en développement (frontend + backend)
npm run dev

# Build production
npm run build

# Réinitialiser complètement la base PostgreSQL configurée dans DATABASE_URL
npm run db:reset

# Lancer en production
npm start
```

> ⚠️ **PostgreSQL + Redis requis** : le backend dépend désormais de PostgreSQL pour les données applicatives et de Redis pour BullMQ.
> Le reset supprime les tables applicatives (`users`, `audits`, `audit_steps`, `user_sessions`, `audit_events`) puis recrée le schéma.

## 📁 Structure du Projet

```
server/
├── index.js              # Point d'entrée Express
├── airtable.js           # Helpers Airtable (sync champs)
├── airtablePoller.js     # Polling Airtable → créer audits
├── db.js                 # Adaptateur PostgreSQL (utilisateurs, audits, sessions)
├── jobs/
│   └── worker.js         # BullMQ Worker (orchestration des 30 étapes)
├── modules/
│   ├── robots_sitemap.js # Robots.txt + Sitemap
│   ├── logo_extraction.js# Extraction du logo
│   ├── responsive.js     # Am I Responsive
│   ├── ssl_labs.js       # SSL Labs (API v4)
│   ├── pagespeed.js      # PageSpeed Insights (Mobile + Desktop)
│   ├── google_sheets.js  # 12 captures Google Sheets (filtres + tris)
│   ├── google_search_console.js  # GSC (Sitemaps + HTTPS)
│   ├── mrm.js           # My Ranking Metrics
│   ├── ubersuggest.js   # Ubersuggest
│   └── authority_checkers.js  # Semrush + Ahrefs
└── utils/
    ├── cloudinary.js     # Upload Cloudinary
    ├── openai.js         # GPT-4o Vision (rognage IA)
    └── encrypt.js        # Chiffrement AES-256 des sessions

src/                      # Frontend React
├── App.jsx
├── pages/
│   ├── Login.jsx
│   ├── Dashboard.jsx
│   └── Settings.jsx
└── index.css
```

## 🔐 Sécurité

- Les sessions utilisateur (cookies Google, MRM, Ubersuggest) sont **chiffrées en AES-256** avant stockage
- L'authentification utilise **JWT** avec expiration
- Les mots de passe sont hashés avec **bcrypt**
- Le `.env` et les sessions sont exclus du dépôt Git

## 📋 Workflow Complet

```mermaid
graph TD
    A[Airtable: Statut = 'A faire'] -->|Poller 20s| B[Créer audit en BDD]
    B --> C[BullMQ Job]
    C --> D[Worker: 30 étapes]
    D --> E[Playwright: Capture écran]
    E --> F[OpenAI: Rognage IA]
    F --> G[Cloudinary: Upload image]
    G --> H[Airtable: Mise à jour champ]
    H --> I[N8N: Génération rapport Slides]
```

---

**Développé par [NOVEK](https://novek.fr)** — Automatisation intelligente pour les agences SEO.
