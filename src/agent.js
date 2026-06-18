import { readEmail, searchEmails } from "./google.js";

const STOPWORDS = new Set([
  "a", "as", "o", "os", "de", "do", "da", "dos", "das", "e", "em", "na", "no",
  "nas", "nos", "para", "por", "com", "sem", "uma", "um", "me", "minha", "meu",
  "que", "quais", "qual", "ultimas", "ultima", "ultimos", "ultimo", "sobre",
  "caixa", "emails", "e-mails", "email", "digam", "respeito"
]);

function normalizeQuery(message) {
  const lower = message.toLowerCase();
  if (lower.includes("hoje")) return "newer_than:1d";
  if (lower.includes("ontem")) return "newer_than:2d older_than:1d";
  if (lower.includes("nao lidos") || lower.includes("não lidos")) return "is:unread newer_than:30d";
  if (lower.includes("importantes")) return "is:important newer_than:14d";
  if (lower.includes("pendenc")) return "label:inbox newer_than:14d";
  if (lower.includes("comercial") || lower.includes("venda") || lower.includes("cliente") || lower.includes("negocio") || lower.includes("negócio")) {
    return "newer_than:90d -from:accounts.google.com -from:google.com -category:social -category:promotions";
  }
  if (lower.includes("semana") || lower.includes("7 dias")) return "newer_than:7d";
  return "newer_than:30d";
}

function buildQueryPlan(message) {
  const lower = message.toLowerCase();
  const queries = [normalizeQuery(message)];

  if (lower.includes("comercial") || lower.includes("cliente") || lower.includes("negocio") || lower.includes("negócio")) {
    queries.push("newer_than:180d (label:sent OR in:anywhere) -from:accounts.google.com -from:google.com");
    queries.push("newer_than:365d -category:promotions -category:social");
  }

  if (lower.includes("ultim") || lower.includes("ultima") || lower.includes("última")) {
    queries.push("newer_than:60d");
  }

  return [...new Set(queries)];
}

function classifyEmail(email) {
  const from = `${email.from} ${email.subject} ${email.snippet}`.toLowerCase();
  if (
    from.includes("no-reply") ||
    from.includes("noreply") ||
    from.includes("alerta de segur") ||
    from.includes("verificação em duas etapas") ||
    from.includes("accounts.google.com") ||
    from.includes("google")
  ) {
    return "alerta";
  }
  if (
    from.includes("proposta") ||
    from.includes("reuni") ||
    from.includes("cliente") ||
    from.includes("follow-up") ||
    from.includes("orcamento") ||
    from.includes("orçamento") ||
    from.includes("comercial") ||
    from.includes("contrato")
  ) {
    return "comercial";
  }
  return "geral";
}

function extractKeywords(message) {
  return message
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 2 && !STOPWORDS.has(word));
}

function scoreEmailForQuestion(email, userMessage) {
  const lowerMessage = userMessage.toLowerCase();
  const haystack = `${email.subject}\n${email.from}\n${email.snippet}\n${email.bodyPreview}`.toLowerCase();
  const kind = classifyEmail(email);
  const keywords = extractKeywords(userMessage);
  let score = 0;

  for (const keyword of keywords) {
    if (haystack.includes(keyword)) score += 4;
  }

  if (kind === "comercial") score += 6;
  if (kind === "alerta") score -= 8;
  if (lowerMessage.includes("comercial") || lowerMessage.includes("cliente") || lowerMessage.includes("negócio") || lowerMessage.includes("negocio")) {
    if (kind === "comercial") score += 8;
    if (kind === "alerta") score -= 12;
  }
  if (lowerMessage.includes("hoje") && email.date.toLowerCase().includes(new Date().toDateString().slice(4).toLowerCase())) {
    score += 2;
  }
  return score;
}

function detectIntent(message) {
  const lower = message.toLowerCase();
  if (lower.includes("arquiv")) return "archive_email";
  if (lower.includes("marc") && (lower.includes("lido") || lower.includes("leitura"))) return "mark_as_read";
  if (lower.includes("label") || lower.includes("etiqueta")) return "apply_label";
  if (lower.includes("rascunho")) return "create_draft";
  if (lower.includes("responda") || lower.includes("responder") || lower.includes("reply")) return "reply_email";
  return "read";
}

async function summarizeEmails(userId, query) {
  const emails = await searchEmails(userId, query, 5);
  return {
    toolName: "summarize_emails",
    emails
  };
}

function buildReadPrompt(userMessage, emails, queryPlan) {
  const condensed = emails.map((email, index) => ({
    index: index + 1,
    type: classifyEmail(email),
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
              "Voce analisa emails do proprio usuario. Nunca invente emails. Responda em portugues do Brasil. Seja objetivo e aderente apenas a pergunta atual. Ignore lixo irrelevante. Estruture em: resposta direta, pontos-chave e observacoes curtas. Se a pergunta pedir interacoes comerciais, priorize clientes, parceiros, negociacoes, follow-ups e propostas; descarte alertas automatizados."
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Pedido do usuario: ${userMessage}\n\nConsultas usadas no Gmail:\n${JSON.stringify(queryPlan, null, 2)}\n\nEmails encontrados:\n${JSON.stringify(condensed, null, 2)}`
          }
        ]
      }
    ]
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
              "Voce ajuda um usuario a operar a propria caixa postal. Nunca execute a acao; apenas prepare o conteudo para confirmacao."
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
    return `OPENAI_API_KEY ausente. Conteudo de IA indisponivel.\n\nContexto coletado:\n${fallback.slice(0, 1200)}`;
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

  if (text) {
    return text;
  }

  if (data.error?.message) {
    throw new Error(`OpenAI response error: ${data.error.message}`);
  }

  throw new Error("A OpenAI respondeu sem texto util.");
}

function dedupeEmails(emails) {
  const seen = new Set();
  return emails.filter((email) => {
    if (seen.has(email.id)) return false;
    seen.add(email.id);
    return true;
  });
}

function pickRelevantEmails(emails, userMessage) {
  return emails
    .map((email) => ({
      ...email,
      _score: scoreEmailForQuestion(email, userMessage),
      _kind: classifyEmail(email)
    }))
    .filter((email) => email._score > -3)
    .sort((a, b) => b._score - a._score)
    .slice(0, 6);
}

async function gatherReadContext(userId, userMessage) {
  const queryPlan = buildQueryPlan(userMessage);
  const collected = [];

  for (const query of queryPlan) {
    const emails = await searchEmails(userId, query, 6);
    collected.push(...emails);
  }

  const emails = pickRelevantEmails(dedupeEmails(collected), userMessage);
  return {
    toolName: "search_emails",
    queryPlan,
    emails
  };
}

async function prepareWriteAction(userId, userMessage, intent) {
  const emails = await searchEmails(userId, normalizeQuery(userMessage), 3);
  const target = emails[0];

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
  const intent = detectIntent(userMessage);
  if (intent !== "read") {
    return prepareWriteAction(userId, userMessage, intent);
  }

  const toolResult = await gatherReadContext(userId, userMessage);
  const answer = await callOpenAI(buildReadPrompt(userMessage, toolResult.emails, toolResult.queryPlan));
  return {
    answer,
    toolName: toolResult.toolName,
    emailCount: toolResult.emails.length,
    queryPlan: toolResult.queryPlan,
    sources: toolResult.emails.map((email) => ({
      id: email.id,
      kind: email._kind || classifyEmail(email),
      subject: email.subject,
      from: email.from,
      date: email.date,
      snippet: email.snippet
    }))
  };
}
