// ============================================================
// server.js — Zadzwoń pod 112 · Backend v1.6.3
// ============================================================
// Nowe w v1.6.3:
//   - Fix OTP: generateLink zastąpiony email_otp (Zimbra SOAP)
// Nowe w v1.6.1:
//   - POST /api/validate-invitation — sprawdza kod zaproszenia
//   - POST /api/register-school    — rejestracja placówki + 5 darmowych sesji
//   - POST /api/generate-invitation — generuje kod HK+5 (tylko admin)
//   - Nowa zmienna env: ADMIN_SECRET
// ============================================================

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const crypto = require("crypto");
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
    "http://localhost:3000",
    "https://dev.herokids.eu"
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
  ZIMBRA_URL = "https://zimbra1.mail.ovh.net/service/soap",
  ZIMBRA_USER,
  ZIMBRA_PASSWORD,
  ADMIN_SECRET,
  PAYU_POS_ID,
  PAYU_CLIENT_ID,
  PAYU_CLIENT_SECRET,
  PAYU_NOTIFY_KEY,
  PAYU_SANDBOX,
  PORT = 3000
} = process.env;

const SUPPORT_EMAIL = "support@herokids.eu";
const FREE_SESSIONS_ON_REGISTER = 5;

const PAYU_BASE = PAYU_SANDBOX === "true"
  ? "https://secure.snd.payu.com"
  : "https://secure.payu.com";

const PACKAGES = {
  P1: { name: "Pakiet Mały",   sessions: 20, amount: 2900, label: "20 sesji · 29 zł" },
  P2: { name: "Pakiet Średni", sessions: 40, amount: 4900, label: "40 sesji · 49 zł" },
  P3: { name: "Pakiet Duży",   sessions: 70, amount: 6900, label: "70 sesji · 69 zł" }
};

// ============================================================
// ZIMBRA SOAP
// ============================================================
async function zimbraAuth() {
  const body = {
    Header: { context: { _jsns: "urn:zimbra" } },
    Body: {
      AuthRequest: {
        _jsns: "urn:zimbraAccount",
        account: { by: "name", _content: ZIMBRA_USER },
        password: { _content: ZIMBRA_PASSWORD }
      }
    }
  };
  const res = await fetch(ZIMBRA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Zimbra auth HTTP error: ${res.status}`);
  const data = await res.json();
  const token = data?.Body?.AuthResponse?.authToken?.[0]?._content;
  if (!token) throw new Error("Zimbra auth: brak authToken w odpowiedzi");
  return token;
}

async function zimbraSendMail({ authToken, to, cc, subject, textBody, htmlBody }) {
  const addresses = [
    { t: "f", a: ZIMBRA_USER, p: "HeroKids 112" },
    ...(Array.isArray(to) ? to : [to]).map(a => ({ t: "t", a })),
    ...(cc ? (Array.isArray(cc) ? cc : [cc]).map(a => ({ t: "c", a })) : [])
  ];
  const body = {
    Header: { context: { _jsns: "urn:zimbra", authToken: { _content: authToken } } },
    Body: {
      SendMsgRequest: {
        _jsns: "urn:zimbraMail",
        m: {
          su: { _content: subject },
          e: addresses,
          mp: [{
            ct: "multipart/alternative",
            mp: [
              { ct: "text/plain", content: { _content: textBody } },
              { ct: "text/html",  content: { _content: htmlBody  } }
            ]
          }]
        }
      }
    }
  };
  const res = await fetch(ZIMBRA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Zimbra sendMail HTTP error: ${res.status}`);
  const data = await res.json();
  if (data?.Body?.Fault) throw new Error("Zimbra sendMail fault: " + data.Body.Fault.Reason?.Text);
  return data?.Body?.SendMsgResponse?.m?.[0]?.id || "sent";
}

