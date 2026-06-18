function toNodeHeaders(headers) {
  return Object.fromEntries(headers.entries());
}

function toNodeRequest(request) {
  const url = new URL(request.url);
  return {
    method: request.method,
    url: `${url.pathname}${url.search}`,
    headers: toNodeHeaders(request.headers),
    async *[Symbol.asyncIterator]() {
      const body = await request.arrayBuffer();
      if (body.byteLength) yield Buffer.from(body);
    }
  };
}

function createNodeResponse() {
  let status = 200;
  const headers = {};
  const chunks = [];
  let resolve;
  const completed = new Promise((done) => {
    resolve = done;
  });

  return {
    response: {
      writeHead(nextStatus, nextHeaders = {}) {
        status = nextStatus;
        Object.assign(headers, nextHeaders);
      },
      setHeader(name, value) {
        headers[name] = value;
      },
      end(chunk = "") {
        if (chunk) chunks.push(chunk);
        const body = chunks.length
          ? Buffer.concat(chunks.map((item) => (Buffer.isBuffer(item) ? item : Buffer.from(String(item)))))
          : undefined;
        resolve(new Response(body, { status, headers }));
      }
    },
    completed
  };
}

async function dispatch(request) {
  try {
    const { handler } = await import("../src/server.js");
    const nodeReq = toNodeRequest(request);
    const { response: nodeRes, completed } = createNodeResponse();
    await handler(nodeReq, nodeRes);
    return completed;
  } catch (error) {
    console.error("Vercel boot error", error);
    return Response.json(
      {
        error: "Falha ao carregar o backend.",
        detail: error?.message || "Erro desconhecido no boot da funcao."
      },
      { status: 500, headers: { "cache-control": "no-store" } }
    );
  }
}

export default {
  fetch: dispatch
};
