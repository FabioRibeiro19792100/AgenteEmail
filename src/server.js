import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  acceptInviteAndCreateSession,
  appendAgentLog,
  createSessionForUser,
  consumeOAuthState,
  createOperationalNote,
  createOAuthState,
  createPendingAction,
  defaultWeeklyReportSettings,
  deleteOperationalNote,
  generateId,
  getPendingActionByIdForUser,
  getLatestGmailConnectedUser,
  getReadyStats,
  getUserByEmail,
  getSessionById,
  getUserById,
  getWeeklyReportSettings,
  importStudents,
  listOperationalNotesForUser,
  listPendingActionsForUser,
  listStudents,
  nowIso,
  updateOperationalNoteStatus,
  updatePendingAction,
  upsertWeeklyReportSettings,
  getActiveInstructions,
  saveInstruction,
  deleteInstruction
} from "./db.js";
import { buildDecisionFeed, prepareReplyForEmail, refineDraftWithAI, runAgent, runDailyBriefing, runExecutiveAnalysis, runInboxZeroNext, runInsightAnalysis, runSilentTriage } from "./agent.js";
import { getConfig, loadEnv, validateConfig } from "./config.js";
import {
  applyLabel,
  archiveEmail,
  batchModifyEmails,
  buildGmailAuthUrl,
  createDraft,
  getGmailConnectionStatus,
  markAsRead,
  readEmail,
  searchEmails,
  replyEmail,
  revokeGmailConnection,
  saveGmailConnection,
  sendEmail,
  sendPlainEmail,
  snoozeEmail,
  trashEmail
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
const operationalNotesFallbackStore = new Map();

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

async function getOrCreateLocalFallbackUser() {
  const email = process.env.DEV_USER_EMAIL || "teste-local@mailflow.local";
  let user = await getUserByEmail(email);
  if (user) return user;

  const created = await importStudents([
    {
      nome: "Teste Local",
      turma: "Teste Local",
      email,
      papel: "aluno",
      instituicao: "Local"
    }
  ]);
  if (!created.length) throw new Error("Nao foi possivel criar cabine local.");
  user = await getUserByEmail(email);
  if (!user) throw new Error("Cabine local nao encontrada.");
  return user;
}

async function setSessionForUser(res, user) {
  const sessionId = crypto.randomBytes(16).toString("hex");
  await createSessionForUser(user.user_id, sessionId);
  setCookie(res, "session_id", sessionId);
}

async function resolveProductUser(req, res, { createFallback = true } = {}) {
  const existingUser = await getSessionUser(req);
  if (config.isProduction) return existingUser;

  const connectedUser = await getLatestGmailConnectedUser();
  if (existingUser) {
    const existingGmail = await getGmailConnectionStatus(existingUser.user_id);
    if (existingGmail || !connectedUser || connectedUser.user_id === existingUser.user_id) {
      return existingUser;
    }
    await setSessionForUser(res, connectedUser);
    return connectedUser;
  }

  if (connectedUser) {
    await setSessionForUser(res, connectedUser);
    return connectedUser;
  }

  if (!createFallback) return null;
  const fallbackUser = await getOrCreateLocalFallbackUser();
  await setSessionForUser(res, fallbackUser);
  return fallbackUser;
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

async function bootstrapLocalSession(req, res) {
  if (config.isProduction) {
    return sendJson(res, 403, { error: "Em producao, entre por um link individual de convite." });
  }

  const before = await getSessionUser(req);
  const beforeId = before?.user_id || "";
  const user = await resolveProductUser(req, res, { createFallback: true });
  return sendJson(res, 200, {
    ok: true,
    user,
    alreadyAuthenticated: Boolean(before),
    switchedToConnectedUser: Boolean(beforeId && user?.user_id && beforeId !== user.user_id)
  });
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
  const user = await resolveProductUser(req, res, { createFallback: true });
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
    "/executive": "executive.html",
    "/mailflow": "mailflow.html",
    "/connections": "connections.html",
    "/availability": "availability.html"
  };
  return map[urlPath];
}

function inviteLink(req, inviteId) {
  return `${requestOrigin(req)}/invite/${inviteId}`;
}

function safeReturnTo(value, fallback = "/mailflow") {
  const target = String(value || "").trim();
  if (!target || !target.startsWith("/") || target.startsWith("//")) return fallback;
  if (target.includes("\n") || target.includes("\r")) return fallback;
  return target;
}

function parseImportRows(rawInput) {
  const lines = rawInput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.map((line) => {
    const parts = line.split(",").map((item) => item?.trim() || "");
    const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parts[0] || "");
    if (looksLikeEmail) {
      const [email, turma, papel, instituicao] = parts;
      return {
        nome: email.split("@")[0] || email,
        turma: turma || "Turma Padrao",
        email,
        papel,
        instituicao
      };
    }
    const [nome, turma, email, papel, instituicao] = parts;
    return {
      nome,
      turma: turma || "Turma Padrao",
      email,
      papel,
      instituicao
    };
  });
}

