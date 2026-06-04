require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { randomUUID } = require("crypto");

const logger = require("./src/utils/logger.js");

const app = express();
const PORT = process.env.PORT || 3001;
const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET;

if (!MONGO_URI) {
  throw new Error("Missing required environment variable: MONGO_URI");
}

if (!JWT_SECRET) {
  throw new Error("Missing required environment variable: JWT_SECRET");
}

// ---------------- MIDDLEWARE ----------------
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ---------------- FILE PATHS ----------------
const dataFilePath = path.join(__dirname, "assets", "glossary_data.json");
const exportFilePath = path.join(__dirname, "assets", "glossary_bilingual.json");

// ---------------- MODELS ----------------
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true, trim: true },
  password: { type: String, required: true },
});

const wordSchema = new mongoose.Schema(
  {
    word: { type: String, required: true, trim: true },
    comment: { type: String, trim: true },
    note: { type: String, trim: true },
    pos: { type: String, trim: true },
    gender: { type: String, trim: true },
  },
  { _id: false }
);

const glossaryEntrySchema = new mongoose.Schema(
  {
    id: { type: String, unique: true, required: true, index: true },
    en: { type: [wordSchema], default: [] },
    de: { type: [wordSchema], default: [] },
    hide: { type: Boolean, default: false },
    lastModifiedBy: { type: String, default: "" },
    lastModifiedAt: { type: String, default: "" },
  },
  { timestamps: true }
);

const User = mongoose.model("User", userSchema);
const GlossaryEntry = mongoose.model("GlossaryEntry", glossaryEntrySchema);

// ---------------- HELPERS ----------------
function readJsonFile(filePath = dataFilePath) {
  if (!fs.existsSync(filePath)) {
    logger.warn(`File not found: ${filePath}`);
    return [];
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    logger.error(`Error reading file ${filePath}: ${err.message}`);
    return [];
  }
}

function serializeJson(data) {
  const serialized = JSON.stringify(data, null, 2);

  if (serialized === undefined) {
    throw new TypeError("Data cannot be serialized as JSON");
  }

  // JSON.stringify escapes quotes, backslashes, and control characters.
  // Parse once before writing so an invalid export can never replace the file.
  JSON.parse(serialized);
  return serialized;
}

function writeJsonFile(filePath, data) {
  const tempFilePath = `${filePath}.tmp`;

  try {
    fs.writeFileSync(tempFilePath, serializeJson(data), "utf8");
    fs.renameSync(tempFilePath, filePath);
    logger.info(`Successfully wrote to file: ${filePath}`);
  } catch (err) {
    if (fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }
    logger.error(`Failed to write file ${filePath}: ${err.message}`);
    throw err;
  }
}

function getGermanTimestamp() {
  return new Date().toLocaleString("de-DE", { timeZone: "Europe/Berlin" });
}

function parseGermanTimestamp(value) {
  if (!value || typeof value !== "string") return 0;

  const [datePart, timePart] = value.split(", ");
  if (!datePart || !timePart) return 0;

  const [day, month, year] = datePart.split(".").map((part) => Number(part));
  const [hour = 0, minute = 0, second = 0] = timePart
    .split(":")
    .map((part) => Number(part));

  if ([day, month, year, hour, minute, second].some(Number.isNaN)) {
    return 0;
  }

  return new Date(year, month - 1, day, hour, minute, second).getTime();
}

function normalizeWord(word) {
  return String(word || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("de-DE");
}

function sanitizeWordEntry(entry) {
  const word = String(entry?.word || "").trim().replace(/\s+/g, " ");
  if (!word) return null;

  const cleaned = { word };
  ["comment", "note", "pos", "gender"].forEach((field) => {
    const value = String(entry?.[field] || "").trim();
    if (value) cleaned[field] = value;
  });

  return cleaned;
}

function sanitizeWordArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map(sanitizeWordEntry).filter(Boolean);
}

function sanitizeGlossaryEntry(entry) {
  return {
    id: entry.id || randomUUID(),
    en: sanitizeWordArray(entry.en),
    de: sanitizeWordArray(entry.de),
    hide: !!entry.hide,
    lastModifiedBy: entry.lastModifiedBy || "",
    lastModifiedAt: entry.lastModifiedAt || "",
  };
}

function serializeGlossaryEntry(entry) {
  const plain = typeof entry.toObject === "function" ? entry.toObject() : entry;
  const { _id, __v, createdAt, updatedAt, ...clientEntry } = plain;
  void _id;
  void __v;
  void createdAt;
  void updatedAt;
  return clientEntry;
}

