"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const menu = [
  { id: "cinnamon-capibara", name: "Коричная капибара" },
  { id: "vanilla-croissant", name: "Ванильный круассан" },
  { id: "chocolate-croissant", name: "Шоколадный круассан" }
];

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(data));
}

function sendText(response, statusCode, text, contentType = "text/plain; charset=utf-8") {
  response.writeHead(statusCode, { "Content-Type": contentType });
  response.end(text);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(Object.assign(new Error("Некорректный JSON."), { statusCode: 400 }));
      }
    });
    request.on("error", reject);
  });
}

async function handleRequest(request, response) {
  const { pathname } = new URL(request.url || "/", "http://localhost");

  if (request.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    fs.readFile(path.join(__dirname, "index.html"), (error, html) => {
      if (error) {
        sendText(response, 500, "Не удалось загрузить страницу.");
        return;
      }
      sendText(response, 200, html, "text/html; charset=utf-8");
    });
    return;
  }

  if (request.method === "GET" && pathname === "/api/menu") {
    sendJson(response, 200, { items: menu });
    return;
  }

  if (request.method === "POST" && pathname === "/api/selection") {
    let selection;
    try {
      selection = await readJsonBody(request);
    } catch (error) {
      sendJson(response, error.statusCode || 400, { ok: false, error: error.message });
      return;
    }

    if (!selection || typeof selection !== "object" || Array.isArray(selection) || typeof selection.id !== "string") {
      sendJson(response, 400, { ok: false, error: "Укажите идентификатор позиции в поле id." });
      return;
    }

    const item = menu.find((entry) => entry.id === selection.id);
    if (!item) {
      sendJson(response, 400, { ok: false, error: "Неизвестный идентификатор позиции." });
      return;
    }

    sendJson(response, 200, {
      ok: true,
      message: "Выбор подтверждён локально; он не сохранён.",
      item
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/reset") {
    sendJson(response, 200, { ok: true, message: "Выбор сброшен." });
    return;
  }

  if (request.method === "GET" && pathname === "/api/status") {
    sendJson(response, 200, { ok: true, time: new Date().toISOString() });
    return;
  }

  sendJson(response, 404, { ok: false, error: "Маршрут не найден." });
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch(() => {
    if (!response.headersSent) {
      sendJson(response, 500, { ok: false, error: "Внутренняя ошибка сервера." });
    }
  });
});

const port = process.env.PORT === undefined || process.env.PORT === "" ? 3000 : Number(process.env.PORT);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error("PORT должен быть целым числом от 0 до 65535.");
}

server.listen(port, "0.0.0.0", () => {
  const address = server.address();
  if (address && typeof address === "object") {
    console.log(`Server listening on http://0.0.0.0:${address.port}`);
  }
});