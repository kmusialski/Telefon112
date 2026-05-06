// ============================================================
// server.js — Zadzwoń pod 112 · Backend v1.6
// ============================================================
// Zmiany v1.6 względem v1.5b:
//   - Resend API zastąpiony nodemailer + Zimbra OVH SMTP
//   - Nadawca: noreply@herokids.eu
//   - Odbiorcy: dyrektor szkoły (TO) + support@herokids.eu (CC)
//   - /api/send-log-email przyjmuje nowe pola:
//       user_message  — wiadomość od dyrektora wpisana w panelu
//       client_info   — dane techniczne z przeglądarki (debug)
//   - Mail rozbudowany: sekcja techniczna (zwijana) + wiadomość od użytkownika
//   - /api/health sprawdza SMTP przez transporter.verify(), raportuje smtp zamiast resend
//   - Zachowana pełna integracja PayU z v1.5b
// ============================================================

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.set("trust proxy", 1);

app.use(cors({
  origin: [
    "https://kmusialski.github.io",
    "https://herokids.eu",
    "http://herokids.eu",
    "https://www.herokids.eu",
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
  SMTP_HOST = "ssl0.ovh.net",  // Zimbra OVH
  SMTP_PORT = "587",
  SMTP_USER,                    // noreply@herokids.eu
  SMTP_PASSWORD,
  PAYU_POS_ID,
  PAYU_CLIENT_ID,
  PAYU_CLIENT_SECRET,
  PAYU_NOTIFY_KEY,
  PAYU_SANDBOX,
  PORT = 3000
} = process.env;

// Adres support — zawsze w CC każdego logu sesji
const SUPPORT_EMAIL = "support@herokids.eu";

const PAYU_BASE = PAYU_SANDBOX === "true"
  ? "https://secure.snd.payu.com"
  : "https://secure.payu.com";

// Pakiety — ceny w groszach (PayU wymaga groszy)
const PACKAGES = {
  basic:    { name: "Basic",    sessions: 30,  amount: 2900, label: "30 sesji · 29 zł" },
  standard: { name: "Standard", sessions: 60,  amount: 4900, label: "60 sesji · 49 zł" },
  pro:      { name: "Pro",      sessions: 100, amount: 7900, label: "100 sesji · 79 zł" }
};

// ============================================================
// SMTP TRANSPORTER — Zimbra OVH
// ============================================================
const smtpTransporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: parseInt(SMTP_PORT, 10),
  secure: false,        // STARTTLS na porcie 587
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASSWORD
  },
  tls: {
    rejectUnauthorized: false  // OVH relay może używać self-signed cert
  }
});

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
// HELPER — pobierz token PayU OAuth2
// ============================================================
async function getPayuToken() {
  const res = await fetch(`${PAYU_BASE}/pl/standard/user/oauth/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=client_credentials&client_id=${PAYU_CLIENT_ID}&client_secret=${PAYU_CLIENT_SECRET}`
  });
  if (!res.ok) throw new Error(`PayU OAuth error: ${res.status}`);
  const data = await res.json();
  return data.access_token;
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
  if (!rateLimit(ip, 120)) return res.status(429).json({ error: "Za dużo zapytań. Spróbuj za godzinę." });

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
// Wysyłka zanonimizowanego logu mailem przez Zimbra OVH SMTP
//
// Body:
//   session_id   — ID sesji w Supabase
//   access_jwt   — JWT użytkownika Supabase (dyrektora)
//   user_message — (opcjonalnie) wiadomość od dyrektora wpisana w panelu
//   client_info  — (opcjonalnie) dane techniczne z przeglądarki:
//                  { userAgent, platform, language, screenW, screenH,
//                    connectionType, sessionErrors }
//
// Odbiorcy:
//   TO  — dyrektor szkoły (director_email z Supabase)
//   CC  — support@herokids.eu
// ============================================================
app.post("/api/send-log-email", async (req, res) => {
  const { session_id, access_jwt, user_message = "", client_info = {} } = req.body;
  console.log(`[EMAIL] ▶ Żądanie wysyłki — session_id: ${session_id}`);

  const { data: { user }, error: authError } = await supabase.auth.getUser(access_jwt);
  if (authError || !user) {
    console.error(`[EMAIL] ❌ Auth error: ${authError?.message}`);
    return res.status(401).json({ error: "Brak autoryzacji: " + (authError?.message || "brak usera") });
  }
  console.log(`[EMAIL] ✅ Użytkownik: ${user.email}`);

  const { data: session, error: sessionError } = await supabase
    .from("sessions")
    .select("*, session_messages(*), schools(name, director_email)")
    .eq("id", session_id)
    .single();

  if (sessionError || !session) {
    console.error(`[EMAIL] ❌ Sesja nie znaleziona: ${sessionError?.message}`);
    return res.status(404).json({ error: "Sesja nie znaleziona" });
  }
  console.log(`[EMAIL] ✅ Sesja pobrana. Wiadomości: ${session.session_messages?.length || 0}, Szkoła: ${session.schools?.name}`);

  // Zbuduj surowy log
  const rawLog = (session.session_messages || [])
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .map(m => `[${m.role === "user" ? "DZIECKO" : "DYSPOZYTOR"}] ${m.content}`)
    .join("\n");

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
      console.log(`[EMAIL] ✅ Anonimizacja OK`);
    } catch (e) {
      console.error(`[EMAIL] ⚠️ Anonimizacja failed: ${e.message} — używam surowego logu`);
    }
  }

  await supabase.from("sessions").update({
    anonymized_log: anonLog,
    log_sent_at: new Date().toISOString()
  }).eq("id", session_id);

  // ── Przygotuj dane do maila ────────────────────────────────
  const directorEmail = session.schools?.director_email || user.email;
  const schoolName    = session.schools?.name || "Szkoła";
  const date          = new Date(session.started_at).toLocaleString("pl-PL");
  const dateEnded     = session.ended_at ? new Date(session.ended_at).toLocaleString("pl-PL") : "—";
  const dur           = session.duration_seconds ? Math.round(session.duration_seconds / 60) + " min" : "—";
  const msgCount      = session.session_messages?.length || session.message_count || 0;
  const endedBy       = session.ended_by || "—";
  const clientIp      = req.headers["x-forwarded-for"]?.split(",")[0] || req.ip || "—";
  const serverVersion = "1.6";

  // Dane techniczne od frontendu
  const ua            = client_info.userAgent      || "—";
  const platform      = client_info.platform       || "—";
  const browserLang   = client_info.language       || "—";
  const screenSize    = (client_info.screenW && client_info.screenH)
                        ? `${client_info.screenW}×${client_info.screenH}` : "—";
  const connType      = client_info.connectionType || "—";
  const sessionErrors = client_info.sessionErrors  || "—";

  console.log(`[EMAIL] TO: ${directorEmail}, CC: ${SUPPORT_EMAIL}`);
  console.log(`[EMAIL] SMTP: ${SMTP_HOST}:${SMTP_PORT}, user: ${SMTP_USER ? "✅" : "❌ BRAK"}`);

  if (!SMTP_USER || !SMTP_PASSWORD) {
    console.error(`[EMAIL] ❌ Brak konfiguracji SMTP!`);
    return res.status(500).json({ error: "Brak konfiguracji SMTP na serwerze" });
  }

  const subject = `[112] Log sesji — ${schoolName} · ${date}`;

  // ── Wiadomość od dyrektora (opcjonalna) ───────────────────
  const userMessageSection = user_message.trim()
    ? `\n💬 WIADOMOŚĆ OD DYREKTORA:\n${user_message.trim()}\n`
    : "";

  const userMessageHtml = user_message.trim()
    ? `<div style="background:#fff8e1;border-left:4px solid #ffc107;border-radius:0 8px 8px 0;padding:14px 16px;margin-bottom:16px">
        <h3 style="margin:0 0 8px;color:#333;font-size:14px">💬 Wiadomość od dyrektora</h3>
        <p style="margin:0;font-size:14px;color:#333;white-space:pre-wrap">${user_message.trim()}</p>
       </div>`
    : "";

  // ── Treść plain text ───────────────────────────────────────
  const textBody = [
    `=== LOG SESJI EDUKACYJNEJ — ZADZWOŃ POD 112 · v${serverVersion} ===`,
    ``,
    `DANE SZKOŁY:`,
    `Szkoła:              ${schoolName}`,
    `Dyrektor / email:    ${directorEmail}`,
    `Wysłano przez:       ${user.email}`,
    userMessageSection,
    `DANE SESJI:`,
    `Data rozpoczęcia:    ${date}`,
    `Data zakończenia:    ${dateEnded}`,
    `Czas rozmowy:        ${dur}`,
    `Liczba wiadomości:   ${msgCount}`,
    `Gwiazdki:            ${session.stars || 0}/3`,
    `Język:               ${session.lang}`,
    `Zakończono przez:    ${endedBy}`,
    ``,
    `=== LOG TECHNICZNY (debug) ===`,
    `Session ID:          ${session_id}`,
    `Backend wersja:      v${serverVersion}`,
    `IP klienta:          ${clientIp}`,
    `User-Agent:          ${ua}`,
    `Platforma:           ${platform}`,
    `Język przeglądarki:  ${browserLang}`,
    `Rozdzielczość:       ${screenSize}`,
    `Typ połączenia:      ${connType}`,
    `Błędy w sesji:       ${sessionErrors}`,
    `SMTP host:           ${SMTP_HOST}:${SMTP_PORT}`,
    `Supabase project:    ${SUPABASE_URL ? SUPABASE_URL.split(".")[0].replace("https://", "") : "—"}`,
    ``,
    `=== LOG ROZMOWY (zanonimizowany) ===`,
    ``,
    anonLog,
    ``,
    `===`,
    `Zadzwoń pod 112 · Symulator edukacyjny · herokids.eu`,
    `Wysłano automatycznie na żądanie: ${user.email}`,
  ].join("\n");

  // ── Treść HTML ─────────────────────────────────────────────
  const htmlBody = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:640px;margin:0 auto;color:#1a1a1a">

      <div style="background:#c00;padding:20px 24px;border-radius:12px 12px 0 0">
        <h2 style="margin:0;color:#fff;font-size:20px">🚨 Log sesji — Zadzwoń pod 112</h2>
        <p style="margin:4px 0 0;color:rgba(255,255,255,0.8);font-size:13px">Wersja backendu v${serverVersion} · ${new Date().toLocaleString("pl-PL")}</p>
      </div>

      <div style="background:#fff;border:1px solid #e5e5e5;border-top:none;padding:20px 24px;border-radius:0 0 12px 12px">

        <!-- Dane szkoły -->
        <div style="background:#f0f7ff;border-radius:8px;padding:14px 16px;margin-bottom:16px">
          <h3 style="margin:0 0 10px;color:#333;font-size:14px;text-transform:uppercase;letter-spacing:0.5px">Dane szkoły</h3>
          <table style="font-size:14px;border-collapse:collapse;width:100%">
            <tr><td style="padding:3px 16px 3px 0;color:#666;width:160px">Szkoła:</td><td><b>${schoolName}</b></td></tr>
            <tr><td style="padding:3px 16px 3px 0;color:#666">Dyrektor / email:</td><td><b>${directorEmail}</b></td></tr>
            <tr><td style="padding:3px 16px 3px 0;color:#666">Wysłano przez:</td><td>${user.email}</td></tr>
          </table>
        </div>

        <!-- Wiadomość od dyrektora (opcjonalna) -->
        ${userMessageHtml}

        <!-- Dane sesji -->
        <div style="background:#f5f5f5;border-radius:8px;padding:14px 16px;margin-bottom:16px">
          <h3 style="margin:0 0 10px;color:#333;font-size:14px;text-transform:uppercase;letter-spacing:0.5px">Dane sesji</h3>
          <table style="font-size:14px;border-collapse:collapse;width:100%">
            <tr><td style="padding:3px 16px 3px 0;color:#666;width:160px">Rozpoczęto:</td><td>${date}</td></tr>
            <tr><td style="padding:3px 16px 3px 0;color:#666">Zakończono:</td><td>${dateEnded}</td></tr>
            <tr><td style="padding:3px 16px 3px 0;color:#666">Czas rozmowy:</td><td>${dur}</td></tr>
            <tr><td style="padding:3px 16px 3px 0;color:#666">Wiadomości:</td><td>${msgCount}</td></tr>
            <tr><td style="padding:3px 16px 3px 0;color:#666">Gwiazdki:</td><td>${"★".repeat(session.stars || 0)}${"☆".repeat(3 - (session.stars || 0))} (${session.stars || 0}/3)</td></tr>
            <tr><td style="padding:3px 16px 3px 0;color:#666">Język:</td><td>${session.lang}</td></tr>
            <tr><td style="padding:3px 16px 3px 0;color:#666">Zakończono przez:</td><td>${endedBy}</td></tr>
          </table>
        </div>

        <!-- Log rozmowy -->
        <h3 style="color:#333;font-size:14px;text-transform:uppercase;letter-spacing:0.5px;margin:0 0 8px">Log rozmowy (zanonimizowany)</h3>
        <pre style="background:#111;color:#a0ffa0;padding:16px;border-radius:8px;font-size:12px;line-height:1.7;white-space:pre-wrap;overflow-x:auto;margin:0 0 16px">${anonLog}</pre>

        <!-- Sekcja techniczna — zwijana -->
        <details style="margin-bottom:16px">
          <summary style="cursor:pointer;font-size:13px;color:#666;padding:10px 14px;background:#f9f9f9;border-radius:8px;border:1px solid #e5e5e5;list-style:none">
            🔧 <b>Log techniczny</b> — kliknij aby rozwinąć
          </summary>
          <div style="border:1px solid #e5e5e5;border-top:none;border-radius:0 0 8px 8px;padding:14px 16px">
            <table style="font-size:12px;border-collapse:collapse;width:100%;font-family:monospace">
              <tr style="background:#f5f5f5"><td style="padding:4px 12px 4px 0;color:#666;width:180px">Session ID:</td><td style="word-break:break-all">${session_id}</td></tr>
              <tr><td style="padding:4px 12px 4px 0;color:#666">Backend wersja:</td><td>v${serverVersion}</td></tr>
              <tr style="background:#f5f5f5"><td style="padding:4px 12px 4px 0;color:#666">IP klienta:</td><td>${clientIp}</td></tr>
              <tr><td style="padding:4px 12px 4px 0;color:#666">User-Agent:</td><td style="word-break:break-all">${ua}</td></tr>
              <tr style="background:#f5f5f5"><td style="padding:4px 12px 4px 0;color:#666">Platforma:</td><td>${platform}</td></tr>
              <tr><td style="padding:4px 12px 4px 0;color:#666">Język przeglądarki:</td><td>${browserLang}</td></tr>
              <tr style="background:#f5f5f5"><td style="padding:4px 12px 4px 0;color:#666">Rozdzielczość:</td><td>${screenSize}</td></tr>
              <tr><td style="padding:4px 12px 4px 0;color:#666">Typ połączenia:</td><td>${connType}</td></tr>
              <tr style="background:#f5f5f5"><td style="padding:4px 12px 4px 0;color:#666">Błędy w sesji:</td><td style="word-break:break-all">${sessionErrors}</td></tr>
              <tr><td style="padding:4px 12px 4px 0;color:#666">SMTP host:</td><td>${SMTP_HOST}:${SMTP_PORT}</td></tr>
              <tr style="background:#f5f5f5"><td style="padding:4px 12px 4px 0;color:#666">Supabase project:</td><td>${SUPABASE_URL ? SUPABASE_URL.split(".")[0].replace("https://", "") : "—"}</td></tr>
            </table>
          </div>
        </details>

        <p style="font-size:11px;color:#999;margin:0;border-top:1px solid #eee;padding-top:12px">
          Wysłano automatycznie · <a href="https://herokids.eu" style="color:#0a84ff">herokids.eu</a> · na żądanie: ${user.email}
        </p>

      </div>
    </div>
  `;

  console.log(`[EMAIL] Wysyłam przez SMTP (${SMTP_HOST}:${SMTP_PORT})...`);
  try {
    const info = await smtpTransporter.sendMail({
      from: `"HeroKids 112" <${SMTP_USER}>`,
      to: directorEmail,
      cc: SUPPORT_EMAIL,
      subject,
      text: textBody,
      html: htmlBody
    });

    console.log(`[EMAIL] ✅ Wysłano! MessageId: ${info.messageId}`);
    return res.json({
      ok: true,
      sent_to: [directorEmail],
      cc: [SUPPORT_EMAIL],
      messageId: info.messageId
    });
  } catch (e) {
    console.error(`[EMAIL] ❌ SMTP error: ${e.message}`);
    return res.status(500).json({ error: "Błąd wysyłki SMTP: " + e.message });
  }
});

// ============================================================
// POST /api/create-order  [PayU]
// ============================================================
app.post("/api/create-order", async (req, res) => {
  const { package: packageKey, school_id, token_id, buyer_email, buyer_name, return_url } = req.body;

  const pkg = PACKAGES[packageKey];
  if (!pkg) return res.status(400).json({ error: "Nieznany pakiet" });
  if (!buyer_email) return res.status(400).json({ error: "Brak email kupującego" });

  const extOrderId = `112-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;

  const { data: order, error: orderError } = await supabase
    .from("orders")
    .insert({
      school_id: school_id || null,
      token_id: token_id || null,
      package_name: packageKey,
      sessions_count: pkg.sessions,
      amount_pln: pkg.amount,
      payu_ext_order_id: extOrderId,
      status: "pending"
    })
    .select("id").single();

  if (orderError) {
    console.error("[PAYU] Błąd zapisu zamówienia:", orderError);
    return res.status(500).json({ error: "Błąd zapisu zamówienia" });
  }

  let accessToken;
  try {
    accessToken = await getPayuToken();
  } catch (e) {
    console.error("[PAYU] OAuth error:", e.message);
    return res.status(502).json({ error: "Błąd autoryzacji PayU" });
  }

  const notifyUrl = PAYU_SANDBOX === "true"
    ? "https://telefon112-dev.up.railway.app/api/payu-notify"
    : "https://telefon112-production.up.railway.app/api/payu-notify";

  const continueUrl = (return_url || "https://herokids.eu/sklep.html")
    .replace("{extOrderId}", extOrderId);

  const orderPayload = {
    extOrderId,
    notifyUrl,
    continueUrl,
    customerIp: req.headers["x-forwarded-for"]?.split(",")[0] || req.ip || "127.0.0.1",
    merchantPosId: PAYU_POS_ID,
    description: `Zadzwoń pod 112 — ${pkg.label}`,
    currencyCode: "PLN",
    totalAmount: String(pkg.amount),
    buyer: {
      email: buyer_email,
      firstName: buyer_name || "Dyrektor",
      lastName: "",
      language: "pl"
    },
    products: [{
      name: `Pakiet ${pkg.name} — Zadzwoń pod 112`,
      unitPrice: String(pkg.amount),
      quantity: "1"
    }]
  };

  try {
    const payuRes = await fetch(`${PAYU_BASE}/api/v2_1/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${accessToken}` },
      body: JSON.stringify(orderPayload),
      redirect: "manual"
    });

    const payuData = await payuRes.json().catch(() => ({}));
    console.log(`[PAYU] Odpowiedź: ${payuRes.status}`, payuData);

    const payuOrderId  = payuData.orderId;
    const redirectUri  = payuData.redirectUri;

    if (!redirectUri) {
      console.error("[PAYU] Brak redirectUri:", payuData);
      return res.status(502).json({ error: "Błąd PayU: brak URL płatności", details: payuData });
    }

    await supabase.from("orders").update({ payu_order_id: payuOrderId }).eq("id", order.id);

    console.log(`[PAYU] ✅ Zamówienie created: ${extOrderId} → ${redirectUri}`);
    return res.json({ ok: true, redirect_url: redirectUri, order_id: order.id, ext_order_id: extOrderId });

  } catch (e) {
    console.error("[PAYU] create-order error:", e.message);
    return res.status(500).json({ error: "Błąd tworzenia zamówienia: " + e.message });
  }
});