function validateGlossaryPayload(body, options = {}) {
  const { partial = false } = options;
  const errors = [];
  const payload = {};
  const allowedFields = new Set(["en", "de", "hide"]);

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { errors: ["Request body must be an object."], payload };
  }

  const unknownFields = Object.keys(body).filter((key) => !allowedFields.has(key));
  if (unknownFields.length > 0) {
    errors.push(`Unsupported field(s): ${unknownFields.join(", ")}.`);
  }

  if (partial && !Object.keys(body).some((key) => allowedFields.has(key))) {
    errors.push("At least one supported field is required.");
  }

  if ("en" in body) {
    payload.en = sanitizeWordArray(body.en);
    if (payload.en.length === 0) {
      errors.push("At least one English word is required.");
    }
  } else if (!partial) {
    errors.push("English words are required.");
  }

  if ("de" in body) {
    payload.de = sanitizeWordArray(body.de);
    if (payload.de.length === 0) {
      errors.push("At least one Deutsch word is required.");
    }
  } else if (!partial) {
    errors.push("Deutsch words are required.");
  }

  if ("hide" in body) {
    payload.hide = !!body.hide;
  }

  return { errors, payload };
}

function collectDuplicateWords(entry, existingEntries, options = {}) {
  const { excludeId = null } = options;
  const duplicates = [];
  const seenInEntry = new Map();
  const existingWords = new Map();

  existingEntries.forEach((existingEntry) => {
    if (excludeId && existingEntry.id === excludeId) return;

    ["en", "de"].forEach((lang) => {
      if (!Array.isArray(existingEntry[lang])) return;

      existingEntry[lang].forEach(({ word }) => {
        const normalized = normalizeWord(word);
        const key = `${lang}:${normalized}`;
        if (!normalized || existingWords.has(key)) return;

        existingWords.set(key, {
          id: existingEntry.id,
          lang,
          word: String(word).trim(),
        });
      });
    });
  });

  ["en", "de"].forEach((lang) => {
    if (!Array.isArray(entry[lang])) return;

    entry[lang].forEach(({ word }) => {
      const normalized = normalizeWord(word);
      if (!normalized) return;

      const key = `${lang}:${normalized}`;
      const displayWord = String(word).trim();

      if (seenInEntry.has(key)) {
        duplicates.push({
          type: "within-entry",
          lang,
          word: displayWord,
        });
        return;
      }

      seenInEntry.set(key, true);

      const existingMatch = existingWords.get(key);
      if (existingMatch) {
        duplicates.push({
          type: "existing-entry",
          lang,
          word: displayWord,
          existingEntryId: existingMatch.id,
          existingWord: existingMatch.word,
        });
      }
    });
  });

  return duplicates;
}

function formatDuplicateMessage(duplicates) {
  const langLabels = { en: "English", de: "Deutsch" };
  const formatWords = (items) =>
    items
      .map((duplicate) => `${langLabels[duplicate.lang]} "${duplicate.word}"`)
      .join(", ");
  const existingDuplicates = duplicates.filter(
    (duplicate) => duplicate.type === "existing-entry"
  );

  if (existingDuplicates.length > 0) {
    return `This word already exists in the glossary: ${formatWords(existingDuplicates)}.`;
  }

  return `This word is entered more than once in this entry: ${formatWords(duplicates)}.`;
}

function sendDuplicateResponse(res, duplicates) {
  return res.status(409).json({
    error: formatDuplicateMessage(duplicates),
    code: "DUPLICATE_WORD",
    duplicates,
  });
}

function cleanExportEntry(entry) {
  const { id, lastModifiedBy, lastModifiedAt, hide, hidden, ...rest } = entry;
  void id;
  void lastModifiedBy;
  void lastModifiedAt;
  void hide;
  void hidden;

  return {
    ...rest,
    en: sanitizeWordArray(entry.en),
    de: sanitizeWordArray(entry.de),
  };
}

async function getAllGlossaryEntries() {
  const entries = await GlossaryEntry.find({}).lean();
  return entries
    .map(serializeGlossaryEntry)
    .sort(
      (a, b) =>
        parseGermanTimestamp(b.lastModifiedAt) -
        parseGermanTimestamp(a.lastModifiedAt)
    );
}

async function seedGlossaryFromJsonIfEmpty() {
  const existingCount = await GlossaryEntry.countDocuments();
  if (existingCount > 0) return;

  const seedData = readJsonFile(dataFilePath).map(sanitizeGlossaryEntry);
  if (seedData.length === 0) {
    logger.warn("No glossary seed data found.");
    return;
  }

  await GlossaryEntry.insertMany(seedData, { ordered: false });
  logger.info(`Seeded ${seedData.length} glossary entries from JSON.`);
}

