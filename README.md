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

## Variables d'environnement

- `PASSBOLT_CONTAINER` (défaut: `passbolt-passbolt-1`) : nom du conteneur Passbolt cible.
- `PASSBOLT_CLI_PATH` (défaut: `/usr/share/php/passbolt/bin/cake`) : chemin vers la commande `cake` dans le conteneur Passbolt.
- `IMPORT_COMMAND_TIMEOUT` (défaut: `60`) : timeout (en secondes) d'une commande CLI d'import pour éviter un blocage infini.
- `IMPORT_TOTAL_TIMEOUT` (défaut: `60`) : timeout global d'un import (au-delà, debug automatique).

## Format CSV attendu

```csv
email,firstname,lastname,role
user1@example.com,Jean,Dupont,user
user2@example.com,Marie,Durand,admin
```

## Fichier CSV d'exemple (5 utilisateurs)

Un exemple prêt à l'emploi est disponible ici : `examples/users-5.csv`.
Vous pouvez l'uploader directement dans l'UI.

## Endpoint API

- `POST /import` : envoie un `multipart/form-data` avec `file=<csv>`.
- `POST /import-stream` : même import mais en flux NDJSON pour afficher les commandes/logs en temps réel dans l'UI.
- `GET /health` : vérification rapide du service + auto-détection container/CLI.
- `GET /debug/import` : diagnostic détaillé (checks + recommandations).

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

## Logos UI (favicon + logo principal)

Pour utiliser **vos 2 logos personnalisés** sans bloquer la création de PR :

- Placez vos fichiers dans `ui/assets/` :
  - `favicon.png` (icone navigateur)
  - `passbolt.png` (logo UI)
- L'UI est configurée avec fallback automatique :
  - si les PNG existent, ils sont utilisés,
  - sinon l'UI repasse automatiquement sur les SVG (`favicon.svg`, `logo-mark.svg`, `logo-full.svg`).

Cela permet de garder une UI brandée en local/prod, tout en restant compatible avec des outils CI/PR qui n'acceptent pas les diffs binaires.
