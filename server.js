"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const slots = [
  { id: "09:00", time: "09:00" },
  { id: "11:00", time: "11:00" },
  { id: "13:00", time: "13:00" },
  { id: "15:00", time: "15:00" },
  { id: "17:00", time: "17:00" }
];
const defaultDatabasePath = process.env.AMVERA === "1"
  ? path.join("/data", "boris.sqlite")
  : path.join(__dirname, "data", "boris.sqlite");
const databasePath = process.env.DATABASE_PATH || defaultDatabasePath;
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
const database = new Database(databasePath);
database.pragma("journal_mode = WAL");
database.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    date TEXT NOT NULL,
    slot_id TEXT NOT NULL,
    full_name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (date, slot_id)
  )
`);
const findBookings = database.prepare("SELECT slot_id, full_name FROM bookings WHERE date = ?");
const insertBooking = database.prepare(
  "INSERT INTO bookings (date, slot_id, full_name) VALUES (?, ?, ?)"
);

function getCurrentDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.APP_TIME_ZONE || "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const dateParts = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
}

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

  if (request.method === "GET" && pathname === "/assets/corgi.png") {
    fs.readFile(path.join(__dirname, "assets", "corgi.png"), (error, image) => {
      if (error) {
        console.error("Could not read corgi image:", error.message);
        sendJson(response, 500, { ok: false, error: "Не удалось загрузить изображение." });
        return;
      }
      response.writeHead(200, {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=3600"
      });
      response.end(image);
    });
    return;
  }

  if (request.method === "GET" && pathname === "/api/state") {
    const date = getCurrentDate();
    const bookings = new Map(findBookings.all(date).map((booking) => [booking.slot_id, booking.full_name]));
    sendJson(response, 200, {
      date,
      slots: slots.map((slot) => ({ ...slot, fullName: bookings.get(slot.id) || null })),
      lastFeeding: null
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/bookings") {
    let booking;
    try {
      booking = await readJsonBody(request);
    } catch (error) {
      sendJson(response, error.statusCode || 400, { ok: false, error: error.message });
      return;
    }

    if (!booking || typeof booking !== "object" || Array.isArray(booking)) {
      sendJson(response, 400, { ok: false, error: "Передайте слот и ФИО." });
      return;
    }

    const slot = slots.find((entry) => entry.id === booking.slotId);
    if (!slot) {
      sendJson(response, 400, { ok: false, error: "Выберите время из расписания." });
      return;
    }

    const fullName = typeof booking.fullName === "string" ? booking.fullName.trim() : "";
    if (!fullName || fullName.length > 100) {
      sendJson(response, 400, { ok: false, error: "Укажите ФИО длиной не более 100 символов." });
      return;
    }

    try {
      insertBooking.run(getCurrentDate(), slot.id, fullName);
    } catch (error) {
      if (error.code && error.code.startsWith("SQLITE_CONSTRAINT")) {
        sendJson(response, 409, { ok: false, error: "Это время уже занято." });
        return;
      }
      throw error;
    }

    sendJson(response, 201, { ok: true, slot: { ...slot, fullName } });
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