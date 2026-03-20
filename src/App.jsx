import { useState, useEffect, useCallback } from "react";

const SHEET_ID = "1o1N4B9SCmxcGt9TfZJcPreZGS6lo16-ZGBBtNkXn5x8";
const SHEET_NAME = "Sheet1";
// ─── Default allowlist (user can edit this inline) ───────────────────────────
const DEFAULT_ALLOWLIST = {
  subject_keywords: [
    "application received",
    "thank you for applying",
    "your application",
    "application for",
    "we received your application",
    "application confirmation",
    "interview invitation",
    "interview request",
    "schedule an interview",
    "next steps",
    "moving forward",
    "unfortunately",
    "we regret",
    "not moving forward",
    "other candidates",
    "position has been filled",
    "under review",
    "application status",
    "job application",
    "offer letter",
    "congratulations",
  ],
  body_keywords: [
    "applied for",
    "your resume",
    "your application has been",
    "hiring team",
    "recruiting team",
    "talent acquisition",
    "we will be in touch",
    "we'll be in touch",
    "not selected",
    "decided to move forward with other",
    "keep your resume on file",
  ],
  exclude_senders: ["noreply@linkedin.com", "jobs-noreply@linkedin.com"],
};

// ─── Status classification prompt ─────────────────────────────────────────────
function buildClassificationPrompt(email, allowlist) {
  return `You are classifying a job application email. Based on the email below, determine the application status.

Allowlist keywords for context:
- Subject keywords: ${allowlist.subject_keywords.join(", ")}
- Body keywords: ${allowlist.body_keywords.join(", ")}

Email Subject: ${email.subject}
Email From: ${email.from}
Email Date: ${email.date}
Email Body (first 800 chars): ${(email.body || "").slice(0, 800)}

Classify this email into EXACTLY one of these statuses:
- "applied" — confirmation that application was received
- "reviewing" — application is under review, being considered
- "interviewing" — interview scheduled, invited, or completed
- "rejected" — application declined, not moving forward
- "offer" — job offer extended
- "unknown" — cannot determine, not a job application email

Also extract the company name from the email.

Respond ONLY with valid JSON, no explanation, no markdown:
{"status": "...", "company": "...", "confidence": 0.0-1.0}`;
}

// ─── Gmail OAuth helpers ───────────────────────────────────────────────────────
//const GMAIL_SCOPES = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_SCOPES = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/spreadsheets";

// ─── Status config ─────────────────────────────────────────────────────────────
const STATUS_CONFIG = {
  applied:      { label: "Applied",      color: "#378ADD", bg: "#E6F1FB", dark: "#0C447C" },
  reviewing:    { label: "Reviewing",    color: "#BA7517", bg: "#FAEEDA", dark: "#633806" },
  interviewing: { label: "Interviewing", color: "#1D9E75", bg: "#E1F5EE", dark: "#085041" },
  rejected:     { label: "Rejected",     color: "#E24B4A", bg: "#FCEBEB", dark: "#501313" },
  offer:        { label: "Offer",        color: "#639922", bg: "#EAF3DE", dark: "#173404" },
  unknown:      { label: "Unknown",      color: "#888780", bg: "#F1EFE8", dark: "#2C2C2A" },
};

const STATUS_ORDER = ["applied", "reviewing", "interviewing", "rejected", "offer"];

