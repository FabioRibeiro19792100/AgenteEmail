import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  acceptInviteAndCreateSession,
  appendAgentLog,
  consumeOAuthState,
  createOAuthState,
  createPendingAction,
  defaultWeeklyReportSettings,
  generateId,
  getPendingActionByIdForUser,
  getReadyStats,
  getSessionById,
  getUserById,
  getWeeklyReportSettings,
  importStudents,
  listPendingActionsForUser,
  listStudents,
  nowIso,
  updatePendingAction,
  upsertWeeklyReportSettings
} from "./db.js";
import { prepareReplyForEmail, refineDraftWithAI, runAgent, runInsightAnalysis } from "./agent.js";
import { getConfig, loadEnv, validateConfig } from "./config.js";
import {
  applyLabel,
  archiveEmail,
  buildGmailAuthUrl,
  createDraft,
  getGmailConnectionStatus,
  markAsRead,
  readEmail,
  searchEmails,
  replyEmail,
  revokeGmailConnection,
  saveGmailConnection,
  sendEmail
} from "./google.js";
import { createSignedState, verifySignedState } from "./security.js";

loadEnv();
const config = getConfig();
let configIssues = [];
try {
  configIssues = validateConfig();
} catch (error) {
  configIssues = error.message.replace(/^Configuration error:\s*/, "").split("; ");
  if (!config.isProduction) {
    console.warn(error.message);
  }
}

const publicDir = path.join(process.cwd(), "public");

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function sendRedirect(res, location) {
  res.writeHead(302, { location });
  res.end();
}

function sendFile(res, filePath, contentType = "text/html; charset=utf-8") {
  res.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
  res.end(fs.readFileSync(filePath));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function parseCookies(req) {
  const raw = req.headers.cookie || "";
  return Object.fromEntries(
    raw
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const index = item.indexOf("=");
        return [item.slice(0, index), decodeURIComponent(item.slice(index + 1))];
      })
  );
}

function requestOrigin(req) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto = Array.isArray(forwardedProto)
    ? forwardedProto[0]
    : forwardedProto?.split(",")[0]?.trim() || (config.isProduction ? "https" : "http");
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return host ? `${proto}://${host}` : config.appBaseUrl;
}

function setCookie(res, name, value) {
  const secure = config.isProduction ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${name}=${encodeURIComponent(value)}; HttpOnly; Path=/; SameSite=Lax${secure}`
  );
}

function clearCookie(res, name) {
  const secure = config.isProduction ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${name}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${secure}`);
}

async function getSessionUser(req) {
  const cookies = parseCookies(req);
  if (!cookies.session_id) return null;
  const session = await getSessionById(cookies.session_id);
  if (!session) return null;
  return getUserById(session.user_id);
}

async function gmailConnectionSummary(userId) {
  const gmail = await getGmailConnectionStatus(userId);
  return {
    gmailConnected: Boolean(gmail),
    googleEmail: gmail?.googleEmail || null,
    scopes: gmail?.scopes || [],
    operationalReady: gmail?.operational || false
  };
}

async function logAction({ userId, turmaId, actionType, toolName, status }) {
  await appendAgentLog({
    id: generateId("log"),
    user_id: userId,
    turma_id: turmaId,
    action_type: actionType,
    tool_name: toolName,
    status,
    created_at: nowIso()
  });
}

async function ensureAuth(req, res) {
  const user = await getSessionUser(req);
  if (!user) {
    sendJson(res, 401, { error: "Sessao invalida ou expirada." });
    return null;
  }
  return user;
}

const adminSessionTtlMs = 12 * 60 * 60 * 1000;

function adminPassword() {
  if (!config.isProduction) return process.env.ADMIN_PASSWORD || "admin";
  const password = process.env.ADMIN_PASSWORD || "";
  return password.length >= 12 ? password : "";
}

function isAdminRole(user) {
  const role = String(user?.papel || "").trim().toLowerCase();
  return role === "admin" || role === "administrador";
}

