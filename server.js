import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const app = express();

app.use(cors());
app.use(express.json());

// Serve the frontend
app.use(express.static("public"));

// Simple test route
app.get("/ping", (req, res) => {
  res.send("pong");
});

// AI-powered listing generator
app.post("/api/listings/generate", async (req, res) => {
  try {
    const {
      address,
      city,
      state,
      zip,
      price,
      beds,
      baths,
      sqft,
      extras,
      tone,
    } = req.body || {};

    const prompt = `
You are an expert real estate copywriter.

Write a polished property listing using this data:

Address: ${address || "N/A"}
City/State/ZIP: ${city || ""}${city && state ? ", " : ""}${state || ""} ${zip || ""}

Price: ${price || "N/A"}
Beds: ${beds || "N/A"}
Baths: ${baths || "N/A"}
Square Feet: ${sqft || "N/A"}

Extra details: ${extras || "None provided."}

Desired style: ${tone || "professional MLS style"}.

Requirements:
- Start with a short, catchy title.
- Then 2–3 paragraphs describing the home, layout, finishes, and lifestyle.
- Include a bullet list of key features (beds, baths, sqft, lot, upgrades, etc.).
- Add a short section highlighting the neighborhood/location.
- Finish with a strong call-to-action for buyers or agents.
Use clear, professional language. Do not mention that you are an AI.
`;

    const response = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content:
            "You write clear, persuasive real estate listing descriptions that sound like an experienced agent.",
        },
        { role: "user", content: prompt },
      ],
    });

    const listingText = response.choices[0]?.message?.content || "";

    res.json({ listing: listingText });
  } catch (err) {
    console.error("Error in /api/listings/generate:", err);
    res.status(500).json({ error: "Error generating listing" });
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
