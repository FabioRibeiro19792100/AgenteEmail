import { decryptText, encryptText } from "./security.js";
import {
  getGoogleConnection,
  nowIso,
  revokeGoogleConnectionRecord,
  updateGoogleConnection,
  upsertGoogleConnection
} from "./db.js";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.send"
].join(" ");

function requireEnv(name) {
  if (!process.env[name]) {
    throw new Error(`Missing env var: ${name}`);
  }
  return process.env[name];
}

export function buildGmailAuthUrl(state) {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", requireEnv("GOOGLE_CLIENT_ID"));
  url.searchParams.set("redirect_uri", requireEnv("GOOGLE_REDIRECT_URI_GMAIL"));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_GMAIL_SCOPES);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  return url.toString();
}

async function exchangeCodeForTokens(code, redirectUri) {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: requireEnv("GOOGLE_CLIENT_ID"),
      client_secret: requireEnv("GOOGLE_CLIENT_SECRET"),
      redirect_uri: redirectUri,
      grant_type: "authorization_code"
    })
  });

  if (!response.ok) {
    throw new Error(`Google token exchange failed: ${await response.text()}`);
  }

  return response.json();
}

async function refreshAccessToken(refreshToken) {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: requireEnv("GOOGLE_CLIENT_ID"),
      client_secret: requireEnv("GOOGLE_CLIENT_SECRET"),
      grant_type: "refresh_token"
    })
  });

  if (!response.ok) {
    throw new Error(`Google token refresh failed: ${await response.text()}`);
  }

  return response.json();
}

export async function fetchGoogleEmail(accessToken) {
  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { authorization: `Bearer ${accessToken}` }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Gmail profile: ${await response.text()}`);
  }

  const data = await response.json();
  return data.emailAddress;
}

async function getGmailConnectionRecord(userId) {
  return getGoogleConnection(userId, "gmail");
}

function hasScopes(connection, requiredScopes = []) {
  const granted = new Set((connection.scopes || "").split(/\s+/).filter(Boolean));
  return requiredScopes.every((scope) => granted.has(scope));
}

export async function getGmailConnectionStatus(userId) {
  const connection = await getGmailConnectionRecord(userId);
  if (!connection) return null;
  return {
    googleEmail: connection.google_email,
    scopes: (connection.scopes || "").split(/\s+/).filter(Boolean),
    operational: hasScopes(connection, [
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/gmail.send"
    ])
  };
}

export async function saveGmailConnection({ userId, code }) {
  const tokenData = await exchangeCodeForTokens(code, requireEnv("GOOGLE_REDIRECT_URI_GMAIL"));
  const googleEmail = await fetchGoogleEmail(tokenData.access_token);
  const now = nowIso();
  const existing = await getGoogleConnection(userId, "gmail");

  const record = {
    id: existing?.id || `gconn_${userId}`,
    user_id: userId,
    provider: "gmail",
    google_email: googleEmail,
    access_token_encrypted: encryptText(tokenData.access_token),
    refresh_token_encrypted: encryptText(
      tokenData.refresh_token ||
        (existing?.refresh_token_encrypted ? decryptText(existing.refresh_token_encrypted) : "")
    ),
    scopes: tokenData.scope || GOOGLE_GMAIL_SCOPES,
    expires_at: new Date(Date.now() + (tokenData.expires_in || 3600) * 1000).toISOString(),
    created_at: existing?.created_at || now,
    updated_at: now,
    revoked_at: null
  };

  return upsertGoogleConnection(record);
}

export async function getValidGmailAccessToken(userId, requiredScopes = []) {
  const connection = await getGmailConnectionRecord(userId);

  if (!connection) {
    throw new Error("Gmail not connected");
  }

  if (!hasScopes(connection, requiredScopes)) {
    throw new Error("Reconecte o Gmail para liberar permissoes operacionais desta cabine.");
  }

  const refreshToken = decryptText(connection.refresh_token_encrypted);
  if (!refreshToken) {
    throw new Error("Missing Google refresh token");
  }

  if (new Date(connection.expires_at).getTime() > Date.now() + 60_000) {
    return decryptText(connection.access_token_encrypted);
  }

  const refreshed = await refreshAccessToken(refreshToken);
  const current = await getGoogleConnection(userId, "gmail");
  if (!current) {
    throw new Error("Gmail not connected");
  }
  await updateGoogleConnection(userId, "gmail", {
    access_token_encrypted: encryptText(refreshed.access_token),
    expires_at: new Date(Date.now() + (refreshed.expires_in || 3600) * 1000).toISOString(),
    updated_at: nowIso()
  });
  return refreshed.access_token;
}

function decodeBody(payload) {
  const parts = payload.parts || [];
  const textPart = parts.find((part) => part.mimeType === "text/plain") || parts[0];
  const raw = textPart?.body?.data || payload.body?.data || "";
  return Buffer.from(raw, "base64url").toString("utf8");
}

function parseEmailAddress(value) {
  const match = value.match(/<([^>]+)>/);
  return match?.[1] || value.trim();
}

export async function listRecentEmails(userId, query = "", maxResults = 10) {
  const accessToken = await getValidGmailAccessToken(userId);
  const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  url.searchParams.set("maxResults", String(maxResults));
  url.searchParams.set("q", query || "newer_than:7d");
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}` }
  });

  if (!response.ok) {
    throw new Error(`Failed to list emails: ${await response.text()}`);
  }

  const data = await response.json();
  return data.messages || [];
}