function safeCompare(left, right) {
  const leftHash = crypto.createHash("sha256").update(String(left || "")).digest();
  const rightHash = crypto.createHash("sha256").update(String(right || "")).digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

function createAdminSessionToken() {
  return createSignedState({
    type: "admin_session",
    createdAt: Date.now(),
    nonce: generateId("adm")
  });
}

function hasValidAdminSession(req) {
  const cookies = parseCookies(req);
  if (!cookies.admin_session) return false;
  try {
    const payload = verifySignedState(cookies.admin_session);
    return (
      payload.type === "admin_session" &&
      Number.isFinite(Number(payload.createdAt)) &&
      Date.now() - Number(payload.createdAt) <= adminSessionTtlMs
    );
  } catch {
    return false;
  }
}

async function isAdminRequest(req) {
  if (hasValidAdminSession(req)) return true;
  try {
    const user = await getSessionUser(req);
    return isAdminRole(user);
  } catch {
    return false;
  }
}

async function ensureAdmin(req, res, { redirectTo } = {}) {
  if (await isAdminRequest(req)) return true;
  if (redirectTo) {
    sendRedirect(res, `/admin/login?next=${encodeURIComponent(redirectTo)}`);
    return false;
  }
  sendJson(res, 403, { error: "Acesso admin necessario." });
  return false;
}

function permissionModel() {
  return {
    confirmationRequired: true,
    level1: [
      "ler e-mails",
      "pesquisar e-mails",
      "resumir e-mails",
      "identificar padroes",
      "classificar mensagens",
      "detectar pendencias",
      "gerar relatorios",
      "responder perguntas sobre a caixa postal"
    ],
    level2: [
      "criar rascunhos",
      "sugerir respostas",
      "gerar respostas em lote",
      "preparar encaminhamentos",
      "preparar classificacoes",
      "preparar acoes futuras"
    ],
    level3: [
      "enviar e-mails",
      "responder e-mails",
      "encaminhar e-mails",
      "aplicar labels",
      "remover labels",
      "marcar como lido",
      "marcar como nao lido",
      "arquivar mensagens",
      "mover mensagens entre categorias"
    ]
  };
}

function routePage(urlPath) {
  const map = {
    "/": "index.html",
    "/admin/login": "admin-login.html",
    "/admin/import": "admin-import.html",
    "/admin/students": "admin-students.html",
    "/composer": "composer.html",
    "/connections": "connections.html",
    "/availability": "availability.html"
  };
  return map[urlPath];
}

function inviteLink(req, inviteId) {
  return `${requestOrigin(req)}/invite/${inviteId}`;
}

function parseImportRows(rawInput) {
  const lines = rawInput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.map((line) => {
    const [nome, turma, email, papel, instituicao] = line.split(",").map((item) => item?.trim() || "");
    return {
      nome,
      turma: turma || "Turma Padrao",
      email,
      papel,
      instituicao
    };
  });
}

function serializePendingAction(action) {
  return {
    id: action.id,
    toolName: action.tool_name,
    permissionLevel: action.permission_level,
    title: action.title,
    summary: action.summary,
    confirmLabel: action.confirm_label,
    editable: action.editable,
    previewText: action.preview_text,
    createdAt: action.created_at
  };
}

const weeklyReportDays = new Set([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday"
]);

function serializeWeeklyReportSettings(settings) {
  return {
    whatsappNumber: settings.whatsapp_number || "",
    scheduleDay: settings.schedule_day || "friday",
    scheduleTime: settings.schedule_time || "09:00",
    timezone: settings.timezone || "America/Sao_Paulo",
    timezoneLabel: settings.timezone_label || "BRT",
    enabled: settings.enabled !== false,
    updatedAt: settings.updated_at || null
  };
}

function normalizeWeeklyReportSettings(body = {}) {
  const rawDay = String(body.scheduleDay || body.schedule_day || "friday").trim().toLowerCase();
  const scheduleDay = weeklyReportDays.has(rawDay) ? rawDay : "friday";
  const rawTime = String(body.scheduleTime || body.schedule_time || "09:00").trim();
  const timeMatch = rawTime.match(/^(\d{1,2}):(\d{2})$/);
  let scheduleTime = "09:00";
  if (timeMatch) {
    const hour = Number(timeMatch[1]);
    const minute = Number(timeMatch[2]);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      scheduleTime = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    }
  }

  return {
    whatsapp_number: String(body.whatsappNumber || body.whatsapp_number || "")
      .replace(/[^\d+\s().-]/g, "")
      .trim(),
    schedule_day: scheduleDay,
    schedule_time: scheduleTime,
    timezone: "America/Sao_Paulo",
    timezone_label: "BRT",
    enabled: body.enabled !== false
  };
}

async function getPendingActionsForUser(userId) {
  return listPendingActionsForUser(userId);
}

