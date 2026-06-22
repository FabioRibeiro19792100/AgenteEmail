import { readEmail, searchEmails } from "./google.js";

const DEFAULT_INSIGHT_SCAN_RESULTS = 200;
const MAX_INSIGHT_SCAN_RESULTS = 500;
const MAX_INSIGHT_EVIDENCE = 80;
const MAX_INSIGHT_RESULTS_PER_QUERY = 200;

const STOPWORDS = new Set([
  "a", "as", "o", "os", "de", "do", "da", "dos", "das", "e", "em", "na", "no",
  "nas", "nos", "para", "por", "com", "sem", "uma", "um", "me", "minha", "meu",
  "que", "quais", "qual", "ultimas", "ultima", "ultimos", "ultimo", "sobre",
  "caixa", "emails", "e-mails", "email", "digam", "respeito", "esse", "essa",
  "isto", "isso", "pra", "pro", "dos", "das", "das", "por", "favor"
]);

const AUTOMATED_TERMS = [
  "no-reply",
  "noreply",
  "do-not-reply",
  "donotreply",
  "accounts.google.com",
  "alerta de seguranca",
  "alerta de segurança",
  "verificacao em duas etapas",
  "verificação em duas etapas",
  "security alert",
  "newsletter",
  "unsubscribe",
  "promocao",
  "promoção",
  "notificacao automatica",
  "notificação automática"
];

const CALENDAR_TERMS = [
  "agenda",
  "calendar",
  "calendario",
  "calendário",
  "reuniao",
  "reunião",
  "meeting",
  "convite",
  "evento",
  "event",
  "canceled event",
  "cancelled event",
  "evento cancelado",
  "cancelado"
];

const COMMERCIAL_TERMS = [
  "cliente",
  "comercial",
  "venda",
  "negocio",
  "negócio",
  "proposta",
  "orcamento",
  "orçamento",
  "contrato",
  "invoice",
  "fatura",
  "pagamento",
  "preco",
  "preço",
  "pricing",
  "renovacao",
  "renovação",
  "lead",
  "parceiro",
  "parceria",
  "follow-up",
  "follow up",
  "reuniao comercial",
  "deal"
];

const PENDING_TERMS = [
  "pendencia",
  "pendência",
  "responder",
  "responda",
  "resposta",
  "retorno",
  "aguardando",
  "preciso",
  "poderia",
  "confirma",
  "confirmar",
  "aprovar",
  "aprovacao",
  "aprovação",
  "urgente",
  "prazo",
  "deadline"
];

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function includesAny(text, terms) {
  const normalized = normalizeText(text);
  return terms.some((term) => normalized.includes(normalizeText(term)));
}

function detectTimeWindowDays(message) {
  const lower = normalizeText(message);
  const explicitDays = lower.match(/(\d{1,3})\s*dias?/);
  if (explicitDays) return Math.min(365, Math.max(1, Number(explicitDays[1])));
  const explicitMonths = lower.match(/(\d{1,2})\s*mes(es)?/);
  if (explicitMonths) return Math.min(365, Math.max(1, Number(explicitMonths[1]) * 30));
  if (lower.includes("hoje")) return 1;
  if (lower.includes("ontem")) return 2;
  if (lower.includes("semana") || lower.includes("7 dias")) return 7;
  if (lower.includes("mes") || lower.includes("mês") || lower.includes("30 dias")) return 30;
  if (lower.includes("trimestre") || lower.includes("90 dias")) return 90;
  if (lower.includes("ano") || lower.includes("365 dias")) return 365;
  if (lower.includes("ultim")) return 90;
  return 30;
}

function inferFocus(message) {
  if (includesAny(message, COMMERCIAL_TERMS)) return "commercial";
  if (includesAny(message, PENDING_TERMS)) return "pending";
  if (includesAny(message, CALENDAR_TERMS)) return "schedule";
  if (includesAny(message, ["nao lido", "não lido", "unread"])) return "unread";
  if (includesAny(message, ["seguranca", "segurança", "login", "senha"])) return "security";
  return "general";
}

function analyzeRequest(message) {
  const days = detectTimeWindowDays(message);
  const focus = inferFocus(message);
  return {
    days,
    focus,
    wantsLatest: includesAny(message, ["ultima", "última", "ultimas", "últimas", "recentes"]),
    wantsAction: includesAny(message, PENDING_TERMS),
    wantsBusinessOnly: focus === "commercial"
  };
}

function windowQuery(days) {
  return `newer_than:${days}d`;
}