// ============================================================
// SUPABASE
// ============================================================
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ============================================================
// RATE LIMITER
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
// HELPER — pobierz i zwaliduj token dostępu
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
// HELPER — PayU OAuth2
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
  return res.json({ valid: true, credits: tokenData.credits, school_name: tokenData.schools?.name || "", token_id: tokenData.id });
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
// ============================================================
app.post("/api/send-log-email", async (req, res) => {
  const { session_id, access_jwt, user_message = "", client_info = {} } = req.body;
  console.log(`[EMAIL] ▶ Żądanie wysyłki — session_id: ${session_id}`);

  const { data: { user }, error: authError } = await supabase.auth.getUser(access_jwt);
  if (authError || !user) {
    console.error(`[EMAIL] ❌ Auth error: ${authError?.message}`);
    return res.status(401).json({ error: "Brak autoryzacji: " + (authError?.message || "brak usera") });
  }

  const { data: session, error: sessionError } = await supabase
    .from("sessions")
    .select("*, session_messages(*), schools(name, director_email)")
    .eq("id", session_id).single();
  if (sessionError || !session) return res.status(404).json({ error: "Sesja nie znaleziona" });

  const rawLog = (session.session_messages || [])
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .map(m => `[${m.role === "user" ? "DZIECKO" : "DYSPOZYTOR"}] ${m.content}`)
    .join("\n");

  let anonLog = session.anonymized_log || rawLog;
  if (!session.anonymized_log) {
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
    } catch (e) {
      console.error(`[EMAIL] ⚠️ Anonimizacja failed: ${e.message}`);
    }
  }

  await supabase.from("sessions").update({ anonymized_log: anonLog, log_sent_at: new Date().toISOString() }).eq("id", session_id);

  const directorEmail = session.schools?.director_email || user.email;
  const schoolName    = session.schools?.name || "Szkoła";
  const date          = new Date(session.started_at).toLocaleString("pl-PL");
  const dateEnded     = session.ended_at ? new Date(session.ended_at).toLocaleString("pl-PL") : "—";
  const dur           = session.duration_seconds ? Math.round(session.duration_seconds / 60) + " min" : "—";
  const msgCount      = session.session_messages?.length || session.message_count || 0;
  const endedBy       = session.ended_by || "—";
  const clientIp      = req.headers["x-forwarded-for"]?.split(",")[0] || req.ip || "—";
  const serverVersion = "1.6.1";
  const ua            = client_info.userAgent      || "—";
  const platform      = client_info.platform       || "—";
  const browserLang   = client_info.language       || "—";
  const screenSize    = (client_info.screenW && client_info.screenH) ? `${client_info.screenW}×${client_info.screenH}` : "—";
  const connType      = client_info.connectionType || "—";
  const sessionErrors = client_info.sessionErrors  || "—";

  if (!ZIMBRA_USER || !ZIMBRA_PASSWORD) return res.status(500).json({ error: "Brak konfiguracji email na serwerze" });

  const subject = `[112] Log sesji — ${schoolName} · ${date}`;
  const userMessageHtml = user_message.trim()
    ? `<div style="background:#fff8e1;border-left:4px solid #ffc107;border-radius:0 8px 8px 0;padding:14px 16px;margin-bottom:16px"><h3 style="margin:0 0 8px;color:#333;font-size:14px">💬 Wiadomość od dyrektora</h3><p style="margin:0;font-size:14px;color:#333;white-space:pre-wrap">${user_message.trim()}</p></div>`
    : "";

  const textBody = [
    `=== LOG SESJI EDUKACYJNEJ — ZADZWOŃ POD 112 · v${serverVersion} ===`,
    `Szkoła: ${schoolName} | Dyrektor: ${directorEmail} | Wysłano przez: ${user.email}`,
    user_message.trim() ? `\n💬 WIADOMOŚĆ OD DYREKTORA:\n${user_message.trim()}\n` : "",
    `Rozpoczęto: ${date} | Zakończono: ${dateEnded} | Czas: ${dur} | Wiadomości: ${msgCount}`,
    `Gwiazdki: ${session.stars || 0}/3 | Język: ${session.lang} | Zakończono przez: ${endedBy}`,
    `\n=== LOG TECHNICZNY ===`,
    `Session ID: ${session_id} | Backend: v${serverVersion} | IP: ${clientIp}`,
    `UA: ${ua} | Platform: ${platform} | Lang: ${browserLang} | Screen: ${screenSize}`,
    `Connection: ${connType} | Błędy: ${sessionErrors}`,
    `\n=== LOG ROZMOWY (zanonimizowany) ===\n`,
    anonLog,
    `\n===\nZadzwoń pod 112 · herokids.eu`
  ].join("\n");

  const htmlBody = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:640px;margin:0 auto;color:#1a1a1a">
      <div style="background:#c00;padding:20px 24px;border-radius:12px 12px 0 0">
        <h2 style="margin:0;color:#fff;font-size:20px">🚨 Log sesji — Zadzwoń pod 112</h2>
        <p style="margin:4px 0 0;color:rgba(255,255,255,0.8);font-size:13px">v${serverVersion} · ${new Date().toLocaleString("pl-PL")}</p>
      </div>
      <div style="background:#fff;border:1px solid #e5e5e5;border-top:none;padding:20px 24px;border-radius:0 0 12px 12px">
        <div style="background:#f0f7ff;border-radius:8px;padding:14px 16px;margin-bottom:16px">
          <h3 style="margin:0 0 10px;color:#333;font-size:14px;text-transform:uppercase;letter-spacing:0.5px">Dane szkoły</h3>
          <table style="font-size:14px;border-collapse:collapse;width:100%">
            <tr><td style="padding:3px 16px 3px 0;color:#666;width:160px">Szkoła:</td><td><b>${schoolName}</b></td></tr>
            <tr><td style="padding:3px 16px 3px 0;color:#666">Dyrektor:</td><td><b>${directorEmail}</b></td></tr>
            <tr><td style="padding:3px 16px 3px 0;color:#666">Wysłano przez:</td><td>${user.email}</td></tr>
          </table>
        </div>
        ${userMessageHtml}
        <div style="background:#f5f5f5;border-radius:8px;padding:14px 16px;margin-bottom:16px">
          <h3 style="margin:0 0 10px;color:#333;font-size:14px;text-transform:uppercase;letter-spacing:0.5px">Dane sesji</h3>
          <table style="font-size:14px;border-collapse:collapse;width:100%">
            <tr><td style="padding:3px 16px 3px 0;color:#666;width:160px">Rozpoczęto:</td><td>${date}</td></tr>
            <tr><td style="padding:3px 16px 3px 0;color:#666">Zakończono:</td><td>${dateEnded}</td></tr>
            <tr><td style="padding:3px 16px 3px 0;color:#666">Czas rozmowy:</td><td>${dur}</td></tr>
            <tr><td style="padding:3px 16px 3px 0;color:#666">Wiadomości:</td><td>${msgCount}</td></tr>
            <tr><td style="padding:3px 16px 3px 0;color:#666">Gwiazdki:</td><td>${"★".repeat(session.stars||0)}${"☆".repeat(3-(session.stars||0))} (${session.stars||0}/3)</td></tr>
            <tr><td style="padding:3px 16px 3px 0;color:#666">Zakończono przez:</td><td>${endedBy}</td></tr>
          </table>
        </div>
        <h3 style="color:#333;font-size:14px;text-transform:uppercase;letter-spacing:0.5px;margin:0 0 8px">Log rozmowy (zanonimizowany)</h3>
        <pre style="background:#111;color:#a0ffa0;padding:16px;border-radius:8px;font-size:12px;line-height:1.7;white-space:pre-wrap;overflow-x:auto;margin:0 0 16px">${anonLog}</pre>
        <details style="margin-bottom:16px">
          <summary style="cursor:pointer;font-size:13px;color:#666;padding:10px 14px;background:#f9f9f9;border-radius:8px;border:1px solid #e5e5e5;list-style:none">🔧 <b>Log techniczny</b> — kliknij aby rozwinąć</summary>
          <div style="border:1px solid #e5e5e5;border-top:none;border-radius:0 0 8px 8px;padding:14px 16px">
            <table style="font-size:12px;border-collapse:collapse;width:100%;font-family:monospace">
              <tr style="background:#f5f5f5"><td style="padding:4px 12px 4px 0;color:#666;width:180px">Session ID:</td><td style="word-break:break-all">${session_id}</td></tr>
              <tr><td style="padding:4px 12px 4px 0;color:#666">Backend:</td><td>v${serverVersion}</td></tr>
              <tr style="background:#f5f5f5"><td style="padding:4px 12px 4px 0;color:#666">IP klienta:</td><td>${clientIp}</td></tr>
              <tr><td style="padding:4px 12px 4px 0;color:#666">User-Agent:</td><td style="word-break:break-all">${ua}</td></tr>
              <tr style="background:#f5f5f5"><td style="padding:4px 12px 4px 0;color:#666">Platforma:</td><td>${platform}</td></tr>
              <tr><td style="padding:4px 12px 4px 0;color:#666">Rozdzielczość:</td><td>${screenSize}</td></tr>
              <tr style="background:#f5f5f5"><td style="padding:4px 12px 4px 0;color:#666">Połączenie:</td><td>${connType}</td></tr>
              <tr><td style="padding:4px 12px 4px 0;color:#666">Błędy:</td><td style="word-break:break-all">${sessionErrors}</td></tr>
            </table>
          </div>
        </details>
        <p style="font-size:11px;color:#999;margin:0;border-top:1px solid #eee;padding-top:12px">Wysłano automatycznie · <a href="https://herokids.eu" style="color:#0a84ff">herokids.eu</a> · na żądanie: ${user.email}</p>
      </div>
    </div>`;

  try {
    const authToken = await zimbraAuth();
    const msgId = await zimbraSendMail({ authToken, to: directorEmail, cc: SUPPORT_EMAIL, subject, textBody, htmlBody });
    return res.json({ ok: true, sent_to: [directorEmail], cc: [SUPPORT_EMAIL], messageId: msgId });
  } catch (e) {
    console.error(`[EMAIL] ❌ Zimbra error: ${e.message}`);
    return res.status(500).json({ error: "Błąd wysyłki Zimbra: " + e.message });
  }
});

// ============================================================
// POST /api/validate-invitation
// Sprawdza czy kod zaproszenia istnieje i nie był użyty
// Body: { code }
// ============================================================
app.post("/api/validate-invitation", async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ valid: false, message: "Brak kodu zaproszenia" });

  console.log(`[INVITE] Walidacja kodu: ${code.toUpperCase()}`);

  const { data, error } = await supabase
    .from("invitation_codes")
    .select("id, code, used")
    .eq("code", code.toUpperCase())
    .single();

  if (error || !data) {
    console.log(`[INVITE] ❌ Kod nie znaleziony: ${code}`);
    return res.status(404).json({ valid: false, message: "Nieprawidłowy kod zaproszenia" });
  }

  if (data.used) {
    console.log(`[INVITE] ❌ Kod już użyty: ${code}`);
    return res.status(409).json({ valid: false, message: "Ten kod zaproszenia został już wykorzystany" });
  }

  console.log(`[INVITE] ✅ Kod prawidłowy: ${code}`);
  return res.json({ valid: true, invitation_id: data.id });
});

// ============================================================
// POST /api/register-school
// Rejestracja placówki:
//   1. Tworzy konto Supabase Auth (email + hasło)
//   2. Tworzy rekord w tabeli schools
//   3. Tworzy token z 5 darmowymi sesjami
//   4. Oznacza kod zaproszenia jako użyty
//   5. Supabase automatycznie wysyła OTP na email (przez Zimbrę w ustawieniach Auth)
//
// Body: { invitation_id, email, password, school_name,
//         invoice_name?, invoice_nip?, invoice_address? }
// ============================================================
app.post("/api/register-school", async (req, res) => {
  const {
    invitation_id,
    email,
    password,
    school_name,
    invoice_name = null,
    invoice_nip  = null,
    invoice_address = null
  } = req.body;

  if (!invitation_id || !email || !password || !school_name) {
    return res.status(400).json({ error: "Brak wymaganych pól: invitation_id, email, password, school_name" });
  }

  console.log(`[REGISTER] ▶ Rejestracja: ${email} | Szkoła: ${school_name}`);

  // 1. Sprawdź czy kod zaproszenia nadal jest ważny (double-check)
  const { data: invite, error: inviteError } = await supabase
    .from("invitation_codes")
    .select("id, used")
    .eq("id", invitation_id)
    .single();

  if (inviteError || !invite) {
    console.error(`[REGISTER] ❌ Kod zaproszenia nie znaleziony`);
    return res.status(404).json({ error: "Nieprawidłowy kod zaproszenia" });
  }
  if (invite.used) {
    console.error(`[REGISTER] ❌ Kod zaproszenia już użyty`);
    return res.status(409).json({ error: "Kod zaproszenia został już wykorzystany" });
  }

  // 2. Utwórz konto Supabase Auth (service role — omija potwierdzenie email)
  //    Supabase wyśle OTP automatycznie jeśli skonfigurowane w Auth → Email
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: false
  });

  // Wymuś wysyłkę OTP — pobierz kod z generateLink i wyślij przez Zimbra
  if (!authError && authData?.user) {
    try {
      const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
        type: "signup",
        email,
        password
      });
      if (linkError) throw new Error(linkError.message);
      const otpCode = linkData?.properties?.email_otp;
      if (!otpCode) throw new Error("Brak email_otp w odpowiedzi generateLink");
      console.log(`[REGISTER] 📧 Wysyłam OTP na ${email}`);
      const zimbraToken = await zimbraAuth();
      await zimbraSendMail({
        authToken: zimbraToken,
        to: email,
        subject: `HeroKids — kod aktywacyjny konta`,
        textBody: `Twój kod aktywacyjny HeroKids: ${otpCode}\n\nWpisz go na stronie rejestracji, aby aktywować konto.\nKod jest jednorazowy i wygasa po 24 godzinach.`,
        htmlBody: `<div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:24px"><div style="background:#c00;padding:16px 24px;border-radius:8px 8px 0 0"><h2 style="margin:0;color:#fff;font-size:18px">🚨 HeroKids — aktywacja konta</h2></div><div style="background:#fff;border:1px solid #e5e5e5;border-top:none;padding:24px;border-radius:0 0 8px 8px"><p style="color:#333;font-size:15px">Twój jednorazowy kod aktywacyjny:</p><div style="text-align:center;margin:20px 0;font-family:monospace;font-size:36px;font-weight:700;letter-spacing:8px;color:#c00;background:#fff0f3;padding:16px;border-radius:8px">${otpCode}</div><p style="color:#666;font-size:13px">Wpisz go na stronie rejestracji HeroKids, aby aktywować konto.</p><p style="color:#999;font-size:12px">Kod jest jednorazowy i wygasa po 24 godzinach.</p></div></div>`
      });
      console.log(`[REGISTER] ✅ OTP wysłany przez Zimbra na ${email}`);
    } catch (e) {
      console.warn(`[REGISTER] ⚠️ OTP email failed: ${e.message}`);
    }
  }

  if (authError) {
    console.error(`[REGISTER] ❌ Auth error: ${authError.message}`);
    if (authError.message.includes("already registered")) {
      return res.status(409).json({ error: "Ten adres email jest już zarejestrowany" });
    }
    return res.status(500).json({ error: "Błąd tworzenia konta: " + authError.message });
  }

  const userId = authData.user.id;
  console.log(`[REGISTER] ✅ Konto Auth utworzone: ${userId}`);

  // 3. Utwórz rekord szkoły
  const { data: school, error: schoolError } = await supabase
    .from("schools")
    .insert({
      name: school_name,
      director_email: email,
      auth_user_id: userId,
      invoice_name,
      invoice_nip,
      invoice_address,
      created_at: new Date().toISOString()
    })
    .select("id").single();

  if (schoolError) {
    console.error(`[REGISTER] ❌ Błąd tworzenia szkoły: ${schoolError.message}`);
    // Rollback — usuń konto Auth
    await supabase.auth.admin.deleteUser(userId);
    return res.status(500).json({ error: "Błąd tworzenia placówki: " + schoolError.message });
  }

  console.log(`[REGISTER] ✅ Szkoła utworzona: ${school.id}`);

  // 4. Wygeneruj token dostępu z 5 darmowymi sesjami
  const tokenCode = "PSZ-" + Math.random().toString(36).slice(2, 6).toUpperCase() + "-" + Math.random().toString(36).slice(2, 6).toUpperCase();
  const { error: tokenError } = await supabase
    .from("tokens")
    .insert({
      token_code: tokenCode,
      school_id: school.id,
      credits: FREE_SESSIONS_ON_REGISTER,
      active: true,
      created_at: new Date().toISOString()
    });

  if (tokenError) {
    console.error(`[REGISTER] ⚠️ Błąd tworzenia tokenu: ${tokenError.message}`);
    // Nie robimy rollbacku — szkoła i konto są OK, token można dodać ręcznie
  } else {
    console.log(`[REGISTER] ✅ Token utworzony: ${tokenCode} (${FREE_SESSIONS_ON_REGISTER} sesji)`);
  }

  // 5. Oznacz kod zaproszenia jako użyty
  await supabase
    .from("invitation_codes")
    .update({ used: true, used_by_email: email, used_at: new Date().toISOString() })
    .eq("id", invitation_id);

  console.log(`[REGISTER] ✅ Rejestracja zakończona: ${email}`);

  return res.json({
    ok: true,
    message: "Konto zostało utworzone. Sprawdź email — wpisz kod weryfikacyjny aby aktywować konto.",
    user_id: userId,
    school_id: school.id,
    token_code: tokenCode
  });
});