// ---------------- AUTH MIDDLEWARE ----------------
function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    logger.warn("Missing authorization header");
    return res.status(401).json({ error: "Missing authorization header" });
  }

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    logger.error(`Invalid token: ${err.message}`);
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ---------------- ROUTES ----------------
app.get("/", (req, res) => {
  logger.info("Root endpoint accessed");
  res.send("Backend running and MongoDB connected.");
});

app.post("/api/glossary/register", async (req, res) => {
  const { username, password } = req.body || {};

  if (!String(username || "").trim() || !String(password || "").trim()) {
    return res.status(400).json({ error: "Username and password are required" });
  }

  try {
    const hashed = await bcrypt.hash(password, 10);
    const newUser = new User({ username: username.trim(), password: hashed });
    await newUser.save();
    logger.info(`User registered: ${username}`);
    res.json({ message: "User registered successfully" });
  } catch (err) {
    if (err.code === 11000) {
      logger.warn(`Username already exists: ${username}`);
      return res.status(400).json({ error: "Username already exists" });
    }

    logger.error(`Registration failed for ${username}: ${err.message}`);
    res.status(500).json({ error: "Signup failed" });
  }
});

app.post("/api/glossary/login", async (req, res) => {
  const { username, password } = req.body || {};

  if (!String(username || "").trim() || !String(password || "").trim()) {
    return res.status(400).json({ error: "Username and password are required" });
  }

  try {
    const user = await User.findOne({ username: username.trim() });
    if (!user) {
      logger.warn(`Login failed: user not found - ${username}`);
      return res.status(400).json({ error: "Invalid credentials" });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      logger.warn(`Invalid password for user: ${username}`);
      return res.status(400).json({ error: "Invalid credentials" });
    }

    const token = jwt.sign(
      { id: user._id, username: user.username },
      JWT_SECRET,
      { expiresIn: "1h" }
    );

    logger.info(`User logged in: ${username}`);
    res.json({
      message: "Login successful",
      token,
      username: user.username,
    });
  } catch (err) {
    logger.error(`Login error for ${username}: ${err.message}`);
    res.status(500).json({ error: "Login failed" });
  }
});

// ---------------- GLOSSARY ROUTES ----------------
app.get("/api/glossary/getAll", verifyToken, async (req, res) => {
  try {
    const glossary = await getAllGlossaryEntries();
    logger.info(`User ${req.user.username} fetched glossary`);
    res.json(glossary);
  } catch (err) {
    logger.error(`Failed to fetch glossary: ${err.message}`);
    res.status(500).json({ error: "Failed to fetch glossary" });
  }
});

app.get("/api/glossary/search", verifyToken, async (req, res) => {
  const { q = "", lang = "all" } = req.query;

  try {
    const glossary = await getAllGlossaryEntries();
    if (!q) return res.json(glossary);

    const lowered = normalizeWord(q);
    const filtered = glossary.filter((entry) => {
      if (lang === "all") {
        return ["en", "de"].some(
          (language) =>
            Array.isArray(entry[language]) &&
            entry[language].some(({ word }) => normalizeWord(word).includes(lowered))
        );
      }

      return (
        Array.isArray(entry[lang]) &&
        entry[lang].some(({ word }) => normalizeWord(word).includes(lowered))
      );
    });

    logger.info(`Search query: "${q}" by ${req.user.username}`);
    res.json(filtered);
  } catch (err) {
    logger.error(`Search failed: ${err.message}`);
    res.status(500).json({ error: "Search failed" });
  }
});

app.post("/api/glossary/create", verifyToken, async (req, res) => {
  const { errors, payload } = validateGlossaryPayload(req.body);
  if (errors.length > 0) {
    return res.status(400).json({ error: errors.join(" ") });
  }

  try {
    const glossary = await getAllGlossaryEntries();
    const duplicates = collectDuplicateWords(payload, glossary);

    if (duplicates.length > 0) {
      logger.warn(
        `Duplicate glossary word rejected for ${req.user.username}: ${JSON.stringify(duplicates)}`
      );
      return sendDuplicateResponse(res, duplicates);
    }

    const newEntry = await GlossaryEntry.create({
      id: randomUUID(),
      ...payload,
      lastModifiedBy: req.user.username,
      lastModifiedAt: getGermanTimestamp(),
    });

    logger.info(`Entry created by ${req.user.username}: ${newEntry.id}`);
    res.json({
      message: "Entry added successfully",
      object: serializeGlossaryEntry(newEntry),
    });
  } catch (err) {
    logger.error(`Create failed: ${err.message}`);
    res.status(500).json({ error: "Failed to add entry" });
  }
});