function addQuery(queries, query) {
  if (query && !queries.includes(query)) queries.push(query);
}

function buildQueryPlan(message) {
  const analysis = analyzeRequest(message);
  const base = windowQuery(analysis.days);
  const queries = [];

  if (analysis.focus === "commercial") {
    for (const term of ["cliente", "proposta", "contrato", "orcamento", "orçamento", "follow-up", "pagamento", "parceria"]) {
      addQuery(queries, `${base} ${term} -category:social -category:promotions`);
    }
    addQuery(queries, `${base} in:anywhere -category:social -category:promotions`);
    addQuery(queries, `${base} in:sent -category:social -category:promotions`);
  } else if (analysis.focus === "pending") {
    addQuery(queries, `${base} is:unread -category:social -category:promotions`);
    addQuery(queries, `${base} label:inbox -category:social -category:promotions`);
    for (const term of ["responder", "retorno", "aprovar", "confirmar", "urgente"]) {
      addQuery(queries, `${base} ${term} -category:social -category:promotions`);
    }
  } else if (analysis.focus === "schedule") {
    for (const term of ["reunião", "reuniao", "agenda", "calendar", "evento", "meeting"]) {
      addQuery(queries, `${base} ${term} -category:social -category:promotions`);
    }
  } else if (analysis.focus === "unread") {
    addQuery(queries, `${base} is:unread -category:social -category:promotions`);
  } else if (analysis.focus === "security") {
    addQuery(queries, `${base} security`);
    addQuery(queries, `${base} segurança`);
    addQuery(queries, `${base} from:accounts.google.com`);
  }

  addQuery(queries, `${base} is:important -category:social -category:promotions`);
  addQuery(queries, `${base} -category:social -category:promotions`);

  if (analysis.days < 90 && analysis.wantsLatest) {
    addQuery(queries, "newer_than:90d -category:social -category:promotions");
  }

  return {
    analysis,
    queries: queries.slice(0, 12),
    perQueryLimit: analysis.days >= 90 ? 12 : analysis.days >= 30 ? 10 : 8
  };
}

function normalizeQuery(message) {
  return buildQueryPlan(message).queries[0] || "newer_than:30d -category:social -category:promotions";
}

function emailText(email) {
  return `${email.subject}\n${email.from}\n${email.to || ""}\n${email.snippet}\n${email.bodyPreview}`;
}

function emailDirection(email) {
  const labels = Array.isArray(email.labelIds) ? email.labelIds : [];
  if (labels.includes("SENT")) return "enviado";
  if (labels.includes("DRAFT")) return "rascunho";
  return "recebido";
}

function classifyEmail(email) {
  const text = emailText(email);
  if (includesAny(text, AUTOMATED_TERMS)) return "automatico";
  if (includesAny(text, COMMERCIAL_TERMS)) return "comercial";
  if (includesAny(text, CALENDAR_TERMS)) return "agenda";
  if (includesAny(text, PENDING_TERMS)) return "pendencia";
  return "geral";
}

function extractKeywords(message) {
  return normalizeText(message)
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 2 && !STOPWORDS.has(word));
}

