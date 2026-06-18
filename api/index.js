export default async function vercelHandler(request, response) {
  try {
    const { handler } = await import("../src/server.js");
    return handler(request, response);
  } catch (error) {
    console.error("Vercel boot error", error);
    response.writeHead(500, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    });
    response.end(
      JSON.stringify({
        error: "Falha ao carregar o backend.",
        detail: error?.message || "Erro desconhecido no boot da funcao."
      })
    );
  }
}
