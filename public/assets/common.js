async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    ...options
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Erro inesperado");
  return data;
}

function el(id) {
  return document.getElementById(id);
}
