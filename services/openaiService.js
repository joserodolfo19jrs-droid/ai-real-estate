// services/openaiService.js
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function generateListing(info) {
  const prompt = `
You are an expert real estate copywriter.

Write a polished property listing using this data:

${JSON.stringify(info, null, 2)}

Style: ${info.tone || "professional MLS style"}.

Requirements:
- Start with a short, catchy title.
- Then 2–3 paragraphs describing the home, layout, finishes, and lifestyle.
- Include a bullet list of key features (beds, baths, sqft, lot, upgrades, etc.).
- Add a short section highlighting the neighborhood/location.
- Finish with a strong call-to-action for buyers or agents.
`;

  const response = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      { role: "system", content: "You write clear, persuasive real estate listing descriptions." },
      { role: "user", content: prompt },
    ],
  });

  return response.choices[0].message.content;
}
