# 📈 The Trend Scope

Une application personnelle pour détecter les vidéos **les plus virales** sur YouTube (FR/US/ES), avec filtrage thématique, statistiques évolutives, notifications et tableau de bord analytique. Développée pour un usage local sécurisé : frontend ultra-rapide (vanilla JS responsive), backend Node.js minimaliste (prêt à évoluer vers Rust si besoin), et base Supabase.

---

## 🚀 Objectifs

| Fonction                   | Détail |
|----------------------------|--------|
| 🔍 Détection virale       | Repère les vidéos avec la vélocité la plus forte (vues/h). |
| 🎯 Ciblage intelligent    | Classement par **catégories** (nourriture, voiture, etc.) et **langues** (FR/US/ES). |
| 🕹️ Rafraîchissement manuel | Pas de timing fixe, l’utilisateur contrôle les actualisations. |
| 🧠 Historique enrichi     | Affiche les stats d’évolution (vues/likes) et permet d’ajouter des **notes personnelles**. |
| 🔔 Alertes & notifications | Centre de notifications interne avec déclenchement configurable. |
| 🛡️ Authentification forte | Accès par **login, mot de passe sécurisé (16+ caractères)**. |
| 📦 Intégration Supabase   | Stockage des vidéos, notes, historiques, utilisateurs via **Supabase**. |
| 🧱 Structure scalable      | Prêt à être hébergé publiquement après phase de validation. |
| 🎯 Ciblage intelligent    | Classement par **catégories** (nourriture, business, sport…) et **langues** (FR/US/ES). |
| 🕹️ Rafraîchissement manuel | L’utilisateur contrôle les actualisations (pas de cron imposé). |
| 🧠 Historique enrichi     | Statistiques d’évolution et **notes personnelles**. |
| 🔔 Alertes & notifications | Seuil configurable côté Supabase. |
| 🛡️ Authentification forte | Accès par **login + mot de passe** stockés dans Supabase. |
| 📦 Intégration Supabase   | Stockage des vidéos, notes, historiques, utilisateurs. |
| 🧱 Structure scalable      | Prêt à être hébergé publiquement après validation. |

---

## 📚 Sources utilisées

