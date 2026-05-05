# Glossary Backend

Express backend for the bilingual glossary app. It provides authentication, glossary CRUD routes, search, export, and duplicate-word validation.

## Requirements

- Node.js 20+
- npm
- MongoDB running locally

The current MongoDB connection string in `server.js` is:

```text
mongodb://appUser:AppPass456@127.0.0.1:27017/glossary_app
```

## Setup

```bash
npm install
```

Create a local `.env` file:

```env
PORT=3001
```

## Run

There is currently no `start` script, so run the server directly:

```bash
node server.js
```

The server listens on `PORT` from `.env`.

## Data Files

Glossary data is stored in JSON files under `assets/`:

```text
assets/glossary_data.json       main editable glossary data
assets/glossary_bilingual.json  generated export file
assets/*_backup.json            backups
```

Logs are written under `logs/`.

## API

All glossary routes except login/register require:

```http
Authorization: Bearer <token>
```

### Auth

```http
POST /api/glossary/register
POST /api/glossary/login
```

Login returns a JWT and username.

### Glossary

```http
GET    /api/glossary/getAll
GET    /api/glossary/search?q=<query>&lang=all|en|de
POST   /api/glossary/create
PUT    /api/glossary/update/:id
DELETE /api/glossary/delete/:id
POST   /api/glossary/delete-multiple
GET    /api/glossary/export
```

## Duplicate Word Validation

Create and word-edit updates reject duplicate words with HTTP `409`.

Duplicate matching is:

- exact after trimming
- case-insensitive
- whitespace-normalized
- language-aware

For example, `Stellvertreter` and `Stellvertreterin` are different words and should not be flagged as duplicates.

Example duplicate response:

```json
{
  "error": "This word already exists in the glossary: Deutsch \"Beispiel\".",
  "code": "DUPLICATE_WORD",
  "duplicates": [
    {
      "type": "existing-entry",
      "lang": "de",
      "word": "Beispiel",
      "existingEntryId": "...",
      "existingWord": "Beispiel"
    }
  ]
}
```

Hide-only updates do not run duplicate validation.

## Export

`GET /api/glossary/export` writes a cleaned export file to `assets/glossary_bilingual.json` and downloads it. The export removes metadata fields such as `lastModifiedBy`, `lastModifiedAt`, and `hide`.

## Verification

Syntax-check the backend:

```bash
node --check server.js
```

The current `npm test` script is a placeholder and does not run tests yet.
