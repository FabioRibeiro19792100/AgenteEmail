export default async function vercelHandler(req, res) {
  try {
    const { handler } = await import("../src/server.js");
    return handler(req, res);
  } catch (error) {
    console.error("Vercel boot error", error);
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(
      JSON.stringify({
        error: "Falha ao carregar o backend.",
        detail: error?.message || "Erro desconhecido no boot da funcao."
      })
    );
  }
}
