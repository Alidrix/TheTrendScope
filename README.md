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

## Format CSV attendu

```csv
email,firstname,lastname,role
user1@example.com,Jean,Dupont,user
user2@example.com,Marie,Durand,admin
```

## Endpoint API

- `POST /import` : envoie un `multipart/form-data` avec `file=<csv>`.
- `POST /import-stream` : même import mais en flux NDJSON pour afficher les commandes/logs en temps réel dans l'UI.
- `GET /health` : vérification rapide du service.

### Personnaliser les ports (éviter les conflits)

Créez un fichier `.env` à côté de `docker-compose.yml` :

```env
IMPORTER_API_PORT=19090
IMPORTER_UI_PORT=19091
```

Puis relancez :

```bash
docker compose down
docker compose up -d --build
```


### Dépannage rapide

- Si vous voyez `404 Not Found` sur `/import-stream`, vos conteneurs tournent probablement avec une ancienne image/config. Relancez avec rebuild :

```bash
docker compose down
docker compose up -d --build
```

- L'UI bascule automatiquement sur `/import` si `/import-stream` est indisponible, mais sans logs temps réel.