export async function readEmail(userId, messageId) {
  const accessToken = await getValidGmailAccessToken(userId);
  const response = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
    { headers: { authorization: `Bearer ${accessToken}` } }
  );

  if (!response.ok) {
    throw new Error(`Failed to read email: ${await response.text()}`);
  }

  const data = await response.json();
  const headers = Object.fromEntries(
    (data.payload.headers || []).map((header) => [header.name.toLowerCase(), header.value])
  );
  return {
    id: data.id,
    threadId: data.threadId,
    labelIds: data.labelIds || [],
    subject: headers.subject || "(sem assunto)",
    from: headers.from || "",
    to: headers.to || "",
    cc: headers.cc || "",
    replyToEmail: parseEmailAddress(headers["reply-to"] || headers.from || ""),
    date: headers.date || "",
    snippet: data.snippet || "",
    bodyPreview: decodeBody(data.payload).slice(0, 1200),
    messageIdHeader: headers["message-id"] || "",
    references: headers.references || ""
  };
}

export async function searchEmails(userId, query = "", maxResults = 5) {
  const ids = await listRecentEmails(userId, query, Math.max(maxResults, 1));
  const emails = [];
  const failures = [];
  const selectedIds = ids.slice(0, maxResults);

  for (let index = 0; index < selectedIds.length; index += 8) {
    const batch = selectedIds.slice(index, index + 8);
    const results = await Promise.allSettled(batch.map((item) => readEmail(userId, item.id)));
    for (const result of results) {
      if (result.status === "fulfilled") {
        emails.push(result.value);
      } else {
        failures.push(result.reason);
      }
    }
  }

  if (!emails.length && failures.length) {
    throw failures[0];
  }

  return emails;
}

function buildRawEmail({ to, subject, body, inReplyTo, references }) {
  const headers = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit"
  ];
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headers.push(`References: ${references}`);
  const mime = `${headers.join("\r\n")}\r\n\r\n${body}`;
  return Buffer.from(mime, "utf8").toString("base64url");
}

