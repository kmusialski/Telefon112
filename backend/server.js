const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(express.json({ limit: "1mb" }));

// CORS — tylko własna domena (w produkcji ustaw ALLOWED_ORIGIN w .env)
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
app.use(cors({
  origin: ALLOWED_ORIGIN,
  methods: ["GET", "POST"],
}));

// Rate limiting — max 20 requestów/godzinę per IP
const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 godzina
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Przekroczono limit sesji. Spróbuj za godzinę." },
});
app.use("/api/", limiter);

// ============================================================
// WALIDACJA KLUCZY
// ============================================================
function requireKeys(req, res, next) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "Brak klucza ANTHROPIC_API_KEY na serwerze." });
  }
  if (!process.env.ELEVENLABS_API_KEY) {
    return res.status(500).json({ error: "Brak klucza ELEVENLABS_API_KEY na serwerze." });
  }
  next();
}

// ============================================================
// WALIDACJA DŁUGOŚCI ROZMOWY
// ============================================================
const MAX_MESSAGES = 20;

function validateHistory(messages) {
  if (!Array.isArray(messages)) return false;
  if (messages.length > MAX_MESSAGES) return false;
  return messages.every(m =>
    m && typeof m.role === "string" && typeof m.content === "string" &&
    ["user", "assistant"].includes(m.role) &&
    m.content.length < 2000
  );
}

// ============================================================
// ENDPOINT: /api/chat — proxy do Claude Haiku
// ============================================================
app.post("/api/chat", requireKeys, async (req, res) => {
  const { messages, system, lang } = req.body;

  if (!validateHistory(messages)) {
    return res.status(400).json({ error: "Nieprawidłowa historia rozmowy." });
  }
  if (typeof system !== "string" || system.length > 5000) {
    return res.status(400).json({ error: "Nieprawidłowy prompt systemowy." });
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        system: system,
        messages: messages,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      console.error("[Claude] Error:", response.status, err);
      return res.status(response.status).json({ error: err?.error?.message || "Błąd Claude API." });
    }

    const data = await response.json();
    const reply = data?.content?.[0]?.text;

    if (!reply) {
      return res.status(500).json({ error: "Pusta odpowiedź z Claude." });
    }

    console.log(`[Chat] lang=${lang || "pl"} tokens=${data.usage?.input_tokens}+${data.usage?.output_tokens}`);
    return res.json({ reply });

  } catch (e) {
    console.error("[Chat] Fetch error:", e.message);
    return res.status(500).json({ error: "Błąd połączenia z Claude API." });
  }
});

// ============================================================
// ENDPOINT: /api/tts — proxy do ElevenLabs
// ============================================================
const ALLOWED_VOICE_IDS = new Set([
  "pqHfZKP75CvOlQylNhV4",  // PL — aktualny głos
  "21m00Tcm4TlvDq8ikWAM",
  "pNInz6obpgDQGcFmaJgB",
  "ThT5KcBeYPX3keUQqHPh",
  "XB0fDUnXU5powFXDhCwa",  // DE
  "EXAVITQu4vr4xnSDxMaL",  // DE Sarah
]);

app.post("/api/tts", requireKeys, async (req, res) => {
  const { text, voiceId, voiceSettings } = req.body;

  if (typeof text !== "string" || text.length === 0 || text.length > 1000) {
    return res.status(400).json({ error: "Nieprawidłowy tekst TTS." });
  }
  if (!ALLOWED_VOICE_IDS.has(voiceId)) {
    return res.status(400).json({ error: "Niedozwolone voice_id." });
  }

  const vs = voiceSettings || { stability: 0.75, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true };

  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: text,
          model_id: "eleven_multilingual_v2",
          voice_settings: vs,
        }),
      }
    );

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      console.error("[TTS] Error:", response.status, err);
      return res.status(response.status).json({ error: "Błąd ElevenLabs API." });
    }

    const audioBuffer = await response.arrayBuffer();
    console.log(`[TTS] voice=${voiceId} bytes=${audioBuffer.byteLength}`);

    res.set("Content-Type", "audio/mpeg");
    res.set("Content-Length", audioBuffer.byteLength);
    return res.send(Buffer.from(audioBuffer));

  } catch (e) {
    console.error("[TTS] Fetch error:", e.message);
    return res.status(500).json({ error: "Błąd połączenia z ElevenLabs." });
  }
});

// ============================================================
// ENDPOINT: /api/anonymize — anonimizacja logu przez Claude
// ============================================================
app.post("/api/anonymize", requireKeys, async (req, res) => {
  const { text } = req.body;

  if (typeof text !== "string" || text.length === 0 || text.length > 10000) {
    return res.status(400).json({ error: "Nieprawidłowy tekst do anonimizacji." });
  }

  const prompt = `Zanonimizuj poniższy log rozmowy. Zamień wszystkie dane osobowe:
- imiona → [Imię]
- nazwiska → [Nazwisko]  
- adresy, ulice, numery domów → [Adres]
- nazwy miejscowości → [Miejscowość]
- numery telefonów → [Telefon]

Zachowaj strukturę rozmowy i pozostałe słowa bez zmian. Zwróć TYLKO zanonimizowany tekst.

LOG:
${text}`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: "Błąd anonimizacji." });
    }

    const data = await response.json();
    const anonymized = data?.content?.[0]?.text;
    if (!anonymized) return res.status(500).json({ error: "Pusta odpowiedź." });

    console.log(`[Anonymize] ${text.length} → ${anonymized.length} chars`);
    return res.json({ anonymized });

  } catch (e) {
    console.error("[Anonymize] Error:", e.message);
    return res.status(500).json({ error: "Błąd anonimizacji." });
  }
});

// ============================================================
// HEALTH CHECK
// ============================================================
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    version: "1.4.0",
    timestamp: new Date().toISOString(),
    keys: {
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      elevenlabs: !!process.env.ELEVENLABS_API_KEY,
    },
  });
});

app.listen(PORT, () => {
  console.log(`✅ Serwer działa na porcie ${PORT}`);
  console.log(`   ANTHROPIC_KEY: ${process.env.ANTHROPIC_API_KEY ? "✅ ustawiony" : "❌ BRAK"}`);
  console.log(`   ELEVENLABS_KEY: ${process.env.ELEVENLABS_API_KEY ? "✅ ustawiony" : "❌ BRAK"}`);
  console.log(`   ALLOWED_ORIGIN: ${ALLOWED_ORIGIN}`);
});
