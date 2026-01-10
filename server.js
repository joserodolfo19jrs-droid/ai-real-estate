const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const crypto = require("crypto");
const puppeteer = require("puppeteer");
require("dotenv").config();

const rateLimit = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 3001;

// Debug (optional)
console.log("OPENAI KEY EXISTS:", !!process.env.OPENAI_API_KEY);

// Limit AI calls per IP
const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // 30 requests per 15 min per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});

// Used inside the AI route
const hasOpenAIKey = !!process.env.OPENAI_API_KEY;
if (!hasOpenAIKey) console.warn("⚠️ OPENAI_API_KEY missing — AI generation disabled.");


// ---------------- Middleware ----------------
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use(express.static(path.join(__dirname, "public"))); // serves index.html

// ---------------- Storage ----------------
const DATA_DIR = path.join(__dirname, "data");
const LISTINGS_FILE = path.join(DATA_DIR, "listings.json");

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(LISTINGS_FILE)) fs.writeFileSync(LISTINGS_FILE, JSON.stringify([], null, 2));
}
function readListings() {
  ensureDataFile();
  try {
    const raw = fs.readFileSync(LISTINGS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function writeListings(listings) {
  ensureDataFile();
  fs.writeFileSync(LISTINGS_FILE, JSON.stringify(listings, null, 2));
}

// ---------------- Uploads (multer) ----------------
const UPLOADS_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname || "").toLowerCase() || ".jpg").slice(0, 10);
    cb(null, crypto.randomBytes(16).toString("hex") + ext);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ["image/jpeg", "image/png", "image/webp", "image/jpg"].includes(file.mimetype);
    cb(ok ? null : new Error("Only jpg/png/webp allowed"), ok);
  },
});

// ---------------- Helpers ----------------
function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function imageUrlToDataUri(imageUrl) {
  try {
    if (!imageUrl) return null;
    const s = String(imageUrl);

    // Only allow local uploads so Puppeteer always renders images
    if (!s.startsWith("/uploads/")) return null;

    const filePath = path.join(__dirname, s);
    if (!fs.existsSync(filePath)) return null;

    const ext = path.extname(filePath).toLowerCase();
    const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
    const b64 = fs.readFileSync(filePath).toString("base64");
    return `data:${mime};base64,${b64}`;
  } catch {
    return null;
  }
}

function fmtCurrency(v) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  if (s.includes("$") || s.includes(",")) return s;
  const n = Number(s.replace(/[^\d.]/g, ""));
  if (!Number.isFinite(n)) return s;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}

function fmtNumber(v) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  if (s.includes(",")) return s;
  const n = Number(s.replace(/[^\d.]/g, ""));
  if (!Number.isFinite(n)) return s;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);
}

// ---------------- OpenAI Generation (optional) ----------------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

function buildPrompt(input) {
  const tone = input.tone || "MLS (English)";
  const spanish = /spanish/i.test(tone);
  const langRule = spanish
    ? "Language requirement: Output must be 100% Spanish. Do NOT include English."
    : "Language requirement: Output must be 100% English.";

  return `
You are an expert real estate listing writer.
Style/Tone: "${tone}"
${langRule}

Rules:
- Use clear, professional language appropriate to the tone.
- Avoid fair-housing violations.
- Use only provided facts; do not invent specifics.
- Output: First line = title. Then a polished description. Then optional bullet highlights.

Property details:
Address: ${input.address || ""}
City/State: ${(input.city || "")} ${(input.state || "")}
Price: ${input.price || ""}
Beds: ${input.beds || ""}
Baths: ${input.baths || ""}
Sqft: ${input.sqft || ""}
Year Built: ${input.yearBuilt || ""}
Features/Notes: ${input.features || ""}
Extra description from user: ${input.descriptionInput || ""}
`.trim();
}