async function gmailJsonRequest(userId, endpoint, { method = "GET", body, requiredScopes = [] } = {}) {
  const accessToken = await getValidGmailAccessToken(userId, requiredScopes);
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${endpoint}`, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (!response.ok) {
    throw new Error(`Gmail operation failed: ${await response.text()}`);
  }

  return response.status === 204 ? null : response.json();
}

async function getOrCreateLabelId(userId, labelName) {
  const label = labelName.trim();
  const labels = await gmailJsonRequest(userId, "labels", {
    requiredScopes: ["https://www.googleapis.com/auth/gmail.modify"]
  });
  const existing = (labels.labels || []).find(
    (item) => item.name.toLowerCase() === label.toLowerCase() || item.id === label
  );
  if (existing) return existing.id;
  const created = await gmailJsonRequest(userId, "labels", {
    method: "POST",
    requiredScopes: ["https://www.googleapis.com/auth/gmail.modify"],
    body: {
      name: label,
      labelListVisibility: "labelShow",
      messageListVisibility: "show"
    }
  });
  return created.id;
}

export async function createDraft(userId, threadId, content, options = {}) {
  const raw = buildRawEmail({
    to: options.to || options.replyToEmail || "destinatario@example.com",
    subject: options.subject || "(sem assunto)",
    body: content,
    inReplyTo: options.inReplyTo || "",
    references: options.references || ""
  });
  const data = await gmailJsonRequest(userId, "drafts", {
    method: "POST",
    requiredScopes: ["https://www.googleapis.com/auth/gmail.compose"],
    body: {
      message: {
        raw,
        threadId: threadId || undefined
      }
    }
  });
  return { draftId: data.id, messageId: data.message?.id || null };
}

export async function sendEmail(userId, draftId) {
  const data = await gmailJsonRequest(userId, "drafts/send", {
    method: "POST",
    requiredScopes: ["https://www.googleapis.com/auth/gmail.send"],
    body: { id: draftId }
  });
  return { messageId: data.id, threadId: data.threadId };
}

export async function sendPlainEmail(userId, { to, subject, body }) {
  const data = await gmailJsonRequest(userId, "messages/send", {
    method: "POST",
    requiredScopes: ["https://www.googleapis.com/auth/gmail.send"],
    body: {
      raw: buildRawEmail({ to, subject, body })
    }
  });
  return { messageId: data.id, threadId: data.threadId, to };
}

export async function replyEmail(userId, messageId, content) {
  const original = await readEmail(userId, messageId);
  const data = await gmailJsonRequest(userId, "messages/send", {
    method: "POST",
    requiredScopes: ["https://www.googleapis.com/auth/gmail.send"],
    body: {
      raw: buildRawEmail({
        to: original.replyToEmail,
        subject: original.subject.toLowerCase().startsWith("re:") ? original.subject : `Re: ${original.subject}`,
        body: content,
        inReplyTo: original.messageIdHeader,
        references: original.references || original.messageIdHeader
      }),
      threadId: original.threadId
    }
  });
  return { messageId: data.id, threadId: data.threadId, to: original.replyToEmail };
}

export async function archiveEmail(userId, messageId) {
  await gmailJsonRequest(userId, `messages/${messageId}/modify`, {
    method: "POST",
    requiredScopes: ["https://www.googleapis.com/auth/gmail.modify"],
    body: { removeLabelIds: ["INBOX"] }
  });
  return { messageId };
}

export async function applyLabel(userId, messageId, label) {
  const labelId = await getOrCreateLabelId(userId, label);
  await gmailJsonRequest(userId, `messages/${messageId}/modify`, {
    method: "POST",
    requiredScopes: ["https://www.googleapis.com/auth/gmail.modify"],
    body: { addLabelIds: [labelId] }
  });
  return { messageId, labelId, label };
}

export async function markAsRead(userId, messageId) {
  await gmailJsonRequest(userId, `messages/${messageId}/modify`, {
    method: "POST",
    requiredScopes: ["https://www.googleapis.com/auth/gmail.modify"],
    body: { removeLabelIds: ["UNREAD"] }
  });
  return { messageId };
}

export async function revokeGmailConnection(userId) {
  return Boolean(await revokeGoogleConnectionRecord(userId, "gmail"));
}