function parseEmailTime(email) {
  const time = new Date(email.date).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function recencyBoost(email) {
  const time = parseEmailTime(email);
  if (!time) return 0;
  const daysOld = (Date.now() - time) / 86_400_000;
  if (daysOld <= 2) return 4;
  if (daysOld <= 7) return 3;
  if (daysOld <= 30) return 2;
  if (daysOld <= 90) return 1;
  return 0;
}

function scoreEmailForQuestion(email, userMessage, analysis) {
  const lowerMessage = normalizeText(userMessage);
  const haystack = normalizeText(emailText(email));
  const subject = normalizeText(email.subject);
  const from = normalizeText(email.from);
  const kind = classifyEmail(email);
  const keywords = extractKeywords(userMessage);
  const reasons = [];
  let score = recencyBoost(email);

  for (const keyword of keywords) {
    if (subject.includes(keyword)) {
      score += 6;
      reasons.push(`assunto contem "${keyword}"`);
    } else if (from.includes(keyword)) {
      score += 4;
      reasons.push(`remetente contem "${keyword}"`);
    } else if (haystack.includes(keyword)) {
      score += 2;
    }
  }

  if (kind === "comercial") {
    score += analysis.focus === "commercial" ? 14 : 5;
    reasons.push("sinais comerciais");
  }

  if (kind === "pendencia") {
    if (emailDirection(email) === "enviado") {
      score += analysis.focus === "pending" ? 3 : 1;
      reasons.push("pendencia mencionada em email enviado");
    } else {
      score += analysis.focus === "pending" ? 12 : 4;
      reasons.push("sinais de pendencia recebida");
    }
  }

  if (kind === "agenda") {
    score += analysis.focus === "schedule" ? 10 : 1;
    reasons.push("sinais de agenda");
  }

  if (kind === "automatico") {
    score += analysis.focus === "security" ? 4 : -14;
    reasons.push("mensagem automatica");
  }

  if (analysis.wantsBusinessOnly && kind !== "comercial") {
    score -= 8;
  }

  if (analysis.wantsAction && includesAny(haystack, PENDING_TERMS) && emailDirection(email) !== "enviado") {
    score += 6;
    reasons.push("pode exigir acao sua");
  }

  if (
    lowerMessage.includes("comercial") &&
    includesAny(haystack, ["canceled event", "cancelled event", "evento cancelado"])
  ) {
    score -= 10;
    reasons.push("evento automatico, provavelmente nao comercial");
  }

  if (!reasons.length && score > 0) {
    reasons.push("recencia/contexto geral");
  }

  return { score, kind, reasons: [...new Set(reasons)].slice(0, 4) };
}

function dedupeEmails(emails) {
  const seen = new Set();
  return emails.filter((email) => {
    if (seen.has(email.id)) return false;
    seen.add(email.id);
    return true;
  });
}

function rankEmails(emails, userMessage, analysis) {
  return emails
    .map((email) => {
      const scored = scoreEmailForQuestion(email, userMessage, analysis);
      return {
        ...email,
        _score: scored.score,
        _kind: scored.kind,
        _reasons: scored.reasons
      };
    })
    .sort((a, b) => {
      if (b._score !== a._score) return b._score - a._score;
      return parseEmailTime(b) - parseEmailTime(a);
    });
}

function selectRelevantEmails(rankedEmails, analysis) {
  const threshold = analysis.focus === "general" ? 1 : 3;
  const relevant = rankedEmails.filter((email) => email._score >= threshold);
  const fallback = rankedEmails.filter((email) => email._kind !== "automatico");
  return (relevant.length ? relevant : fallback).slice(0, 20);
}

async function searchWithPlan(userId, plan) {
  const collected = [];
  const failures = [];

  for (const query of plan.queries) {
    try {
      const emails = await searchEmails(userId, query, plan.perQueryLimit);
      collected.push(...emails);
    } catch (error) {
      failures.push({ query, error: error.message });
    }
  }

  if (!collected.length && failures.length) {
    throw new Error(failures[0].error);
  }

  return {
    emails: dedupeEmails(collected),
    failures
  };
}

async function gatherReadContext(userId, userMessage) {
  const plan = buildQueryPlan(userMessage);
  const collected = await searchWithPlan(userId, plan);
  const ranked = rankEmails(collected.emails, userMessage, plan.analysis);
  const emails = selectRelevantEmails(ranked, plan.analysis);

  return {
    toolName: "cognitive_email_search",
    queryPlan: plan.queries,
    analysis: plan.analysis,
    emails,
    totalScanned: collected.emails.length,
    searchFailures: collected.failures
  };
}

function buildReadPrompt(userMessage, toolResult) {
  const condensed = toolResult.emails.map((email, index) => ({
    index: index + 1,
    relevanceScore: email._score,
    type: email._kind || classifyEmail(email),
    whySelected: email._reasons || [],
    subject: email.subject,
    from: email.from,
    date: email.date,
    snippet: email.snippet,
    bodyPreview: email.bodyPreview
  }));

  return {
    model: "gpt-4.1-mini",
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text:
              "Voce e um agente cognitivo de email do proprio usuario. Nunca invente emails, nomes, prazos ou fatos. Responda em portugues do Brasil. Aja como analista: use apenas as evidencias ranqueadas, descarte ruido automatico quando nao for relevante e explique incerteza. Se a pergunta pedir interacoes comerciais, priorize clientes, parceiros, propostas, contratos, pagamentos, follow-ups e reunioes comerciais; nao confunda alertas, newsletters ou eventos cancelados automaticos com interacao comercial. Seja direto, util e orientado a proximo passo."
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: [
              `Pedido do usuario: ${userMessage}`,
              "",
              `Foco inferido: ${toolResult.analysis.focus}`,
              `Janela analisada: ultimos ${toolResult.analysis.days} dias`,
              `Emails escaneados antes do ranking: ${toolResult.totalScanned}`,
              "",
              "Consultas usadas no Gmail:",
              JSON.stringify(toolResult.queryPlan, null, 2),
              "",
              "Evidencias ranqueadas:",
              JSON.stringify(condensed, null, 2),
              "",
              "Formato da resposta:",
              "1. Resposta direta em 2-4 linhas.",
              "2. Evidencias principais com remetente, assunto e data.",
              "3. Proximo passo sugerido, se houver."
            ].join("\n")
          }
        ]
      }
    ]
  };
}

