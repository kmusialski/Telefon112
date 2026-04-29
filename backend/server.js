// ============================================================
// server.js — Zadzwoń pod 112 · Backend v1.5a
// Stack: Node.js + Express · Railway
// Nowe w v1.5a: Supabase (tokeny, kredyty, sesje), email logów
// ============================================================

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const { createClient } = require("@supabase/supabase-js");
const nodemailer = require("nodemailer");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(cors({
  origin: [
    "https://kmusialski.github.io",
    "https://telefon112-production.up.railway.app",
    "https://telefon112-dev.up.railway.app",
    "http://localhost:3000"
  ]
}));

// ============================================================
// ENV — Railway environment variables
// ============================================================
const {
  ANTHROPIC_API_KEY,
  ELEVENLABS_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,   // service_role key — tylko na serwerze!
  GMAIL_USER,             // np. app@zadzwon112.pl
  GMAIL_APP_PASSWORD,     // App Password z Gmail (nie hasło konta)
  ADMIN_EMAIL,            // opcjonalny CC
  PORT = 3000
} = process.env;

// ============================================================
// SUPABASE
// ============================================================
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ============================================================
// RATE LIMITER (in-memory, prosty)
// ============================================================
const rateMap = new Map();
function rateLimit(ip, max = 30, windowMs = 3600000) {
  const now = Date.now();
  const entry = rateMap.get(ip) || { count: 0, reset: now + windowMs };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + windowMs; }
  entry.count++;
  rateMap.set(ip, entry);
  return entry.count <= max;
}

// ============================================================
// HELPER — pobierz i zwaliduj token z Supabase
// ============================================================
async function getTokenData(token) {
  if (!token) return null;
  const { data, error } = await supabase
    .from("tokens")
    .select("id, token_code, school_id, credits, active, schools(name, director_email)")
    .eq("token_code", token.toUpperCase())
    .single();
  if (error || !data) return null;
  if (!data.active) return null;
  return data;
}

// ============================================================
// POST /api/validate-token
// Walidacja tokenu — zwraca credits i nazwę szkoły
// ============================================================
app.post("/api/validate-token", async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ valid: false, message: "Brak tokenu" });

  const tokenData = await getTokenData(token);
  if (!tokenData) return res.status(401).json({ valid: false, message: "Nieprawidłowy kod dostępu" });
  if (tokenData.credits <= 0) return res.status(402).json({ valid: false, message: "Brak dostępnych sesji. Odnów pakiet." });

  return res.json({
    valid: true,
    credits: tokenData.credits,
    school_name: tokenData.schools?.name || "",
    token_id: tokenData.id
  });
});

// ============================================================
// POST /api/chat
// Proxy do Claude Haiku — wymaga tokenu, odejmuje kredyt przy starcie sesji
// ============================================================
app.post("/api/chat", async (req, res) => {
  const ip = req.headers["x-forwarded-for"] || req.ip;
  if (!rateLimit(ip)) return res.status(429).json({ error: "Za dużo zapytań. Spróbuj za godzinę." });

  const { message, history = [], system, lang = "pl", token, session_id } = req.body;
  if (!message) return res.status(400).json({ error: "Brak wiadomości" });

  // Walidacja tokenu
  const tokenData = await getTokenData(token);
  if (!tokenData) return res.status(401).json({ error: "Nieprawidłowy token" });
  if (tokenData.credits <= 0) return res.status(402).json({ error: "Brak kredytów" });

  // Historia — max 20 wiadomości
  const safeHistory = (Array.isArray(history) ? history : []).slice(-18);
  const messages = [...safeHistory, { role: "user", content: message }];

  // Jeśli to pierwsza wiadomość sesji — utwórz rekord sesji i odejmij kredyt
  let currentSessionId = session_id;
  let newCredits = tokenData.credits;

  if (!session_id) {
    // Otwórz nową sesję
    const { data: sessionData } = await supabase
      .from("sessions")
      .insert({
        token_id: tokenData.id,
        school_id: tokenData.school_id,
        lang,
        started_at: new Date().toISOString(),
        status: "active"
      })
      .select("id")
      .single();

    if (sessionData) currentSessionId = sessionData.id;

    // Odejmij 1 kredyt
    const { data: creditData } = await supabase
      .from("tokens")
      .update({ credits: tokenData.credits - 1 })
      .eq("id", tokenData.id)
      .select("credits")
      .single();

    if (creditData) newCredits = creditData.credits;
  }

  // Wywołanie Claude
  try {
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        system: system || "",
        messages
      })
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      console.error("Claude error:", err);
      return res.status(502).json({ error: "Błąd AI" });
    }

    const claudeData = await claudeRes.json();
    const reply = claudeData.content?.[0]?.text || "";

    // Zapisz wiadomość w logu sesji
    if (currentSessionId) {
      await supabase.from("session_messages").insert([
        { session_id: currentSessionId, role: "user", content: message, created_at: new Date().toISOString() },
        { session_id: currentSessionId, role: "assistant", content: reply, created_at: new Date().toISOString() }
      ]);
    }

    return res.json({
      reply,
      session_id: currentSessionId,
      credits: newCredits
    });

  } catch (e) {
    console.error("Chat error:", e);
    return res.status(500).json({ error: "Błąd serwera" });
  }
});