async function persistPendingAction(user, operation) {
  const record = {
    id: generateId("act"),
    user_id: user.user_id,
    turma_id: user.turma_id,
    tool_name: operation.toolName,
    permission_level: operation.permissionLevel,
    title: operation.title,
    summary: operation.summary,
    confirm_label: operation.confirmLabel,
    editable: Boolean(operation.editable),
    preview_text: operation.previewText,
    payload: operation.payload,
    status: "pending_confirmation",
    created_at: nowIso(),
    updated_at: nowIso(),
    executed_at: null,
    error_message: null,
    execution_result: null
  };
  const created = await createPendingAction(record);
  return serializePendingAction(created);
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function parseSenderName(from = "") {
  const withoutEmail = String(from).replace(/<[^>]+>/g, "").replaceAll('"', "").trim();
  if (withoutEmail) return withoutEmail;
  return parseSenderEmail(from).split("@")[0] || "Remetente";
}

function parseSenderEmail(from = "") {
  const match = String(from).match(/<([^>]+)>/);
  return match?.[1] || String(from).trim();
}

function senderInitials(name) {
  const words = String(name || "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);
  const initials = words.map((word) => word[0]).join("").toUpperCase();
  return initials || "CI";
}

function formatEmailDate(dateValue) {
  const parsed = new Date(dateValue);
  if (Number.isNaN(parsed.getTime())) {
    return { date: dateValue || "", time: "" };
  }
  return {
    date: parsed.toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" }),
    time: parsed.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
  };
}

function classifyInboxEmail(email) {
  const text = normalizeText(`${email.from} ${email.subject} ${email.snippet} ${email.bodyPreview}`);
  if (
    text.includes("canceled event") ||
    text.includes("cancelled event") ||
    text.includes("evento cancelado") ||
    text.includes("agenda") ||
    text.includes("reuniao") ||
    text.includes("meeting") ||
    text.includes("calendar") ||
    text.includes("horario") ||
    text.includes("call")
  ) {
    return "Scheduling";
  }
  if (
    text.includes("newsletter") ||
    text.includes("unsubscribe") ||
    text.includes("no-reply") ||
    text.includes("noreply") ||
    text.includes("promocao") ||
    text.includes("security alert") ||
    text.includes("alerta de seguranca") ||
    text.includes("accounts.google.com")
  ) {
    return "Newsletters";
  }
  return "Priority";
}

function scoreInboxEmail(email, category) {
  const text = normalizeText(`${email.from} ${email.subject} ${email.snippet} ${email.bodyPreview}`);
  let score = category === "Priority" ? 20 : category === "Scheduling" ? 10 : -4;

  if (
    text.includes("cliente") ||
    text.includes("proposta") ||
    text.includes("contrato") ||
    text.includes("orcamento") ||
    text.includes("follow-up") ||
    text.includes("pagamento")
  ) {
    score += 18;
  }

  if (
    text.includes("responder") ||
    text.includes("retorno") ||
    text.includes("aprovar") ||
    text.includes("confirmar") ||
    text.includes("urgente")
  ) {
    score += 10;
  }

  if (
    text.includes("no-reply") ||
    text.includes("noreply") ||
    text.includes("newsletter") ||
    text.includes("unsubscribe")
  ) {
    score -= 12;
  }

  if (
    text.includes("canceled event") ||
    text.includes("cancelled event") ||
    text.includes("evento cancelado")
  ) {
    score -= 8;
  }

  const time = new Date(email.date).getTime();
  if (!Number.isNaN(time)) {
    const daysOld = (Date.now() - time) / 86_400_000;
    if (daysOld <= 2) score += 4;
    else if (daysOld <= 7) score += 3;
    else if (daysOld <= 30) score += 2;
  }

  return score;
}

function hasAny(text, terms) {
  return terms.some((term) => text.includes(term));
}

function detectValueSignal(email, category, priorityScore) {
  const text = normalizeText(`${email.from} ${email.subject} ${email.snippet} ${email.bodyPreview}`);
  const reasons = [];
  let score = priorityScore;
  let signal = "Triagem";
  let valueType = "Operacional";
  let urgency = "media";
  let nextStep = "Abrir, entender o contexto e decidir se precisa de resposta.";
  let risk = "Pode consumir atencao sem gerar proximo passo claro.";
  let actionKind = "reply";

  const commercialTerms = [
    "cliente",
    "lead",
    "proposta",
    "proposal",
    "contrato",
    "contract",
    "orcamento",
    "budget",
    "pagamento",
    "invoice",
    "preco",
    "valor",
    "comercial",
    "venda",
    "compra",
    "negociacao",
    "deal"
  ];
  const decisionTerms = [
    "aprovar",
    "aprovacao",
    "validar",
    "validacao",
    "decidir",
    "decisao",
    "autorizar",
    "confirmar",
    "confirmacao",
    "retorno",
    "responder",
    "pendente"
  ];
  const urgencyTerms = ["urgente", "hoje", "deadline", "prazo", "asap", "prioridade", "imediato"];
  const schedulingTerms = [
    "agenda",
    "reuniao",
    "meeting",
    "call",
    "horario",
    "convite",
    "evento",
    "calendar",
    "canceled event",
    "cancelled event"
  ];
  const noiseTerms = [
    "no-reply",
    "noreply",
    "newsletter",
    "unsubscribe",
    "alerta de seguranca",
    "security alert",
    "accounts.google.com",
    "promocao"
  ];

  const commercial = hasAny(text, commercialTerms);
  const decision = hasAny(text, decisionTerms);
  const urgent = hasAny(text, urgencyTerms);
  const scheduling = category === "Scheduling" || hasAny(text, schedulingTerms);
  const noise = category === "Newsletters" || hasAny(text, noiseTerms);

  if (commercial) {
    score += 34;
    reasons.push("sinal comercial");
  }
  if (decision) {
    score += 22;
    reasons.push("pede retorno ou decisao");
  }
  if (urgent) {
    score += 18;
    reasons.push("tem linguagem de urgencia");
  }
  if (scheduling) {
    score += 8;
    reasons.push("envolve agenda ou compromisso");
  }
  if (noise) {
    score -= 42;
    reasons.push("parece automatico ou informativo");
  }

  if (noise && !commercial && !decision) {
    signal = "Ruido filtravel";
    valueType = "Limpeza";
    urgency = "baixa";
    nextStep = "Arquivar ou ignorar, salvo se voce estiver procurando exatamente esse assunto.";
    risk = "Baixo risco. O valor aqui e reduzir distracao.";
    actionKind = "archive";
  } else if (commercial) {
    signal = "Oportunidade comercial";
    valueType = "Receita";
    urgency = urgent || decision ? "alta" : "media";
    nextStep = decision
      ? "Preparar resposta objetiva para destravar o proximo passo."
      : "Preparar follow-up e checar se existe uma proxima acao comercial.";
    risk = "Perder timing, deixar cliente sem retorno ou esfriar uma oportunidade.";
  } else if (decision) {
    signal = "Decisao pendente";
    valueType = "Execucao";
    urgency = urgent ? "alta" : "media";
    nextStep = "Preparar resposta com decisao, pergunta de clarificacao ou proximo passo.";
    risk = "Manter alguem bloqueado esperando sua resposta.";
  } else if (scheduling) {
    signal = "Agenda";
    valueType = "Tempo";
    urgency = urgent ? "alta" : "media";
    nextStep = "Confirmar, reagendar ou responder com disponibilidade.";
    risk = "Perder alinhamento de horario ou deixar compromisso solto.";
  }

  if (!reasons.length) reasons.push("mensagem humana possivelmente relevante");

  return {
    signal,
    valueType,
    urgency,
    score,
    reasons: reasons.slice(0, 3),
    nextStep,
    risk,
    actionKind
  };
}

function summarizeInboxEmail(email, category) {
  const content = String(email.bodyPreview || email.snippet || "").replace(/\s+/g, " ").trim();
  const clipped = content.slice(0, 190);
  if (category === "Scheduling") {
    return clipped || "Possivel conversa de agenda ou alinhamento de horario.";
  }
  if (category === "Newsletters") {
    return clipped || "Mensagem informativa ou automatizada, com baixa prioridade operacional.";
  }
  return clipped || "Mensagem potencialmente relevante para acompanhamento.";
}

function buildCognitiveAnalysis(email, category) {
  const subject = email.subject || "sem assunto";
  if (category === "Scheduling") {
    return {
      keyAction: "Verificar disponibilidade e preparar resposta de agenda, se fizer sentido.",
      impact: "Pode destravar reuniao, alinhamento ou proximo passo operacional.",
      tags: ["agenda", "resposta", "tempo"]
    };
  }
  if (category === "Newsletters") {
    return {
      keyAction: "Ler apenas se houver contexto direto; caso contrario, considerar arquivar.",
      impact: "Baixo risco imediato. Bom candidato a limpeza de caixa.",
      tags: ["informativo", "baixa prioridade"]
    };
  }
  return {
    keyAction: `Avaliar se "${subject}" pede follow-up, resposta ou classificacao.`,
    impact: "Pode conter interacao comercial, pendencia ou contexto que merece acao.",
    tags: ["prioridade", "analise", "follow-up"]
  };
}

function serializeInboxEmail(email) {
  const sender = parseSenderName(email.from);
  const category = classifyInboxEmail(email);
  const dateParts = formatEmailDate(email.date);
  const priorityScore = scoreInboxEmail(email, category);
  const valueSignal = detectValueSignal(email, category, priorityScore);
  return {
    id: email.id,
    threadId: email.threadId,
    sender,
    senderEmail: parseSenderEmail(email.from),
    senderInitials: senderInitials(sender),
    subject: email.subject,
    time: dateParts.time,
    date: dateParts.date,
    rawDate: email.date,
    category,
    priorityScore,
    businessScore: valueSignal.score,
    valueSignal,
    unread: Array.isArray(email.labelIds) ? email.labelIds.includes("UNREAD") : false,
    content: email.bodyPreview || email.snippet || "",
    snippet: email.snippet || "",
    aiSummary: summarizeInboxEmail(email, category),
    cognitiveAnalysis: buildCognitiveAnalysis(email, category),
    attachments: [],
    history: []
  };
}

function buildInboxMetrics(emails) {
  const priority = emails.filter((email) => email.category === "Priority").length;
  const scheduling = emails.filter((email) => email.category === "Scheduling").length;
  const newsletters = emails.filter((email) => email.category === "Newsletters").length;
  const unread = emails.filter((email) => email.unread).length;
  const actionable = emails.filter((email) => email.valueSignal?.actionKind !== "archive").length;
  const commercial = emails.filter((email) => email.valueSignal?.valueType === "Receita").length;
  const highUrgency = emails.filter((email) => email.valueSignal?.urgency === "alta").length;
  const noise = emails.filter((email) => email.valueSignal?.actionKind === "archive").length;
  return {
    emailsProcessed: emails.length,
    dailyTargetPct: Math.min(100, Math.max(18, emails.length * 8)),
    timeSavedHrs: Number((emails.length * 0.08 + priority * 0.12).toFixed(1)),
    pendingCount: priority + scheduling,
    actionableCount: actionable,
    commercialCount: commercial,
    highUrgencyCount: highUrgency,
    noiseCount: noise,
    unreadCount: unread,
    priorityCount: priority,
    schedulingCount: scheduling,
    newsletterCount: newsletters,
    pendingCritical: priority > 0
  };
}

function inboxQueryFromUrl(url) {
  const explicit = url.searchParams.get("q")?.trim();
  if (explicit) return explicit;
  const timeframe = url.searchParams.get("timeframe") || "30d";
  const daysMatch = String(timeframe).match(/^(\d{1,3})d$/);
  if (daysMatch) return `newer_than:${Math.min(365, Math.max(1, Number(daysMatch[1])))}d -category:social`;
  if (timeframe === "24h") return "newer_than:1d -category:social";
  if (timeframe === "90d") return "newer_than:90d -category:social";
  return "newer_than:30d -category:social";
}

function clampInboxLimit(value) {
  const parsed = Number(value || 60);
  if (!Number.isFinite(parsed)) return 60;
  return Math.min(200, Math.max(1, parsed));
}

function archiveOperationFromEmail(email) {
  return {
    toolName: "archive_email",
    permissionLevel: 3,
    title: "Arquivar mensagem",
    summary: `Arquivar "${email.subject || "mensagem"}"`,
    confirmLabel: "Arquivar",
    editable: false,
    previewText: `Mensagem alvo: ${email.subject || "sem assunto"}\nRemetente: ${email.from || ""}\nData: ${email.date || ""}`,
    payload: { messageId: email.id }
  };
}

function markAsReadOperationFromEmail(email) {
  return {
    toolName: "mark_as_read",
    permissionLevel: 3,
    title: "Marcar como lido",
    summary: `Marcar "${email.subject || "mensagem"}" como lido`,
    confirmLabel: "Marcar como lido",
    editable: false,
    previewText: `Mensagem alvo: ${email.subject || "sem assunto"}\nRemetente: ${email.from || ""}\nData: ${email.date || ""}`,
    payload: { messageId: email.id }
  };
}

async function executePendingAction(user, action, body = {}) {
  const payload = { ...(action.payload || {}) };
  if (action.editable && typeof body.editedContent === "string" && body.editedContent.trim()) {
    if (action.tool_name === "apply_label") {
      payload.label = body.editedContent.trim();
    } else {
      payload.content = body.editedContent.trim();
    }
  }

  switch (action.tool_name) {
    case "create_draft":
      return createDraft(user.user_id, payload.threadId, payload.content, {
        to: payload.to,
        subject: payload.subject,
        references: payload.references,
        inReplyTo: payload.inReplyTo
      });
    case "send_email":
      return sendEmail(user.user_id, payload.draftId);
    case "reply_email":
      return replyEmail(user.user_id, payload.messageId, payload.content);
    case "archive_email":
      return archiveEmail(user.user_id, payload.messageId);
    case "apply_label":
      return applyLabel(user.user_id, payload.messageId, payload.label);
    case "mark_as_read":
      return markAsRead(user.user_id, payload.messageId);
    default:
      throw new Error("Acao pendente nao suportada.");
  }
}

async function router(req, res) {
  const url = new URL(req.url, requestOrigin(req));

  if (req.method === "GET" && url.pathname === "/healthz") {
    return sendJson(res, 200, { ok: true, status: "healthy", timestamp: nowIso() });
  }

  if (req.method === "GET" && url.pathname === "/readyz") {
    if (configIssues.length) {
      return sendJson(res, 503, {
        ok: false,
        status: "misconfigured",
        issues: configIssues,
        timestamp: nowIso()
      });
    }
    const stats = await getReadyStats();
    return sendJson(res, 200, {
      ok: true,
      status: "ready",
      userCount: stats.userCount,
      timestamp: nowIso()
    });
  }

  if (req.method === "GET" && url.pathname === "/favicon.ico") {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === "GET" && routePage(url.pathname)) {
    if (url.pathname.startsWith("/admin/") && url.pathname !== "/admin/login") {
      if (!(await ensureAdmin(req, res, { redirectTo: url.pathname }))) return;
    }
    if (url.pathname === "/admin/login" && (await isAdminRequest(req))) {
      return sendRedirect(res, "/admin/import");
    }
    return sendFile(res, path.join(publicDir, routePage(url.pathname)));
  }

  if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
    const assetPath = path.join(publicDir, url.pathname.replace("/assets/", "assets/"));
    const ext = path.extname(assetPath);
    const contentType = ext === ".css" ? "text/css; charset=utf-8" : "application/javascript; charset=utf-8";
    return sendFile(res, assetPath, contentType);
  }

  if (req.method === "GET" && url.pathname.startsWith("/invite/")) {
    return sendFile(res, path.join(publicDir, "invite.html"));
  }

  if (req.method === "GET" && url.pathname === "/api/invite/validate") {
    const inviteId = url.searchParams.get("inviteId");
    const sessionId = crypto.randomBytes(16).toString("hex");
    const invite = await acceptInviteAndCreateSession(inviteId, sessionId);
    if (!invite) return sendJson(res, 404, { error: "Invite nao encontrado." });
    const user = await getUserById(invite.user_id);
    setCookie(res, "session_id", sessionId);
    return sendJson(res, 200, {
      ok: true,
      redirectTo: "/composer",
      user: { nome: user.nome, turma_id: user.turma_id }
    });
  }

  if (req.method === "GET" && url.pathname === "/api/session") {
    const user = await getSessionUser(req);
    if (!user) return sendJson(res, 200, { authenticated: false });
    return sendJson(res, 200, {
      authenticated: true,
      user,
      permissions: permissionModel(),
      connections: await gmailConnectionSummary(user.user_id),
      pendingActions: (await getPendingActionsForUser(user.user_id)).map(serializePendingAction)
    });
  }

  if (req.method === "GET" && url.pathname === "/api/weekly-report/settings") {
    const user = await ensureAuth(req, res);
    if (!user) return;
    try {
      const settings = await getWeeklyReportSettings(user.user_id);
      return sendJson(res, 200, {
        ok: true,
        storageReady: true,
        settings: serializeWeeklyReportSettings(settings)
      });
    } catch (error) {
      return sendJson(res, 200, {
        ok: true,
        storageReady: false,
        settings: serializeWeeklyReportSettings(defaultWeeklyReportSettings(user.user_id)),
        error: "Atualize o schema do Supabase para salvar a agenda semanal."
      });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/weekly-report/settings") {
    const user = await ensureAuth(req, res);
    if (!user) return;
    const body = await readBody(req);
    const patch = normalizeWeeklyReportSettings(body);
    if (patch.whatsapp_number && patch.whatsapp_number.replace(/\D/g, "").length < 10) {
      return sendJson(res, 400, { error: "Informe um WhatsApp com DDI e DDD." });
    }
    try {
      const settings = await upsertWeeklyReportSettings(user.user_id, patch);
      await logAction({
        userId: user.user_id,
        turmaId: user.turma_id,
        actionType: "weekly_report_settings",
        toolName: "save_weekly_report_settings",
        status: "success"
      });
      return sendJson(res, 200, {
        ok: true,
        storageReady: true,
        settings: serializeWeeklyReportSettings(settings)
      });
    } catch (error) {
      return sendJson(res, 400, {
        error: "Nao foi possivel salvar. Atualize o schema do Supabase e tente novamente.",
        detail: config.isProduction ? undefined : error.message
      });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/admin/session") {
    return sendJson(res, 200, { admin: await isAdminRequest(req) });
  }

  if (req.method === "POST" && url.pathname === "/api/admin/login") {
    const body = await readBody(req);
    const expectedPassword = adminPassword();
    if (!expectedPassword) {
      return sendJson(res, 500, {
        error: "ADMIN_PASSWORD ausente ou curta demais no ambiente de producao."
      });
    }
    if (!safeCompare(body.password, expectedPassword)) {
      return sendJson(res, 401, { error: "Senha administrativa invalida." });
    }
    setCookie(res, "admin_session", createAdminSessionToken());
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/admin/logout") {
    clearCookie(res, "admin_session");
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/api/inbox/recent") {
    const user = await ensureAuth(req, res);
    if (!user) return;
    const query = inboxQueryFromUrl(url);
    const maxResults = clampInboxLimit(url.searchParams.get("max"));
    try {
      const rawEmails = await searchEmails(user.user_id, query, maxResults);
      const emails = rawEmails
        .map(serializeInboxEmail)
        .sort((a, b) => {
          const scoreDiff = (b.businessScore ?? b.priorityScore) - (a.businessScore ?? a.priorityScore);
          if (scoreDiff !== 0) return scoreDiff;
          return new Date(b.rawDate).getTime() - new Date(a.rawDate).getTime();
        });
      return sendJson(res, 200, {
        ok: true,
        query,
        emails,
        metrics: buildInboxMetrics(emails),
        generatedAt: nowIso()
      });
    } catch (error) {
      return sendJson(res, 400, {
        error: error.message.includes("Gmail not connected")
          ? "Conecte seu Gmail para carregar a Smart Inbox."
          : error.message
      });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/inbox/actions/archive") {
    const user = await ensureAuth(req, res);
    if (!user) return;
    const body = await readBody(req);
    if (!body.messageId) return sendJson(res, 400, { error: "messageId obrigatorio." });
    try {
      const email = await readEmail(user.user_id, body.messageId);
      const pendingAction = await persistPendingAction(user, archiveOperationFromEmail(email));
      return sendJson(res, 200, {
        ok: true,
        message: "Acao preparada. Confirme para arquivar.",
        pendingAction
      });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/inbox/actions/mark-read") {
    const user = await ensureAuth(req, res);
    if (!user) return;
    const body = await readBody(req);
    if (!body.messageId) return sendJson(res, 400, { error: "messageId obrigatorio." });
    try {
      const email = await readEmail(user.user_id, body.messageId);
      const pendingAction = await persistPendingAction(user, markAsReadOperationFromEmail(email));
      return sendJson(res, 200, {
        ok: true,
        message: "Acao preparada. Confirme para marcar como lido.",
        pendingAction
      });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/composer/prepare-reply") {
    const user = await ensureAuth(req, res);
    if (!user) return;
    const body = await readBody(req);
    if (!body.messageId) return sendJson(res, 400, { error: "messageId obrigatorio." });
    try {
      const result = await prepareReplyForEmail(user.user_id, body.messageId, body.instruction || "");
      const pendingAction = await persistPendingAction(user, result.operation);
      await logAction({
        userId: user.user_id,
        turmaId: user.turma_id,
        actionType: "prepare_reply",
        toolName: result.toolName,
        status: "success"
      });
      return sendJson(res, 200, {
        answer: result.answer,
        toolName: result.toolName,
        pendingAction
      });
    } catch (error) {
      await logAction({
        userId: user.user_id,
        turmaId: user.turma_id,
        actionType: "prepare_reply",
        toolName: "prepare_reply_error",
        status: "error"
      });
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/composer/refine") {
    const user = await ensureAuth(req, res);
    if (!user) return;
    const body = await readBody(req);
    if (!body.draft) return sendJson(res, 400, { error: "Rascunho vazio." });
    try {
      const refinedDraft = await refineDraftWithAI(body.draft, body.action || "smart_proof", body.tone || "");
      return sendJson(res, 200, { ok: true, refinedDraft });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/insights/analyze") {
    const user = await ensureAuth(req, res);
    if (!user) return;
    const body = await readBody(req);
    try {
      const insight = await runInsightAnalysis(user.user_id, {
        question: body.question || "",
        timeframe: body.timeframe || "30d",
        query: body.query || "",
        maxResults: body.maxResults || 40
      });
      await logAction({
        userId: user.user_id,
        turmaId: user.turma_id,
        actionType: "insight_analysis",
        toolName: "gmail_insight_analysis",
        status: "success"
      });
      return sendJson(res, 200, { ok: true, insight });
    } catch (error) {
      await logAction({
        userId: user.user_id,
        turmaId: user.turma_id,
        actionType: "insight_analysis",
        toolName: "gmail_insight_analysis",
        status: "error"
      });
      return sendJson(res, 400, {
        error: error.message.includes("Gmail not connected")
          ? "Conecte seu Gmail para tirar insights reais da caixa."
          : error.message
      });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/admin/import-students") {
    if (!(await ensureAdmin(req, res))) return;
    const body = await readBody(req);
    const rows = Array.isArray(body.students) ? body.students : parseImportRows(body.raw || "");
    const createdRows = await importStudents(rows);
    return sendJson(res, 200, {
      ok: true,
      created: createdRows.map((item) => ({
        nome: item.nome,
        turma: item.turma,
        link: inviteLink(req, item.invite_id)
      }))
    });
  }

  if (req.method === "GET" && url.pathname === "/api/admin/students") {
    if (!(await ensureAdmin(req, res))) return;
    const students = (await listStudents()).map((item) => ({
      ...item,
      invite_link: item.invite_id ? inviteLink(req, item.invite_id) : ""
    }));
    return sendJson(res, 200, { students });
  }

  if (req.method === "GET" && url.pathname === "/api/google/gmail/start") {
    const user = await ensureAuth(req, res);
    if (!user) return;
    try {
      const statePayload = { userId: user.user_id, provider: "gmail", nonce: generateId("state") };
      await createOAuthState({
        nonce: statePayload.nonce,
        user_id: user.user_id,
        provider: "gmail",
        created_at: nowIso()
      });
      return sendRedirect(res, buildGmailAuthUrl(createSignedState(statePayload)));
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/google/gmail/callback") {
    try {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const payload = verifySignedState(state);
      const stateExists = await consumeOAuthState(payload.nonce);
      if (!stateExists) throw new Error("OAuth state expired");
      await saveGmailConnection({ userId: payload.userId, code });
      return sendRedirect(res, "/composer?gmail=connected");
    } catch (error) {
      return sendRedirect(res, `/connections?error=${encodeURIComponent(error.message)}`);
    }
  }

  if (req.method === "POST" && url.pathname === "/api/google/gmail/revoke") {
    const user = await ensureAuth(req, res);
    if (!user) return;
    const revoked = await revokeGmailConnection(user.user_id);
    return sendJson(res, 200, { ok: revoked });
  }

  if (req.method === "POST" && url.pathname === "/api/agent/message") {
    const user = await ensureAuth(req, res);
    if (!user) return;
    const body = await readBody(req);
    try {
      const result = await runAgent(user.user_id, body.message || "");
      const operations = Array.isArray(result.operations)
        ? result.operations
        : result.operation
          ? [result.operation]
          : [];
      const pendingActions = [];
      for (const operation of operations) {
        pendingActions.push(await persistPendingAction(user, operation));
      }
      const pendingAction = pendingActions[0] || null;
      await logAction({
        userId: user.user_id,
        turmaId: user.turma_id,
        actionType: "agent_message",
        toolName: result.toolName,
        status: "success"
      });
      return sendJson(res, 200, {
        answer: result.answer,
        toolName: result.toolName,
        emailCount: result.emailCount || 0,
        queryPlan: result.queryPlan || [],
        sources: result.sources || [],
        pendingAction,
        pendingActions
      });
    } catch (error) {
      await logAction({
        userId: user.user_id,
        turmaId: user.turma_id,
        actionType: "agent_message",
        toolName: "agent_error",
        status: "error"
      });
      return sendJson(res, 400, {
        error: error.message.includes("Gmail not connected")
          ? "Conecte seu Gmail antes de usar o composer."
          : error.message
      });
    }
  }

  const actionMatch =
    req.method === "POST"
      ? url.pathname.match(/^\/api\/agent\/actions\/([^/]+)\/(confirm|cancel)$/)
      : null;

  if (actionMatch) {
    const [, actionId, actionCommand] = actionMatch;
    const user = await ensureAuth(req, res);
    if (!user) return;
    const action = await getPendingActionByIdForUser(actionId, user.user_id);

    if (!action) {
      return sendJson(res, 404, { error: "Acao pendente nao encontrada." });
    }

    if (action.status !== "pending_confirmation") {
      return sendJson(res, 400, { error: "Essa acao ja foi resolvida." });
    }

    if (actionCommand === "cancel") {
      await updatePendingAction(action.id, {
        status: "cancelled",
        updated_at: nowIso()
      });
      await logAction({
        userId: user.user_id,
        turmaId: user.turma_id,
        actionType: "pending_action_cancel",
        toolName: action.tool_name,
        status: "cancelled"
      });
      return sendJson(res, 200, { ok: true });
    }

    const body = await readBody(req);
    try {
      const result = await executePendingAction(user, action, body);
      const patch = {
        status: "executed",
        updated_at: nowIso(),
        executed_at: nowIso(),
        execution_result: result
      };
      if (action.editable && typeof body.editedContent === "string" && body.editedContent.trim()) {
        if (action.tool_name === "apply_label") {
          action.payload.label = body.editedContent.trim();
        } else {
          action.payload.content = body.editedContent.trim();
        }
        patch.preview_text = body.editedContent.trim();
        patch.payload = action.payload;
      }
      await updatePendingAction(action.id, patch);
      await logAction({
        userId: user.user_id,
        turmaId: user.turma_id,
        actionType: "pending_action_execute",
        toolName: action.tool_name,
        status: "success"
      });
      return sendJson(res, 200, {
        ok: true,
        result,
        message:
          action.tool_name === "create_draft"
            ? "Rascunho criado com sucesso."
            : "Acao executada com sucesso mediante a sua confirmacao."
      });
    } catch (error) {
      await updatePendingAction(action.id, {
        status: "error",
        updated_at: nowIso(),
        error_message: error.message
      });
      await logAction({
        userId: user.user_id,
        turmaId: user.turma_id,
        actionType: "pending_action_execute",
        toolName: action.tool_name,
        status: "error"
      });
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/calendar/freebusy") {
    return sendJson(res, 501, { error: "Calendar preparado, mas bloqueado nesta versao." });
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/turmas/") && url.pathname.endsWith("/availability")) {
    return sendJson(res, 501, { error: "Disponibilidade coletiva sera liberada em uma proxima etapa." });
  }

  if (req.method === "GET" && url.pathname === "/api/google/calendar/start") {
    return sendJson(res, 501, { error: "Conector Calendar ainda nao habilitado." });
  }

  if (req.method === "GET" && url.pathname === "/api/google/calendar/callback") {
    return sendJson(res, 501, { error: "Conector Calendar ainda nao habilitado." });
  }

  if (req.method === "POST" && url.pathname === "/api/logout") {
    clearCookie(res, "session_id");
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: "Rota nao encontrada." });
}

export async function handler(req, res) {
  try {
    return await router(req, res);
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, {
      error: "Erro interno controlado.",
      detail: config.isProduction ? undefined : error.message
    });
  }
}

export default handler;

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";

const currentFile = fileURLToPath(import.meta.url);
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === currentFile;

if (isDirectRun) {
  const server = http.createServer(handler);

  server.listen(port, host, () => {
    console.log(`Server running on http://${host}:${port}`);
  });

  process.on("SIGTERM", () => {
    server.close(() => process.exit(0));
  });

  process.on("SIGINT", () => {
    server.close(() => process.exit(0));
  });
}
