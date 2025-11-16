require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { randomUUID } = require("crypto");

// 👉 use require here instead of import since the file uses CommonJS syntax
const logger = require("./src/utils/logger.js");

const app = express();
const PORT = process.env.PORT || 3002;

// ---------------- MIDDLEWARE ----------------
app.use(cors());
app.use(bodyParser.json());

// ---------------- DATABASE ----------------
mongoose
  .connect("mongodb://appUser:AppPass456@127.0.0.1:27017/glossary_app")
  .then(() => {
    logger.info("✅ MongoDB connected");
  })
  .catch((err) => {
    logger.error("❌ MongoDB connection error: " + err.message);
  });

// ---------------- MODELS ----------------
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  password: String,
});
const User = mongoose.model("User", userSchema);

// ---------------- FILE PATHS ----------------
const dataFilePath = path.join(__dirname, "assets", "glossary_data.json");
const exportFilePath = path.join(__dirname, "assets", "glossary_bilingual.json");

// ---------------- JSON HELPERS ----------------
function readJsonFile(filePath = dataFilePath) {
  if (!fs.existsSync(filePath)) {
    logger.warn(`⚠️ File not found: ${filePath}`);
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    logger.error(`❌ Error reading file ${filePath}: ${err.message}`);
    return [];
  }
}

function writeJsonFile(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
    logger.info(`💾 Successfully wrote to file: ${filePath}`);
  } catch (err) {
    logger.error(`❌ Failed to write file ${filePath}: ${err.message}`);
  }
}

function getGermanTimestamp() {
  return new Date().toLocaleString("de-DE", { timeZone: "Europe/Berlin" });
}

// ---------------- AUTH MIDDLEWARE ----------------
function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    logger.warn("⚠️ Missing authorization header");
    return res.status(401).json({ error: "Missing authorization header" });
  }

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, "devSecret123");
    req.user = decoded;
    next();
  } catch (err) {
    logger.error(`❌ Invalid token: ${err.message}`);
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ---------------- ROUTES ----------------

// ✅ Root Test
app.get("/", (req, res) => {
  logger.info("Root endpoint accessed");
  res.send("🚀 Backend running and MongoDB connected!");
});

// ✅ Register
app.post("/api/glossary/register", async (req, res) => {
  const { username, password } = req.body;
  try {
    const hashed = await bcrypt.hash(password, 10);
    const newUser = new User({ username, password: hashed });
    await newUser.save();
    logger.info(`👤 User registered: ${username}`);
    res.json({ message: "✅ User registered successfully" });
  } catch (err) {
    if (err.code === 11000) {
      logger.warn(`⚠️ Username already exists: ${username}`);
      res.status(400).json({ error: "Username already exists" });
    } else {
      logger.error(`❌ Registration failed for ${username}: ${err.message}`);
      res.status(500).json({ error: "Signup failed" });
    }
  }
});

// ✅ Login
app.post("/api/glossary/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    const user = await User.findOne({ username });
    if (!user) {
      logger.warn(`⚠️ Login failed: user not found - ${username}`);
      return res.status(400).json({ error: "Invalid credentials" });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      logger.warn(`⚠️ Invalid password for user: ${username}`);
      return res.status(400).json({ error: "Invalid credentials" });
    }

    const token = jwt.sign(
      { id: user._id, username: user.username },
      "devSecret123",
      { expiresIn: "1h" }
    );

    logger.info(`🔐 User logged in: ${username}`);
    res.json({
      message: "✅ Login successful",
      token,
      username: user.username,
    });
  } catch (err) {
    logger.error(`❌ Login error for ${username}: ${err.message}`);
    res.status(500).json({ error: "Login failed" });
  }
});

// ---------------- GLOSSARY ROUTES ----------------

// 📖 Get all (protected)
app.get("/api/glossary/getAll", verifyToken, (req, res) => {
  const glossary = readJsonFile();
  logger.info(`📚 User ${req.user.username} fetched glossary`);
  res.json(glossary);
});