// ============================================================
// POST /api/tts
// Proxy do ElevenLabs — wymaga tokenu
// ============================================================
const ALLOWED_VOICES = [
  "pqHfZKP75CvOlQylNhV4", // PL
  "EXAVITQu4vr4xnSDxMaL"  // DE
];

app.post("/api/tts", async (req, res) => {
  const ip = req.headers["x-forwarded-for"] || req.ip;
  if (!rateLimit(ip, 60)) return res.status(429).json({ error: "Za dużo zapytań" });

  const { text, voice_id, voice_settings, token } = req.body;
  if (!text) return res.status(400).json({ error: "Brak tekstu" });
  if (!ALLOWED_VOICES.includes(voice_id)) return res.status(400).json({ error: "Niedozwolony głos" });

  // Szybka walidacja tokenu (nie odejmujemy kredytu za TTS)
  const tokenData = await getTokenData(token);
  if (!tokenData) return res.status(401).json({ error: "Nieprawidłowy token" });

  try {
    const elRes = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voice_id}`,
      {
        method: "POST",
        headers: { "xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ text, model_id: "eleven_multilingual_v2", voice_settings })
      }
    );

    if (!elRes.ok) return res.status(502).json({ error: "Błąd TTS" });

    res.set("Content-Type", "audio/mpeg");
    elRes.body.pipe(res);

  } catch (e) {
    console.error("TTS error:", e);
    res.status(500).json({ error: "Błąd serwera" });
  }
});

// ============================================================
// POST /api/anonymize
// Anonimizacja logu przez Claude
// ============================================================
app.post("/api/anonymize", async (req, res) => {
  const { log: logText, token } = req.body;
  if (!logText) return res.status(400).json({ error: "Brak logu" });

  const tokenData = await getTokenData(token);
  if (!tokenData) return res.status(401).json({ error: "Nieprawidłowy token" });

  try {
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2000,
        system: "Zanonimizuj poniższy log rozmowy. Zastąp wszystkie imiona, nazwiska, adresy, numery telefonów i inne dane osobowe placeholderami jak [IMIĘ], [NAZWISKO], [ADRES], [TELEFON]. Zachowaj strukturę i treść merytoryczną. Zwróć tylko zanonimizowany tekst.",
        messages: [{ role: "user", content: logText }]
      })
    });

    const data = await claudeRes.json();
    return res.json({ anonymized: data.content?.[0]?.text || logText });

  } catch (e) {
    return res.status(500).json({ error: "Błąd anonimizacji" });
  }
});

// ============================================================
// POST /api/session-end
// Zamknięcie sesji — aktualizacja statusu i statystyk
// ============================================================
app.post("/api/session-end", async (req, res) => {
  const { session_id, token, stars, messages, duration, lang, ended_by } = req.body;
  if (!session_id) return res.status(400).json({ error: "Brak session_id" });

  const tokenData = await getTokenData(token);
  if (!tokenData) return res.status(401).json({ error: "Nieprawidłowy token" });

  await supabase
    .from("sessions")
    .update({
      status: "completed",
      ended_at: new Date().toISOString(),
      stars: stars || 0,
      message_count: messages || 0,
      duration_seconds: duration || 0,
      ended_by: ended_by || "auto"
    })
    .eq("id", session_id)
    .eq("token_id", tokenData.id); // bezpieczeństwo — tylko własne sesje

  return res.json({ ok: true });
});

// ============================================================
// POST /api/send-log-email
// Wysyłka zanonimizowanego logu mailem — wymaga Supabase Auth (token JWT dyrektora)
// ============================================================
app.post("/api/send-log-email", async (req, res) => {
  const { session_id, access_jwt } = req.body;

  // Weryfikacja JWT dyrektora przez Supabase
  const { data: { user }, error: authError } = await supabase.auth.getUser(access_jwt);
  if (authError || !user) return res.status(401).json({ error: "Brak autoryzacji" });

  // Pobierz dane sesji
  const { data: session } = await supabase
    .from("sessions")
    .select("*, session_messages(*), schools(name, director_email)")
    .eq("id", session_id)
    .single();

  if (!session) return res.status(404).json({ error: "Sesja nie znaleziona" });

  // Anonimizuj log
  const rawLog = session.session_messages
    .map(m => `[${m.role.toUpperCase()}] ${m.content}`)
    .join("\n");

  let anonLog = rawLog;
  try {
    const anonRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2000,
        system: "Zanonimizuj poniższy log rozmowy edukacyjnej. Zastąp imiona, nazwiska, adresy i numery telefonów placeholderami [IMIĘ], [NAZWISKO], [ADRES], [TELEFON]. Zachowaj strukturę. Zwróć tylko zanonimizowany tekst.",
        messages: [{ role: "user", content: rawLog }]
      })
    });
    const anonData = await anonRes.json();
    if (anonData.content?.[0]?.text) anonLog = anonData.content[0].text;
  } catch (e) { /* użyj surowego logu */ }

  // Zaktualizuj status anonimizacji
  await supabase.from("sessions").update({ anonymized_log: anonLog, log_sent_at: new Date().toISOString() }).eq("id", session_id);

  // Wyślij email
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD }
  });

  const directorEmail = session.schools?.director_email || user.email;
  const schoolName = session.schools?.name || "Szkoła";
  const date = new Date(session.started_at).toLocaleString("pl-PL");

  const mailOptions = {
    from: `"Zadzwoń pod 112" <${GMAIL_USER}>`,
    to: GMAIL_USER,
    cc: directorEmail,
    subject: `[112] Log sesji — ${schoolName} · ${date}`,
    text: `Log zanonimizowanej sesji edukacyjnej\n\nSzkoła: ${schoolName}\nData: ${date}\nCzas rozmowy: ${session.duration_seconds}s\nGwiazdki: ${session.stars}/3\nJęzyk: ${session.lang}\n\n--- LOG ROZMOWY (zanonimizowany) ---\n\n${anonLog}\n\n---\nZadzwoń pod 112 · Symulator edukacyjny\nWysłano automatycznie na żądanie dyrektora szkoły.`,
    html: `<h2>Log sesji edukacyjnej — Zadzwoń pod 112</h2>
      <table style="font-family:monospace;font-size:13px;border-collapse:collapse">
        <tr><td style="padding:4px 12px;color:#666">Szkoła:</td><td>${schoolName}</td></tr>
        <tr><td style="padding:4px 12px;color:#666">Data:</td><td>${date}</td></tr>
        <tr><td style="padding:4px 12px;color:#666">Czas rozmowy:</td><td>${session.duration_seconds}s</td></tr>
        <tr><td style="padding:4px 12px;color:#666">Gwiazdki:</td><td>${session.stars}/3</td></tr>
        <tr><td style="padding:4px 12px;color:#666">Język:</td><td>${session.lang}</td></tr>
      </table>
      <h3>Log rozmowy (zanonimizowany)</h3>
      <pre style="background:#f5f5f5;padding:16px;border-radius:8px;font-size:12px;line-height:1.6">${anonLog}</pre>
      <p style="font-size:11px;color:#999">Wysłano automatycznie na żądanie dyrektora szkoły. CC: ${directorEmail}</p>`
  };

  try {
    await transporter.sendMail(mailOptions);
    return res.json({ ok: true, sent_to: [GMAIL_USER, directorEmail] });
  } catch (e) {
    console.error("Email error:", e);
    return res.status(500).json({ error: "Błąd wysyłki emaila: " + e.message });
  }
});

// ============================================================
// GET /api/health
// ============================================================
app.get("/api/health", async (req, res) => {
  const supabaseOk = !!SUPABASE_URL && !!SUPABASE_SERVICE_KEY;
  const anthropicOk = !!ANTHROPIC_API_KEY;
  const elevenlabsOk = !!ELEVENLABS_API_KEY;
  const gmailOk = !!GMAIL_USER && !!GMAIL_APP_PASSWORD;
  res.json({
    status: "ok",
    version: "1.5a",
    services: { anthropic: anthropicOk, elevenlabs: elevenlabsOk, supabase: supabaseOk, gmail: gmailOk },
    timestamp: new Date().toISOString()
  });
});

// ============================================================
// START
// ============================================================
app.listen(PORT, () => {
  console.log(`✅ Zadzwoń pod 112 backend v1.5a — port ${PORT}`);
  console.log(`   Anthropic: ${ANTHROPIC_API_KEY ? "✅" : "❌"}`);
  console.log(`   ElevenLabs: ${ELEVENLABS_API_KEY ? "✅" : "❌"}`);
  console.log(`   Supabase: ${SUPABASE_URL ? "✅" : "❌"}`);
  console.log(`   Gmail: ${GMAIL_USER ? "✅" : "❌"}`);
});
