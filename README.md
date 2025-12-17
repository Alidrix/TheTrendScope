# 📈 The Trend Scope

Radar en temps réel pour détecter les vidéos YouTube les plus virales (FR/US/ES), suivre leur vélocité, historiser les stats, ajouter des notes et pousser des alertes internes. Le tout stocké dans Supabase (avec repli local) et servi par un serveur Node minimaliste. Le logo est intégré directement dans la SPA via une image encodée en base64 (aucun binaire dans le dépôt).

## 🚀 Fonctionnalités clés

- 🔎 **Détection virale** : récupération des tendances `videos.list?chart=mostPopular` par pays/langue/catégorie YouTube + calcul de vélocité (vues/h) et badge **Short ≤ 60 s**.
- 🎯 **Ciblage** : chips catégories (nourriture, voiture, business, drôle, influenceurs, gaming, sport, musique) + sélection pays (FR/US/ES) et langue.
- 🕹️ **Rafraîchissement manuel** : bouton `Rafraîchir` (nouvelles vidéos) et `Rafraîchir stats` (relevé des vues/likes des vidéos déjà suivies).
- 🧠 **Historique enrichi** : insertion automatique dans `video_history` (vues/likes horodatés) + graphes d’évolution.
- ✍️ **Notes personnelles** : textarea par carte vidéo, persistée (Supabase ou stockage local).
- ✅ **Marquer comme utilisée** : retire visuellement la vidéo active, reste suivie en historique.
- 🔔 **Notifications internes** : seuil configurable (vues/h) + centre de notifications.
- 📤 **Exports** : boutons CSV/JSON pour l’historique.
- 🌗 **Theme toggle** : clair/sombre, navbar glass, badges soft, loader overlay, toasts.
- ▶️ **Prévisualisation** : modal d’embed YouTube.
- 📦 **Supabase ready** : Synchro `videos` et `video_history` via REST (service role). Repli local sur `data/store.json` si les variables d’environnement ne sont pas définies.
- 📦 **Supabase ready** : Synchro `videos`, `video_history`, `admins` via REST (service role). Repli local sur `data/store.json` si les variables d’environnement ne sont pas définies.

## 🏗️ Structure

```
public/
  index.html    # SPA vanilla + Chart.js CDN
  app.js        # logique UI + appels API
  styles.css    # thème sombre/clair, grilles responsives
server.js       # serveur HTTP, routes API, intégration Supabase/YouTube
package.json    # scripts npm (sans dépendances externes)
data/store.json # stockage local (généré au besoin)
```

## ⚙️ Configuration

Créer un fichier `.env` à la racine (copie `.env.example`) :

```
YOUTUBE_API_KEY=...votre_cle_youtube...
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
PORT=4443
```

Créer un fichier `.env` à la racine (le repo en contient déjà un exemple) :

```
SUPABASE_URL=https://ltxjjnzsphhprykuwwye.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...clef_service...
YOUTUBE_API_KEY=...clef_youtube...
ADMIN_USER=zakamon
ADMIN_PASSWORD=4GS49PFJ$64@Nr*eXEPa9z%4
PORT=4443
```

> 🔒 **Identifiants admin** : la connexion UI vérifie d’abord la table `admins` de Supabase, puis le repli local défini dans `.env`. Les sessions sont stockées en mémoire (entête `x-session-token`).

### Tables Supabase (SQL à exécuter)

Utilise l’éditeur SQL Supabase avec ce script (reprend le schéma historique) :

```sql
create extension if not exists "uuid-ossp";

create table if not exists public.videos (
  id text primary key,
  title text not null,
  description text,
  country char(2) not null,
  category text,
  view_count bigint,
  like_count bigint,
  published_at timestamptz,
  duration_seconds integer,
  is_short boolean default false,
  velocity_per_hour numeric,
  used boolean default false,
  note text,
  thumbnail_url text,
  refreshed_at timestamptz default now()
);

create table if not exists public.video_history (
  id uuid default uuid_generate_v4() primary key,
  video_id text references public.videos(id) on delete cascade,
  view_count bigint,
  like_count bigint,
  recorded_at timestamptz default now()
);

create table if not exists public.admins (
  id uuid default uuid_generate_v4() primary key,
  username text unique not null,
  password text not null,
  created_at timestamptz default now()
);

insert into public.admins (username, password)
values ('zakamon', '4GS49PFJ$64@Nr*eXEPa9z%4')
on conflict (username) do update set password = excluded.password;
```

## ▶️ Lancer en local

1) Installer Node.js (>=18). Aucun paquet externe n’est nécessaire.

2) Renseigner `.env` avec votre clé YouTube (Supabase en option).
2) Renseigner `.env` avec vos clés Supabase et YouTube.

3) Démarrer :
```bash
npm start
# http://localhost:4443
```

4) Lancez les rafraîchissements directement depuis l’UI (aucune authentification requise).
4) Connectez-vous via l’UI (identifiants Supabase `admins`).

## 🔌 API résumée

| Méthode | Route | Description |
| --- | --- | --- |
| `POST` | `/api/login` | Auth admin → `{ token }` (header `x-session-token`). |
| `GET` | `/api/videos` | Liste des vidéos suivies (velocity desc). |
| `POST` | `/api/refresh` | Rafraîchit les tendances (pays/catégorie/langue, seuil alerte). |
| `POST` | `/api/refresh-stats` | Met à jour vues/likes de toutes les vidéos suivies. |
| `POST` | `/api/videos/:id/refresh` | Met à jour une vidéo. |
| `POST` | `/api/videos/:id/note` | Sauvegarde la note. |
| `POST` | `/api/videos/:id/mark-used` | Marque comme utilisée. |
| `GET` | `/api/history` | Historique vues/likes. |
| `GET` | `/api/notifications` | Notifications internes. |
| `GET` | `/api/export?format=csv|json` | Export de l’historique. |

## 🧠 Notes d’implémentation

- **Supabase** : synchronisation REST (`Prefer: resolution=merge-duplicates`) + repli local `data/store.json` pour le prototypage sans connexion.
- **YouTube** : `videos.list` (chart=mostPopular) et `videos.list?id=...` pour le rafraîchissement de stats. Vélocité = `viewCount / heures depuis publication` (min 1h).
- **UI** : vanilla JS + Chart.js CDN, responsive, thème glass, loader overlay, toasts, modal embed.
- **Export** : CSV simple (`video_id,view_count,like_count,recorded_at`) ou JSON brut.

## ✅ Checklist rapide

- Rafraîchissement manuel des tendances et des stats.
- Notes personnelles + marquage « utilisée ».
- Historique (graphes + export CSV/JSON).
- Notifications internes basées sur la vélocité.
- Badge Shorts, filtres pays/langue/catégories.
- Thème sombre/clair, navbar glass, loader/toasts, modal de prévisualisation.