// ─── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [view, setView]                   = useState("dashboard"); // dashboard | allowlist | email
  const [emails, setEmails]               = useState([]);
  const [classified, setClassified]       = useState([]);
  const [loading, setLoading]             = useState(false);
  const [loadingMsg, setLoadingMsg]       = useState("");
  const [error, setError]                 = useState(null);
  const [selectedStatus, setSelectedStatus] = useState(null);
  const [selectedEmail, setSelectedEmail] = useState(null);
  const [allowlist, setAllowlist]         = useState(DEFAULT_ALLOWLIST);
  const [allowlistText, setAllowlistText] = useState(JSON.stringify(DEFAULT_ALLOWLIST, null, 2));
  const [allowlistError, setAllowlistError] = useState(null);
  const [dateFrom, setDateFrom]           = useState(() => {
    const d = new Date(); d.setMonth(d.getMonth() - 3);
    return d.toISOString().split("T")[0];
  });
  const [dateTo, setDateTo]               = useState(() => new Date().toISOString().split("T")[0]);
  const [gmailToken, setGmailToken]       = useState(null);
  const [gmailClientId, setGmailClientId] = useState("411851235029-3jf76gogovsbpo5oehh6gjga8r6b2nir.apps.googleusercontent.com");
  const [showClientIdInput, setShowClientIdInput] = useState(false);
  const [classifyProgress, setClassifyProgress] = useState({ done: 0, total: 0 });

  // ── Filter classified emails by date ──────────────────────────────────────
  const filteredEmails = classified.filter(e => {
    if (!e.date) return true;
    const d = new Date(e.date);
    const from = new Date(dateFrom + "T00:00:00");
    const to   = new Date(dateTo   + "T23:59:59");
    return d >= from && d <= to;
  });

  // ── Funnel counts ──────────────────────────────────────────────────────────
  const counts = STATUS_ORDER.reduce((acc, s) => {
    acc[s] = filteredEmails.filter(e => e.status === s).length;
    return acc;
  }, {});
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  // ── Companies for selected status ──────────────────────────────────────────
  const companiesForStatus = selectedStatus
    ? filteredEmails.filter(e => e.status === selectedStatus)
    : [];

  // ── Gmail: load Google Identity Services ──────────────────────────────────
  useEffect(() => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    document.head.appendChild(script);
    return () => document.head.removeChild(script);
  }, []);

  // ── Gmail: sign in ─────────────────────────────────────────────────────────
  const signInGmail = useCallback(() => {
    if (!gmailClientId.trim()) { setShowClientIdInput(true); return; }
    const client = window.google?.accounts?.oauth2?.initTokenClient({
      client_id: gmailClientId.trim(),
      scope: GMAIL_SCOPES,
      callback: (resp) => {
        if (resp.access_token) {
          setGmailToken(resp.access_token);
          setError(null);
        } else {
          setError("Gmail sign-in failed: " + (resp.error || "unknown error"));
        }
      },
    });
    client?.requestAccessToken();
  }, [gmailClientId]);

  // ── Gmail: fetch emails ────────────────────────────────────────────────────
  const fetchGmailEmails = useCallback(async () => {
    if (!gmailToken) { signInGmail(); return; }
    setLoading(true);
    setError(null);
    setLoadingMsg("Searching Gmail for job application emails…");
    try {
      // Build query from allowlist keywords + date range
      const kwQuery = allowlist.subject_keywords.slice(0, 6)
        .map(k => `subject:"${k}"`).join(" OR ");
      const afterDate  = Math.floor(new Date(dateFrom).getTime() / 1000);
      const beforeDate = Math.floor(new Date(dateTo  ).getTime() / 1000) + 86400;
      const query = `(${kwQuery}) after:${afterDate} before:${beforeDate}`;

      // List message IDs
      const listRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=50&q=${encodeURIComponent(query)}`,
        { headers: { Authorization: `Bearer ${gmailToken}` } }
      );
      if (!listRes.ok) throw new Error("Gmail API error: " + listRes.status);
      const listData = await listRes.json();
      const messages = listData.messages || [];

      if (!messages.length) {
        setEmails([]); setClassified([]);
        setLoadingMsg(""); setLoading(false);
        setError("No matching emails found for that date range. Try widening the date range or editing the allowlist.");
        return;
      }

      setLoadingMsg(`Found ${messages.length} emails. Fetching details…`);

      // Fetch each message
      const fetched = [];
      for (const msg of messages) {
        const res = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
          { headers: { Authorization: `Bearer ${gmailToken}` } }
        );
        if (!res.ok) continue;
        const data = await res.json();

        // Parse headers
        const headers = data.payload?.headers || [];
        const h = (name) => headers.find(x => x.name.toLowerCase() === name.toLowerCase())?.value || "";

        // Decode body
        let body = "";
        const findBody = (parts) => {
          for (const p of (parts || [])) {
            if (p.mimeType === "text/plain" && p.body?.data) {
              body = atob(p.body.data.replace(/-/g, "+").replace(/_/g, "/"));
              return;
            }
            if (p.parts) findBody(p.parts);
          }
        };
        if (data.payload?.body?.data) {
          body = atob(data.payload.body.data.replace(/-/g, "+").replace(/_/g, "/"));
        } else {
          findBody(data.payload?.parts);
        }

        // Filter by exclude_senders
        const from = h("From");
        if (allowlist.exclude_senders.some(s => from.includes(s))) continue;

        fetched.push({
          id: msg.id,
          subject: h("Subject"),
          from,
          date: h("Date"),
          body,
          snippet: data.snippet || "",
        });
      }

      setEmails(fetched);
      await classifyEmails(fetched);
    } catch (err) {
      setError("Error fetching Gmail: " + err.message);
      setLoading(false);
      setLoadingMsg("");
    }
  }, [gmailToken, allowlist, dateFrom, dateTo, signInGmail]);

  const saveToSheet = async (emailData, token) => {
  const values = emailData.map(e => [
    e.company || "Unknown",
    e.status || "unknown",
    e.subject || "",
    e.from || "",
    e.date || "",
    (e.body || "").slice(0, 500),
    e.confidence || 0,
  ]);

  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${SHEET_NAME}!A2:G:append?valueInputOption=RAW`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ values }),
    }
  );
};

  // ── Classify via Claude API ────────────────────────────────────────────────
  const classifyEmails = useCallback(async (emailList) => {
    setClassifyProgress({ done: 0, total: emailList.length });
    const results = [];
    for (let i = 0; i < emailList.length; i++) {
      const email = emailList[i];
      setLoadingMsg(`Classifying email ${i + 1} of ${emailList.length}…`);
      try {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "claude-sonnet-4-20250514",
            max_tokens: 1000,
            messages: [{ role: "user", content: buildClassificationPrompt(email, allowlist) }],
          }),
        });
        const data = await res.json();
        const text = data.content?.find(b => b.type === "text")?.text || "{}";
        const clean = text.replace(/```json|```/g, "").trim();
        const parsed = JSON.parse(clean);
        results.push({ ...email, ...parsed });
      } catch {
        results.push({ ...email, status: "unknown", company: "Unknown", confidence: 0 });
      }
      setClassifyProgress({ done: i + 1, total: emailList.length });
    }
    setClassified(results);
    if (gmailToken) await saveToSheet(results, gmailToken);

    setLoading(false);
    setLoadingMsg("");
    setClassifyProgress({ done: 0, total: 0 });
  }, [allowlist]);

  // ── Demo: load sample data ─────────────────────────────────────────────────
  const loadDemo = useCallback(() => {
    const sample = [
      { id: "1", subject: "Your application to Acme Corp", from: "recruiting@acme.com", date: "Mon, 3 Mar 2025 10:00:00 +0000", body: "Thank you for applying to the Senior PM role at Acme Corp. We have received your application and will review it shortly.", status: "applied", company: "Acme Corp", confidence: 0.95 },
      { id: "2", subject: "Application update – Beta Inc", from: "hr@beta.io", date: "Tue, 11 Mar 2025 14:30:00 +0000", body: "Hi, we wanted to let you know that your application is currently under review by our team. We'll be in touch soon.", status: "reviewing", company: "Beta Inc", confidence: 0.88 },
      { id: "3", subject: "Interview invitation – Gamma LLC", from: "talent@gamma.com", date: "Mon, 17 Mar 2025 09:15:00 +0000", body: "We are pleased to invite you for an interview for the Product Manager position. Please let us know your availability.", status: "interviewing", company: "Gamma LLC", confidence: 0.97 },
      { id: "4", subject: "Re: Your application – Delta Co", from: "noreply@delta.co", date: "Fri, 21 Mar 2025 17:00:00 +0000", body: "After careful consideration, we have decided to move forward with other candidates. We appreciate your interest.", status: "rejected", company: "Delta Co", confidence: 0.93 },
      { id: "5", subject: "Application received – Epsilon Tech", from: "jobs@epsilon.tech", date: "Mon, 24 Mar 2025 08:00:00 +0000", body: "Thank you for applying to Epsilon Tech. We have received your application for the Product Manager role.", status: "applied", company: "Epsilon Tech", confidence: 0.91 },
      { id: "6", subject: "Moving forward – Zeta Labs", from: "hr@zetalabs.com", date: "Wed, 26 Mar 2025 11:00:00 +0000", body: "Great news! We'd love to schedule a call to discuss next steps for the PM role.", status: "interviewing", company: "Zeta Labs", confidence: 0.89 },
      { id: "7", subject: "Application confirmation – Eta Corp", from: "careers@etacorp.com", date: "Fri, 28 Mar 2025 15:00:00 +0000", body: "We confirm receipt of your application. Our team will be reviewing applications over the next two weeks.", status: "applied", company: "Eta Corp", confidence: 0.92 },
      { id: "8", subject: "Unfortunately – Theta Partners", from: "talent@theta.com", date: "Mon, 31 Mar 2025 10:30:00 +0000", body: "We regret to inform you that we will not be moving forward with your application at this time.", status: "rejected", company: "Theta Partners", confidence: 0.96 },
    ];
    setClassified(sample);
    setEmails(sample);
    setDateFrom("2025-03-01");
    setDateTo("2025-04-01");
  }, []);

  // ── Allowlist editor save ──────────────────────────────────────────────────
  const saveAllowlist = () => {
    try {
      const parsed = JSON.parse(allowlistText);
      setAllowlist(parsed);
      setAllowlistError(null);
    } catch (e) {
      setAllowlistError("Invalid JSON: " + e.message);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────────
  const css = `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: var(--font-sans, system-ui, sans-serif); }
    .app { min-height: 100vh; background: var(--color-background-tertiary); }
    .topbar { background: var(--color-background-primary); border-bottom: 1px solid var(--color-border-tertiary); padding: 0 24px; display: flex; align-items: center; gap: 24px; height: 56px; }
    .topbar-title { font-size: 16px; font-weight: 500; color: var(--color-text-primary); flex: 1; }
    .nav-btn { background: none; border: none; font-size: 13px; color: var(--color-text-secondary); cursor: pointer; padding: 6px 10px; border-radius: 6px; }
    .nav-btn.active { background: var(--color-background-secondary); color: var(--color-text-primary); font-weight: 500; }
    .nav-btn:hover { background: var(--color-background-secondary); }
    .main { padding: 24px; max-width: 1100px; margin: 0 auto; }
    .card { background: var(--color-background-primary); border: 1px solid var(--color-border-tertiary); border-radius: 12px; padding: 20px; }
    .section-title { font-size: 13px; font-weight: 500; color: var(--color-text-secondary); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 16px; }
    .row { display: flex; gap: 16px; flex-wrap: wrap; }
    .btn { background: var(--color-background-secondary); border: 1px solid var(--color-border-secondary); color: var(--color-text-primary); font-size: 13px; font-weight: 500; padding: 8px 16px; border-radius: 8px; cursor: pointer; }
    .btn:hover { background: var(--color-background-tertiary); }
    .btn-primary { background: #185FA5; border-color: #185FA5; color: #fff; }
    .btn-primary:hover { background: #0C447C; }
    .btn-sm { font-size: 12px; padding: 5px 10px; }
    .input { background: var(--color-background-secondary); border: 1px solid var(--color-border-secondary); color: var(--color-text-primary); font-size: 13px; padding: 7px 10px; border-radius: 6px; outline: none; }
    .input:focus { border-color: var(--color-border-primary); }
    label { font-size: 13px; color: var(--color-text-secondary); }
    .error { color: var(--color-text-danger); font-size: 13px; padding: 10px; background: var(--color-background-danger); border-radius: 8px; }
    .loading { font-size: 13px; color: var(--color-text-secondary); padding: 10px 0; }
    .progress-bar { height: 4px; background: var(--color-background-secondary); border-radius: 2px; margin-top: 8px; overflow: hidden; }
    .progress-fill { height: 100%; background: #185FA5; border-radius: 2px; transition: width 0.3s; }
    .funnel-row { display: flex; gap: 12px; margin-bottom: 8px; flex-wrap: wrap; }
    .funnel-card { flex: 1; min-width: 110px; border-radius: 10px; padding: 16px 14px 12px; cursor: pointer; border: 2px solid transparent; transition: border-color 0.15s, transform 0.1s; }
    .funnel-card:hover { transform: translateY(-1px); }
    .funnel-card.selected { border-color: currentColor; }
    .funnel-count { font-size: 28px; font-weight: 500; line-height: 1; }
    .funnel-label { font-size: 12px; margin-top: 4px; opacity: 0.75; }
    .funnel-bar-wrap { height: 5px; background: rgba(0,0,0,0.08); border-radius: 3px; margin-top: 10px; overflow: hidden; }
    .funnel-bar-fill { height: 100%; border-radius: 3px; }
    .company-list { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
    .company-row { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: var(--color-background-secondary); border-radius: 8px; cursor: pointer; border: 1px solid var(--color-border-tertiary); }
    .company-row:hover { border-color: var(--color-border-secondary); }
    .company-name { font-size: 14px; font-weight: 500; color: var(--color-text-primary); }
    .company-meta { font-size: 12px; color: var(--color-text-secondary); }
    .chevron { color: var(--color-text-secondary); font-size: 14px; }
    .email-view { background: var(--color-background-primary); border: 1px solid var(--color-border-tertiary); border-radius: 12px; padding: 20px; margin-top: 16px; }
    .email-header { border-bottom: 1px solid var(--color-border-tertiary); padding-bottom: 14px; margin-bottom: 14px; }
    .email-subject { font-size: 16px; font-weight: 500; color: var(--color-text-primary); margin-bottom: 8px; }
    .email-meta { display: flex; flex-direction: column; gap: 3px; }
    .email-body { font-size: 13px; color: var(--color-text-secondary); white-space: pre-wrap; line-height: 1.7; }
    .tag { display: inline-flex; align-items: center; padding: 3px 8px; border-radius: 4px; font-size: 12px; font-weight: 500; }
    .textarea { width: 100%; min-height: 320px; font-family: var(--font-mono, monospace); font-size: 12px; background: var(--color-background-secondary); border: 1px solid var(--color-border-secondary); color: var(--color-text-primary); padding: 12px; border-radius: 8px; resize: vertical; outline: none; }
    .textarea:focus { border-color: var(--color-border-primary); }
    .empty { text-align: center; padding: 48px 0; color: var(--color-text-secondary); font-size: 14px; }
    .client-id-box { background: var(--color-background-secondary); border: 1px solid var(--color-border-secondary); border-radius: 10px; padding: 16px; margin-top: 12px; }
    .back-btn { background: none; border: none; color: var(--color-text-secondary); cursor: pointer; font-size: 13px; display: flex; align-items: center; gap: 4px; padding: 0; margin-bottom: 12px; }
    .back-btn:hover { color: var(--color-text-primary); }
    .confidence { font-size: 11px; color: var(--color-text-secondary); margin-left: 6px; }
  `;

  const StatusTag = ({ status }) => {
    const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.unknown;
    return (
      <span className="tag" style={{ background: cfg.bg, color: cfg.dark }}>
        {cfg.label}
      </span>
    );
  };

  const formatDate = (d) => {
    if (!d) return "";
    try { return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); }
    catch { return d; }
  };

  // ─── VIEWS ─────────────────────────────────────────────────────────────────

  const DashboardView = () => (
    <div>
      {/* Controls row */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row" style={{ alignItems: "flex-end", gap: 12 }}>
          <div>
            <label style={{ display: "block", marginBottom: 4 }}>From</label>
            <input type="date" className="input" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
          </div>
          <div>
            <label style={{ display: "block", marginBottom: 4 }}>To</label>
            <input type="date" className="input" value={dateTo} onChange={e => setDateTo(e.target.value)} />
          </div>
          <div style={{ flex: 1 }} />
          <button className="btn btn-sm" onClick={loadDemo}>Load demo data</button>
          {gmailToken
            ? <button className="btn btn-primary btn-sm" onClick={fetchGmailEmails} disabled={loading}>
                {loading ? "Scanning…" : "Refresh Gmail"}
              </button>
            : <button className="btn btn-primary btn-sm" onClick={signInGmail} disabled={loading}>
                Connect Gmail
              </button>
          }
        </div>

        {showClientIdInput && !gmailToken && (
          <div className="client-id-box" style={{ marginTop: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 6 }}>Enter your Google OAuth Client ID</div>
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 8 }}>
              Create one at <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer" style={{ color: "#185FA5" }}>console.cloud.google.com</a> → Credentials → OAuth 2.0 Client IDs. Set Authorized JS origin to this page's URL.
            </div>
            <div className="row" style={{ gap: 8 }}>
              <input className="input" style={{ flex: 1 }} placeholder="xxxx.apps.googleusercontent.com"
                value={gmailClientId} onChange={e => setGmailClientId(e.target.value)} />
              <button className="btn btn-primary btn-sm" onClick={signInGmail}>Sign in</button>
            </div>
          </div>
        )}

        {loading && (
          <div style={{ marginTop: 12 }}>
            <div className="loading">{loadingMsg}</div>
            {classifyProgress.total > 0 && (
              <div className="progress-bar">
                <div className="progress-fill"
                  style={{ width: `${Math.round(classifyProgress.done / classifyProgress.total * 100)}%` }} />
              </div>
            )}
          </div>
        )}
        {error && <div className="error" style={{ marginTop: 12 }}>{error}</div>}
      </div>

      {/* Funnel */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="section-title">Application funnel — {total} emails matched</div>
        {total === 0 ? (
          <div className="empty">No applications in this date range. Load demo data or connect Gmail to get started.</div>
        ) : (
          <div className="funnel-row">
            {STATUS_ORDER.map(s => {
              const cfg = STATUS_CONFIG[s];
              const pct = total > 0 ? Math.round(counts[s] / total * 100) : 0;
              return (
                <div key={s} className={`funnel-card${selectedStatus === s ? " selected" : ""}`}
                  style={{ background: cfg.bg, color: cfg.dark }}
                  onClick={() => setSelectedStatus(selectedStatus === s ? null : s)}>
                  <div className="funnel-count">{counts[s]}</div>
                  <div className="funnel-label">{cfg.label}</div>
                  <div className="funnel-bar-wrap">
                    <div className="funnel-bar-fill" style={{ width: `${pct}%`, background: cfg.color }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Company list for selected status */}
      {selectedStatus && companiesForStatus.length > 0 && (
        <div className="card">
          <div className="section-title">
            {STATUS_CONFIG[selectedStatus].label} — {companiesForStatus.length} companies
          </div>
          <div className="company-list">
            {companiesForStatus.map(e => (
              <div key={e.id} className="company-row"
                onClick={() => { setSelectedEmail(e); setView("email"); }}>
                <div>
                  <div className="company-name">{e.company || "Unknown company"}</div>
                  <div className="company-meta">{e.subject} · {formatDate(e.date)}</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  {e.confidence && (
                    <span className="confidence">{Math.round(e.confidence * 100)}% confident</span>
                  )}
                  <span className="chevron">›</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  const EmailView = () => {
    if (!selectedEmail) return null;
    return (
      <div>
        <button className="back-btn" onClick={() => { setView("dashboard"); }}>
          ← Back to dashboard
        </button>
        <div className="email-view">
          <div className="email-header">
            <div className="email-subject">{selectedEmail.subject}</div>
            <div className="email-meta">
              <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>
                <strong style={{ color: "var(--color-text-primary)", fontWeight: 500 }}>From:</strong> {selectedEmail.from}
              </div>
              <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>
                <strong style={{ color: "var(--color-text-primary)", fontWeight: 500 }}>Date:</strong> {formatDate(selectedEmail.date)}
              </div>
              <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
                <StatusTag status={selectedEmail.status} />
                <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
                  {selectedEmail.company}
                </span>
              </div>
            </div>
          </div>
          <div className="email-body">
            {selectedEmail.body || selectedEmail.snippet || "No body content available."}
          </div>
        </div>
      </div>
    );
  };

  const AllowlistView = () => (
    <div className="card">
      <div className="section-title">Allowlist configuration</div>
      <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginBottom: 12 }}>
        Edit the subject and body keywords used to find and classify job application emails. Changes apply on the next Gmail scan.
      </div>
      <textarea className="textarea" value={allowlistText}
        onChange={e => setAllowlistText(e.target.value)} />
      {allowlistError && <div className="error" style={{ marginTop: 8 }}>{allowlistError}</div>}
      <div className="row" style={{ marginTop: 12, gap: 8 }}>
        <button className="btn btn-primary btn-sm" onClick={saveAllowlist}>Save allowlist</button>
        <button className="btn btn-sm" onClick={() => {
          setAllowlistText(JSON.stringify(DEFAULT_ALLOWLIST, null, 2));
          setAllowlistError(null);
        }}>Reset to defaults</button>
      </div>
    </div>
  );

  return (
    <>
      <style>{css}</style>
      <div className="app">
        <div className="topbar">
          <div className="topbar-title">Job application tracker</div>
          <button className={`nav-btn${view === "dashboard" || view === "email" ? " active" : ""}`}
            onClick={() => setView("dashboard")}>Dashboard</button>
          <button className={`nav-btn${view === "allowlist" ? " active" : ""}`}
            onClick={() => setView("allowlist")}>Allowlist</button>
        </div>
        <div className="main">
          {view === "allowlist" && <AllowlistView />}
          {(view === "dashboard") && <DashboardView />}
          {view === "email" && <EmailView />}
        </div>
      </div>
    </>
  );
}