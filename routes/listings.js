import express from "express";
import { generateListing } from "../services/openaiService.js";

const router = express.Router();

router.post("/generate", async (req, res) => {
  try {
    const listing = await generateListing(req.body);
    res.json({ listing });
  } catch (err) {
    console.error("Error in /api/listings/generate:", err);
    res.status(500).json({ error: "Error generating listing" });
  }
});

export default router;