async function generateWithOpenAI(prompt) {
  if (!OPENAI_API_KEY) {
    return {
      title: "Property Listing",
      description:
        "OPENAI_API_KEY is not set. Add it to your .env file to enable AI generation.\n\n(Uploads + PDF + branding still work.)",
    };
  }

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: "You generate real estate listing content." },
        { role: "user", content: prompt },
      ],
      temperature: 0.7,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenAI error (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content?.trim() || "";
  const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
  const title = (lines[0] && lines[0].length <= 90 ? lines[0] : "Property Listing").replace(/^["']|["']$/g, "");
  return { title, description: content };
}

// ---------------- PDF builder (reused) ----------------
function buildPdfHtml(listing) {
  const agent = listing.agent || {};
  const propertyImageDataUri = imageUrlToDataUri(listing.imageUrl);
  const agentLogoDataUri = imageUrlToDataUri(agent.logoUrl);

  const priceFmt = fmtCurrency(listing.price);
  const sqftFmt = fmtNumber(listing.sqft);

  const presentedBy = agent.name ? escapeHtml(agent.name) : "—";
  const brokerageSuffix = agent.brokerage ? " • " + escapeHtml(agent.brokerage) : "";

  return `
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Listing PDF</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 40px; color: #111; }
    :root { --accent: #111; }

    .topbar { display:flex; justify-content: space-between; align-items:flex-start; gap:18px; }
    .left { flex: 1; }
    .right { width: 260px; text-align: right; }

    .title { font-size: 22px; font-weight: 800; margin: 0; letter-spacing: .2px; }
    .subtitle { margin: 6px 0 0 0; color: #444; font-size: 12px; line-height: 1.35; }

    .badge { display:inline-block; margin-top: 10px; font-size: 11px; padding: 6px 10px; border: 1px solid #ddd; border-radius: 999px; color: #111; background: #fff; }

    .presented { margin-top: 12px; font-size: 11px; color: #666; }
    .presented b { color: #111; }

    .logoBox { display:flex; justify-content:flex-end; margin-bottom: 10px; }
    .logoBox img { max-width: 170px; max-height: 70px; object-fit: contain; }

    .agentCard { border: 1px solid #eee; border-radius: 14px; padding: 12px; text-align: left; background: #fff; }
    .agentName { font-weight: 800; font-size: 13px; margin: 0; color: #111; }
    .agentLine { font-size: 11px; color:#444; margin: 4px 0; }

    .hero { margin-top: 18px; border: 1px solid #eee; border-radius: 16px; overflow: hidden; }
    .hero img { width: 100%; height: 280px; object-fit: cover; display:block; }

    .grid { display:grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 16px; }
    .card { border: 1px solid #eee; border-radius: 14px; padding: 14px; background:#fff; }
    .k { color: #666; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
    .v { font-size: 14px; font-weight: 700; margin-top: 4px; }
    .priceBig { font-size: 18px; font-weight: 900; color: var(--accent); }

    .desc { margin-top: 16px; line-height: 1.5; white-space: pre-wrap; font-size: 12.5px; }

    .footerBar { margin-top: 20px; border-top: 1px solid #eee; padding-top: 12px; display:flex; justify-content: space-between; align-items: center; gap: 14px; font-size: 10.5px; color:#666; }
    .footerLeft { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
    .footerDot { width: 4px; height: 4px; border-radius: 999px; background: #bbb; display:inline-block; }
    .footerRight { text-align:right; }
    .smallCaps { text-transform: uppercase; letter-spacing: .08em; font-size: 10px; color:#777; }
  </style>
</head>
<body>

  <div class="topbar">
    <div class="left">
      <p class="title">${escapeHtml(listing.title || "Property Listing")}</p>
      <p class="subtitle">${escapeHtml([listing.address, listing.city, listing.state].filter(Boolean).join(", "))}</p>
      <div class="badge">${escapeHtml(listing.tone || "MLS")}</div>
      <div class="presented">Presented by <b>${presentedBy}</b>${brokerageSuffix}</div>
    </div>

    <div class="right">
      ${agentLogoDataUri ? `<div class="logoBox"><img src="${agentLogoDataUri}" /></div>` : ""}
      <div class="agentCard">
        ${agent.name ? `<div class="agentName">${escapeHtml(agent.name)}</div>` : ""}
        ${agent.phone ? `<div class="agentLine">${escapeHtml(agent.phone)}</div>` : ""}
        ${agent.email ? `<div class="agentLine">${escapeHtml(agent.email)}</div>` : ""}
        ${agent.brokerage ? `<div class="agentLine">${escapeHtml(agent.brokerage)}</div>` : ""}
      </div>
    </div>
  </div>

  ${propertyImageDataUri ? `<div class="hero"><img src="${propertyImageDataUri}" /></div>` : ""}

  <div class="grid">
    <div class="card">
      <div class="k">Price</div>
      <div class="v priceBig">${escapeHtml(priceFmt || listing.price || "")}</div>
    </div>
    <div class="card">
      <div class="k">Beds / Baths / Sqft</div>
      <div class="v">${escapeHtml([listing.beds, listing.baths, sqftFmt || listing.sqft].filter(Boolean).join(" • "))}</div>
    </div>
  </div>

  ${listing.yearBuilt ? `
    <div class="card" style="margin-top:14px;">
      <div class="k">Year Built</div>
      <div class="v">${escapeHtml(listing.yearBuilt)}</div>
    </div>
  ` : ""}

  <div class="card desc">${escapeHtml(listing.description || "")}</div>

  <div class="footerBar">
    <div class="footerLeft">
      <span class="smallCaps">Listing Flyer</span>
      <span class="footerDot"></span>
      <span>${escapeHtml(agent.name || "")}</span>
      ${agent.phone ? `<span class="footerDot"></span><span>${escapeHtml(agent.phone)}</span>` : ""}
      ${agent.email ? `<span class="footerDot"></span><span>${escapeHtml(agent.email)}</span>` : ""}
    </div>
    <div class="footerRight">Generated ${escapeHtml(new Date().toLocaleString())}</div>
  </div>

</body>
</html>
`.trim();
}

// ---------------- Routes ----------------
app.get("/api/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.post("/api/upload", upload.single("image"), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: "No file uploaded." });
  return res.json({ ok: true, imageUrl: `/uploads/${req.file.filename}` });
});

app.post("/api/listings/generate", aiLimiter, async (req, res) => {
  if (!hasOpenAIKey) {
    return res.status(503).json({ error: "AI generation is disabled (missing OPENAI_API_KEY)." });
  }

  try {
    const input = req.body || {};
    const prompt = buildPrompt(input);
    const generated = await generateWithOpenAI(prompt);

    const listing = {
      id: crypto.randomBytes(12).toString("hex"),
      createdAt: new Date().toISOString(),
      tone: input.tone || "MLS (English)",
      title: generated.title || "Property Listing",
      description: generated.description || "",
      address: input.address || "",
      city: input.city || "",
      state: input.state || "",
      price: input.price || "",
      beds: input.beds || "",
      baths: input.baths || "",
      sqft: input.sqft || "",
      yearBuilt: input.yearBuilt || "",
      features: input.features || "",
      descriptionInput: input.descriptionInput || "",
      imageUrl: input.imageUrl || "",
      agent: {
        name: input?.agent?.name || "",
        brokerage: input?.agent?.brokerage || "",
        phone: input?.agent?.phone || "",
        email: input?.agent?.email || "",
        logoUrl: input?.agent?.logoUrl || "",
      },
    };

    return res.json({ ok: true, listing });
  } catch (err) {
    console.error("Generate error:", err);
    return res.status(500).json({ ok: false, error: "Failed to generate listing." });
  }
});


app.get("/api/listings", (req, res) => {
  const listings = readListings();
  return res.json({ ok: true, listings });
});

app.get("/api/listings/:id", (req, res) => {
  try {
    const listings = readListings();
    const listing = listings.find((l) => l.id === req.params.id);
    if (!listing) return res.status(404).json({ ok: false, error: "Listing not found." });
    return res.json({ ok: true, listing });
  } catch (err) {
    console.error("Get listing error:", err);
    return res.status(500).json({ ok: false, error: "Failed to load listing." });
  }
});

app.post("/api/listings/save", (req, res) => {
  try {
    const listing = req.body;
    if (!listing?.id) return res.status(400).json({ ok: false, error: "Listing with id is required." });
    const listings = readListings();
    listings.unshift(listing);
    writeListings(listings);
    return res.json({ ok: true });
  } catch (err) {
    console.error("Save error:", err);
    return res.status(500).json({ ok: false, error: "Failed to save listing." });
  }
});

app.delete("/api/listings/:id", (req, res) => {
  try {
    const listings = readListings();
    const filtered = listings.filter((l) => l.id !== req.params.id);
    writeListings(filtered);
    return res.json({ ok: true });
  } catch (err) {
    console.error("Delete error:", err);
    return res.status(500).json({ ok: false, error: "Failed to delete listing." });
  }
});

// PDF from listing object (current page)
app.post("/api/pdf", async (req, res) => {
  let browser;
  try {
    const listing = req.body || {};
    const html = buildPdfHtml(listing);

    browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });

    const pdfData = await page.pdf({
      format: "Letter",
      printBackground: true,
      margin: { top: "18mm", right: "14mm", bottom: "18mm", left: "14mm" },
    });

    const pdfBuffer = Buffer.isBuffer(pdfData) ? pdfData : Buffer.from(pdfData);
    res.status(200);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="listing.pdf"');
    res.setHeader("Content-Length", pdfBuffer.length);
    return res.end(pdfBuffer);
  } catch (err) {
    console.error("PDF Error:", err);
    return res.status(500).type("text/plain").send(String(err?.stack || err));
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

// PDF from saved listing ID (for share pages)
app.get("/pdf/:id", async (req, res) => {
  let browser;
  try {
    const listings = readListings();
    const listing = listings.find((l) => l.id === req.params.id);
    if (!listing) return res.status(404).type("text/plain").send("Listing not found.");

    const html = buildPdfHtml(listing);

    browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });

    const pdfData = await page.pdf({
      format: "Letter",
      printBackground: true,
      margin: { top: "18mm", right: "14mm", bottom: "18mm", left: "14mm" },
    });

    const pdfBuffer = Buffer.isBuffer(pdfData) ? pdfData : Buffer.from(pdfData);
    res.status(200);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="listing.pdf"');
    res.setHeader("Content-Length", pdfBuffer.length);
    return res.end(pdfBuffer);
  } catch (err) {
    console.error("PDF by id error:", err);
    return res.status(500).type("text/plain").send(String(err?.stack || err));
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

// Public share page
app.get("/listing/:id", (req, res) => {
  const id = req.params.id;

  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Listing ${escapeHtml(id)}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 0; background: #fafafa; color: #111; }
    .wrap { max-width: 980px; margin: 0 auto; padding: 18px; }
    .card { background: #fff; border: 1px solid #e8e8e8; border-radius: 14px; padding: 14px; }
    .top { display:flex; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
    .title { margin: 0; font-size: 20px; font-weight: 800; }
    .sub { margin: 8px 0 0; color:#555; font-size: 12px; line-height: 1.4; }
    .badge { display:inline-block; margin-top: 10px; font-size: 11px; padding: 6px 10px; border: 1px solid #ddd; border-radius: 999px; }
    .agent { text-align: right; min-width: 240px; }
    .logo { max-width: 180px; max-height: 70px; object-fit: contain; display:block; margin-left: auto; margin-bottom: 8px; }
    .agentName { font-weight: 800; margin: 0; font-size: 13px; }
    .agentLine { margin: 4px 0; font-size: 11px; color:#444; }
    .hero { margin-top: 14px; border: 1px solid #eee; border-radius: 14px; overflow: hidden; }
    .hero img { width: 100%; height: 320px; object-fit: cover; display:block; }
    .grid { display:grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 14px; }
    @media (max-width: 720px) { .grid { grid-template-columns: 1fr; } .agent { text-align:left; } .logo { margin-left: 0; } }
    .k { color:#666; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
    .v { font-size: 14px; font-weight: 800; margin-top: 4px; }
    .desc { margin-top: 14px; white-space: pre-wrap; line-height: 1.5; font-size: 13px; }
    .btns { display:flex; gap: 10px; flex-wrap: wrap; margin-top: 12px; }
    a.btn { border: 1px solid #e8e8e8; border-radius: 10px; padding: 10px 12px; background:#111; color:#fff; font-size: 14px; text-decoration:none; display:inline-block; }
    a.secondary { background:#fff; color:#111; }
    .muted { color:#666; font-size: 12px; margin-top: 10px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card" id="card"><div class="muted">Loading…</div></div>
  </div>

  <script>
    const id = ${JSON.stringify(id)};

    function esc(s){ return String(s ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;"); }
    function fmtMoney(x){
      const s = String(x ?? "").trim();
      if (!s) return "";
      if (s.includes("$") || s.includes(",")) return s;
      const n = Number(s.replace(/[^\\d.]/g,""));
      if (!Number.isFinite(n)) return s;
      return new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0}).format(n);
    }

    async function load() {
      const card = document.getElementById("card");
      try {
        const r = await fetch("/api/listings/" + encodeURIComponent(id));
        const data = await r.json();
        if (!r.ok || !data.ok) throw new Error(data.error || "Not found");

        const l = data.listing;
        const a = l.agent || {};

        card.innerHTML = \`
          <div class="top">
            <div>
              <h1 class="title">\${esc(l.title || "Property Listing")}</h1>
              <div class="sub">\${esc([l.address, l.city, l.state].filter(Boolean).join(", "))}</div>
              <div class="badge">\${esc(l.tone || "MLS")}</div>
            </div>

            <div class="agent">
              \${a.logoUrl ? \`<img class="logo" src="\${esc(a.logoUrl)}" alt="Agent logo" />\` : ""}
              \${a.name ? \`<p class="agentName">\${esc(a.name)}</p>\` : ""}
              \${a.brokerage ? \`<div class="agentLine">\${esc(a.brokerage)}</div>\` : ""}
              \${a.phone ? \`<div class="agentLine">\${esc(a.phone)}</div>\` : ""}
              \${a.email ? \`<div class="agentLine">\${esc(a.email)}</div>\` : ""}
            </div>
          </div>

          \${l.imageUrl ? \`<div class="hero"><img src="\${esc(l.imageUrl)}" alt="Property photo" /></div>\` : ""}

          <div class="grid">
            <div class="card">
              <div class="k">Price</div>
              <div class="v">\${esc(fmtMoney(l.price) || l.price || "")}</div>
            </div>
            <div class="card">
              <div class="k">Beds / Baths / Sqft</div>
              <div class="v">\${esc([l.beds, l.baths, l.sqft].filter(Boolean).join(" • "))}</div>
            </div>
          </div>

          \${l.yearBuilt ? \`
            <div class="card" style="margin-top:12px;">
              <div class="k">Year Built</div>
              <div class="v">\${esc(l.yearBuilt)}</div>
            </div>\` : ""}

          <div class="card desc">\${esc(l.description || "")}</div>

          <div class="btns">
            <a class="btn" href="/pdf/\${encodeURIComponent(l.id)}">Download PDF</a>
            <a class="btn secondary" href="/">Back to Generator</a>
          </div>

          <div class="muted">Share link: \${location.href}</div>
        \`;
      } catch (e) {
        card.innerHTML = '<div class="muted">This listing link is invalid or was deleted.</div>';
      }
    }

    load();
  </script>
</body>
</html>`);
});

// ---------------- Start ----------------
app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on http://127.0.0.1:" + PORT);
  console.log("Share pages: http://127.0.0.1:" + PORT + "/listing/<LISTING_ID>");
});
