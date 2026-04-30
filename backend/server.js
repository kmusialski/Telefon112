// ============================================================
// server.js — Zadzwoń pod 112 · Backend v1.5a
// ============================================================

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const { createClient } = require("@supabase/supabase-js");
// nodemailer usunięty — Railway blokuje SMTP. Używamy Resend API (HTTPS port 443)

const app = express();
app.use(express.json({ limit: "2mb" }));
app.set("trust proxy", 1); // Railway używa proxy

app.use(cors({
  origin: [
    "https://kmusialski.github.io",
    "https://telefon112-production.up.railway.app",
    "https://telefon112-dev.up.railway.app",
    "http://localhost:3000"
  ]
}));

// ============================================================
// ENV
// ============================================================
const {
  ANTHROPIC_API_KEY,
  ELEVENLABS_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  RESEND_API_KEY,   // Resend.com — działa przez HTTPS (Railway nie blokuje)
  PORT = 3000
} = process.env;

// Stały adres aplikacji — CC na każdym mailu
const APP_EMAIL = "musialski.k@gmail.com";

// ============================================================
// SUPABASE
// ============================================================
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ============================================================
// RATE LIMITER (in-memory)
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
// HELPER — pobierz i zwaliduj token
// ============================================================
async function getTokenData(token) {
  if (!token) return null;
  const { data, error } = await supabase
    .from("tokens")
    .select("id, token_code, school_id, credits, active, schools(name, director_email)")
    .eq("token_code", token.toUpperCase())
    .single();
  if (error || !data || !data.active) return null;
  return data;
}

// ============================================================
// POST /api/validate-token
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
// ============================================================
app.post("/api/chat", async (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.ip;
  if (!rateLimit(ip)) return res.status(429).json({ error: "Za dużo zapytań. Spróbuj za godzinę." });

  const { message, history = [], system, lang = "pl", token, session_id } = req.body;
  if (!message) return res.status(400).json({ error: "Brak wiadomości" });

  const tokenData = await getTokenData(token);
  if (!tokenData) return res.status(401).json({ error: "Nieprawidłowy token" });
  if (tokenData.credits <= 0) return res.status(402).json({ error: "Brak kredytów" });

  const safeHistory = (Array.isArray(history) ? history : []).slice(-18);
  const messages = [...safeHistory, { role: "user", content: message }];

  let currentSessionId = session_id;
  let newCredits = tokenData.credits;

  if (!session_id) {
    const { data: sessionData } = await supabase
      .from("sessions")
      .insert({ token_id: tokenData.id, school_id: tokenData.school_id, lang, started_at: new Date().toISOString(), status: "active" })
      .select("id").single();
    if (sessionData) currentSessionId = sessionData.id;

    const { data: creditData } = await supabase
      .from("tokens").update({ credits: tokenData.credits - 1 }).eq("id", tokenData.id).select("credits").single();
    if (creditData) newCredits = creditData.credits;
  }

  try {
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 300, system: system || "", messages })
    });
    if (!claudeRes.ok) { console.error("Claude error:", await claudeRes.text()); return res.status(502).json({ error: "Błąd AI" }); }
    const claudeData = await claudeRes.json();
    const reply = claudeData.content?.[0]?.text || "";

    if (currentSessionId) {
      await supabase.from("session_messages").insert([
        { session_id: currentSessionId, role: "user", content: message, created_at: new Date().toISOString() },
        { session_id: currentSessionId, role: "assistant", content: reply, created_at: new Date().toISOString() }
      ]);
    }
    return res.json({ reply, session_id: currentSessionId, credits: newCredits });
  } catch (e) {
    console.error("Chat error:", e);
    return res.status(500).json({ error: "Błąd serwera" });
  }
});

// ============================================================
// POST /api/tts
// ============================================================
const ALLOWED_VOICES = ["pqHfZKP75CvOlQylNhV4", "EXAVITQu4vr4xnSDxMaL"];

