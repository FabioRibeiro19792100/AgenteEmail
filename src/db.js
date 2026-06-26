import crypto from "node:crypto";

function getSupabaseUrl() {
  return process.env.SUPABASE_URL || "";
}

function getSupabaseKey() {
  return process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
}

function ensureSupabaseConfig() {
  if (!getSupabaseUrl() || !getSupabaseKey()) {
    throw new Error("Supabase nao configurado. Defina SUPABASE_URL e SUPABASE_SECRET_KEY.");
  }
}

function apiUrl(path) {
  ensureSupabaseConfig();
  return `${getSupabaseUrl()}${path}`;
}

function supabaseHeaders(extra = {}) {
  ensureSupabaseConfig();
  return {
    apikey: getSupabaseKey(),
    authorization: `Bearer ${getSupabaseKey()}`,
    "content-type": "application/json",
    ...extra
  };
}

async function parseResponse(response) {
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(data?.message || data?.error || `Supabase error ${response.status}`);
  }
  return data;
}

function buildQuery({ select = "*", filters = {}, orderBy, limit } = {}) {
  const params = new URLSearchParams();
  params.set("select", select);
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined) continue;
    params.set(key, value);
  }
  if (orderBy) params.set("order", orderBy);
  if (limit) params.set("limit", String(limit));
  return params.toString();
}

async function selectRows(table, options = {}) {
  const response = await fetch(apiUrl(`/rest/v1/${table}?${buildQuery(options)}`), {
    headers: supabaseHeaders()
  });
  return parseResponse(response);
}

async function insertRows(table, rows, { upsert = false } = {}) {
  const prefer = upsert ? "resolution=merge-duplicates,return=representation" : "return=representation";
  const response = await fetch(apiUrl(`/rest/v1/${table}`), {
    method: "POST",
    headers: supabaseHeaders({ Prefer: prefer }),
    body: JSON.stringify(rows)
  });
  return parseResponse(response);
}

async function updateRows(table, filters, patch) {
  const response = await fetch(apiUrl(`/rest/v1/${table}?${buildQuery({ filters })}`), {
    method: "PATCH",
    headers: supabaseHeaders({ Prefer: "return=representation" }),
    body: JSON.stringify(patch)
  });
  return parseResponse(response);
}

async function deleteRows(table, filters) {
  const response = await fetch(apiUrl(`/rest/v1/${table}?${buildQuery({ filters })}`), {
    method: "DELETE",
    headers: supabaseHeaders({ Prefer: "return=representation" })
  });
  return parseResponse(response);
}

export function eq(value) {
  return `eq.${String(value)}`;
}

export function isNull() {
  return "is.null";
}

export function generateId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function defaultWeeklyReportSettings(userId) {
  return {
    user_id: userId,
    whatsapp_number: "",
    schedule_day: "friday",
    schedule_time: "09:00",
    timezone: "America/Sao_Paulo",
    timezone_label: "BRT",
    enabled: true,
    created_at: null,
    updated_at: null
  };
}

export async function getUserById(userId) {
  const rows = await selectRows("users", { filters: { user_id: eq(userId) }, limit: 1 });
  return rows[0] || null;
}

export async function getUserByEmail(email) {
  const rows = await selectRows("users", {
    filters: { email_informado: eq(email) },
    orderBy: "created_at.asc",
    limit: 1
  });
  return rows[0] || null;
}

export async function getLatestGmailConnectedUser() {
  const rows = await selectRows("google_connections", {
    filters: {
      provider: eq("gmail"),
      revoked_at: isNull()
    },
    orderBy: "updated_at.desc",
    limit: 1
  });
  const connection = rows[0] || null;
  if (!connection) return null;
  return getUserById(connection.user_id);
}

export async function getSessionById(sessionId) {
  const rows = await selectRows("sessions", { filters: { session_id: eq(sessionId) }, limit: 1 });
  return rows[0] || null;
}

export async function createSessionForUser(userId, sessionId) {
  await deleteRows("sessions", { user_id: eq(userId) });
  const rows = await insertRows("sessions", [
    { session_id: sessionId, user_id: userId, created_at: nowIso() }
  ]);
  return rows[0] || null;
}

export async function acceptInviteAndCreateSession(inviteId, sessionId) {
  const invites = await selectRows("invites", {
    filters: { invite_id: eq(inviteId) },
    limit: 1
  });
  const invite = invites[0] || null;
  if (!invite) return null;

  await createSessionForUser(invite.user_id, sessionId);

  await updateRows("invites", { invite_id: eq(inviteId) }, {
    status: "accepted",
    first_access_at: invite.first_access_at || nowIso(),
    last_access_at: nowIso()
  });

  return invite;
}

export async function appendAgentLog(record) {
  const rows = await insertRows("agent_logs", [record]);
  return rows[0] || null;
}

export async function listPendingActionsForUser(userId) {
  return selectRows("pending_actions", {
    filters: {
      user_id: eq(userId),
      status: eq("pending_confirmation")
    },
    orderBy: "created_at.desc"
  });
}

export async function createPendingAction(record) {
  const rows = await insertRows("pending_actions", [record]);
  return rows[0] || null;
}

export async function getPendingActionByIdForUser(actionId, userId) {
  const rows = await selectRows("pending_actions", {
    filters: { id: eq(actionId), user_id: eq(userId) },
    limit: 1
  });
  return rows[0] || null;
}

export async function updatePendingAction(actionId, patch) {
  const rows = await updateRows("pending_actions", { id: eq(actionId) }, patch);
  return rows[0] || null;
}

/* ── Instruções do agente ──────────────────────────────────────── */

