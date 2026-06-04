process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/glossary_test";
process.env.JWT_SECRET ||= "test-secret";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  cleanExportEntry,
  collectDuplicateWords,
  normalizeWord,
  parseGermanTimestamp,
  sanitizeWordEntry,
  serializeJson,
  validateGlossaryPayload,
} = require("../server.js");

test("normalizeWord trims, lowercases, and collapses whitespace", () => {
  assert.equal(normalizeWord("  Stellvertreter   IN  "), "stellvertreter in");
});

test("parseGermanTimestamp sorts newer timestamps higher", () => {
  assert.ok(
    parseGermanTimestamp("5.5.2026, 11:39:35") >
      parseGermanTimestamp("4.5.2026, 11:39:35")
  );
});

test("sanitizeWordEntry removes empty optional fields", () => {
  assert.deepEqual(
    sanitizeWordEntry({
      word: "  Beispiel  ",
      comment: " ",
      note: "internal",
      gender: "",
    }),
    { word: "Beispiel", note: "internal" }
  );
});

test("validateGlossaryPayload requires both languages on create", () => {
  const { errors } = validateGlossaryPayload({ en: [{ word: "example" }] });

  assert.deepEqual(errors, ["Deutsch words are required."]);
});

test("validateGlossaryPayload allows hide-only updates", () => {
  const { errors, payload } = validateGlossaryPayload(
    { hide: true },
    { partial: true }
  );

  assert.deepEqual(errors, []);
  assert.deepEqual(payload, { hide: true });
});

test("duplicate detection does not conflate different words", () => {
  const duplicates = collectDuplicateWords(
    { de: [{ word: "Stellvertreterin" }], en: [{ word: "representative" }] },
    [{ id: "1", de: [{ word: "Stellvertreter" }], en: [] }]
  );

  assert.deepEqual(duplicates, []);
});

test("duplicate detection catches existing exact language match", () => {
  const duplicates = collectDuplicateWords(
    { de: [{ word: " beispiel " }], en: [{ word: "sample" }] },
    [{ id: "1", de: [{ word: "Beispiel" }], en: [] }]
  );

  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].type, "existing-entry");
  assert.equal(duplicates[0].existingEntryId, "1");
});

test("duplicate detection excludes the edited entry", () => {
  const duplicates = collectDuplicateWords(
    { id: "1", de: [{ word: "Beispiel" }], en: [{ word: "sample" }] },
    [{ id: "1", de: [{ word: "Beispiel" }], en: [{ word: "sample" }] }],
    { excludeId: "1" }
  );

  assert.deepEqual(duplicates, []);
});

test("cleanExportEntry removes ids, visibility flags, metadata, and empty fields", () => {
  assert.deepEqual(
    cleanExportEntry({
      id: "entry-id",
      hide: true,
      hidden: true,
      lastModifiedBy: "editor",
      lastModifiedAt: "5.5.2026, 11:39:35",
      en: [
        {
          word: "  example  ",
          comment: "",
          note: " ",
          pos: "noun",
          gender: "",
        },
      ],
      de: [
        {
          word: "  Beispiel  ",
          comment: "Kommentar",
          note: "",
          pos: "",
          gender: "n",
        },
      ],
    }),
    {
      en: [{ word: "example", pos: "noun" }],
      de: [{ word: "Beispiel", comment: "Kommentar", gender: "n" }],
    }
  );
});

test("serializeJson safely escapes quotations and preserves their value", () => {
  const data = [
    {
      en: [{ word: '5" display', comment: 'Called "large"' }],
      de: [{ word: '5"-Anzeige', note: 'Pfad C:\\Glossary' }],
    },
  ];

  const serialized = serializeJson(data);

  assert.match(serialized, /5\\" display/);
  assert.match(serialized, /Called \\"large\\"/);
  assert.match(serialized, /C:\\\\Glossary/);
  assert.deepEqual(JSON.parse(serialized), data);
});