app.post("/api/tts", async (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.ip;
  if (!rateLimit(ip, 60)) return res.status(429).json({ error: "Za dużo zapytań" });

  const { text, voice_id, voice_settings, token } = req.body;
  if (!text) return res.status(400).json({ error: "Brak tekstu" });
  if (!ALLOWED_VOICES.includes(voice_id)) return res.status(400).json({ error: "Niedozwolony głos" });

  const tokenData = await getTokenData(token);
  if (!tokenData) return res.status(401).json({ error: "Nieprawidłowy token" });

  try {
    const elRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice_id}`, {
      method: "POST",
      headers: { "xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ text, model_id: "eleven_multilingual_v2", voice_settings })
    });
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
        model: "claude-haiku-4-5-20251001", max_tokens: 2000,
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
// ============================================================
app.post("/api/session-end", async (req, res) => {
  const { session_id, token, stars, messages, duration, lang, ended_by } = req.body;
  if (!session_id) return res.status(400).json({ error: "Brak session_id" });

  const tokenData = await getTokenData(token);
  if (!tokenData) return res.status(401).json({ error: "Nieprawidłowy token" });

  await supabase.from("sessions").update({
    status: "completed", ended_at: new Date().toISOString(),
    stars: stars || 0, message_count: messages || 0,
    duration_seconds: duration || 0, ended_by: ended_by || "auto"
  }).eq("id", session_id).eq("token_id", tokenData.id);

  return res.json({ ok: true });
});

// ============================================================
// POST /api/send-log-email
// Wysyłka zanonimizowanego logu mailem
// Odbiorcy: email dyrektora (z konta Supabase) + APP_EMAIL
// ============================================================
app.post("/api/send-log-email", async (req, res) => {
  const { session_id, access_jwt } = req.body;
  console.log(`[EMAIL] ▶ Żądanie wysyłki — session_id: ${session_id}`);

  // Weryfikacja JWT
  console.log(`[EMAIL] Weryfikacja JWT (długość: ${access_jwt?.length || 0})`);
  const { data: { user }, error: authError } = await supabase.auth.getUser(access_jwt);
  if (authError || !user) {
    console.error(`[EMAIL] ❌ Auth error: ${authError?.message || "brak usera"}`);
    return res.status(401).json({ error: "Brak autoryzacji: " + (authError?.message || "brak usera") });
  }
  console.log(`[EMAIL] ✅ Użytkownik: ${user.email}`);

  // Pobierz sesję
  console.log(`[EMAIL] Pobieranie sesji z Supabase...`);
  const { data: session, error: sessionError } = await supabase
    .from("sessions")
    .select("*, session_messages(*), schools(name, director_email)")
    .eq("id", session_id)
    .single();

  if (sessionError || !session) {
    console.error(`[EMAIL] ❌ Sesja nie znaleziona: ${sessionError?.message}`);
    return res.status(404).json({ error: "Sesja nie znaleziona: " + (sessionError?.message || "") });
  }
  console.log(`[EMAIL] ✅ Sesja pobrana. Wiadomości: ${session.session_messages?.length || 0}, Szkoła: ${session.schools?.name}`);

  // Zbuduj surowy log
  const rawLog = (session.session_messages || [])
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .map(m => `[${m.role === "user" ? "DZIECKO" : "DYSPOZYTOR"}] ${m.content}`)
    .join("\n");
  console.log(`[EMAIL] Surowy log: ${rawLog.length} znaków`);

  // Anonimizuj — jeśli już mamy zanonimizowany, użyj go
  let anonLog = session.anonymized_log || rawLog;
  if (!session.anonymized_log) {
    console.log(`[EMAIL] Anonimizuję przez Claude...`);
    try {
      const anonRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001", max_tokens: 2000,
          system: "Zanonimizuj poniższy log rozmowy edukacyjnej. Zastąp imiona, nazwiska, adresy i numery telefonów placeholderami [IMIĘ], [NAZWISKO], [ADRES], [TELEFON]. Zachowaj strukturę. Zwróć tylko zanonimizowany tekst.",
          messages: [{ role: "user", content: rawLog }]
        })
      });
      const anonData = await anonRes.json();
      if (anonData.content?.[0]?.text) anonLog = anonData.content[0].text;
      console.log(`[EMAIL] ✅ Anonimizacja OK (${anonLog.length} znaków)`);
    } catch (e) {
      console.error(`[EMAIL] ⚠️ Anonimizacja failed: ${e.message} — używam surowego logu`);
    }
  } else {
    console.log(`[EMAIL] Zanonimizowany log już istnieje — pomijam anonimizację`);
  }

  // Zapisz w Supabase
  await supabase.from("sessions").update({
    anonymized_log: anonLog,
    log_sent_at: new Date().toISOString()
  }).eq("id", session_id);
  console.log(`[EMAIL] ✅ Supabase zaktualizowany`);

  // Przygotuj dane do maila
  const directorEmail = session.schools?.director_email || user.email;
  const schoolName = session.schools?.name || "Szkoła";
  const date = new Date(session.started_at).toLocaleString("pl-PL");
  const dur = session.duration_seconds ? Math.round(session.duration_seconds / 60) + " min" : "—";

  // Na razie wysyłamy tylko na APP_EMAIL (Resend darmowy = tylko zweryfikowany adres)
  // Docelowo po dodaniu domeny: recipients = [directorEmail, APP_EMAIL]
  const recipient = APP_EMAIL;
  console.log(`[EMAIL] Odbiorca: ${recipient} (tryb testowy — brak własnej domeny Resend)`);
  console.log(`[EMAIL] Dyrektor szkoły (info w treści): ${directorEmail}`);
  console.log(`[EMAIL] Resend API key: ${RESEND_API_KEY ? "ustawiony ✅" : "BRAK ❌"}`);

  if (!RESEND_API_KEY) {
    console.error(`[EMAIL] ❌ Brak RESEND_API_KEY!`);
    return res.status(500).json({ error: "Brak konfiguracji Resend na serwerze (RESEND_API_KEY)" });
  }

  const subject = `[112] Log sesji — ${schoolName} · ${date}`;
  const textBody = [
    `=== LOG SESJI EDUKACYJNEJ — ZADZWOŃ POD 112 ===`,
    ``,
    `DANE SZKOŁY:`,
    `Szkoła:         ${schoolName}`,
    `Dyrektor/email: ${directorEmail}`,
    `Wysłano przez:  ${user.email}`,
    ``,
    `DANE SESJI:`,
    `Data:           ${date}`,
    `Czas rozmowy:   ${dur}`,
    `Gwiazdki:       ${session.stars || 0}/3`,
    `Język:          ${session.lang}`,
    `Session ID:     ${session_id}`,
    ``,
    `=== LOG ROZMOWY (zanonimizowany) ===`,
    ``,
    anonLog,
    ``,
    `===`,
    `Zadzwoń pod 112 · Symulator edukacyjny`,
    `Wysłano automatycznie na żądanie dyrektora: ${user.email}`,
    `UWAGA: Mail docelowo będzie też wysyłany bezpośrednio do dyrektora (po konfiguracji domeny).`
  ].join("\n");

  const htmlBody = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
      <h2 style="color:#c00;border-bottom:2px solid #c00;padding-bottom:8px">🚨 Log sesji — Zadzwoń pod 112</h2>
      <div style="background:#f0f7ff;border-radius:8px;padding:16px;margin-bottom:16px">
        <h3 style="margin:0 0 10px;color:#333">Dane szkoły</h3>
        <table style="font-size:14px;border-collapse:collapse;width:100%">
          <tr><td style="padding:4px 16px 4px 0;color:#666;width:140px">Szkoła:</td><td><b>${schoolName}</b></td></tr>
          <tr><td style="padding:4px 16px 4px 0;color:#666">Dyrektor / email:</td><td><b>${directorEmail}</b></td></tr>
          <tr><td style="padding:4px 16px 4px 0;color:#666">Wysłano przez:</td><td>${user.email}</td></tr>
        </table>
      </div>
      <div style="background:#f5f5f5;border-radius:8px;padding:16px;margin-bottom:16px">
        <h3 style="margin:0 0 10px;color:#333">Dane sesji</h3>
        <table style="font-size:14px;border-collapse:collapse;width:100%">
          <tr><td style="padding:4px 16px 4px 0;color:#666;width:140px">Data:</td><td>${date}</td></tr>
          <tr><td style="padding:4px 16px 4px 0;color:#666">Czas rozmowy:</td><td>${dur}</td></tr>
          <tr><td style="padding:4px 16px 4px 0;color:#666">Gwiazdki:</td><td>${"★".repeat(session.stars || 0)}${"☆".repeat(3 - (session.stars || 0))} (${session.stars || 0}/3)</td></tr>
          <tr><td style="padding:4px 16px 4px 0;color:#666">Język:</td><td>${session.lang}</td></tr>
        </table>
      </div>
      <h3 style="color:#333">Log rozmowy (zanonimizowany)</h3>
      <pre style="background:#111;color:#a0ffa0;padding:16px;border-radius:8px;font-size:12px;line-height:1.7;white-space:pre-wrap;overflow-x:auto">${anonLog}</pre>
      <p style="font-size:11px;color:#999;margin-top:16px;border-top:1px solid #eee;padding-top:12px">
        Wysłano automatycznie na żądanie: ${user.email}<br/>
        <i>Uwaga: W fazie testowej maile trafiają tylko na adres administratora aplikacji. Po konfiguracji domeny będą wysyłane bezpośrednio do dyrektora szkoły.</i>
      </p>
    </div>
  `;

  console.log(`[EMAIL] Wysyłam przez Resend API...`);
  try {
    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: "Zadzwoń pod 112 <onboarding@resend.dev>",
        to: [recipient],
        subject,
        text: textBody,
        html: htmlBody
      })
    });

    const resendData = await resendRes.json();
    console.log(`[EMAIL] Resend response: ${resendRes.status} — ${JSON.stringify(resendData)}`);

    if (!resendRes.ok) {
      console.error(`[EMAIL] ❌ Resend error: ${JSON.stringify(resendData)}`);
      return res.status(500).json({ error: "Błąd Resend: " + (resendData.message || JSON.stringify(resendData)) });
    }

    console.log(`[EMAIL] ✅ Wysłano! ID: ${resendData.id}`);
    return res.json({ ok: true, sent_to: [recipient], director_notified: false, messageId: resendData.id });
  } catch (e) {
    console.error(`[EMAIL] ❌ Wyjątek: ${e.message}`);
    return res.status(500).json({ error: "Błąd wysyłki: " + e.message });
  }
});

// ============================================================
// GET /api/health
// ============================================================
app.get("/api/health", async (req, res) => {
  res.json({
    status: "ok",
    version: "1.5a",
    services: {
      anthropic: !!ANTHROPIC_API_KEY,
      elevenlabs: !!ELEVENLABS_API_KEY,
      supabase: !!SUPABASE_URL && !!SUPABASE_SERVICE_KEY,
      resend: !!RESEND_API_KEY
    },
    app_email: APP_EMAIL,
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
  console.log(`   Resend: ${RESEND_API_KEY ? "✅" : "❌"}`);
  console.log(`   App email (CC): ${APP_EMAIL}`);
});