// ============================================================
// POST /api/generate-invitation
// Generuje nowy kod zaproszenia HK + 5 znaków
// Wymaga nagłówka: Authorization: Bearer <ADMIN_SECRET>
// Body: { note? } — opcjonalna notatka (np. nazwa szkoły)
// ============================================================
app.post("/api/generate-invitation", async (req, res) => {
  const authHeader = req.headers["authorization"] || "";
  const secret = authHeader.replace("Bearer ", "").trim();

  if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
    console.warn(`[ADMIN] ❌ Nieautoryzowana próba generowania kodu`);
    return res.status(401).json({ error: "Brak autoryzacji" });
  }

  const { note = "" } = req.body;
  const code = "HK" + Math.random().toString(36).slice(2, 7).toUpperCase();

  const { error } = await supabase
    .from("invitation_codes")
    .insert({
      code,
      used: false,
      note: note || null,
      created_at: new Date().toISOString()
    });

  if (error) {
    console.error(`[ADMIN] ❌ Błąd zapisu kodu: ${error.message}`);
    return res.status(500).json({ error: "Błąd zapisu kodu: " + error.message });
  }

  console.log(`[ADMIN] ✅ Wygenerowano kod: ${code}${note ? " (" + note + ")" : ""}`);
  return res.json({ ok: true, code, note: note || null });
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
    .insert({ school_id: school_id || null, token_id: token_id || null, package_name: packageKey, sessions_count: pkg.sessions, amount_pln: pkg.amount, payu_ext_order_id: extOrderId, status: "pending" })
    .select("id").single();

  if (orderError) return res.status(500).json({ error: "Błąd zapisu zamówienia" });

  let accessToken;
  try { accessToken = await getPayuToken(); }
  catch (e) { return res.status(502).json({ error: "Błąd autoryzacji PayU" }); }

  const notifyUrl = PAYU_SANDBOX === "true"
    ? "https://telefon112-dev.up.railway.app/api/payu-notify"
    : "https://telefon112-production.up.railway.app/api/payu-notify";
  const continueUrl = (return_url || "https://herokids.eu/sklep.html").replace("{extOrderId}", extOrderId);

  const orderPayload = {
    extOrderId, notifyUrl, continueUrl,
    customerIp: req.headers["x-forwarded-for"]?.split(",")[0] || req.ip || "127.0.0.1",
    merchantPosId: PAYU_POS_ID,
    description: `Zadzwoń pod 112 — ${pkg.label}`,
    currencyCode: "PLN", totalAmount: String(pkg.amount),
    buyer: { email: buyer_email, firstName: buyer_name || "Dyrektor", lastName: "", language: "pl" },
    products: [{ name: `Pakiet ${pkg.name} — Zadzwoń pod 112`, unitPrice: String(pkg.amount), quantity: "1" }]
  };

  try {
    const payuRes = await fetch(`${PAYU_BASE}/api/v2_1/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${accessToken}` },
      body: JSON.stringify(orderPayload), redirect: "manual"
    });
    const payuData = await payuRes.json().catch(() => ({}));
    if (!payuData.redirectUri) return res.status(502).json({ error: "Błąd PayU: brak URL płatności", details: payuData });
    await supabase.from("orders").update({ payu_order_id: payuData.orderId }).eq("id", order.id);
    return res.json({ ok: true, redirect_url: payuData.redirectUri, order_id: order.id, ext_order_id: extOrderId });
  } catch (e) {
    return res.status(500).json({ error: "Błąd tworzenia zamówienia: " + e.message });
  }
});

