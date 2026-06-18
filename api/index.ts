export default async function vercelHandler(request: any, response: any) {
  try {
    const { handler } = await import("../src/server.js");
    return await handler(request, response);
  } catch (error: any) {
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