function timeframeToDays(timeframe = "30d") {
  if (timeframe === "24h") return 1;
  const match = String(timeframe).match(/(\d{1,3})d/);
  if (match) return Math.min(365, Math.max(1, Number(match[1])));
  return 30;
}

function hasDateFilter(query = "") {
  return /\b(newer_than|older_than|after|before):/i.test(query);
}

function hasCategoryFilter(query = "") {
  return /\b-?category:/i.test(query);
}

function normalizeCategories(categories = ["primary"]) {
  const allowed = new Set(["primary", "social", "promotions"]);
  const values = Array.isArray(categories)
    ? categories
    : String(categories || "").split(",");
  const normalized = values
    .map((item) => String(item || "").trim().toLowerCase())
    .filter((item) => allowed.has(item));
  return normalized.length ? normalized : ["primary"];
}

function categoryQuery(categories = ["primary"]) {
  const normalized = normalizeCategories(categories);
  const hasPrimary = normalized.includes("primary");
  const hasSocial = normalized.includes("social");
  const hasPromotions = normalized.includes("promotions");

  if (hasPrimary && hasSocial && hasPromotions) return "";
  if (hasPrimary && !hasSocial && !hasPromotions) return "-category:social -category:promotions";
  if (!hasPrimary && hasSocial && !hasPromotions) return "category:social";
  if (!hasPrimary && !hasSocial && hasPromotions) return "category:promotions";

  // Gmail search is brittle with OR groups that include negative category terms.
  // Prefer a slightly broader query over returning zero messages.
  if (hasPrimary) return hasPromotions && !hasSocial ? "-category:social" : hasSocial && !hasPromotions ? "-category:promotions" : "";
  return "{category:social category:promotions}";
}

function scopedInsightQuery(base, query = "", categories = ["primary"]) {
  const trimmed = String(query || "").trim();
  const parts = [];
  if (!hasDateFilter(trimmed)) parts.push(base);
  if (!hasCategoryFilter(trimmed)) {
    const categoryScope = categoryQuery(categories);
    if (categoryScope) parts.push(categoryScope);
  }
  if (trimmed) parts.push(trimmed);
  return parts.join(" ").trim();
}

function buildInsightQueryPlan({ question, timeframe = "30d", query = "", maxResults = DEFAULT_INSIGHT_SCAN_RESULTS, categories = ["primary"] }) {
  const baseAnalysis = analyzeRequest(`${question} ${query}`);
  const analysis = {
    ...baseAnalysis,
    days: timeframeToDays(timeframe)
  };
  const base = windowQuery(analysis.days);
  const queries = [];
  const explicitQuery = String(query || "").trim();
  const selectedCategories = normalizeCategories(categories);

  if (explicitQuery) {
    addQuery(queries, scopedInsightQuery(base, explicitQuery, selectedCategories));
  }

  if (analysis.focus === "commercial") {
    for (const term of ["cliente", "proposta", "contrato", "orcamento", "pagamento", "parceria", "renovacao"]) {
      addQuery(queries, scopedInsightQuery(base, term, selectedCategories));
    }
  } else if (analysis.focus === "pending") {
    for (const term of ["responder", "retorno", "aprovar", "confirmar", "urgente", "pendente"]) {
      addQuery(queries, scopedInsightQuery(base, term, selectedCategories));
    }
    addQuery(queries, scopedInsightQuery(base, "is:unread", selectedCategories));
  } else if (analysis.focus === "schedule") {
    for (const term of ["reuniao", "reunião", "agenda", "meeting", "evento"]) {
      addQuery(queries, scopedInsightQuery(base, term, selectedCategories));
    }
  }

  addQuery(queries, scopedInsightQuery(base, "is:important", selectedCategories));
  addQuery(queries, scopedInsightQuery(base, "", selectedCategories));

  return {
    analysis,
    categories: selectedCategories,
    queries: queries.slice(0, 10),
    perQueryLimit: Math.min(
      MAX_INSIGHT_RESULTS_PER_QUERY,
      Math.max(20, Math.ceil(Number(maxResults || DEFAULT_INSIGHT_SCAN_RESULTS) / Math.max(queries.length || 1, 1)) + 12)
    )
  };
}