export async function getActiveInstructions(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await selectRows("agent_instructions", {
    filters: {
      user_id: eq(userId),
      active: "eq.true",
      applies_from: `lte.${today}`
    },
    orderBy: "applies_from.asc"
  });
  return rows;
}

export async function saveInstruction(userId, { instruction, appliesFrom }) {
  const id = generateId("ainstr");
  const rows = await insertRows("agent_instructions", [{
    id,
    user_id: userId,
    instruction,
    applies_from: appliesFrom || new Date().toISOString().slice(0, 10),
    active: true,
    created_at: nowIso()
  }]);
  return rows[0];
}

export async function deleteInstruction(instructionId, userId) {
  return deleteRows("agent_instructions", { id: eq(instructionId), user_id: eq(userId) });
}

export async function listOperationalNotesForUser(userId) {
  return selectRows("operational_notes", {
    filters: { user_id: eq(userId) },
    orderBy: "created_at.desc"
  });
}

export async function createOperationalNote(record) {
  const rows = await insertRows("operational_notes", [record]);
  return rows[0] || null;
}

export async function updateOperationalNoteStatus(noteId, userId, status) {
  const rows = await updateRows(
    "operational_notes",
    { id: eq(noteId), user_id: eq(userId) },
    { status, updated_at: nowIso() }
  );
  return rows[0] || null;
}

export async function deleteOperationalNote(noteId, userId) {
  const rows = await deleteRows("operational_notes", { id: eq(noteId), user_id: eq(userId) });
  return rows[0] || null;
}

export async function getWeeklyReportSettings(userId) {
  const rows = await selectRows("weekly_report_settings", {
    filters: { user_id: eq(userId) },
    limit: 1
  });
  return rows[0] || defaultWeeklyReportSettings(userId);
}

export async function upsertWeeklyReportSettings(userId, patch) {
  const existing = await getWeeklyReportSettings(userId);
  const now = nowIso();
  const rows = await insertRows(
    "weekly_report_settings",
    [
      {
        ...existing,
        ...patch,
        user_id: userId,
        timezone: "America/Sao_Paulo",
        timezone_label: "BRT",
        enabled: patch.enabled ?? existing.enabled ?? true,
        created_at: existing.created_at || now,
        updated_at: now
      }
    ],
    { upsert: true }
  );
  return rows[0] || defaultWeeklyReportSettings(userId);
}

export async function getReadyStats() {
  const rows = await selectRows("users", { select: "user_id" });
  return { userCount: rows.length };
}

export async function getOrCreateTurmaByName(nome) {
  const rows = await selectRows("turmas", { filters: { nome: eq(nome) }, limit: 1 });
  if (rows[0]) return rows[0];
  const created = await insertRows("turmas", [
    { turma_id: generateId("turma"), nome, created_at: nowIso() }
  ]);
  return created[0];
}

export async function importStudents(rows) {
  const created = [];
  for (const row of rows) {
    if (!row?.email || !row?.turma) continue;
    const turma = await getOrCreateTurmaByName(row.turma);
    const userId = generateId("user");
    const inviteId = generateId("inv");
    const nome = row.nome || row.email.split("@")[0] || row.email;
    await insertRows("users", [
      {
        user_id: userId,
        nome,
        turma_id: turma.turma_id,
        email_informado: row.email || "",
        papel: row.papel || "aluno",
        instituicao: row.instituicao || "",
        agent_permission_level: 3,
        created_at: nowIso(),
        updated_at: nowIso()
      }
    ]);
    await insertRows("invites", [
      {
        invite_id: inviteId,
        user_id: userId,
        status: "pending",
        created_at: nowIso(),
        first_access_at: null,
        last_access_at: null
      }
    ]);
    created.push({ nome, email: row.email, turma: row.turma, invite_id: inviteId });
  }
  return created;
}

export async function listStudents() {
  const [users, turmas, invites] = await Promise.all([
    selectRows("users", { orderBy: "created_at.asc" }),
    selectRows("turmas"),
    selectRows("invites")
  ]);
  return users.map((user) => {
    const turma = turmas.find((item) => item.turma_id === user.turma_id);
    const invite = invites.find((item) => item.user_id === user.user_id);
    return {
      ...user,
      turma_nome: turma?.nome || "",
      invite_id: invite?.invite_id || "",
      invite_status: invite?.status || "pending"
    };
  });
}

export async function createOAuthState(record) {
  const rows = await insertRows("oauth_states", [record]);
  return rows[0] || null;
}

export async function consumeOAuthState(nonce) {
  const rows = await selectRows("oauth_states", {
    filters: { nonce: eq(nonce) },
    limit: 1
  });
  const state = rows[0] || null;
  if (state) {
    await deleteRows("oauth_states", { nonce: eq(nonce) });
  }
  return state;
}

export async function getGoogleConnection(userId, provider = "gmail") {
  const rows = await selectRows("google_connections", {
    filters: {
      user_id: eq(userId),
      provider: eq(provider),
      revoked_at: isNull()
    },
    limit: 1
  });
  return rows[0] || null;
}

export async function upsertGoogleConnection(record) {
  const rows = await insertRows("google_connections", [record], { upsert: true });
  return rows[0] || null;
}

export async function updateGoogleConnection(userId, provider, patch) {
  const rows = await updateRows("google_connections", {
    user_id: eq(userId),
    provider: eq(provider),
    revoked_at: isNull()
  }, patch);
  return rows[0] || null;
}

export async function revokeGoogleConnectionRecord(userId, provider = "gmail") {
  const rows = await updateRows("google_connections", {
    user_id: eq(userId),
    provider: eq(provider),
    revoked_at: isNull()
  }, {
    revoked_at: nowIso(),
    updated_at: nowIso()
  });
  return rows[0] || null;
}
