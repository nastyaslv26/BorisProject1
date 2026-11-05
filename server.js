"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const MAX_BODY_BYTES = 8 * 1024;
const moscowDateTimeFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Moscow",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZoneName: "longOffset"
});

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
  );
  CREATE TABLE IF NOT EXISTS feedings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);
const findBookings = database.prepare("SELECT slot_id, full_name FROM bookings WHERE date = ?");
const insertBooking = database.prepare(
  "INSERT INTO bookings (date, slot_id, full_name, created_at) VALUES (?, ?, ?, ?)"
);
const findLatestFeeding = database.prepare(
  "SELECT full_name, created_at FROM feedings ORDER BY id DESC LIMIT 1"
);
const insertFeeding = database.prepare(
  "INSERT INTO feedings (full_name, created_at) VALUES (?, ?)"
);

function getMoscowDateTime() {
  const parts = Object.fromEntries(
    moscowDateTimeFormatter.formatToParts(new Date()).map(({ type, value }) => [type, value])
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const offset = parts.timeZoneName.slice(3);
  return {
    date,
    timestamp: `${date}T${parts.hour}:${parts.minute}:${parts.second}${offset}`
  };
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

function hasJsonContentType(request) {
  return request.headers["content-type"]
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase() === "application/json";
}

function getValidFullName(value) {
  if (typeof value !== "string") return null;
  const fullName = value.trim();
  return fullName && fullName.length <= 100 && !/[\u0000-\u001f\u007f]/.test(fullName)
    ? fullName
    : null;
}

function rejectUnsupportedContentType(request, response) {
  request.pause();
  response.writeHead(415, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Connection": "close"
  });
  response.end(JSON.stringify({
    ok: false,
    error: "Поддерживается только JSON (Content-Type: application/json)."
  }));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let totalBytes = 0;
    let rejected = false;
    const chunks = [];
    const rejectLargeBody = () => {
      rejected = true;
      chunks.length = 0;
      request.pause();
      reject(Object.assign(new Error("Тело запроса слишком большое."), { statusCode: 413 }));
    };

    const contentLength = request.headers["content-length"];
    if (contentLength !== undefined && Number(contentLength) > MAX_BODY_BYTES) {
      rejectLargeBody();
      return;
    }

    request.on("data", (chunk) => {
      if (rejected) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        rejectLargeBody();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (rejected) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
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
    try {
      const { date } = getMoscowDateTime();
      const bookings = new Map(findBookings.all(date).map((booking) => [booking.slot_id, booking.full_name]));
      const latestFeeding = findLatestFeeding.get();
      sendJson(response, 200, {
        date,
        slots: slots.map((slot) => ({ ...slot, fullName: bookings.get(slot.id) || null })),
        lastFeeding: latestFeeding
          ? { fullName: latestFeeding.full_name, time: latestFeeding.created_at }
          : null
      });
    } catch (error) {
      console.error("Could not load schedule:", error.message);
      sendJson(response, 500, { ok: false, error: "Не удалось загрузить расписание." });
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/bookings") {
    if (!hasJsonContentType(request)) {
      rejectUnsupportedContentType(request, response);
      return;
    }

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

    const fullName = getValidFullName(booking.fullName);
    if (!fullName) {
      sendJson(response, 400, { ok: false, error: "Укажите ФИО длиной не более 100 символов." });
      return;
    }

    try {
      const { date, timestamp } = getMoscowDateTime();
      insertBooking.run(date, slot.id, fullName, timestamp);
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

  if (request.method === "POST" && pathname === "/api/feedings") {
    if (!hasJsonContentType(request)) {
      rejectUnsupportedContentType(request, response);
      return;
    }

    let feeding;
    try {
      feeding = await readJsonBody(request);
    } catch (error) {
      sendJson(response, error.statusCode || 400, { ok: false, error: error.message });
      return;
    }

    if (!feeding || typeof feeding !== "object" || Array.isArray(feeding)) {
      sendJson(response, 400, { ok: false, error: "Передайте ФИО сотрудника." });
      return;
    }

    const fullName = getValidFullName(feeding.fullName);
    if (!fullName) {
      sendJson(response, 400, {
        ok: false,
        error: "Укажите корректное ФИО длиной не более 100 символов."
      });
      return;
    }

    try {
      const { timestamp } = getMoscowDateTime();
      insertFeeding.run(fullName, timestamp);
      sendJson(response, 201, { ok: true, message: "Кормление отмечено." });
    } catch (error) {
      console.error("Could not save feeding:", error.message);
      sendJson(response, 500, { ok: false, error: "Не удалось сохранить отметку о кормлении." });
    }
    return;
  }

  if (request.method === "GET" && pathname === "/api/status") {
    sendJson(response, 200, { ok: true, time: getMoscowDateTime().timestamp });
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