function buildInsightPrompt({ question, context }) {
  const evidence = context.emails.map((email, index) => ({
    index: index + 1,
    type: email._kind || classifyEmail(email),
    direction: emailDirection(email),
    relevanceScore: email._score,
    whySelected: email._reasons || [],
    subject: email.subject,
    from: email.from,
    to: email.to || "",
    date: email.date,
    snippet: email.snippet,
    bodyPreview: email.bodyPreview
  }));

  return {
    model: "gpt-4.1-mini",
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text:
              "Voce e um analista de inteligencia pessoal sobre a caixa de email do proprio usuario. Sua funcao nao e resumir emails soltos; e extrair insights acionaveis, padroes, riscos, oportunidades, lacunas e proximos passos. Use somente as evidencias fornecidas. Nao invente fatos, nomes, valores ou prazos. Se a evidencia for fraca, diga claramente. Responda em portugues do Brasil. Para cada insight, classifique operationalType e recomende somente acoes existentes no produto: generate_note, prepare_reply, apply_label, mark_read, archive. Se a melhor acao for organizar informacao, use generate_note com preview estruturado. So use prepare_reply quando houver conversa humana que realmente peca resposta. Nao prometa calendario externo, tarefas externas, WhatsApp, planilhas ou automacoes que nao existem. Retorne somente JSON valido, sem markdown."
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: [
              `Pergunta de insight do usuario: ${question}`,
              "",
              `Janela analisada: ultimos ${context.analysis.days} dias`,
              `Emails escaneados antes do ranking: ${context.totalScanned}`,
              `Evidencias enviadas para analise: ${context.emails.length}`,
              "Direcao das evidencias: recebido significa email recebido pelo usuario; enviado significa email que o usuario mandou. Nunca trate email enviado pelo usuario como cobranca recebida ou tarefa pedida ao usuario, a menos que a propria pergunta peça promessas/itens enviados pelo usuario.",
              "",
              "Regras para operationalType e recommendedActions:",
              "- conta_a_pagar: primeira acao generate_note com label como Criar pendencia; depois apply_label ou mark_read.",
              "- pagamento_quitado: primeira acao generate_note com label como Registrar quitado; nao use prepare_reply.",
              "- resposta_necessaria: primeira acao prepare_reply.",
              "- oportunidade_comercial: generate_note para briefing e prepare_reply se houver contato humano.",
              "- negociacao_contrato: generate_note para briefing de negociacao e prepare_reply se houver decisao/resposta humana.",
              "- newsletter_ruido: archive ou apply_label; nao use generate_note como principal.",
              "- documento_para_organizar/informacao_para_salvar: generate_note.",
              "A frase offer deve bater exatamente com o primeiro botao recomendado.",
              "",
              "Consultas usadas no Gmail:",
              JSON.stringify(context.queryPlan, null, 2),
              "",
              "Evidencias:",
              JSON.stringify(evidence, null, 2),
              "",
              "Retorne JSON exatamente neste formato:",
              JSON.stringify(
                {
                  summary: "Resposta direta em ate 3 frases, com a principal conclusao.",
                  confidence: "alta | media | baixa",
                  insights: [
                    {
                      type: "oportunidade | risco | padrao | pendencia | ruido | pergunta_aberta",
                      operationalType: "conta_a_pagar | pagamento_quitado | resposta_necessaria | oportunidade_comercial | reuniao_agenda | documento_para_organizar | newsletter_ruido | promessa_recebida | promessa_feita_por_mim | risco_futuro | contato_importante | informacao_para_salvar | negociacao_contrato",
                      title: "Titulo curto do insight",
                      claim: "O que parece estar acontecendo.",
                      whyItMatters: "Por que isso importa para o usuario.",
                      nextAction: "Proxima acao concreta coerente com operationalType.",
                      recommendedActions: [
                        {
                          kind: "generate_note | prepare_reply | apply_label | mark_read | archive",
                          label: "Texto curto do botao",
                          offer: "Frase curta do agente que bate exatamente com o botao principal.",
                          labelValue: "Nome da label, se kind for apply_label.",
                          preview: "Conteudo inicial estruturado, se kind for generate_note ou prepare_reply."
                        }
                      ],
                      evidenceIndexes: [1],
                      confidence: "alta | media | baixa"
                    }
                  ],
                  blindSpots: ["O que nao da para concluir com as evidencias atuais."],
                  suggestedQueries: ["Pergunta ou busca melhor para aprofundar."]
                },
                null,
                2
              )
            ].join("\n")
          }
        ]
      }
    ]
  };
}

