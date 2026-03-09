# Passbolt User Importer

Projet Dockerisé (backend FastAPI + frontend + Nginx) pour importer des utilisateurs Passbolt via CSV.

## Lancement

```bash
sudo docker compose up -d
```

Application disponible sur `http://<serveur>:9001`.

## Variables importantes

- `PASSBOLT_URL` : URL du serveur Passbolt.
- `PASSBOLT_USER_ID` : UUID de l'admin qui réalise l'auth API.
- `PASSBOLT_PRIVATE_KEY_PATH` : chemin de la clé privée GPG dans le conteneur backend (par défaut `/app/keys/private.asc`).
- `PASSBOLT_GPG_PASSPHRASE` : passphrase de la clé privée.
- `PASSBOLT_TOKEN` : JWT statique optionnel (bypass de l'auth challenge/signature).

## Format CSV

Le fichier CSV doit contenir les colonnes suivantes :

- `Email`
- `FirstName`
- `LastName`