// 🔍 Search
app.get("/api/glossary/search", verifyToken, (req, res) => {
  const { q = "", lang = "all" } = req.query;
  const glossary = readJsonFile();

  if (!q) return res.json(glossary);

  const lowered = q.toLowerCase();
  const filtered = glossary.filter((entry) => {
    if (lang === "all") {
      return ["en", "de"].some(
        (l) =>
          Array.isArray(entry[l]) &&
          entry[l].some(
            ({ word }) => word && word.toLowerCase().includes(lowered)
          )
      );
    }
    return (
      Array.isArray(entry[lang]) &&
      entry[lang].some(({ word }) =>
        word ? word.toLowerCase().includes(lowered) : false
      )
    );
  });

  logger.info(`🔍 Search query: "${q}" by ${req.user.username}`);
  res.json(filtered);
});

// 🟢 Create
app.post("/api/glossary/create", verifyToken, (req, res) => {
  const glossary = readJsonFile();
  const username = req.user.username;
  const timestamp = getGermanTimestamp();

  const newEntry = {
    id: randomUUID(),
    ...req.body,
    lastModifiedBy: username,
    lastModifiedAt: timestamp,
  };

  glossary.unshift(newEntry);
  writeJsonFile(dataFilePath, glossary);

  logger.info(`🟢 Entry created by ${username}: ${newEntry.id}`);
  res.json({ message: "✅ Entry added successfully", object: newEntry });
});

// ✏️ Update
app.put("/api/glossary/update/:id", verifyToken, (req, res) => {
  const { id } = req.params;
  const glossary = readJsonFile();
  const index = glossary.findIndex((item) => item.id === id);
  if (index === -1) {
    logger.warn(`⚠️ Update failed: entry not found (${id})`);
    return res.status(404).json({ error: "Entry not found" });
  }

  glossary[index] = {
    ...glossary[index],
    ...req.body,
    lastModifiedBy: req.user.username,
    lastModifiedAt: getGermanTimestamp(),
  };

  writeJsonFile(dataFilePath, glossary);
  logger.info(`✏️ Entry updated by ${req.user.username}: ${id}`);
  res.json({ message: "✏️ Entry updated", object: glossary[index] });
});

// 🗑️ Delete single
app.delete("/api/glossary/delete/:id", verifyToken, (req, res) => {
  const { id } = req.params;
  let glossary = readJsonFile();
  const initial = glossary.length;
  glossary = glossary.filter((item) => item.id !== id);

  if (glossary.length === initial) {
    logger.warn(`⚠️ Delete failed: entry not found (${id})`);
    return res.status(404).json({ error: "Entry not found" });
  }

  writeJsonFile(dataFilePath, glossary);
  logger.info(`🗑️ Entry deleted by ${req.user.username}: ${id}`);
  res.json({ message: "🗑️ Entry deleted" });
});

// 🧹 Delete multiple
app.post("/api/glossary/delete-multiple", verifyToken, (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) {
    logger.error("❌ delete-multiple: ids must be an array");
    return res.status(400).json({ error: "ids must be an array" });
  }

  let glossary = readJsonFile();
  const initial = glossary.length;
  glossary = glossary.filter((item) => !ids.includes(item.id));
  const deletedCount = initial - glossary.length;

  writeJsonFile(dataFilePath, glossary);
  logger.info(`🧹 ${deletedCount} entries deleted by ${req.user.username}`);
  res.json({ message: `🧹 Deleted ${deletedCount} entries` });
});

// 📦 Export (clean JSON)
app.get("/api/glossary/export", verifyToken, (req, res) => {
  const data = readJsonFile(dataFilePath);
  const cleaned = data.map(({ lastModifiedBy, lastModifiedAt, ...rest }) => rest);
  writeJsonFile(exportFilePath, cleaned);

  logger.info(`📦 Glossary exported by ${req.user.username}`);
  res.download(exportFilePath, "glossary_bilingual.json");
});

// ---------------- START SERVER ----------------
app.listen(PORT, () => {
  logger.info(`🚀 Server running at http://localhost:${PORT}`);
});
