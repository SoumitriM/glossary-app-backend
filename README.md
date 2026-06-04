# Glossary Backend

Express backend for the bilingual glossary app. It provides authentication, glossary CRUD routes, search, export, duplicate-word validation, and MongoDB-backed glossary storage.

## Requirements

- Node.js 20+
- npm
- MongoDB running locally or remotely

## Setup

```bash
npm install
cp .env.example .env
```

Update `.env`:

```env
MONGO_URI=mongodb://appUser:AppPass456@127.0.0.1:27017/glossary_app
JWT_SECRET=replace-with-a-long-random-secret
PORT=3001
```

## Scripts

```bash
npm start       # run server.js
npm run dev     # run server.js with Node watch mode
npm run check   # syntax-check server.js
npm test        # run backend unit tests
```

## Storage

MongoDB is now the primary data store for:

- users
- glossary entries

The first time the backend starts with an empty glossary collection, it seeds MongoDB from:

```text
assets/glossary_data.json
```

After seeding, glossary reads/writes use MongoDB. The JSON file remains useful as source seed data and backup material, but the table data no longer comes directly from JSON.

Exports are still written to:

```text
assets/glossary_bilingual.json
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

## Validation

Create requests require at least one English word and one Deutsch word.

Update requests may update:

- `en`
- `de`
- `hide`

Word entries are normalized before saving:

- leading/trailing whitespace is trimmed
- repeated whitespace inside a word is collapsed
- empty optional fields are removed

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

`GET /api/glossary/export` reads entries from MongoDB, writes the cleaned export file to `assets/glossary_bilingual.json`, and downloads it.

The export removes:

- entry ids
- visibility fields such as `hide` and `hidden`
- metadata fields such as `lastModifiedBy` and `lastModifiedAt`
- empty optional word fields such as `comment`, `note`, `pos`, or `gender`
