export default function healthz(request: any, response: any) {
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(
    JSON.stringify({
      ok: true,
      status: "health-function",
      timestamp: new Date().toISOString()
    })
  );
}
