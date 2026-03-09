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

- `importer-ui` : interface web d'import CSV sur `http://<host>:9091`
- `importer-api` : API Flask sur `http://<host>:9090`

## Variables d'environnement

- `PASSBOLT_CONTAINER` (défaut: `passbolt-passbolt-1`) : nom du conteneur Passbolt cible.
- `PASSBOLT_CLI_PATH` (défaut: `/usr/share/php/passbolt/bin/cake`) : chemin vers la commande `cake` dans le conteneur Passbolt.

## Format CSV attendu

```csv
email,firstname,lastname,role
user1@example.com,Jean,Dupont,user
user2@example.com,Marie,Durand,admin
```

## Endpoint API

- `POST /import` : envoie un `multipart/form-data` avec `file=<csv>`.
- `GET /health` : vérification rapide du service.