function parseJsonObject(text) {
  const trimmed = String(text || "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("Resposta de insight nao veio em JSON.");
  }
}

function fallbackInsightResponse(question, context, rawText = "") {
  const top = context.emails.slice(0, 5);
  return {
    summary:
      rawText && !rawText.startsWith("OPENAI_API_KEY ausente")
        ? rawText.slice(0, 600)
        : "Ainda nao foi possivel gerar uma sintese de IA. Abaixo estao as evidencias mais relevantes encontradas para a pergunta.",
    confidence: "baixa",
    insights: top.map((email, index) => ({
      type: email._kind === "comercial" ? "oportunidade" : email._kind === "pendencia" ? "pendencia" : "padrao",
      operationalType: email._kind === "comercial" ? "oportunidade_comercial" : email._kind === "pendencia" ? "resposta_necessaria" : "informacao_para_salvar",
      title: email.subject,
      claim: `Evidencia encontrada de ${email.from}.`,
      whyItMatters: (email._reasons || []).join(", ") || "Foi ranqueado como relevante para a pergunta.",
      nextAction: "Gerar uma nota organizada para revisar a evidencia antes de agir.",
      recommendedActions: [
        {
          kind: "generate_note",
          label: "Gerar nota",
          offer: "Quer que eu gere uma nota organizada com esta evidência?",
          preview: `# Nota organizada\n\nAssunto: ${email.subject}\nRemetente: ${email.from}\nData: ${email.date}\n\n${email.snippet || email.bodyPreview || ""}`
        },
        {
          kind: "apply_label",
          label: "Aplicar label",
          labelValue: "MailFlow/Revisar"
        }
      ],
      evidenceIndexes: [index + 1],
      confidence: "baixa"
    })),
    blindSpots: ["Sem resposta estruturada da IA, as conclusoes ficam limitadas ao ranking de evidencias."],
    suggestedQueries: [question]
  };
}

function extractLabel(message) {
  const match =
    message.match(/label\s+["']?([^"'\n]+)["']?/i) ||
    message.match(/etiqueta\s+["']?([^"'\n]+)["']?/i);
  return match?.[1]?.trim() || "Follow-up";
}

function buildWritePrompt(kind, userMessage, email) {
  const directives = {
    reply_email:
      "Escreva uma resposta pronta para envio. Seja util, objetiva e respeite o contexto do email original.",
    create_draft:
      "Escreva um rascunho de email claro e profissional, pronto para revisao do usuario."
  };

  return {
    model: "gpt-4.1-mini",
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text:
              "Voce ajuda um usuario a operar a propria caixa postal. Nunca execute a acao; apenas prepare o conteudo para confirmacao explicita."
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `${directives[kind]}\n\nPedido do usuario: ${userMessage}\n\nEmail de referencia:\n${JSON.stringify(email, null, 2)}`
          }
        ]
      }
    ]
  };
}

async function callOpenAI(payload) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const fallback = payload.input[1].content[0].text;
    return `OPENAI_API_KEY ausente. Conteudo de IA indisponivel.\n\nContexto coletado:\n${fallback.slice(0, 1600)}`;
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`OpenAI request failed: ${await response.text()}`);
  }

  const data = await response.json();
  const text =
    data.output_text ||
    data.output
      ?.flatMap((item) => item.content || [])
      .filter((item) => item.type === "output_text" || item.type === "text")
      .map((item) => item.text || "")
      .join("\n")
      .trim();

  if (text) return text;
  if (data.error?.message) throw new Error(`OpenAI response error: ${data.error.message}`);
  throw new Error("A OpenAI respondeu sem texto util.");
}