| Service/API | Lien |
|-------------|------|
| 🧠 YouTube Data API | [developers.google.com/youtube/v3](https://developers.google.com/youtube/v3) |
| 🔐 Supabase (Base de données) | [supabase.com](https://supabase.com) |

---

## 🛠️ Stack technique

| Côté       | Techno utilisée |
|------------|-----------------|
| Backend    | ⚙️ Node.js (HTTP + Supabase REST) |
| Frontend   | 🧭 SPA vanilla JS responsive (sans dépendances externes) |
| Frontend   | ⚛️ React 18 (ESM CDN) + UI sombre optimisée |
| Auth       | 🔐 En-têtes admin (user + mot de passe) |
| BDD        | 🧩 Supabase (PostgreSQL) |

---

## 🔍 Fonctionnalités principales

- 🔎 Recherche de vidéos populaires YouTube par pays et catégorie.
- 📈 Calcul automatique de la vélocité (vues/h) + distinction shorts.
- 🧠 Historique des vidéos avec évolution des vues et likes.
- ✍️ Ajout de notes personnelles + marquage « utilisée ».
- 🔔 Alertes (seuil configurable via Supabase) et rafraîchissement manuel.
- 👤 Accès sécurisé (panel d’authentification user + mot de passe dans l’UI, validé par Supabase).
- ⚡ Interface web responsive en vanilla JS (mobile, tablette, desktop).
- 👤 Accès sécurisé (auth forte via Supabase).
- ⚡ Interface web responsive en vanilla JS (mobile & desktop).
- ⚡ Interface React moderne, rapide et responsive.

---

## 📂 Lancer le projet en local

```bash
npm install
npm run init:db # upsert l'admin dans Supabase (assure-toi d'avoir exécuté supabase.sql)
npm start       # http://localhost:4443 (serveur Node + SPA)
```

Le tableau de bord web permet :
- Connexion sécurisée via le **panel d’authentification** (user + mot de passe Supabase).
- Popup verte de succès quand Supabase + JWT sont OK (vérifiés côté serveur).
- Identifiants par défaut : `zakamon` / `4GS49PFJ$64@Nr*eXEPa9z%4` (injection via supabase.sql ou `npm run init:db`).
- Filtrage par pays, catégorie, recherche plein texte et shorts uniquement.
- Rafraîchissement manuel des tendances YouTube (bouton "Rafraîchir (YouTube)") qui upsert les vidéos et l’historique.
- Annotation et suivi (note + marquage "utilisée") persistés dans Supabase, historisation visible par vidéo.
- Notifications internes affichant les vidéos à forte vélocité.

---

## 🧠 Licence

Ce projet est personnel, non destiné à un usage public pour l’instant. Toutes les API utilisées sont soumises aux [CGU de Google](https://developers.google.com/youtube/terms/api-services-terms-of-service).

## 🏁 Démarrage rapide (prototype Node.js minimal)

1. Copie le fichier `.env.example` en `.env` et remplis chaque variable sensible :
   ```env
   SUPABASE_URL=https://ltxjjnzsphhprykuwwye.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=<ta_clé_service_role>
   SUPABASE_ANON_KEY=<ta_clé_anon>
   # JWT utilisés pour signer/vérifier les tokens Supabase
   JWT_CURRENT_KEY=<jwt_current_key>
   JWT_STANDBY_KEY=<jwt_standby_key>
   JWT_LEGACY_SECRET=<jwt_legacy_secret>
   # API YouTube
   YOUTUBE_API_KEY=<ta_cle_youtube>
   # Identifiant par défaut injecté dans la table `admins` lors du init:db
   ADMIN_USER=zakamon
   ADMIN_PASSWORD=4GS49PFJ$64@Nr*eXEPa9z%4
   ```
2. Initialise les tables Supabase (YouTube + historique + comptes admin) :
   ```bash
   npm run init:db
   ```
3. Lance le serveur privé en local :
   ```bash
   npm start
   ```
4. Ouvre http://localhost:4443 pour afficher le tableau de bord : filtrage par pays/thématique, badge Shorts, notes et marquage « utilisée ».
5. Authentification : le bouton "Se connecter" valide l'utilisateur/mot de passe via Supabase (`public.admins`). Les en-têtes `X-Admin-User` et `X-Admin-Pass` sont ensuite ajoutés automatiquement pour les actions sécurisées (rafraîchissement, notes, marquage).

## 🗄️ SQL à exécuter dans Supabase (SQL Editor)

Un fichier prêt à l'emploi est fourni : [`supabase.sql`](./supabase.sql). Tu peux le coller dans le SQL Editor Supabase ou l'exécuter via `psql` pour créer les tables, activer le RLS et insérer l’admin par défaut.

Les commandes suivantes permettent de créer manuellement toutes les tables utilisées par l’authentification Supabase et le stockage des tendances (à lancer dans le SQL Editor Supabase ou via `psql`) :

```sql
-- Extensions
create extension if not exists "uuid-ossp";

-- Tables
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

create index if not exists idx_videos_velocity on public.videos (velocity_per_hour desc);
create index if not exists idx_videos_country on public.videos (country);
create index if not exists idx_videos_category on public.videos (category);

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

-- RLS
-- RLS et politiques pour sécuriser l'accès depuis Supabase REST
alter table public.videos enable row level security;
alter table public.video_history enable row level security;
alter table public.admins enable row level security;

-- Policies: VIDEOS
drop policy if exists "Public read videos" on public.videos;
create policy "Public read videos" on public.videos
  for select
  using (true);

drop policy if exists "Service role manage videos" on public.videos;
create policy "Service role manage videos" on public.videos
-- Les requêtes publiques (anon) peuvent lire les vidéos
create policy if not exists "Public read videos" on public.videos
  for select
  using (true);

-- Seul le service role peut insérer/mettre à jour/supprimer les vidéos
create policy if not exists "Service role manage videos" on public.videos
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- Policies: VIDEO_HISTORY
drop policy if exists "Public read history" on public.video_history;
create policy "Public read history" on public.video_history
  for select
  using (true);

drop policy if exists "Service role manage history" on public.video_history;
create policy "Service role manage history" on public.video_history
-- Historique : lecture libre, écriture réservée au service role
create policy if not exists "Public read history" on public.video_history
  for select
  using (true);

create policy if not exists "Service role manage history" on public.video_history
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- Policies: ADMINS
drop policy if exists "Service role manage admins" on public.admins;
create policy "Service role manage admins" on public.admins
drop policy if exists "Service role manage admins" on public.admins;
create policy "Service role manage admins" on public.admins
-- Admins : uniquement service role (authentification côté backend)
create policy if not exists "Service role manage admins" on public.admins
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- Seed / upsert admin
insert into public.admins (username, password)
values ('zakamon', '4GS49PFJ$64@Nr*eXEPa9z%4')
on conflict (username) do update
set password = excluded.password;
```

> Remarque : le backend s’appuie sur l’API YouTube pour récupérer les tendances FR/US/ES, calcule la vélocité (vues/h), stocke dans Supabase, et conserve l’historique des vues/likes pour suivre l’évolution. Les actions protégées (rafraîchir, notes, marquage) utilisent uniquement `X-Admin-User` et `X-Admin-Pass`.
