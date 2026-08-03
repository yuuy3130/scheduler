import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");
const dataDir = path.join(root, "data");
const dataFile = path.join(dataDir, "store.json");
const loadEnvFile = () => {
  const envFile = path.join(root, ".env");
  if (!fs.existsSync(envFile)) return;
  fs.readFileSync(envFile, "utf8").split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) return;
    const [key, ...valueParts] = trimmed.split("=");
    const value = valueParts.join("=").trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  });
};
loadEnvFile();
const port = Number(process.env.PORT || 3100);
const host = process.env.HOST || (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
const baseUrl = process.env.BASE_URL || `http://${host}:${port}`;
const appsScriptWebhookUrl = process.env.APPS_SCRIPT_WEBHOOK_URL || "";
const appsScriptSecret = process.env.APPS_SCRIPT_SECRET || "";
const spreadsheetId = process.env.SPREADSHEET_ID || "1WJCFJmiSZoSTCu0UQK3IBFYzpWq8H-U0gksyzScU8m8";

fs.mkdirSync(dataDir, { recursive: true });
const defaultStore = {
  settings: { timezone: "Asia/Tokyo" },
  members: [
    { id: "hr-kageyama", name: "影山", email: "twice.mado.2597@gmail.com", fixedLink: "https://meet.google.com/gno-eahn-qnd", color: "#087454" },
    { id: "hr-tanaka", name: "田中", email: "yujiro.smzm@gmail.com", fixedLink: "https://meet.google.com/scc-iegf-frg", color: "#2453d6" },
    { id: "hr-onuma", name: "大沼", email: "yamato0216216@gmail.com", fixedLink: "https://meet.google.com/ovf-kwtm-uqc", color: "#d6246b" },
    { id: "hr-kato", name: "加藤", email: "yuuy3130@gmail.com", fixedLink: "https://meet.google.com/cpx-ocjp-qgk", color: "#10b21a" }
  ],
  availabilities: [],
  meetings: []
};
if (!fs.existsSync(dataFile)) fs.writeFileSync(dataFile, JSON.stringify(defaultStore, null, 2));

const readStore = () => ({ ...defaultStore, ...JSON.parse(fs.readFileSync(dataFile, "utf8")) });
const writeStore = (store) => fs.writeFileSync(dataFile, JSON.stringify(store, null, 2));
const id = () => crypto.randomBytes(5).toString("hex");
const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};
const readBody = async (req) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
};
const sendFile = (res, filename, type) => {
  res.writeHead(200, { "content-type": type });
  fs.createReadStream(path.join(publicDir, filename)).pipe(res);
};
const startOfDay = (value) => {
  const date = new Date(value);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
};
const weekStartOf = (value) => {
  const date = startOfDay(value);
  const day = date.getDay();
  date.setDate(date.getDate() - day);
  return date;
};
const addMinutes = (value, minutes) => new Date(new Date(value).getTime() + minutes * 60_000).toISOString();
const overlaps = (aStart, aEnd, bStart, bEnd) => new Date(aStart) < new Date(bEnd) && new Date(aEnd) > new Date(bStart);
const isQuarterHour = (value) => {
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.getSeconds() === 0 && date.getMilliseconds() === 0 && date.getMinutes() % 15 === 0;
};
const normalizeStore = (store) => {
  store.settings ||= defaultStore.settings;
  store.members ||= [];
  store.availabilities ||= [];
  store.meetings ||= [];
  store.members = store.members.map((member) => ({ fixedLink: "", email: "", color: "#2453d6", ...member }));
  const now = Date.now();
  store.availabilities = store.availabilities.filter((slot) => new Date(slot.end).getTime() > now);
  store.meetings = store.meetings.filter((meeting) => new Date(meeting.end).getTime() > now);
  store.availabilities = store.availabilities.filter((slot) => !store.meetings.some((meeting) => (
    meeting.memberId === slot.memberId &&
    overlaps(slot.start, slot.end, meeting.start, meeting.end)
  )));
  return store;
};
const memberBusy = (store, memberId, start, end) => store.meetings.some((meeting) => meeting.memberId === memberId && overlaps(start, end, meeting.start, meeting.end));
const memberAvailabilityExists = (store, memberId, start, end) => store.availabilities.some((slot) => slot.memberId === memberId && overlaps(start, end, slot.start, slot.end));
const notifyAppsScript = async (meeting, member) => {
  if (!appsScriptWebhookUrl) return { status: "disabled" };
  const payload = {
    secret: appsScriptSecret,
    spreadsheetId,
    meeting: {
      id: meeting.id,
      title: meeting.title,
      location: meeting.location,
      start: meeting.start,
      end: meeting.end,
      note: meeting.note,
      createdAt: meeting.createdAt
    },
    member: {
      id: member.id,
      name: member.name,
      email: member.email,
      fixedLink: member.fixedLink
    }
  };
  try {
    const response = await fetch(appsScriptWebhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const text = await response.text();
    if (!response.ok) throw new Error(text || `HTTP ${response.status}`);
    const result = text ? JSON.parse(text) : {};
    if (result.ok === false) {
      return {
        status: "failed",
        error: result.error || result.calendar?.message || result.sheet?.message || "Apps Script側でエラーが発生しました",
        calendar: result.calendar,
        sheet: result.sheet
      };
    }
    return { status: "sent", calendar: result.calendar, sheet: result.sheet };
  } catch (error) {
    console.error("Apps Script連携エラー:", error);
    return { status: "failed", error: error.message || "Apps Script連携に失敗しました" };
  }
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, baseUrl);
  try {
    if (req.method === "GET" && url.pathname === "/api/state") {
      const store = normalizeStore(readStore());
      writeStore(store);
      return json(res, 200, { ...store, baseUrl });
    }

    if (req.method === "POST" && url.pathname === "/api/members") {
      const store = normalizeStore(readStore());
      const body = await readBody(req);
      const name = String(body.name || "").trim();
      if (!name) return json(res, 400, { error: "名前を入力してください" });
      const member = {
        id: id(),
        name,
        email: String(body.email || "").trim(),
        fixedLink: String(body.fixedLink || "").trim(),
        color: body.color || "#2453d6"
      };
      store.members.push(member);
      writeStore(store);
      return json(res, 201, member);
    }

    if (req.method === "PATCH" && url.pathname.startsWith("/api/members/")) {
      const store = normalizeStore(readStore());
      const member = store.members.find((item) => item.id === url.pathname.split("/").pop());
      if (!member) return json(res, 404, { error: "メンバーが見つかりません" });
      const body = await readBody(req);
      if (body.name !== undefined) member.name = String(body.name || "").trim();
      if (body.email !== undefined) member.email = String(body.email || "").trim();
      if (body.fixedLink !== undefined) member.fixedLink = String(body.fixedLink || "").trim();
      if (body.color !== undefined) member.color = body.color;
      writeStore(store);
      return json(res, 200, member);
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/members/")) {
      const store = normalizeStore(readStore());
      const memberId = url.pathname.split("/").pop();
      store.members = store.members.filter((item) => item.id !== memberId);
      store.availabilities = store.availabilities.filter((item) => item.memberId !== memberId);
      store.meetings = store.meetings.filter((item) => item.memberId !== memberId);
      writeStore(store);
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/availabilities") {
      const store = normalizeStore(readStore());
      const body = await readBody(req);
      const member = store.members.find((item) => item.id === body.memberId);
      if (!member) return json(res, 404, { error: "メンバーが見つかりません" });
      const starts = [...new Set(body.starts || [])].map((value) => new Date(value).toISOString());
      if (starts.some((start) => !isQuarterHour(start))) return json(res, 400, { error: "開始時間は15分刻みで選択してください" });
      let created = 0;
      let skipped = 0;
      for (const start of starts) {
        const end = addMinutes(start, Number(body.duration || 60));
        if (memberBusy(store, member.id, start, end) || memberAvailabilityExists(store, member.id, start, end)) {
          skipped++;
          continue;
        }
        store.availabilities.push({ id: id(), memberId: member.id, start, end });
        created++;
      }
      writeStore(store);
      return json(res, 201, { count: created, skipped });
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/availabilities/")) {
      const store = normalizeStore(readStore());
      store.availabilities = store.availabilities.filter((slot) => slot.id !== url.pathname.split("/").pop());
      writeStore(store);
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/meetings") {
      const store = normalizeStore(readStore());
      const body = await readBody(req);
      const member = store.members.find((item) => item.id === body.memberId);
      if (!member) return json(res, 404, { error: "メンバーが見つかりません" });
      const title = String(body.title || "").trim();
      if (!title) return json(res, 400, { error: "予定名を入力してください" });
      const start = new Date(body.start).toISOString();
      if (!isQuarterHour(start)) return json(res, 400, { error: "開始時間は15分刻みで選択してください" });
      const end = addMinutes(start, Number(body.duration || 60));
      if (memberBusy(store, member.id, start, end)) return json(res, 409, { error: "その時間は既に予定が入っています" });
      const meeting = {
        id: id(),
        memberId: member.id,
        title,
        location: String(body.location || member.fixedLink || "").trim(),
        start,
        end,
        note: String(body.note || "").trim(),
        createdAt: new Date().toISOString()
      };
      store.meetings.push(meeting);
      store.availabilities = store.availabilities.filter((slot) => !(slot.memberId === member.id && overlaps(slot.start, slot.end, start, end)));
      writeStore(store);
      const integration = await notifyAppsScript(meeting, member);
      return json(res, 201, { ...meeting, integration });
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/meetings/")) {
      const store = normalizeStore(readStore());
      store.meetings = store.meetings.filter((meeting) => meeting.id !== url.pathname.split("/").pop());
      writeStore(store);
      return json(res, 200, { ok: true });
    }

    if (req.method === "PATCH" && url.pathname.startsWith("/api/meetings/")) {
      const store = normalizeStore(readStore());
      const meeting = store.meetings.find((item) => item.id === url.pathname.split("/").pop());
      if (!meeting) return json(res, 404, { error: "予定が見つかりません" });
      const body = await readBody(req);
      const member = store.members.find((item) => item.id === body.memberId);
      if (!member) return json(res, 404, { error: "メンバーが見つかりません" });
      const title = String(body.title || "").trim();
      if (!title) return json(res, 400, { error: "予定名を入力してください" });
      const start = new Date(body.start).toISOString();
      if (!isQuarterHour(start)) return json(res, 400, { error: "開始時間は15分刻みで選択してください" });
      const end = addMinutes(start, Number(body.duration || 60));
      const conflicts = store.meetings.some((item) => item.id !== meeting.id && item.memberId === member.id && overlaps(start, end, item.start, item.end));
      if (conflicts) return json(res, 409, { error: "その時間は既に予定が入っています" });
      meeting.memberId = member.id;
      meeting.title = title;
      meeting.location = String(body.location || member.fixedLink || "").trim();
      meeting.start = start;
      meeting.end = end;
      meeting.note = String(body.note || "").trim();
      meeting.updatedAt = new Date().toISOString();
      store.availabilities = store.availabilities.filter((slot) => !(slot.memberId === member.id && overlaps(slot.start, slot.end, start, end)));
      writeStore(store);
      return json(res, 200, { ...meeting, integration: { status: "local-only" } });
    }

    if (req.method === "GET" && url.pathname === "/api/week") {
      const start = weekStartOf(url.searchParams.get("start") || new Date()).toISOString();
      const endDate = new Date(start);
      endDate.setDate(endDate.getDate() + 7);
      const end = endDate.toISOString();
      const store = normalizeStore(readStore());
      writeStore(store);
      return json(res, 200, {
        start,
        end,
        members: store.members,
        availabilities: store.availabilities.filter((slot) => new Date(slot.start) >= new Date(start) && new Date(slot.start) < new Date(end)),
        meetings: store.meetings.filter((meeting) => new Date(meeting.start) < new Date(end) && new Date(meeting.end) > new Date(start)),
        upcomingMeetings: store.meetings
          .filter((meeting) => new Date(meeting.end).getTime() > Date.now())
          .sort((a, b) => new Date(a.start) - new Date(b.start))
      });
    }

    if (["/", "/view", "/manage", "/index.html"].includes(url.pathname)) return sendFile(res, "index.html", "text/html; charset=utf-8");
    if (url.pathname === "/app.js") return sendFile(res, "app.js", "text/javascript; charset=utf-8");
    if (url.pathname === "/styles.css") return sendFile(res, "styles.css", "text/css; charset=utf-8");
    res.writeHead(404);
    res.end("Not found");
  } catch (error) {
    console.error(error);
    json(res, 500, { error: error.message || "サーバーエラー" });
  }
});

server.listen(port, host, () => console.log(`社内日程調整ツール: ${baseUrl}`));