export async function runInsightAnalysis(userId, options = {}) {
  const question = String(options.question || "").trim();
  if (!question) {
    throw new Error("Pergunta de insight obrigatoria.");
  }

  const maxResults = Math.min(
    MAX_INSIGHT_SCAN_RESULTS,
    Math.max(10, Number(options.maxResults || DEFAULT_INSIGHT_SCAN_RESULTS))
  );
  const plan = buildInsightQueryPlan({
    question,
    timeframe: options.timeframe || "30d",
    query: options.query || "",
    maxResults,
    categories: options.categories || ["primary"]
  });
  const collected = await searchWithPlan(userId, plan);
  const ranked = rankEmails(collected.emails, `${question} ${options.query || ""}`, plan.analysis);
  const useful = ranked.filter((email) => email._kind !== "automatico" || plan.analysis.focus === "security");
  const emails = (useful.length ? useful : ranked).slice(0, Math.min(maxResults, MAX_INSIGHT_EVIDENCE));
  const context = {
    analysis: plan.analysis,
    queryPlan: plan.queries,
    emails,
    totalScanned: collected.emails.length,
    searchFailures: collected.failures
  };

  let parsed;
  let rawText = "";
  try {
    rawText = await callOpenAI(buildInsightPrompt({ question, context }));
    parsed = parseJsonObject(rawText);
  } catch {
    parsed = fallbackInsightResponse(question, context, rawText);
  }

  return {
    ...parsed,
    coverage: {
      timeframe: options.timeframe || "30d",
      days: plan.analysis.days,
      categories: plan.categories,
      scanned: collected.emails.length,
      evidenceCount: emails.length,
      failures: collected.failures
    },
    queryPlan: plan.queries,
    sources: emails.map((email, index) => ({
      index: index + 1,
      id: email.id,
      kind: email._kind || classifyEmail(email),
      direction: emailDirection(email),
      score: email._score,
      reasons: email._reasons || [],
      subject: email.subject,
      from: email.from,
      date: email.date,
      snippet: email.snippet
    }))
  };
}

function firstIndexOfAny(lower, terms) {
  return terms
    .map((term) => lower.indexOf(normalizeText(term)))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
}

function detectWriteIntents(message) {
  const lower = normalizeText(message);
  const candidates = [
    {
      intent: "archive_email",
      index: firstIndexOfAny(lower, ["arquiv"])
    },
    {
      intent: "mark_as_read",
      index:
        lower.includes("marc") && (lower.includes("lido") || lower.includes("leitura"))
          ? firstIndexOfAny(lower, ["marc"])
          : undefined
    },
    {
      intent: "apply_label",
      index: firstIndexOfAny(lower, ["label", "etiqueta"])
    },
    {
      intent: "create_draft",
      index: firstIndexOfAny(lower, ["rascunho"])
    },
    {
      intent: "reply_email",
      index: firstIndexOfAny(lower, ["responda", "responder", "reply", "resposta"])
    }
  ];

  const seen = new Set();
  return candidates
    .filter((candidate) => candidate.index !== undefined)
    .sort((a, b) => a.index - b.index)
    .map((candidate) => candidate.intent)
    .filter((intent) => {
      if (seen.has(intent)) return false;
      seen.add(intent);
      return true;
    });
}

async function findTargetEmailForAction(userId, userMessage) {
  const context = await gatherReadContext(userId, userMessage);
  const target = context.emails.find((email) => email._kind !== "automatico") || context.emails[0];
  if (target) return target;

  const fallback = await searchEmails(userId, normalizeQuery(userMessage), 3);
  return fallback[0] || null;
}

async function prepareWriteAction(userId, userMessage, intent) {
  const target = await findTargetEmailForAction(userId, userMessage);

  if (!target) {
    throw new Error("Nao encontrei um email correspondente para preparar essa acao.");
  }

  if (intent === "archive_email") {
    return {
      answer: `Encontrei o email "${target.subject}" de ${target.from}. Posso arquiva-lo quando voce confirmar.`,
      toolName: "archive_email",
      operation: {
        toolName: "archive_email",
        permissionLevel: 3,
        title: "Arquivar mensagem",
        summary: `Arquivar "${target.subject}"`,
        confirmLabel: "Arquivar",
        editable: false,
        previewText: `Mensagem alvo: ${target.subject}\nRemetente: ${target.from}\nData: ${target.date}`,
        payload: { messageId: target.id }
      }
    };
  }

  if (intent === "mark_as_read") {
    return {
      answer: `Separei o email "${target.subject}" para marcar como lido. A execucao depende da sua confirmacao.`,
      toolName: "mark_as_read",
      operation: {
        toolName: "mark_as_read",
        permissionLevel: 3,
        title: "Marcar como lido",
        summary: `Marcar "${target.subject}" como lido`,
        confirmLabel: "Marcar como lido",
        editable: false,
        previewText: `Mensagem alvo: ${target.subject}\nRemetente: ${target.from}\nData: ${target.date}`,
        payload: { messageId: target.id }
      }
    };
  }

  if (intent === "apply_label") {
    const label = extractLabel(userMessage);
    return {
      answer: `Preparei a aplicacao da label "${label}" no email "${target.subject}". Posso executar quando voce confirmar.`,
      toolName: "apply_label",
      operation: {
        toolName: "apply_label",
        permissionLevel: 3,
        title: "Aplicar label",
        summary: `Aplicar "${label}" em "${target.subject}"`,
        confirmLabel: "Aplicar label",
        editable: true,
        previewText: label,
        payload: { messageId: target.id, label }
      }
    };
  }

  const generatedContent = await callOpenAI(buildWritePrompt(intent, userMessage, target));
  const isDraft = intent === "create_draft";

  return {
    answer: isDraft
      ? `Preparei um rascunho com base em "${target.subject}". Revise abaixo e confirme se quiser criar o draft.`
      : `Preparei uma resposta para "${target.subject}". Revise abaixo e confirme antes de enviar.`,
    toolName: intent,
    operation: {
      toolName: intent,
      permissionLevel: isDraft ? 2 : 3,
      title: isDraft ? "Criar rascunho" : "Enviar resposta",
      summary: isDraft
        ? `Criar rascunho a partir de "${target.subject}"`
        : `Responder "${target.subject}"`,
      confirmLabel: isDraft ? "Criar rascunho" : "Enviar",
      editable: true,
      previewText: generatedContent,
      payload: {
        messageId: target.id,
        threadId: target.threadId,
        content: generatedContent,
        to: target.replyToEmail,
        subject: target.subject.toLowerCase().startsWith("re:")
          ? target.subject
          : `Re: ${target.subject}`,
        references: target.references,
        inReplyTo: target.messageIdHeader
      }
    }
  };
}