function invitationEmailBody({ email, turma, link }) {
  return [
    "Olá,",
    "",
    `Você recebeu um convite individual para acessar sua cabine MailFlow Intelligence${turma ? ` da ${turma}` : ""}.`,
    "",
    `Acesse aqui: ${link}`,
    "",
    "Ao abrir o link, você será levado direto para o composer. Depois, conecte seu Gmail para liberar as explorações da caixa de entrada.",
    "",
    `Este convite foi gerado para ${email}. Não compartilhe este link com outras pessoas.`
  ].join("\n");
}

async function resolveInviteSender(req) {
  if (process.env.INVITE_SENDER_USER_ID) {
    return getUserById(process.env.INVITE_SENDER_USER_ID);
  }
  return getSessionUser(req);
}

async function sendInviteEmails(req, createdRows) {
  const sender = await resolveInviteSender(req);
  if (!sender) {
    return {
      senderEmail: "",
      deliveries: createdRows.map((item) => ({
        email: item.email,
        status: "not_sent",
        error: "Nenhum Gmail remetente conectado nesta sessao."
      }))
    };
  }

  const gmail = await getGmailConnectionStatus(sender.user_id);
  if (!gmail?.operational) {
    return {
      senderEmail: gmail?.googleEmail || "",
      deliveries: createdRows.map((item) => ({
        email: item.email,
        status: "not_sent",
        error: "Gmail remetente sem permissao de envio. Reconecte o Gmail."
      }))
    };
  }

  const deliveries = [];
  for (const item of createdRows) {
    try {
      await sendPlainEmail(sender.user_id, {
        to: item.email,
        subject: `Seu convite para o MailFlow Intelligence - ${item.turma}`,
        body: invitationEmailBody({
          email: item.email,
          turma: item.turma,
          link: inviteLink(req, item.invite_id)
        })
      });
      deliveries.push({ email: item.email, status: "sent", error: "" });
    } catch (error) {
      deliveries.push({ email: item.email, status: "error", error: error.message });
    }
  }

  return { senderEmail: gmail.googleEmail, deliveries };
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

function serializeOperationalNote(note) {
  return {
    id: note.id,
    agentId: note.agent_id || "",
    type: note.type || "apontamento",
    title: note.title || "Apontamento operacional",
    summary: note.summary || "",
    nextAction: note.next_action || "",
    evidenceIndexes: Array.isArray(note.evidence_indexes) ? note.evidence_indexes : [],
    sources: Array.isArray(note.sources) ? note.sources : [],
    status: note.status || "open",
    createdAt: note.created_at,
    updatedAt: note.updated_at
  };
}

function normalizeOperationalNoteBody(body = {}) {
  const evidenceIndexes = Array.isArray(body.evidenceIndexes)
    ? body.evidenceIndexes
        .map((item) => Number(item))
        .filter((item) => Number.isFinite(item))
        .slice(0, 30)
    : [];
  const sources = Array.isArray(body.sources)
    ? body.sources.slice(0, 30).map((source) => ({
        index: Number(source.index) || null,
        id: String(source.id || ""),
        subject: String(source.subject || "").slice(0, 240),
        from: String(source.from || "").slice(0, 240),
        date: String(source.date || "").slice(0, 120),
        direction: String(source.direction || "").slice(0, 40),
        snippet: String(source.snippet || "").slice(0, 700)
      }))
    : [];
  const title = String(body.title || "Apontamento operacional").trim().slice(0, 180);
  const summary = String(body.summary || "").trim().slice(0, 8000);
  return {
    agent_id: String(body.agentId || "").slice(0, 80),
    type: String(body.type || "apontamento").slice(0, 80),
    title: title || "Apontamento operacional",
    summary,
    next_action: String(body.nextAction || "").trim().slice(0, 1200),
    evidence_indexes: evidenceIndexes,
    sources
  };
}

function fallbackNotesForUser(userId) {
  if (!operationalNotesFallbackStore.has(userId)) {
    operationalNotesFallbackStore.set(userId, []);
  }
  return operationalNotesFallbackStore.get(userId);
}

function createFallbackOperationalNote(user, payload) {
  const now = nowIso();
  const note = {
    id: generateId("note"),
    user_id: user.user_id,
    turma_id: user.turma_id,
    ...payload,
    status: "open",
    created_at: now,
    updated_at: now
  };
  const notes = fallbackNotesForUser(user.user_id);
  notes.unshift(note);
  return note;
}

function updateFallbackOperationalNoteStatus(userId, noteId, status) {
  const notes = fallbackNotesForUser(userId);
  const note = notes.find((item) => item.id === noteId);
  if (!note) return null;
  note.status = status;
  note.updated_at = nowIso();
  return note;
}

function deleteFallbackOperationalNote(userId, noteId) {
  const notes = fallbackNotesForUser(userId);
  const index = notes.findIndex((item) => item.id === noteId);
  if (index < 0) return null;
  const [note] = notes.splice(index, 1);
  return note;
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
  const days = daysMatch ? Math.min(365, Math.max(1, Number(daysMatch[1]))) : timeframe === "24h" ? 1 : 30;
  return `${categoryQueryFromUrl(url)} newer_than:${days}d`.trim();
}

function selectedInboxCategories(url) {
  const allowed = new Set(["primary", "social", "promotions"]);
  const requested = String(url.searchParams.get("categories") || "primary")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => allowed.has(item));
  return requested.length ? requested : ["primary"];
}