// ============================================================
// POST /api/payu-notify  [PayU webhook]
// ============================================================
app.post("/api/payu-notify", async (req, res) => {
  console.log("[PAYU-NOTIFY] ▶ Otrzymano webhook");

  const signature = req.headers["openpayu-signature"];
  if (signature && PAYU_NOTIFY_KEY) {
    const bodyStr = JSON.stringify(req.body);
    const expectedSig = crypto.createHash("md5").update(bodyStr + PAYU_NOTIFY_KEY).digest("hex");
    const sigMatch = signature.match(/signature=([a-f0-9]+)/i);
    const receivedSig = sigMatch?.[1];
    if (receivedSig && receivedSig !== expectedSig) {
      console.error("[PAYU-NOTIFY] ❌ Nieprawidłowy podpis!");
      return res.status(401).send("Invalid signature");
    }
  }

  const order = req.body?.order;
  if (!order) {
    console.error("[PAYU-NOTIFY] Brak danych zamówienia");
    return res.status(400).send("No order data");
  }

  const { extOrderId, orderId, status } = order;
  console.log(`[PAYU-NOTIFY] extOrderId: ${extOrderId}, status: ${status}`);

  await supabase.from("orders")
    .update({ payu_order_id: orderId, status: status.toLowerCase() })
    .eq("payu_ext_order_id", extOrderId);

  if (status === "COMPLETED") {
    console.log(`[PAYU-NOTIFY] ✅ Płatność COMPLETED — doliczam kredyty`);

    const { data: orderData } = await supabase
      .from("orders")
      .select("token_id, sessions_count")
      .eq("payu_ext_order_id", extOrderId)
      .single();

    if (orderData?.token_id) {
      const { data: tokenData } = await supabase
        .from("tokens").select("credits").eq("id", orderData.token_id).single();
      const newCredits = (tokenData?.credits || 0) + orderData.sessions_count;
      await supabase.from("tokens")
        .update({ credits: newCredits, active: true }).eq("id", orderData.token_id);
      console.log(`[PAYU-NOTIFY] ✅ Token ${orderData.token_id} → +${orderData.sessions_count} kredytów (razem: ${newCredits})`);

    } else if (orderData) {
      console.log(`[PAYU-NOTIFY] Tworzę nowy token dla zamówienia ${extOrderId}`);
      const newTokenCode = "PSZ-" + Math.random().toString(36).slice(2,6).toUpperCase() + "-" + Math.random().toString(36).slice(2,6).toUpperCase();
      const { data: newToken } = await supabase.from("tokens").insert({
        token_code: newTokenCode,
        school_id: orderData.school_id || null,
        credits: orderData.sessions_count,
        active: true
      }).select("id").single();
      await supabase.from("orders")
        .update({ token_id: newToken?.id, status: "completed", completed_at: new Date().toISOString() })
        .eq("payu_ext_order_id", extOrderId);
      console.log(`[PAYU-NOTIFY] ✅ Nowy token: ${newTokenCode} (${orderData.sessions_count} sesji)`);
    }

    await supabase.from("orders")
      .update({ status: "completed", completed_at: new Date().toISOString() })
      .eq("payu_ext_order_id", extOrderId);
  }

  return res.status(200).json({ status: "OK" });
});