// ============================================================
// POST /api/payu-notify  [PayU webhook]
// ============================================================
app.post("/api/payu-notify", async (req, res) => {
  const signature = req.headers["openpayu-signature"];
  if (signature && PAYU_NOTIFY_KEY) {
    const bodyStr = JSON.stringify(req.body);
    const expectedSig = crypto.createHash("md5").update(bodyStr + PAYU_NOTIFY_KEY).digest("hex");
    const sigMatch = signature.match(/signature=([a-f0-9]+)/i);
    if (sigMatch?.[1] && sigMatch[1] !== expectedSig) return res.status(401).send("Invalid signature");
  }

  const order = req.body?.order;
  if (!order) return res.status(400).send("No order data");

  const { extOrderId, orderId, status } = order;
  await supabase.from("orders").update({ payu_order_id: orderId, status: status.toLowerCase() }).eq("payu_ext_order_id", extOrderId);

  if (status === "COMPLETED") {
    const { data: orderData } = await supabase.from("orders").select("token_id, sessions_count, school_id").eq("payu_ext_order_id", extOrderId).single();
    if (orderData?.token_id) {
      const { data: tokenData } = await supabase.from("tokens").select("credits").eq("id", orderData.token_id).single();
      const newCredits = (tokenData?.credits || 0) + orderData.sessions_count;
      await supabase.from("tokens").update({ credits: newCredits, active: true }).eq("id", orderData.token_id);
    } else if (orderData) {
      const newTokenCode = "HK" + Math.random().toString(36).slice(2, 7).toUpperCase();
      const { data: newToken } = await supabase.from("tokens").insert({ token_code: newTokenCode, school_id: orderData.school_id || null, credits: orderData.sessions_count, active: true }).select("id").single();
      await supabase.from("orders").update({ token_id: newToken?.id, status: "completed", completed_at: new Date().toISOString() }).eq("payu_ext_order_id", extOrderId);
    }
    await supabase.from("orders").update({ status: "completed", completed_at: new Date().toISOString() }).eq("payu_ext_order_id", extOrderId);
  }

  return res.status(200).json({ status: "OK" });
});

