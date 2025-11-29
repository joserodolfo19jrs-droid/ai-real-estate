// index.js - AI Real Estate Backend (CommonJS)

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");

const app = express();

// ---------- PERSISTENCE SETUP (JSON FILE) ----------
const DATA_FILE = path.join(__dirname, "listings.json");

// Temporary in-memory storage for saved listings (will sync with file)
let savedListings = [];

// Load listings from file on startup
function loadListingsFromFile() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf8");
      savedListings = JSON.parse(raw);
      console.log(`📂 Loaded ${savedListings.length} saved listings from file.`);
    } else {
      savedListings = [];
      console.log("📂 No listings.json file found. Starting fresh.");
    }
  } catch (err) {
    console.error("❌ Error reading listings.json:", err);
    savedListings = [];
  }
}

// Save listings to file
function saveListingsToFile() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(savedListings, null, 2), "utf8");
    console.log("💾 Saved listings to listings.json");
  } catch (err) {
    console.error("❌ Error writing listings.json:", err);
  }
}

// Load on startup
loadListingsFromFile();

// ---------- OPENAI SETUP ----------

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.use(cors());
app.use(express.json());

// ---------------- TEST ROUTES ----------------

// Test route
app.get("/", (req, res) => {
  res.send("✅ AI Real Estate Backend is running");
});

// Simple GET listing (no AI, just for testing)
app.get("/generate-listing", (req, res) => {
  const address = req.query.address || "123 Main St";
  const beds = req.query.beds || 3;
  const baths = req.query.baths || 2;
  const sqrft = req.query.sqrft || 1800;

  res.send(
    `Beautiful home at ${address} featuring ${beds} bedrooms, ${baths} bathrooms, and ${sqrft} sq ft.`
  );
});

// ---------------- HELPERS ----------------

function toneToStyle(tone) {
  if (tone === "luxury") {
    return "Use an upscale, luxury real estate tone highlighting premium finishes, lifestyle, and exclusivity.";
  }
  if (tone === "investor") {
    return "Write for real estate investors, focusing on ROI potential, rental income, value-add opportunities, and neighborhood growth.";
  }
  if (tone === "casual") {
    return "Use a friendly, casual tone like a social media post, still professional but relaxed and approachable.";
  }
  if (tone === "spanish") {
    return "Write the entire listing in natural, professional Latin American Spanish suitable for real estate marketing.";
  }
  // default neutral
  return "Use a neutral, professional MLS-style real estate tone.";
}

// Escape CSV field
function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  // Escape double quotes by doubling them
  const escaped = str.replace(/"/g, '""');
  // Wrap in quotes to handle commas/newlines
  return `"${escaped}"`;
}

// ---------------- AI LISTING ROUTE ----------------

app.post("/generate-listing", async (req, res) => {
  try {
    const { address, beds, baths, sqrft, tone } = req.body;

    const style = toneToStyle(tone || "neutral");

    const prompt = `
Write a short, professional real estate listing for a property.
Address: ${address}
Bedrooms: ${beds}
Bathrooms: ${baths}
Square Feet: ${sqrft}

Style instructions: ${style}
Keep it under 130 words.
`;

    const response = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: "You are a professional real estate listing writer." },
        { role: "user", content: prompt }
      ],
    });

    const listing = response.choices[0].message.content;

    return res.json({ listing });
  } catch (error) {
    console.error("❌ OpenAI Error:", error);

    return res.json({
      listing:
        "Beautiful home perfect for modern living — contact your agent for more details!",
    });
  }
});

// ---------------- SAVE + HISTORY + DELETE + EXPORT ----------------

// Save listing route
app.post("/save-listing", (req, res) => {
  const { address, tone, listingText } = req.body;

  if (!address || !tone || !listingText) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const entry = {
    address,
    tone,
    listingText,
    createdAt: new Date().toISOString(),
  };

  savedListings.push(entry);
  saveListingsToFile();

  res.json({ success: true, message: "Listing saved!", entry });
});

// View saved listing history
app.get("/history", (req, res) => {
  res.json(savedListings);
});

// Delete listing by index
app.post("/delete-listing", (req, res) => {
  const { index } = req.body;

  if (
    index === undefined ||
    typeof index !== "number" ||
    index < 0 ||
    index >= savedListings.length
  ) {
    return res.status(400).json({ error: "Invalid index" });
  }

  savedListings.splice(index, 1);
  saveListingsToFile();

  res.json({ success: true, message: "Listing deleted." });
});

// Export listings to CSV
app.get("/export-csv", (req, res) => {
  if (!savedListings.length) {
    return res.status(400).send("No listings to export.");
  }

  const header = ["Address", "Tone", "CreatedAt", "ListingText"];
  const lines = [header.join(",")];

  savedListings.forEach((entry) => {
    const row = [
      csvEscape(entry.address),
      csvEscape(entry.tone),
      csvEscape(entry.createdAt),
      csvEscape(entry.listingText),
    ];
    lines.push(row.join(","));
  });

  const csv = lines.join("\n");

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", 'attachment; filename="listings.csv"');
  res.send(csv);
});

// ---------------- FORECLOSURES ROUTE ----------------

app.get("/foreclosures/:county", (req, res) => {
  const { county } = req.params;

  res.json([
    { id: 1, address: "123 Main St", status: "Auction", county },
    { id: 2, address: "77 Oak Ridge", status: "Notice of Sale", county },
  ]);
});

// ---------------- START SERVER ----------------

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
