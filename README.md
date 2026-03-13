# Passbolt CSV Import Platform (CLI-based)

Architecture retenue (plus stable):

```
CSV Import UI -> API Service -> Passbolt CLI container
```

L'import repose sur la CLI officielle Passbolt (`cake passbolt register_user`), sans flux API JWT/GPG.

## Lancement

```bash
sudo docker compose up -d
```

## Services

- `importer-ui` : interface web d'import CSV sur `http://<host>:9091` (ou `${IMPORTER_UI_PORT}`)
- `importer-api` : API Flask sur `http://<host>:9090` (ou `${IMPORTER_API_PORT}`)

> Note architecture UI: le front réellement servi par Docker est `ui/` (monté dans Nginx `importer-ui`). Le dossier `frontend/` est historique et non utilisé dans le flux principal.

## Variables d'environnement

- `PASSBOLT_CONTAINER` (défaut: `passbolt-passbolt-1`) : nom du conteneur Passbolt cible.
- `PASSBOLT_CLI_PATH` (défaut: `/usr/share/php/passbolt/bin/cake`) : chemin vers la commande `cake` dans le conteneur Passbolt.
- `IMPORT_COMMAND_TIMEOUT` (défaut: `60`) : timeout (en secondes) d'une commande CLI d'import pour éviter un blocage infini.
- `IMPORT_TOTAL_TIMEOUT` (défaut: `60`) : timeout global d'un import (au-delà, debug automatique).
- `PASSBOLT_URL` : URL de l'instance Passbolt (ex: `https://passbolt.example.com`).
- `PASSBOLT_VERIFY_TLS` (défaut: `true`) : validation TLS globale (`false` pour lab).
- `PASSBOLT_API_BASE_URL` : URL API Passbolt (ex: `https://passbolt.karapasse.fr`).
- `PASSBOLT_API_AUTH_MODE` (défaut: `jwt`) : mode d'auth API delete (JWT uniquement).
- `PASSBOLT_API_USER_ID` : UUID du compte admin technique utilisé pour l'API delete.
- `PASSBOLT_API_PRIVATE_KEY_PATH` : chemin de la clé privée GPG du compte API.
- `PASSBOLT_API_PASSPHRASE` : passphrase de la clé privée GPG API.
- `PASSBOLT_API_VERIFY_TLS` (défaut: `true`) : validation TLS pour l'API delete/groupes (laisser `true` en production).
- `PASSBOLT_API_CA_BUNDLE` (optionnel) : chemin PEM de la CA à utiliser (ex: `/app/certs/passbolt-ca.pem`) si le certificat Passbolt n'est pas publiquement approuvé.
- `PASSBOLT_API_MFA_PROVIDER` (défaut: `totp`) : provider MFA.
- `PASSBOLT_API_TOTP_SECRET` : secret TOTP pour la vérification MFA automatique.
- `PASSBOLT_API_TIMEOUT` (optionnel, défaut `30`) : timeout API en secondes.
- `PASSBOLT_API_DEBUG` (optionnel, défaut `false`) : logs debug delete API.

## Format CSV attendu

```csv
email,firstname,lastname,role
user1@example.com,Jean,Dupont,user
user2@example.com,Marie,Durand,admin
```

## Fichier CSV d'exemple (5 utilisateurs)

Un exemple prêt à l'emploi est disponible ici : `examples/users-5.csv`.
Un jeu de charge (2000 utilisateurs avec groupes) est disponible ici : `examples/users-2000-groups.csv`.
Vous pouvez l'uploader directement dans l'UI.

## Endpoint API

- `POST /import` : envoie un `multipart/form-data` avec `file=<csv>`.
- `POST /import-stream` : même import mais en flux NDJSON pour afficher les commandes/logs en temps réel dans l'UI.
- `GET /health` : vérification rapide du service + auto-détection container/CLI.
- `GET /debug/import` : diagnostic détaillé (checks + recommandations).
- `POST /delete-last-import-users` : supprime (ou prévisualise) les comptes du dernier batch SQLite.
- `POST /delete-batch-users` : supprime (ou prévisualise) les comptes d'un batch précis (`batch_uuid`).
- `POST /delete-users-stream` : suppression live NDJSON avec progression (`last batch` par défaut).
- `GET /delete-config-status` : état de configuration JWT/MFA de la suppression API.

### Personnaliser les ports (éviter les conflits)

Créez un fichier `.env` à côté de `docker-compose.yml` :

```env
IMPORTER_API_PORT=19090
IMPORTER_UI_PORT=19091
```

Puis relancez :

```bash
sudo docker compose down
sudo docker compose up -d --build
```


### Dépannage rapide

- Si vous voyez `404 Not Found` sur `/import-stream`, vos conteneurs tournent probablement avec une ancienne image/config. Relancez avec rebuild :

```bash
sudo docker compose down
sudo docker compose up -d --build
```

- L'UI bascule automatiquement sur `/import` si `/import-stream` est indisponible, mais sans logs temps réel.

- Si l'UI affiche `JSON.parse: unexpected character`, cela signifie que le proxy renvoie une page HTML (souvent 404) au lieu de JSON. Vérifiez `ui/nginx.conf` puis relancez `sudo docker compose up -d --build`.


### Comportement UI ajouté

- Avant chaque import, l'UI lance un **ping** (`/health`). Si KO, l'import ne démarre pas.
- Un **timeout global de 60s** est appliqué côté UI.
- En cas de timeout/erreur, un **auto-debug** (`/debug/import`) se lance et affiche checks/recommandations dans les logs.


- Si vous voyez `fallback vers /import` puis `500 Internal Server Error`, cela indique généralement une API ancienne/en échec. Relancez en rebuild et vérifiez les logs API :

```bash
sudo docker compose down
sudo docker compose up -d --build
sudo docker logs -n 200 passbolt-import-api
```

## Logos UI (sans fichiers binaires dans le repo)

Pour éviter l'erreur de PR `Les fichiers binaires ne sont pas pris en charge`,
les logos versionnés dans ce dépôt restent en **SVG** (`ui/assets/*.svg`).

Si vous voulez tester localement un `favicon.png` ou un `passbolt.png`,
ajoutez-les uniquement en local (sans commit Git) ou via votre pipeline de déploiement.



## Reverse-proxy UI/API

L'UI appelle désormais systématiquement l'API backend via le préfixe `/api/*` (ex: `/api/delete-config-status`, `/api/import-stream`).
Le proxy Nginx UI redirige `/api/*` vers `importer-api:9090`, ce qui évite les réponses HTML 404 Nginx pour des endpoints backend JSON.

## TLS Passbolt (API groupes + delete)

- Mode recommandé: exposer Passbolt avec un certificat publiquement approuvé.
- Si votre PKI est interne: montez votre CA dans `./certs` puis définissez:

```env
PASSBOLT_API_VERIFY_TLS=true
PASSBOLT_API_CA_BUNDLE=/app/certs/passbolt-ca.pem
```

- `PASSBOLT_API_VERIFY_TLS=false` reste un mode debug/fallback temporaire uniquement.

## Rebuild complet

```bash
sudo docker compose down
sudo docker compose build --no-cache
sudo docker compose up -d
```