// ============================================================
// GET /api/order-status/:extOrderId  [PayU]
// ============================================================
app.get("/api/order-status/:extOrderId", async (req, res) => {
  const { data: order, error } = await supabase
    .from("orders")
    .select("id, package_name, sessions_count, amount_pln, status, payu_order_id, completed_at, token_id, tokens(token_code, credits)")
    .eq("payu_ext_order_id", req.params.extOrderId).single();
  if (error || !order) return res.status(404).json({ error: "Zamówienie nie znalezione" });
  return res.json({ ok: true, status: order.status, package: order.package_name, sessions: order.sessions_count, completed_at: order.completed_at, token_code: order.tokens?.token_code || null, credits: order.tokens?.credits || null });
});

// ============================================================
// GET /api/health
// ============================================================
app.get("/api/health", async (req, res) => {
  let zimbraOk = false;
  try { await zimbraAuth(); zimbraOk = true; }
  catch (e) { console.warn(`[HEALTH] Zimbra auth failed: ${e.message}`); }

  res.json({
    status: "ok",
    version: "1.6.3",
    services: {
      anthropic:    !!ANTHROPIC_API_KEY,
      elevenlabs:   !!ELEVENLABS_API_KEY,
      supabase:     !!SUPABASE_URL && !!SUPABASE_SERVICE_KEY,
      zimbra:       zimbraOk,
      payu:         !!PAYU_POS_ID && !!PAYU_CLIENT_SECRET,
      payu_sandbox: PAYU_SANDBOX === "true",
      admin:        !!ADMIN_SECRET
    },
    zimbra_url:    ZIMBRA_URL,
    support_email: SUPPORT_EMAIL,
    rate_limits:   { chat: "120/h", other: "30/h" },
    timestamp:     new Date().toISOString()
  });
});

// ============================================================
// START
// ============================================================
app.listen(PORT, () => {
  console.log(`✅ HeroKids 112 backend v1.6.3 — port ${PORT}`);
  console.log(`   Anthropic:  ${ANTHROPIC_API_KEY  ? "✅" : "❌"}`);
  console.log(`   ElevenLabs: ${ELEVENLABS_API_KEY  ? "✅" : "❌"}`);
  console.log(`   Supabase:   ${SUPABASE_URL        ? "✅" : "❌"}`);
  console.log(`   Zimbra:     ${ZIMBRA_USER ? `✅ ${ZIMBRA_URL}` : "❌ brak ZIMBRA_USER"}`);
  console.log(`   PayU:       ${PAYU_POS_ID ? "✅" : "❌"} ${PAYU_SANDBOX === "true" ? "(SANDBOX)" : "(PRODUKCJA)"}`);
  console.log(`   Admin:      ${ADMIN_SECRET ? "✅" : "❌ brak ADMIN_SECRET"}`);
  console.log(`   Support CC: ${SUPPORT_EMAIL}`);
});