function categoryQueryFromUrl(url) {
  const categories = selectedInboxCategories(url);
  const hasPrimary = categories.includes("primary");
  const hasSocial = categories.includes("social");
  const hasPromotions = categories.includes("promotions");

  if (hasPrimary && hasSocial && hasPromotions) return "";
  if (hasPrimary && !hasSocial && !hasPromotions) return "-category:social -category:promotions";
  if (!hasPrimary && hasSocial && !hasPromotions) return "category:social";
  if (!hasPrimary && !hasSocial && hasPromotions) return "category:promotions";

  // Gmail search does not reliably support OR groups with negative category terms.
  // When Principal is combined with another category, use a broad window and let ranking filter.
  if (hasPrimary) return hasPromotions && !hasSocial ? "-category:social" : hasSocial && !hasPromotions ? "-category:promotions" : "";
  return "{category:social category:promotions}";
}

function clampInboxLimit(value) {
  const parsed = Number(value || 200);
  if (!Number.isFinite(parsed)) return 200;
  return Math.min(500, Math.max(1, parsed));
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

function applyLabelOperationFromEmail(email, label) {
  const cleanLabel = String(label || "").trim() || "MailFlow";
  return {
    toolName: "apply_label",
    permissionLevel: 3,
    title: "Aplicar label",
    summary: `Aplicar "${cleanLabel}" em "${email.subject || "mensagem"}"`,
    confirmLabel: "Aplicar label",
    editable: true,
    previewText: cleanLabel,
    payload: { messageId: email.id, label: cleanLabel }
  };
}

function trashOperationFromEmail(email) {
  return {
    toolName: "trash_email",
    permissionLevel: 3,
    title: "Mover para lixo",
    summary: `Mover para o lixo: "${email.subject || "mensagem"}"`,
    confirmLabel: "Mover para lixo",
    editable: false,
    previewText: `Mensagem: ${email.subject || "sem assunto"}\nRemetente: ${email.from || ""}\nData: ${email.date || ""}`,
    payload: { messageId: email.id }
  };
}

function snoozeOperationFromEmail(email, snoozeDays = 3) {
  const snoozeDate = new Date(Date.now() + snoozeDays * 24 * 60 * 60 * 1000);
  const dateLabel = snoozeDate.toISOString().split("T")[0];
  return {
    toolName: "snooze_email",
    permissionLevel: 3,
    title: `Adiar email por ${snoozeDays} dia(s)`,
    summary: `Adiar "${email.subject || "mensagem"}" até ${dateLabel}`,
    confirmLabel: `Adiar até ${dateLabel}`,
    editable: false,
    previewText: `Mensagem: ${email.subject || "sem assunto"}\nRemetente: ${email.from || ""}\nAdiado até: ${dateLabel}\nLabel criada: MailFlow/Adiado/${dateLabel}`,
    payload: { messageId: email.id, snoozeDays }
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
    case "trash_email":
      return trashEmail(user.user_id, payload.messageId);
    case "snooze_email":
      return snoozeEmail(user.user_id, payload.messageId, payload.snoozeDays || 3);
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

  if (req.method === "GET" && url.pathname === "/") {
    return sendRedirect(res, "/mailflow");
  }

  if (req.method === "GET" && routePage(url.pathname)) {
    if (url.pathname === "/admin/login") {
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
      redirectTo: "/mailflow",
      user: { nome: user.nome, turma_id: user.turma_id }
    });
  }

  if (req.method === "GET" && url.pathname === "/api/session") {
    const user = await resolveProductUser(req, res, { createFallback: true });
    if (!user) return sendJson(res, 200, { authenticated: false });
    return sendJson(res, 200, {
      authenticated: true,
      user,
      permissions: permissionModel(),
      connections: await gmailConnectionSummary(user.user_id),
      pendingActions: (await getPendingActionsForUser(user.user_id)).map(serializePendingAction)
    });
  }

  if (req.method === "POST" && url.pathname === "/api/dev/session") {
    return bootstrapLocalSession(req, res);
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
      return sendJson(res, 200, { ok: true, message: "Pronto para arquivar. Confirme abaixo.", pendingAction });
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
      return sendJson(res, 200, { ok: true, message: "Pronto para marcar lido. Confirme abaixo.", pendingAction });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/inbox/actions/apply-label") {
    const user = await ensureAuth(req, res);
    if (!user) return;
    const body = await readBody(req);
    if (!body.messageId) return sendJson(res, 400, { error: "messageId obrigatorio." });
    try {
      const email = await readEmail(user.user_id, body.messageId);
      const pendingAction = await persistPendingAction(user, applyLabelOperationFromEmail(email, body.label || "MailFlow"));
      return sendJson(res, 200, { ok: true, message: "Pronto para aplicar label. Confirme abaixo.", pendingAction });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/inbox/actions/trash") {
    const user = await ensureAuth(req, res);
    if (!user) return;
    const body = await readBody(req);
    if (!body.messageId) return sendJson(res, 400, { error: "messageId obrigatorio." });
    try {
      const email = await readEmail(user.user_id, body.messageId);
      const pendingAction = await persistPendingAction(user, trashOperationFromEmail(email));
      return sendJson(res, 200, { ok: true, message: "Pronto para mover ao lixo. Confirme abaixo.", pendingAction });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/inbox/actions/snooze") {
    const user = await ensureAuth(req, res);
    if (!user) return;
    const body = await readBody(req);
    if (!body.messageId) return sendJson(res, 400, { error: "messageId obrigatorio." });
    const snoozeDays = Number(body.snoozeDays) || 3;
    try {
      const email = await readEmail(user.user_id, body.messageId);
      const pendingAction = await persistPendingAction(user, snoozeOperationFromEmail(email, snoozeDays));
      return sendJson(res, 200, { ok: true, message: `Pronto para adiar ${snoozeDays} dia(s). Confirme abaixo.`, pendingAction });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/inbox/actions/batch") {
    const user = await ensureAuth(req, res);
    if (!user) return;
    const body = await readBody(req);
    const ops = Array.isArray(body.operations) ? body.operations : [];
    if (!ops.length) return sendJson(res, 400, { error: "operations vazio." });

    const allowed = new Set(["archive", "trash", "mark_read"]);
    const invalid = ops.find((op) => !allowed.has(op.action));
    if (invalid) return sendJson(res, 400, { error: `Acao em lote nao suportada: ${invalid.action}` });

    const messageIds = ops.map((op) => op.messageId).filter(Boolean);
    if (!messageIds.length) return sendJson(res, 400, { error: "Nenhum messageId valido." });

    try {
      const results = { archive: [], trash: [], mark_read: [] };

      const archiveIds = ops.filter((op) => op.action === "archive").map((op) => op.messageId);
      const trashIds = ops.filter((op) => op.action === "trash").map((op) => op.messageId);
      const markReadIds = ops.filter((op) => op.action === "mark_read").map((op) => op.messageId);

      if (archiveIds.length) {
        await batchModifyEmails(user.user_id, archiveIds, { removeLabelIds: ["INBOX"] });
        results.archive = archiveIds;
      }
      if (trashIds.length) {
        for (const id of trashIds) await trashEmail(user.user_id, id);
        results.trash = trashIds;
      }
      if (markReadIds.length) {
        await batchModifyEmails(user.user_id, markReadIds, { removeLabelIds: ["UNREAD"] });
        results.mark_read = markReadIds;
      }

      const total = archiveIds.length + trashIds.length + markReadIds.length;
      return sendJson(res, 200, {
        ok: true,
        message: `${total} email(s) processado(s) com sucesso.`,
        results
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
        maxResults: body.maxResults || 40,
        categories: body.categories || ["primary"]
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

  if (req.method === "GET" && url.pathname === "/api/executive/notes") {
    const user = await ensureAuth(req, res);
    if (!user) return;
    try {
      const notes = await listOperationalNotesForUser(user.user_id);
      return sendJson(res, 200, {
        ok: true,
        storageReady: true,
        notes: notes.map(serializeOperationalNote)
      });
    } catch (error) {
      return sendJson(res, 200, {
        ok: true,
        storageReady: false,
        fallback: true,
        notes: fallbackNotesForUser(user.user_id).map(serializeOperationalNote),
        error: "Supabase sem tabela operational_notes. Usando apontamentos temporarios neste servidor local."
      });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/executive/notes") {
    const user = await ensureAuth(req, res);
    if (!user) return;
    const body = await readBody(req);
    const payload = normalizeOperationalNoteBody(body);
    if (!payload.summary) {
      return sendJson(res, 400, { error: "Resumo do apontamento obrigatorio." });
    }
    try {
      const now = nowIso();
      const note = await createOperationalNote({
        id: generateId("note"),
        user_id: user.user_id,
        turma_id: user.turma_id,
        ...payload,
        status: "open",
        created_at: now,
        updated_at: now
      });
      await logAction({
        userId: user.user_id,
        turmaId: user.turma_id,
        actionType: "operational_note",
        toolName: "create_operational_note",
        status: "success"
      });
      return sendJson(res, 200, {
        ok: true,
        storageReady: true,
        note: serializeOperationalNote(note)
      });
    } catch (error) {
      const note = createFallbackOperationalNote(user, payload);
      await logAction({
        userId: user.user_id,
        turmaId: user.turma_id,
        actionType: "operational_note",
        toolName: "create_operational_note_fallback",
        status: "success"
      });
      return sendJson(res, 200, {
        ok: true,
        storageReady: false,
        fallback: true,
        note: serializeOperationalNote(note),
        warning: "Apontamento salvo temporariamente. Para persistir em producao, aplique o schema do Supabase.",
        detail: config.isProduction ? undefined : error.message
      });
    }
  }

  const noteStatusMatch = url.pathname.match(/^\/api\/executive\/notes\/([^/]+)\/status$/);
  if (req.method === "POST" && noteStatusMatch) {
    const user = await ensureAuth(req, res);
    if (!user) return;
    const body = await readBody(req);
    const status = String(body.status || "").trim();
    if (!["open", "done", "archived"].includes(status)) {
      return sendJson(res, 400, { error: "Status invalido." });
    }
    try {
      const note = await updateOperationalNoteStatus(
        decodeURIComponent(noteStatusMatch[1]),
        user.user_id,
        status
      );
      if (!note) return sendJson(res, 404, { error: "Apontamento nao encontrado." });
      return sendJson(res, 200, {
        ok: true,
        note: serializeOperationalNote(note)
      });
    } catch (error) {
      const note = updateFallbackOperationalNoteStatus(
        user.user_id,
        decodeURIComponent(noteStatusMatch[1]),
        status
      );
      if (!note) return sendJson(res, 404, { error: "Apontamento nao encontrado." });
      return sendJson(res, 200, {
        ok: true,
        storageReady: false,
        fallback: true,
        note: serializeOperationalNote(note),
        warning: "Status atualizado temporariamente. Para persistir em producao, aplique o schema do Supabase.",
        detail: config.isProduction ? undefined : error.message
      });
    }
  }

  const noteDeleteMatch = url.pathname.match(/^\/api\/executive\/notes\/([^/]+)$/);
  if (req.method === "DELETE" && noteDeleteMatch) {
    const user = await ensureAuth(req, res);
    if (!user) return;
    const noteId = decodeURIComponent(noteDeleteMatch[1]);
    try {
      const note = await deleteOperationalNote(noteId, user.user_id);
      if (!note) return sendJson(res, 404, { error: "Apontamento nao encontrado." });
      return sendJson(res, 200, {
        ok: true,
        deleted: serializeOperationalNote(note)
      });
    } catch (error) {
      const note = deleteFallbackOperationalNote(user.user_id, noteId);
      if (!note) return sendJson(res, 404, { error: "Apontamento nao encontrado." });
      return sendJson(res, 200, {
        ok: true,
        storageReady: false,
        fallback: true,
        deleted: serializeOperationalNote(note),
        warning: "Apontamento removido temporariamente. Para persistir em producao, aplique o schema do Supabase.",
        detail: config.isProduction ? undefined : error.message
      });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/context/contacts") {
    const user = await ensureAuth(req, res);
    if (!user) return;
    try {
      const allNotes = await listOperationalNotesForUser(user.user_id);
      const contacts = allNotes
        .filter((note) => note.type === "contato_vip" && note.status !== "archived")
        .map(serializeOperationalNote);
      return sendJson(res, 200, { ok: true, contacts });
    } catch {
      return sendJson(res, 200, { ok: true, contacts: [] });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/context/contacts") {
    const user = await ensureAuth(req, res);
    if (!user) return;
    const body = await readBody(req);
    if (!body.name && !body.email) return sendJson(res, 400, { error: "Nome ou email obrigatorio." });
    const now = nowIso();
    const summary = [
      body.email ? `Email: ${body.email}` : "",
      body.company ? `Empresa: ${body.company}` : "",
      body.context ? `Contexto: ${body.context}` : "",
      body.notes ? `Notas: ${body.notes}` : ""
    ].filter(Boolean).join("\n");
    try {
      const note = await createOperationalNote({
        id: generateId("contact"),
        user_id: user.user_id,
        turma_id: user.turma_id,
        type: "contato_vip",
        agent_id: "context",
        title: body.name || body.email,
        summary: summary || "Contato VIP salvo manualmente.",
        next_action: body.nextAction || "",
        evidence_indexes: [],
        sources: [],
        status: "open",
        created_at: now,
        updated_at: now
      });
      return sendJson(res, 200, { ok: true, contact: serializeOperationalNote(note) });
    } catch (error) {
      const note = createFallbackOperationalNote(user, {
        type: "contato_vip",
        agent_id: "context",
        title: body.name || body.email,
        summary: summary || "Contato VIP salvo manualmente.",
        next_action: body.nextAction || "",
        evidenceIndexes: [],
        sources: []
      });
      return sendJson(res, 200, {
        ok: true,
        fallback: true,
        contact: serializeOperationalNote(note),
        warning: "Contato salvo temporariamente."
      });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/executive/analyze") {
    const user = await ensureAuth(req, res);
    if (!user) return;
    const body = await readBody(req);
    try {
      let vipContacts = [];
      try {
        const allNotes = await listOperationalNotesForUser(user.user_id);
        vipContacts = allNotes
          .filter((note) => note.type === "contato_vip" && note.status === "open")
          .map((note) => `- ${note.title}: ${note.summary}`);
      } catch { /* ignorar se falhar */ }

      const customInstruction = [
        body.customInstruction || "",
        vipContacts.length ? `\n\nContatos VIP conhecidos (priorize aparições deles):\n${vipContacts.join("\n")}` : ""
      ].join("").trim();

      const analysis = await runExecutiveAnalysis(user.user_id, {
        agentId: body.agentId || "executive_assistant",
        timeframe: body.timeframe || "30d",
        query: body.query || "",
        maxResults: body.maxResults || 200,
        categories: body.categories || ["primary"],
        customInstruction
      });
      await logAction({
        userId: user.user_id,
        turmaId: user.turma_id,
        actionType: "executive_analysis",
        toolName: "executive_agent_analysis",
        status: "success"
      });
      return sendJson(res, 200, { ok: true, analysis });
    } catch (error) {
      await logAction({
        userId: user.user_id,
        turmaId: user.turma_id,
        actionType: "executive_analysis",
        toolName: "executive_agent_analysis",
        status: "error"
      });
      return sendJson(res, 400, {
        error: error.message.includes("Gmail not connected")
          ? "Conecte seu Gmail para gerar a visao executiva."
          : error.message
      });
    }
  }

  // ── Instruções do agente ─────────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/api/agent/instructions") {
    const user = await ensureAuth(req, res);
    if (!user) return;
    try {
      const instructions = await getActiveInstructions(user.user_id);
      return sendJson(res, 200, { ok: true, instructions });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/agent/instructions") {
    const user = await ensureAuth(req, res);
    if (!user) return;
    const body = await readBody(req);
    if (!body.instruction?.trim()) return sendJson(res, 400, { error: "instruction é obrigatório" });
    try {
      const row = await saveInstruction(user.user_id, {
        instruction: body.instruction.trim(),
        appliesFrom: body.appliesFrom || new Date().toISOString().slice(0, 10)
      });
      return sendJson(res, 201, { ok: true, instruction: row });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/agent/instructions/")) {
    const user = await ensureAuth(req, res);
    if (!user) return;
    const instrId = url.pathname.split("/").pop();
    try {
      await deleteInstruction(instrId, user.user_id);
      return sendJson(res, 200, { ok: true });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  // ── Feed de decisões ─────────────────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/executive/feed") {
    const user = await ensureAuth(req, res);
    if (!user) return;
    const body = await readBody(req);
    try {
      const feed = await buildDecisionFeed(user.user_id, {
        timeframe: body.timeframe || "7d",
        maxEmails: Number(body.maxEmails) || 100
      });
      return sendJson(res, 200, { ok: true, feed });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  // ── Briefing por email ────────────────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/executive/briefing/send") {
    const user = await ensureAuth(req, res);
    if (!user) return;
    try {
      const briefing = await runDailyBriefing(user.user_id);
      const report = briefing.report;
      const findings = (report?.findings || []).slice(0, 8);
      const body = [
        `MailFlow — Briefing ${new Date().toLocaleDateString("pt-BR")}`,
        "",
        report?.summary || "",
        "",
        ...findings.map((f, i) => [
          `${i + 1}. ${f.title}`,
          f.claim || f.whyItMatters || "",
          f.nextAction ? `→ ${f.nextAction}` : "",
          ""
        ].filter(Boolean).join("\n"))
      ].join("\n");

      const gmail = await import("./google.js");
      const conn = await import("./db.js");
      const db = await conn.getGoogleConnection(user.user_id, "gmail");
      const toEmail = db?.google_email || user.email_informado;
      if (!toEmail) throw new Error("Não encontrei email de destino.");

      await gmail.sendPlainEmail(user.user_id, {
        to: toEmail,
        subject: `MailFlow Briefing — ${new Date().toLocaleDateString("pt-BR")}`,
        body
      });
      return sendJson(res, 200, { ok: true, sentTo: toEmail });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  // ── Modo 1: Briefing diário ──────────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/executive/briefing") {
    const user = await ensureAuth(req, res);
    if (!user) return;
    try {
      const result = await runDailyBriefing(user.user_id);
      return sendJson(res, 200, { ok: true, briefing: result });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  // ── Modo 2: Triagem silenciosa — preview ────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/executive/triage/preview") {
    const user = await ensureAuth(req, res);
    if (!user) return;
    try {
      const result = await runSilentTriage(user.user_id);
      return sendJson(res, 200, { ok: true, triage: result });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  // ── Modo 2: Triagem silenciosa — executar ───────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/executive/triage/execute") {
    const user = await ensureAuth(req, res);
    if (!user) return;
    const body = await readBody(req);
    try {
      const { toArchive = [], toMarkRead = [], toLabel = [] } = body;
      const results = {};
      if (toArchive.length) {
        await batchModifyEmails(user.user_id, toArchive, { removeLabelIds: ["INBOX"] });
        results.archived = toArchive.length;
      }
      if (toMarkRead.length) {
        await batchModifyEmails(user.user_id, toMarkRead, { removeLabelIds: ["UNREAD"] });
        results.markedRead = toMarkRead.length;
      }
      if (toLabel.length) {
        for (const item of toLabel) {
          try { await applyLabel(user.user_id, item.id, item.label || "MailFlow/Comercial"); } catch { /* continua */ }
        }
        results.labeled = toLabel.length;
      }
      return sendJson(res, 200, { ok: true, results });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  // ── Modo 3: Inbox zero — próximo email ──────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/executive/inbox-zero/next") {
    const user = await ensureAuth(req, res);
    if (!user) return;
    const body = await readBody(req);
    try {
      const result = await runInboxZeroNext(user.user_id, { skipIds: body.skipIds || [] });
      return sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/admin/import-students") {
    const body = await readBody(req);
    const rows = Array.isArray(body.students) ? body.students : parseImportRows(body.raw || "");
    const createdRows = await importStudents(rows);
    const deliveryReport = body.sendEmails === false
      ? { senderEmail: "", deliveries: [] }
      : await sendInviteEmails(req, createdRows);
    const deliveryByEmail = new Map(
      deliveryReport.deliveries.map((item) => [item.email, item])
    );
    return sendJson(res, 200, {
      ok: true,
      senderEmail: deliveryReport.senderEmail,
      created: createdRows.map((item) => ({
        nome: item.nome,
        email: item.email,
        turma: item.turma,
        link: inviteLink(req, item.invite_id),
        delivery: deliveryByEmail.get(item.email) || { status: "not_requested", error: "" }
      }))
    });
  }

  if (req.method === "GET" && url.pathname === "/api/admin/students") {
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
      const statePayload = {
        userId: user.user_id,
        provider: "gmail",
        nonce: generateId("state"),
        returnTo: safeReturnTo(url.searchParams.get("returnTo"))
      };
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
      const returnTo = safeReturnTo(payload.returnTo);
      const separator = returnTo.includes("?") ? "&" : "?";
      return sendRedirect(res, `${returnTo}${separator}gmail=connected`);
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

  if (req.method === "GET" && url.pathname === "/signout") {
    clearCookie(res, "session_id");
    return sendRedirect(res, "/mailflow");
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