app.put("/api/glossary/update/:id", verifyToken, async (req, res) => {
  const { id } = req.params;
  const { errors, payload } = validateGlossaryPayload(req.body, {
    partial: true,
  });

  if (errors.length > 0) {
    return res.status(400).json({ error: errors.join(" ") });
  }

  try {
    const existingEntry = await GlossaryEntry.findOne({ id }).lean();
    if (!existingEntry) {
      logger.warn(`Update failed: entry not found (${id})`);
      return res.status(404).json({ error: "Entry not found" });
    }

    const updatesWords = "en" in payload || "de" in payload;
    const updatedEntry = {
      ...serializeGlossaryEntry(existingEntry),
      ...payload,
    };

    if (updatesWords) {
      const glossary = await getAllGlossaryEntries();
      const duplicates = collectDuplicateWords(updatedEntry, glossary, {
        excludeId: id,
      });

      if (duplicates.length > 0) {
        logger.warn(
          `Duplicate glossary word rejected for ${req.user.username}: ${JSON.stringify(duplicates)}`
        );
        return sendDuplicateResponse(res, duplicates);
      }
    }

    const savedEntry = await GlossaryEntry.findOneAndUpdate(
      { id },
      {
        $set: {
          ...payload,
          lastModifiedBy: req.user.username,
          lastModifiedAt: getGermanTimestamp(),
        },
      },
      { new: true }
    );

    logger.info(`Entry updated by ${req.user.username}: ${id}`);
    res.json({
      message: "Entry updated",
      object: serializeGlossaryEntry(savedEntry),
    });
  } catch (err) {
    logger.error(`Update failed for ${id}: ${err.message}`);
    res.status(500).json({ error: "Failed to update entry" });
  }
});

app.delete("/api/glossary/delete/:id", verifyToken, async (req, res) => {
  const { id } = req.params;

  try {
    const result = await GlossaryEntry.deleteOne({ id });
    if (result.deletedCount === 0) {
      logger.warn(`Delete failed: entry not found (${id})`);
      return res.status(404).json({ error: "Entry not found" });
    }

    logger.info(`Entry deleted by ${req.user.username}: ${id}`);
    res.json({ message: "Entry deleted" });
  } catch (err) {
    logger.error(`Delete failed for ${id}: ${err.message}`);
    res.status(500).json({ error: "Failed to delete entry" });
  }
});

app.post("/api/glossary/delete-multiple", verifyToken, async (req, res) => {
  const { ids } = req.body || {};

  if (!Array.isArray(ids)) {
    logger.error("delete-multiple: ids must be an array");
    return res.status(400).json({ error: "ids must be an array" });
  }

  try {
    const result = await GlossaryEntry.deleteMany({ id: { $in: ids } });
    logger.info(`${result.deletedCount} entries deleted by ${req.user.username}`);
    res.json({ message: `Deleted ${result.deletedCount} entries` });
  } catch (err) {
    logger.error(`Bulk delete failed: ${err.message}`);
    res.status(500).json({ error: "Failed to delete selected entries" });
  }
});

app.get("/api/glossary/export", verifyToken, async (req, res) => {
  try {
    const data = await getAllGlossaryEntries();
    const cleaned = data.map(cleanExportEntry);
    writeJsonFile(exportFilePath, cleaned);

    logger.info(`Glossary exported by ${req.user.username}`);
    res.download(exportFilePath, "glossary_bilingual.json");
  } catch (err) {
    logger.error(`Export failed: ${err.message}`);
    res.status(500).json({ error: "Export failed" });
  }
});

// ---------------- START SERVER ----------------
async function startServer() {
  await mongoose.connect(MONGO_URI);
  logger.info("MongoDB connected");
  await seedGlossaryFromJsonIfEmpty();

  app.listen(PORT, () => {
    logger.info(`Server running at http://localhost:${PORT}`);
  });
}

if (require.main === module) {
  startServer().catch((err) => {
    logger.error(`Failed to start server: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  app,
  collectDuplicateWords,
  formatDuplicateMessage,
  normalizeWord,
  parseGermanTimestamp,
  cleanExportEntry,
  serializeJson,
  sanitizeWordEntry,
  validateGlossaryPayload,
};
