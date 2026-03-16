# Passbolt Cockpit - Import d'utilisateur par .CSV

## Vue d’ensemble

Ce projet sépare maintenant clairement 4 flux :

1. **Création utilisateurs via CLI** (dans le conteneur Passbolt, via `cake passbolt register_user`).
2. **Gestion des groupes via API Passbolt** (`/groups.json`, lecture/création/affectation).
3. **Suppression via API Passbolt** (avec **dry-run obligatoire** avant suppression réelle).
4. **Diagnostic “Santé API Passbolt”** (test bout-en-bout connectivité/TLS/auth/MFA/permissions).

> Le statut “configuré” n’est plus basé sur la seule présence de variables : il s’appuie sur un diagnostic réel.

---

## Lancement

```bash
docker compose --env-file .env up -d --build
```

- UI : `http://localhost:9091`
- API : `http://localhost:9090`

Créez d’abord votre fichier `.env` depuis `.env.example`.

---

## Configuration API Passbolt (sécurisée)

Les secrets ne sont plus hardcodés dans `docker-compose.yml`.

Variables principales :

- `PASSBOLT_API_BASE_URL`
- `PASSBOLT_API_USER_ID`
- `PASSBOLT_API_PRIVATE_KEY_PATH`
- `PASSBOLT_API_GNUPGHOME` (ex: `/tmp/gnupg-passbolt`, doit être un dossier)
- `PASSBOLT_API_PASSPHRASE`
- `PASSBOLT_API_VERIFY_TLS`
- `PASSBOLT_API_CA_BUNDLE`
- `PASSBOLT_API_MFA_PROVIDER`
- `PASSBOLT_API_TOTP_SECRET`

Validation au démarrage :
- message explicite si variable obligatoire manquante,
- message explicite si clé privée introuvable,
- message explicite si CA bundle introuvable.

---

## Auth JWT Passbolt (implémentation actuelle)

Le backend suit le flux JWT attendu :

1. appel `/auth/verify.json`,
2. récupération de la clé publique serveur,
3. génération locale du challenge (`version`, `domain`, `verify_token`, `verify_token_expiry`),
4. signature avec clé privée compte technique,
5. chiffrement avec clé publique serveur,
6. POST `/auth/jwt/login.json`,
7. déchiffrement de la réponse,
8. validation stricte de `verify_token`,
9. extraction `access_token`/`refresh_token`,
10. gestion MFA TOTP si demandé.

---

## Diagnostic “Santé API Passbolt”

Nouvel endpoint backend :

- `GET /api/passbolt/health`
- `POST /api/passbolt/health`

Réponse :

- `overall_status`: `ok | warning | error`
- `steps[]` avec :
  - `id`, `label`, `status`
  - `started_at`, `finished_at`
  - `message`, `details`
  - `http_status`, `endpoint`, `remediation`

Étapes testées : config, réseau, TLS, disponibilité du binaire gpg (path/version/returncode), verify endpoint, clé publique serveur, homedir GPG, lecture clé privée, import clé privée, clé privée utilisable, challenge JWT, signature, chiffrement, login, verify_token, MFA requise ou non, MFA TOTP, endpoint authentifié, groupes, healthcheck, permissions.

---

## Suppression API : dry-run obligatoire

La suppression d’utilisateur passe d’abord par :

- `DELETE /users/{userId}/dry-run.json`

Le backend bloque la suppression réelle si le dry-run échoue et remonte une cause métier (owner unique, transfert requis, dépendances, etc.).

Dry-run groupes également disponible côté service :

- `DELETE /groups/{groupId}/dry-run.json`

---

## UI

Nouvelle rubrique : **“Santé API Passbolt”**

- bouton “Lancer le diagnostic”,
- statut global,
- piliers (Connectivité/TLS/JWT/MFA/Groupes/Suppression/Healthcheck),
- timeline détaillée étape par étape,
- détails techniques repliables,
- actions recommandées.

---

## Endpoints principaux

- `GET /api/health`
- `GET /api/delete-config-status`
- `GET|POST /api/passbolt/health`
- `POST /api/import-stream`
- `POST /api/delete-users-stream`
- `GET /api/batches`
- `GET /api/logs`
- `GET /api/logs/summary`

---

## Erreurs fréquentes

- **MFA requis mais secret absent** : renseigner `PASSBOLT_API_TOTP_SECRET`.
- **TLS invalide** : fournir `PASSBOLT_API_CA_BUNDLE` correct.
- **`/groups.json` refusé** : permissions insuffisantes du compte API.
- **verify_token mismatch** : challenge/réponse non cohérents, auth refusée.
