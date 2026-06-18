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
  generateId,
  getPendingActionByIdForUser,
  getReadyStats,
  getSessionById,
  getUserById,
  importStudents,
  listPendingActionsForUser,
  listStudents,
  nowIso,
  updatePendingAction
} from "./db.js";
import { runAgent } from "./agent.js";
import { getConfig, loadEnv, validateConfig } from "./config.js";
import {
  applyLabel,
  archiveEmail,
  buildGmailAuthUrl,
  createDraft,
  getGmailConnectionStatus,
  markAsRead,
  replyEmail,
  revokeGmailConnection,
  saveGmailConnection,
  sendEmail
} from "./google.js";
import { createSignedState, verifySignedState } from "./security.js";

loadEnv();
let configIssues = [];
try {
  configIssues = validateConfig();
} catch (error) {
  configIssues = error.message.replace(/^Configuration error:\s*/, "").split("; ");
  console.error(error.message);
}
const config = getConfig();

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
  res.setHeader("Set-Cookie", `${name}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

async function getSessionUser(req) {
  const cookies = parseCookies(req);
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

  if (req.method === "POST" && url.pathname === "/api/admin/import-students") {
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
      const pendingAction = result.operation ? await persistPendingAction(user, result.operation) : null;
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
        pendingAction
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