// ============================================================
// GET /api/order-status/:extOrderId  [PayU]
// ============================================================
app.get("/api/order-status/:extOrderId", async (req, res) => {
  const { extOrderId } = req.params;

  const { data: order, error } = await supabase
    .from("orders")
    .select("id, package_name, sessions_count, amount_pln, status, payu_order_id, completed_at, token_id, tokens(token_code, credits)")
    .eq("payu_ext_order_id", extOrderId)
    .single();

  if (error || !order) return res.status(404).json({ error: "Zamówienie nie znalezione" });

  return res.json({
    ok: true,
    status: order.status,
    package: order.package_name,
    sessions: order.sessions_count,
    completed_at: order.completed_at,
    token_code: order.tokens?.token_code || null,
    credits: order.tokens?.credits || null
  });
});

// ============================================================
// GET /api/health
// ============================================================
app.get("/api/health", async (req, res) => {
  // Sprawdź SMTP — verify() łączy i autoryzuje, nie wysyła maila
  let smtpOk = false;
  try {
    await smtpTransporter.verify();
    smtpOk = true;
  } catch (e) {
    console.warn(`[HEALTH] SMTP verify failed: ${e.message}`);
  }

  res.json({
    status: "ok",
    version: "1.6",
    services: {
      anthropic:    !!ANTHROPIC_API_KEY,
      elevenlabs:   !!ELEVENLABS_API_KEY,
      supabase:     !!SUPABASE_URL && !!SUPABASE_SERVICE_KEY,
      smtp:         smtpOk,
      payu:         !!PAYU_POS_ID && !!PAYU_CLIENT_SECRET,
      payu_sandbox: PAYU_SANDBOX === "true"
    },
    smtp_host:     `${SMTP_HOST}:${SMTP_PORT}`,
    support_email: SUPPORT_EMAIL,
    rate_limits:   { chat: "120/h", other: "30/h" },
    cors_origins:  ["kmusialski.github.io", "herokids.eu"],
    timestamp:     new Date().toISOString()
  });
});

// ============================================================
// START
// ============================================================
app.listen(PORT, () => {
  console.log(`✅ HeroKids 112 backend v1.6 — port ${PORT}`);
  console.log(`   Anthropic:  ${ANTHROPIC_API_KEY  ? "✅" : "❌"}`);
  console.log(`   ElevenLabs: ${ELEVENLABS_API_KEY  ? "✅" : "❌"}`);
  console.log(`   Supabase:   ${SUPABASE_URL        ? "✅" : "❌"}`);
  console.log(`   SMTP:       ${SMTP_USER ? `✅ ${SMTP_HOST}:${SMTP_PORT}` : "❌ brak SMTP_USER"}`);
  console.log(`   Support CC: ${SUPPORT_EMAIL}`);
  console.log(`   PayU:       ${PAYU_POS_ID ? "✅" : "❌"} ${PAYU_SANDBOX === "true" ? "(SANDBOX)" : "(PRODUKCJA)"}`);
  console.log(`   PayU URL:   ${PAYU_BASE}`);
});
