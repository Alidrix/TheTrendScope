# TheTrendScope — Cockpit Passbolt Import & Audit

Plateforme cockpit pour importer des utilisateurs Passbolt, auditer les runs et piloter les suppressions via les endpoints backend existants.

## Front officiel

- ✅ Le front servi en production est **`ui/`**.
- ⚠️ `frontend/` est un dossier **legacy/historique**.
- ✅ Le front v2 continue d’utiliser les routes backend existantes via **`/api/*`**.

## Lancement rapide

```bash
sudo docker compose up -d --build
```

Services principaux :
- `importer-ui` : `http://<host>:9091`
- `importer-api` : `http://<host>:9090`

## UI v2 (cockpit premium)

La v2 fournie dans `ui/` apporte :
- hiérarchie visuelle cockpit (fond bleu marine, accent rouge de marque)
- statuts homogènes (success / warning / danger / info)
- protection anti-débordement (ellipsis, line-clamp, break-word, `min-width: 0`, tables en `fixed`)
- séparation métier / technique (vue Logs & audit plus stricte)
- mode **clair/sombre** avec persistance locale
- modularisation JS/CSS par vues et composants réutilisables

### Architecture front `ui/`

```text
ui/
  css/
    tokens.css
    base.css
    layout.css
    components.css
    views.css
    utilities.css
  js/
    app.js
    api.js
    state.js
    utils.js
    views/
      dashboard.js
      importer.js
      deletions.js
      history.js
      logs.js
    components/
      page-header.js
      status-chip.js
      health-card.js
      kpi-card.js
      progress-stepper.js
      console-panel.js
      danger-zone.js
      empty-state.js
      logs-table.js
```

## Endpoints backend utilisés (inchangés)

- `GET /api/health`
- `GET /api/delete-config-status`
- `GET /api/db/summary`
- `GET /api/batches`
- `POST /api/import-stream`
- `POST /api/delete-users-stream`
- `GET /api/logs`
- `GET /api/logs/summary`
- `GET /api/logs/export.csv`
- `DELETE /api/logs`

## Variables d’environnement

Voir les variables Passbolt/API dans l’ancien README (CLI container, TLS, JWT/MFA, timeouts).
Le comportement backend n’a pas été changé par cette refonte UI.

## Notes responsive & robustesse

Cibles testées pour la v2 :
- 1366x768
- 1920x1080

Cas extrêmes couverts côté rendu :
- email long, UUID batch long, nom de fichier CSV long
- chemins techniques et logs verbeux
- états zéro donnée / beaucoup de données

## Legacy

Le dossier `frontend/` est conservé pour référence historique mais n’est plus la source UI recommandée.