export async function prepareReplyForEmail(userId, messageId, instruction = "") {
  const target = await readEmail(userId, messageId);
  const userMessage = instruction || `Responda este email: ${target.subject}`;
  const generatedContent = await callOpenAI(buildWritePrompt("reply_email", userMessage, target));

  return {
    answer: `Preparei uma resposta para "${target.subject}". Revise abaixo e confirme antes de enviar.`,
    toolName: "reply_email",
    operation: {
      toolName: "reply_email",
      permissionLevel: 3,
      title: "Enviar resposta",
      summary: `Responder "${target.subject}"`,
      confirmLabel: "Enviar",
      editable: true,
      previewText: generatedContent,
      payload: {
        messageId: target.id,
        threadId: target.threadId,
        content: generatedContent,
        to: target.replyToEmail,
        subject: target.subject.toLowerCase().startsWith("re:")
          ? target.subject
          : `Re: ${target.subject}`,
        references: target.references,
        inReplyTo: target.messageIdHeader
      }
    }
  };
}

export async function refineDraftWithAI(draft, action, tone = "") {
  const directives = {
    shorten: "Reescreva este rascunho de forma mais curta, clara e objetiva.",
    translate: "Traduza este rascunho para portugues do Brasil, mantendo tom profissional.",
    smart_proof: "Revise gramatica, clareza, coesao e tom profissional deste rascunho.",
    refine_tone: `Reescreva este rascunho no tom ${tone || "profissional"}.`
  };

  return callOpenAI({
    model: "gpt-4.1-mini",
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text:
              "Voce melhora rascunhos de email. Retorne somente o corpo final do email, sem comentarios extras."
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `${directives[action] || directives.smart_proof}\n\nRascunho:\n${draft}`
          }
        ]
      }
    ]
  });
}

export async function runAgent(userId, userMessage) {
  const intents = detectWriteIntents(userMessage);
  if (intents.length === 1) {
    return prepareWriteAction(userId, userMessage, intents[0]);
  }

  if (intents.length > 1) {
    const prepared = [];
    for (const intent of intents) {
      prepared.push(await prepareWriteAction(userId, userMessage, intent));
    }
    return {
      answer: [
        `Preparei ${prepared.length} acoes separadas. Revise cada uma antes de confirmar.`,
        ...prepared.map((item, index) => `${index + 1}. ${item.answer}`)
      ].join("\n"),
      toolName: "multi_action",
      operations: prepared.map((item) => item.operation)
    };
  }

  const toolResult = await gatherReadContext(userId, userMessage);
  const answer = await callOpenAI(buildReadPrompt(userMessage, toolResult));
  return {
    answer,
    toolName: toolResult.toolName,
    emailCount: toolResult.emails.length,
    queryPlan: toolResult.queryPlan,
    sources: toolResult.emails.map((email) => ({
      id: email.id,
      kind: email._kind || classifyEmail(email),
      score: email._score,
      reasons: email._reasons || [],
      subject: email.subject,
      from: email.from,
      date: email.date,
      snippet: email.snippet
    }))
  };
}
