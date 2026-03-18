# Passbolt Cockpit

![Status](https://img.shields.io/badge/status-active-1f883d?style=for-the-badge)
![Docker Compose](https://img.shields.io/badge/docker%20compose-required-2496ED?style=for-the-badge&logo=docker&logoColor=white)
![Backend](https://img.shields.io/badge/backend-Flask-111827?style=for-the-badge&logo=flask)
![UI](https://img.shields.io/badge/ui-Nginx-009639?style=for-the-badge&logo=nginx&logoColor=white)
![Passbolt](https://img.shields.io/badge/target-Passbolt_API-orange?style=for-the-badge)
![Python](https://img.shields.io/badge/python-3.11-3776AB?style=for-the-badge&logo=python&logoColor=white)

Cockpit d’exploitation pour **importer**, **diagnostiquer** et **supprimer** des utilisateurs Passbolt, avec UI web, API Flask et flux de contrôle orientés runbook.

---

## 📚 Sommaire

- [Vue d’ensemble](#-vue-densemble)
- [Fonctionnalités](#-fonctionnalités)
- [Architecture](#-architecture)
- [Structure du projet](#-structure-du-projet)
- [Prérequis](#-prérequis)
- [Installation / démarrage rapide](#-installation--démarrage-rapide)
- [Variables d’environnement importantes](#-variables-denvironnement-importantes)
- [Endpoints principaux](#-endpoints-principaux)
- [Santé API / diagnostic](#-santé-api--diagnostic)
- [Flux de suppression sécurisée](#-flux-de-suppression-sécurisée)
- [Help · Debug & Runbook](#-help--debug--runbook)
- [Erreurs fréquentes](#-erreurs-fréquentes)
- [Bonnes pratiques](#-bonnes-pratiques)
- [Contribution](#-contribution)
- [Changelog](#-changelog)
- [Resources](#-resources)
- [Auteur / licence](#-auteur--licence)

---

## 🎯 Vue d’ensemble

Le projet expose deux services principaux via `docker-compose.yml` :

- `importer-api` : API Flask (port interne `9090`) pour import CSV, suppression et diagnostic Passbolt.
- `importer-ui` : UI statique servie par Nginx (port interne `80`) avec proxy `/api/*` vers l’API.

Ports par défaut côté hôte :

- UI : `9091` → `http://localhost:9091`
- API : `9090` → `http://localhost:9090`

Le cockpit est orienté exploitation réelle : visibilité santé, logs, historique des batches, suppression contrôlée avec dry-run.

---

## ✅ Fonctionnalités

- 📥 **Import CSV streamé** avec progression et journalisation.
- 👥 **Gestion des groupes** (création / affectation) via API Passbolt.
- 🧪 **Diagnostic Passbolt API** complet (`TLS`, `GPG`, `JWT`, `MFA TOTP`, permissions).
- 🗑️ **Suppression sécurisée** avec **dry-run obligatoire** avant suppression effective.
- 🧾 **Audit & logs** avec résumé, filtrage et export CSV.
- 🧠 **Dashboard opérationnel** avec vue santé globale.
- 🗃️ **Persistance SQLite** locale pour batches, utilisateurs et événements.

---

## 🏗️ Architecture

```text
[Browser]
   |
   v
importer-ui (nginx:alpine, :9091)
   |  /api/* proxy
   v
importer-api (Flask, :9090)
   |\
   | \-- SQLite (/app/data/thetrendscope.db)
   |
   \---- Docker socket (/var/run/docker.sock) pour exécuter le CLI Passbolt dans le conteneur cible
         + Appels HTTP vers Passbolt API (JWT + GPG + MFA)
```

### Services réellement lancés (compose principal)

| Service | Image/Build | Rôle | Ports | Volumes clés |
|---|---|---|---|---|
| `importer-api` | `build: ./api` | API Flask + logique Passbolt | `${IMPORTER_API_PORT:-9090}:9090` | `/var/run/docker.sock`, `./data`, `./app/keys`, `./certs` |
| `importer-ui` | `nginx:alpine` | UI + reverse proxy API | `${IMPORTER_UI_PORT:-9091}:80` | `./ui`, `./ui/nginx.conf` |

> Les dossiers `backend/`, `frontend/` et `nginx/` existent dans le repo mais ne sont **pas** démarrés par le `docker-compose.yml` actuel.

---

## 🗂️ Structure du projet

```text
.
├── api/                 # API Flask, auth Passbolt, DB SQLite, tests
├── ui/                  # SPA statique + conf nginx locale UI
├── app/keys/            # Clés privées (montées en lecture seule dans l'API)
├── certs/               # Bundles / CA TLS (montés en lecture seule)
├── backend/             # Variante FastAPI (non utilisée par compose principal)
├── frontend/            # Front statique alternatif (non utilisé par compose principal)
├── nginx/               # Reverse-proxy alternatif (non utilisé par compose principal)
├── docker-compose.yml   # Orchestration principale
└── README.md
```

---

## 🧰 Prérequis

- Docker Engine + Docker Compose plugin.
- Accès à une instance Passbolt cible.
- Clé privée GPG technique disponible localement (ex. `./app/keys/admin-private.asc`).
- Variables d’environnement Passbolt correctement renseignées.

---

## 🚀 Installation / démarrage rapide

```bash
git clone https://github.com/Alidrix/TheTrendScope.git
cd TheTrendScope
```

1. Créez/ajustez votre `.env` à la racine (voir section variables).
2. Vérifiez la présence des fichiers montés (`app/keys`, `certs` si utilisé).
3. Lancez la stack :

```bash
docker compose --env-file .env up -d --build
```

4. Vérifiez :

- UI : `http://localhost:9091`
- API health : `http://localhost:9090/api/health`
- API passbolt health : `http://localhost:9090/api/passbolt/health`

---

## 🔐 Variables d’environnement importantes

### Variables principales (API / auth Passbolt)

| Variable | Obligatoire | Description | Exemple |
|---|---|---|---|
| `PASSBOLT_API_BASE_URL` | ✅ | URL de base Passbolt | `https://passbolt.example.com` |
| `PASSBOLT_API_USER_ID` | ✅ | UUID du compte technique Passbolt | `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |
| `PASSBOLT_API_PRIVATE_KEY_PATH` | ✅ | Chemin de la clé privée dans le conteneur | `/app/keys/admin-private.asc` |
| `PASSBOLT_API_GNUPGHOME` | ✅ | Répertoire GPG local API | `/tmp/gnupg-passbolt` |
| `PASSBOLT_API_PASSPHRASE` | ✅ | Passphrase de la clé privée | (secret) |
| `PASSBOLT_API_VERIFY_TLS` | ⚠️ | Vérification TLS (`true/false`) | `true` |
| `PASSBOLT_API_CA_BUNDLE` | optionnel | Bundle CA custom | `/certs/origin_ca_rsa_root.pem` |
| `PASSBOLT_API_MFA_PROVIDER` | optionnel | Provider MFA (actuel: `totp`) | `totp` |
| `PASSBOLT_API_TOTP_SECRET` | si MFA | Secret TOTP du compte technique | (secret) |
| `PASSBOLT_API_TIMEOUT` | optionnel | Timeout HTTP vers Passbolt | `30` |

### Variables d’exploitation compose

| Variable | Défaut | Rôle |
|---|---|---|
| `IMPORTER_API_PORT` | `9090` | Port exposé API |
| `IMPORTER_UI_PORT` | `9091` | Port exposé UI |
| `PASSBOLT_CONTAINER` | `passbolt-passbolt-1` | Nom conteneur Passbolt ciblé pour le CLI |
| `PASSBOLT_CLI_PATH` | `/usr/share/php/passbolt/bin/cake` | Chemin CLI `cake` dans le conteneur Passbolt |
| `IMPORT_COMMAND_TIMEOUT` | `60` | Timeout commande unitaire |
| `IMPORT_TOTAL_TIMEOUT` | `60` | Timeout global import |

### Point d’attention secret (`$` dans passphrase)

Dans `docker-compose.yml`, `PASSBOLT_API_PASSPHRASE` est injectée en **clé seule** (`- PASSBOLT_API_PASSPHRASE`) pour éviter les effets d’interpolation Compose quand la passphrase contient des caractères `$`.

---

## 🌐 Endpoints principaux

> Préfixe recommandé côté UI : `/api/*` (proxy Nginx UI).

| Méthode | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | Santé API + diagnostic Docker/CLI |
| `GET` | `/api/delete-config-status` | État de configuration suppression côté Passbolt |
| `GET`,`POST` | `/api/passbolt/health` | Diagnostic Passbolt complet |
| `POST` | `/api/import-stream` | Import CSV streamé |
| `POST` | `/api/delete-users-stream` | Suppression streamée d’un batch |
| `GET` | `/api/batches` | Liste des batches |
| `GET` | `/api/logs` | Logs applicatifs |
| `DELETE` | `/api/logs` | Purge des logs |
| `GET` | `/api/logs/summary` | Synthèse des logs |
| `GET` | `/api/logs/export.csv` | Export CSV des logs |
| `GET` | `/api/db/summary` | Résumé SQLite |

Endpoints complémentaires non préfixés `/api` existent également (`/health`, `/import-stream`, `/delete-users-stream`, etc.).

---

## 🩺 Santé API / diagnostic

Endpoint de diagnostic Passbolt :

- `GET /api/passbolt/health`
- `POST /api/passbolt/health`

Le rapport contient :

- `overall_status`: `ok | warning | error`
- `steps[]` avec statut détaillé par étape (config, réseau, TLS, import clé, signature, login JWT, MFA, groupes, healthcheck).

Ce diagnostic est le point d’entrée recommandé avant toute action d’import/suppression en production.

---

## 🗑️ Flux de suppression sécurisée

La suppression s’appuie sur le principe suivant :

1. Dry-run côté Passbolt (`/users/{id}/dry-run.json`).
2. Blocage immédiat si dry-run rejeté (ownership unique, dépendances, transferts requis).
3. Suppression effective uniquement si les pré-contrôles sont validés.

Résultat : réduction du risque de suppression destructive non maîtrisée.

---

## 🆘 Help · Debug & Runbook

### 1) Commandes Docker / Compose essentielles

```bash
# Démarrer / reconstruire
docker compose --env-file .env up -d --build

# Voir l'état des services
docker compose ps

# Redémarrer un service
docker compose restart importer-api
docker compose restart importer-ui

# Stopper la stack
docker compose down
```

### 2) Logs et inspection rapide

```bash
# Logs API
docker compose logs -f importer-api

# Logs UI (nginx)
docker compose logs -f importer-ui

# Dernières erreurs uniquement
docker compose logs --tail=200 importer-api
```

### 3) Exécution dans les conteneurs

```bash
# Shell API
docker compose exec importer-api sh

# Vérifier présence clé privée
docker compose exec importer-api ls -l /app/keys

# Vérifier certs montés
docker compose exec importer-api ls -l /certs

# Vérifier variables Passbolt (sans afficher secrets complets)
docker compose exec importer-api sh -lc 'env | sort | grep -E "^PASSBOLT_|^IMPORT_"'
```

### 4) Tests API via curl

```bash
# Santé API locale
curl -sS http://localhost:9090/api/health | jq

# Diagnostic Passbolt complet
curl -sS http://localhost:9090/api/passbolt/health | jq

# Statut suppression config
curl -sS http://localhost:9090/api/delete-config-status | jq

# Résumé logs
curl -sS http://localhost:9090/api/logs/summary | jq
```

### 5) Vérification UI et reverse proxy

```bash
# UI disponible ?
curl -I http://localhost:9091/

# Proxy UI -> API OK ?
curl -sS http://localhost:9091/api/health | jq

# Vérifier config nginx chargée dans importer-ui
docker compose exec importer-ui nginx -T
```

### 6) Contrôles ciblés Passbolt / GPG / TLS

```bash
# Clé privée lisible
docker compose exec importer-api sh -lc 'test -f /app/keys/admin-private.asc && echo "key: OK" || echo "key: MISSING"'

# Bundle CA lisible (si PASSBOLT_API_CA_BUNDLE configuré)
docker compose exec importer-api sh -lc 'test -f /certs/origin_ca_rsa_root.pem && echo "ca: OK" || echo "ca: MISSING"'

# GPG disponible
docker compose exec importer-api sh -lc 'gpg --version | head -n 1'
```

### 7) Vérification MFA TOTP

```bash
# Vérifier présence du secret TOTP
docker compose exec importer-api sh -lc 'test -n "$PASSBOLT_API_TOTP_SECRET" && echo "totp: SET" || echo "totp: MISSING"'
```

### 8) Si un conteneur ne démarre pas

```bash
# Identifier rapidement le service en erreur
docker compose ps -a

# Lire le log du service fautif
docker compose logs --tail=300 importer-api
```

---

## ⚠️ Erreurs fréquentes

| Symptôme | Cause probable | Action recommandée |
|---|---|---|
| API ne répond pas (`9090`) | conteneur `importer-api` down / crash | `docker compose ps`, puis `docker compose logs importer-api` |
| UI ne charge pas (`9091`) | conteneur `importer-ui` down / port occupé | `docker compose ps`, vérifier `IMPORTER_UI_PORT` |
| `/api/*` KO via UI | proxy Nginx UI mal chargé | `docker compose exec importer-ui nginx -T` |
| Auth Passbolt échoue | variables JWT/GPG incomplètes | vérifier `PASSBOLT_API_*`, lancer `/api/passbolt/health` |
| JWT login rejeté | signature/challenge invalide | analyser étape `sign`/`jwt_login` du diagnostic |
| Clé GPG introuvable | mauvais montage `./app/keys` ou chemin | contrôler `/app/keys` + `PASSBOLT_API_PRIVATE_KEY_PATH` |
| Erreur TLS | CA bundle absent/invalide | corriger `PASSBOLT_API_CA_BUNDLE` ou `PASSBOLT_API_VERIFY_TLS` |
| MFA TOTP bloque | secret TOTP absent ou désynchronisé | renseigner `PASSBOLT_API_TOTP_SECRET`, relancer diagnostic |
| Suppression refusée | dry-run négatif (ownership/dépendances) | exécuter transferts requis puis relancer |
| Logs d’erreur persistants | incident non purgé | exporter `/api/logs/export.csv`, corriger, puis purge ciblée |

---

## 🛡️ Bonnes pratiques

- Toujours exécuter `/api/passbolt/health` avant un import/suppressions massifs.
- Éviter de désactiver TLS (`PASSBOLT_API_VERIFY_TLS=false`) hors labo.
- Monter `app/keys` et `certs` en lecture seule uniquement.
- Ne jamais exposer la passphrase en clair dans l’historique shell.
- Conserver les exports de logs CSV pour audit post-incident.

---

## 🤝 Contribution

1. Créez une branche dédiée (`feat/*`, `fix/*`, `docs/*`).
2. Gardez les changements ciblés et cohérents avec la stack réellement utilisée.
3. Testez localement avant commit :
   - `docker compose ps`
   - `curl http://localhost:9090/api/health`
   - `curl http://localhost:9090/api/passbolt/health`
4. Ouvrez une Pull Request claire (objectif, périmètre, impact exploitation).

---

## 📝 Changelog

### 2026-03-18

#### Added
- README restructuré avec sections runbook `Help`, `Resources`, `Contribution`, `Changelog`.
- Sommaire cliquable, tableaux opérationnels, checklists debug.

#### Changed
- Documentation recentrée sur la stack active (`importer-api` + `importer-ui`).
- Clarification des endpoints, ports, volumes et variables critiques.

#### Fixed
- Alignement factuel avec le `docker-compose.yml` et les endpoints réellement exposés.

#### Security
- Mise en avant des pratiques de gestion des secrets, GPG et TLS.

---

## 🔗 Resources

- Docker Engine : https://docs.docker.com/engine/
- Docker Compose : https://docs.docker.com/compose/
- Flask : https://flask.palletsprojects.com/
- Nginx (reverse proxy) : https://nginx.org/en/docs/
- Passbolt API (référence officielle) : https://www.passbolt.com/docs/api/
- Passbolt Help (auth / MFA / admin) : https://www.passbolt.com/docs/
- python-gnupg : https://pypi.org/project/python-gnupg/
- pyotp (TOTP) : https://pyauth.github.io/pyotp/
- GitHub Markdown : https://docs.github.com/en/get-started/writing-on-github
- Shields.io (badges) : https://shields.io/

---

## 👤 Auteur / licence

- Repository : **Alidrix/TheTrendScope**
- Licence : aucune licence explicite détectée à la racine du dépôt.
