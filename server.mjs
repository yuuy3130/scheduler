import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(root, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}
const publicDir = path.join(root, "public");
const dataDir = path.join(root, "data");
const dataFile = path.join(dataDir, "store.json");
const seedFile = path.join(dataDir, "seed.json");
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
const baseUrl = process.env.BASE_URL || `http://localhost:${port}`;

fs.mkdirSync(dataDir, { recursive: true });
const defaultStore = {
  settings: { teamName: "採用チーム", notificationEmail: "frt.shibuya@gmail.com", calendarEmail: "frt.shibuya@gmail.com", timezone: "Asia/Tokyo" },
  google: {},
  interviewers: [],
  availabilities: [],
  links: [],
  blocks: [],
  bookings: []
};
const loadSeedStore = () => {
  if (!fs.existsSync(seedFile)) return defaultStore;
  try {
    return { ...defaultStore, ...JSON.parse(fs.readFileSync(seedFile, "utf8")), google: {} };
  } catch {
    return defaultStore;
  }
};
const storeHasOperationalData = (store) => Boolean(store.interviewers?.length || store.availabilities?.length || store.bookings?.length || store.google?.accessToken);
if (!fs.existsSync(dataFile)) {
  fs.writeFileSync(dataFile, JSON.stringify(loadSeedStore(), null, 2));
}

const useSupabase = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
async function supabaseRequest(pathname, options = {}) {
  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1${pathname}`, {
    ...options,
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  const result = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(result?.message || "Supabaseの読み書きに失敗しました");
  return result;
}
async function readStore() {
  if (!useSupabase) return JSON.parse(fs.readFileSync(dataFile, "utf8"));
  const local = fs.existsSync(dataFile) ? JSON.parse(fs.readFileSync(dataFile, "utf8")) : defaultStore;
  const seed = loadSeedStore();
  const fallback = storeHasOperationalData(local) ? local : seed;
  let rows;
  try {
    rows = await supabaseRequest("/app_state?id=eq.main&select=data");
  } catch (error) {
    console.warn("Supabaseに接続できないため、ローカル保存データを使用します:", error.message);
    return fallback;
  }
  if (rows?.[0]?.data) {
    const remote = rows[0].data;
    const remoteEmpty = !storeHasOperationalData(remote);
    if (remoteEmpty && storeHasOperationalData(fallback)) {
      await writeStore(fallback);
      return fallback;
    }
    if (!remote.interviewers?.length && fallback.interviewers?.length) {
      const restored = {
        ...remote,
        interviewers: fallback.interviewers || [],
        availabilities: remote.availabilities?.length ? remote.availabilities : (fallback.availabilities || []),
        links: remote.links?.length ? remote.links : (fallback.links || []),
        blocks: remote.blocks?.length ? remote.blocks : (fallback.blocks || []),
        bookings: remote.bookings?.length ? remote.bookings : (fallback.bookings || [])
      };
      await writeStore(restored);
      return restored;
    }
    return remote;
  }
  await writeStore(fallback);
  return fallback;
}
async function writeStore(data) {
  fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));
  if (!useSupabase) return;
  try {
    await supabaseRequest("/app_state", {
      method: "POST",
      headers: { prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ id: "main", data, updated_at: new Date().toISOString() })
    });
  } catch (error) {
    console.warn("Supabaseに保存できないため、ローカル保存のみ行いました:", error.message);
  }
}
const localTimeParts = (value, timezone = "Asia/Tokyo") => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date(value));
  return {
    hour: Number(parts.find((part) => part.type === "hour")?.value || 0),
    minute: Number(parts.find((part) => part.type === "minute")?.value || 0)
  };
};
const isAllowedAvailabilityStart = (start, timezone = "Asia/Tokyo") => {
  const { hour, minute } = localTimeParts(start, timezone);
  return minute === 0 && hour >= 10 && hour <= 20;
};
const normalizeStore = (store) => {
  store.settings = { teamName: "採用チーム", notificationEmail: "frt.shibuya@gmail.com", calendarEmail: "frt.shibuya@gmail.com", timezone: "Asia/Tokyo", ...(store.settings || {}) };
  store.interviewers ||= [];
  store.availabilities ||= [];
  store.links ||= [];
  store.blocks ||= [];
  store.bookings ||= [];
  store.interviewers.forEach((item, index) => {
    if (!Number.isFinite(item.priority)) item.priority = index + 1;
    item.email ||= "";
    item.meetUrl ||= "";
  });
  store.interviewers.sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));
  store.interviewers.forEach((item, index) => { item.priority = index + 1; });
  const todayKey = localDateKey(new Date(), store.settings.timezone);
  store.availabilities = store.availabilities.filter((item) => localDateKey(item.start, store.settings.timezone) > todayKey && isAllowedAvailabilityStart(item.start, store.settings.timezone));
  store.blocks = [];
  store.bookings = store.bookings.filter((item) => {
    const duration = item.duration || store.links.find((link) => link.id === item.linkId)?.duration || 60;
    return new Date(item.start).getTime() + duration * 60_000 > Date.now();
  });
  store.bookings.forEach((item) => {
    item.interviewerId ||= bookingInterviewerId(store, item);
    item.duration ||= store.links.find((link) => link.id === item.linkId)?.duration || 60;
  });
  for (const link of store.links) {
    if (!link.interviewerId) {
      let interviewer = store.interviewers.find((item) => item.name === link.interviewer);
      if (!interviewer) {
        interviewer = { id: id(), name: link.interviewer || "面接官", email: "", meetUrl: "", createdAt: new Date().toISOString() };
        store.interviewers.push(interviewer);
      }
      link.interviewerId = interviewer.id;
      for (const start of link.slots || []) {
        if (localDateKey(start, store.settings.timezone) > todayKey && !store.availabilities.some((item) => item.interviewerId === interviewer.id && item.start === start)) {
          store.availabilities.push({ id: id(), interviewerId: interviewer.id, start });
        }
      }
    }
  }
  return store;
};
const id = () => crypto.randomBytes(5).toString("hex");
const commonLink = () => ({ id: "all", title: "面接", interviewer: "面接官", duration: 60, active: true });
const bookingInterviewerId = (store, booking) => booking.interviewerId || store.links.find((link) => link.id === booking.linkId)?.interviewerId || "";
const isInterviewerBooked = (store, interviewerId, slotStart, duration = 60) => {
  const start = new Date(slotStart).getTime();
  const end = start + duration * 60_000;
  return store.bookings.some((booking) => {
    if (bookingInterviewerId(store, booking) !== interviewerId) return false;
    const bookingLink = store.links.find((link) => link.id === booking.linkId);
    const bookingStart = new Date(booking.start).getTime();
    const bookingEnd = bookingStart + (booking.duration || bookingLink?.duration || 60) * 60_000;
    return start < bookingEnd && end > bookingStart;
  });
};
const isBlocked = (store, interviewerId, slotStart, duration = 60) => {
  const start = new Date(slotStart).getTime();
  const end = start + duration * 60_000;
  return store.blocks.some((block) => (!block.interviewerId || block.interviewerId === interviewerId) && start < new Date(block.end).getTime() && end > new Date(block.start).getTime());
};
const availableInterviewersForSlot = (store, slotStart) => {
  const todayKey = localDateKey(new Date(), store.settings.timezone);
  if (localDateKey(slotStart, store.settings.timezone) <= todayKey) return [];
  const interviewerIds = new Set(store.availabilities.filter((item) => item.start === slotStart).map((item) => item.interviewerId));
  return store.interviewers
    .filter((interviewer) => interviewerIds.has(interviewer.id))
    .filter((interviewer) => !isInterviewerBooked(store, interviewer.id, slotStart, 60) && !isBlocked(store, interviewer.id, slotStart, 60))
    .sort((a, b) => a.priority - b.priority);
};
const aggregateSlots = (store) => {
  const starts = [...new Set(store.availabilities.map((item) => item.start))].sort((a, b) => new Date(a) - new Date(b));
  return starts.map((start) => ({ start, count: availableInterviewersForSlot(store, start).length })).filter((item) => item.count > 0);
};
const candidateVisibleDateKeys = (store, days = 5) => {
  const keys = [];
  const now = new Date();
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (let offset = 1; offset <= days; offset++) {
    const date = new Date(base);
    date.setDate(base.getDate() + offset);
    keys.push(localDateKey(date, store.settings.timezone));
  }
  return new Set(keys);
};
const isCandidateVisibleSlot = (store, start) => candidateVisibleDateKeys(store).has(localDateKey(start, store.settings.timezone));
const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};
const readBody = async (req) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
};
const localDateKey = (value, timezone = "Asia/Tokyo") => new Intl.DateTimeFormat("sv-SE", {
  timeZone: timezone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
}).format(new Date(value));
const infraMessageUrl = "https://enterprise.in-fra.jp/messages/1824768";
const formatDateTime = (value, timezone = "Asia/Tokyo") => new Intl.DateTimeFormat("ja-JP", {
  timeZone: timezone,
  year: "numeric",
  month: "long",
  day: "numeric",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit"
}).format(new Date(value));
const googleDateTime = (value, timezone = "Asia/Tokyo") => {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(new Date(value));
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
};
const base64url = (value) => Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

async function googleRequest(store, url, options = {}) {
  let token = store.google.accessToken;
  if (!token) throw new Error("Googleカレンダーが未連携です");
  if (Date.now() >= (store.google.expiresAt || 0) - 60_000 && store.google.refreshToken) {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID || "",
        client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
        refresh_token: store.google.refreshToken,
        grant_type: "refresh_token"
      })
    });
    const fresh = await response.json();
    if (!response.ok) {
      const reason = [fresh.error, fresh.error_description].filter(Boolean).join(": ");
      const reconnectHint = "Google連携の有効期限が切れている可能性があります。管理画面からGoogle連携をやり直してください";
      throw new Error(reason ? `${reconnectHint}（${reason}）` : reconnectHint);
    }
    token = fresh.access_token;
    store.google.accessToken = token;
    store.google.expiresAt = Date.now() + fresh.expires_in * 1000;
    await writeStore(store);
  }
  const response = await fetch(url, {
    ...options,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(options.headers || {}) }
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const details = (result.error?.errors || [])
      .map((item) => item.message || item.reason)
      .filter(Boolean)
      .join(" / ");
    throw new Error([result.error?.message, details].filter(Boolean).join(": ") || "Google APIでエラーが発生しました");
  }
  return result;
}

async function createCalendarEvent(store, link, booking) {
  const end = new Date(new Date(booking.start).getTime() + link.duration * 60_000).toISOString();
  const interviewer = store.interviewers.find((item) => item.id === (booking.interviewerId || link.interviewerId));
  const calendarId = encodeURIComponent(store.settings.calendarEmail || "frt.shibuya@gmail.com");
  const timezone = store.settings.timezone || "Asia/Tokyo";
  const meetUrl = booking.meetUrl || interviewer?.meetUrl || "";
  return googleRequest(store, `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`, {
    method: "POST",
    body: JSON.stringify({
      summary: `【1次面接】${booking.candidateName}様-${interviewer?.name || link.interviewer}-`,
      description: `面接調整リンクから確定しました。\n面接官: ${interviewer?.name || link.interviewer}\n候補者: ${booking.candidateName}\n面接URL: ${meetUrl || "未設定"}`,
      ...(meetUrl ? { location: meetUrl } : {}),
      start: { dateTime: googleDateTime(booking.start, timezone), timeZone: timezone },
      end: { dateTime: googleDateTime(end, timezone), timeZone: timezone }
    })
  });
}
async function sendBookingNotification(store, booking) {
  if (!store.google.accessToken) return null;
  const interviewer = store.interviewers.find((item) => item.id === booking.interviewerId);
  const recipients = [...new Set(store.interviewers.map((item) => item.email).concat(store.settings.notificationEmail))]
    .map((email) => (email || "").trim())
    .filter((email) => email && email.includes("@"));
  if (!recipients.length) return null;
  const subject = `面接が設定されました：${booking.candidateName}様`;
  const body = [
    "面接が設定されました。",
    "",
    `日時：${formatDateTime(booking.start, store.settings.timezone)}`,
    `候補者名：${booking.candidateName}`,
    `面接官：${interviewer?.name || "未設定"}`,
    `URL：${booking.meetUrl || "未発行"}`,
    `インフラメッセージ：${infraMessageUrl}`,
    "",
    "上記インフラメッセージ上で候補者へ返信してください。",
    "",
    "--以下infra送信分--",
    "{name}様",
    "",
    "ご連絡ありがとうございます。",
    "下記の通りで面談を確定させていただきました。",
    "",
    "内容をご確認いただけましたらご返信いただきますようお願いいたします。",
    "",
    "◆面談開始時刻",
    formatDateTime(booking.start, store.settings.timezone),
    "◆場所（オンライン）",
    "〜URL〜",
    booking.meetUrl || "未発行",
    "",
    "当日はこちらのURLからよろしくお願いいたします。",
    "",
    "以上、ご確認のほどよろしくお願いいたします。",
    "",
    "フロンティア株式会社 採用担当"
  ].join("\n");
  const raw = [
    `To: ${recipients.join(", ")}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    body
  ].join("\r\n");
  return googleRequest(store, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    body: JSON.stringify({ raw: base64url(raw) })
  });
}
async function deleteCalendarEvent(store, booking) {
  if (!store.google.accessToken || !booking.calendarEventId) return;
  const calendarId = encodeURIComponent(store.settings.calendarEmail || "frt.shibuya@gmail.com");
  try {
    await googleRequest(store, `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(booking.calendarEventId)}`, { method: "DELETE" });
  } catch (error) {
    if (!String(error.message).includes("Not Found")) throw error;
  }
}
async function updateCalendarEvent(store, booking) {
  if (!store.google.accessToken || !booking.calendarEventId) return null;
  const calendarId = encodeURIComponent(store.settings.calendarEmail || "frt.shibuya@gmail.com");
  const interviewer = store.interviewers.find((item) => item.id === booking.interviewerId);
  const meetUrl = booking.meetUrl || interviewer?.meetUrl || "";
  const timezone = store.settings.timezone || "Asia/Tokyo";
  const end = new Date(new Date(booking.start).getTime() + (booking.duration || 60) * 60_000).toISOString();
  return googleRequest(store, `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(booking.calendarEventId)}`, {
    method: "PATCH",
    body: JSON.stringify({
      summary: `【1次面接】${booking.candidateName}様-${interviewer?.name || "面接官"}-`,
      description: `面接調整リンクから変更されました。\n面接官: ${interviewer?.name || "面接官"}\n候補者: ${booking.candidateName}\n面接URL: ${meetUrl || "未設定"}`,
      ...(meetUrl ? { location: meetUrl } : {}),
      start: { dateTime: googleDateTime(booking.start, timezone), timeZone: timezone },
      end: { dateTime: googleDateTime(end, timezone), timeZone: timezone }
    })
  });
}

function sendFile(res, filename, type) {
  const full = path.join(publicDir, filename);
  res.writeHead(200, { "content-type": type });
  fs.createReadStream(full).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, baseUrl);
  try {
    if (req.method === "GET" && url.pathname === "/api/state") {
      const store = normalizeStore(await readStore());
      await writeStore(store);
      return json(res, 200, { ...store, google: { connected: Boolean(store.google.accessToken) }, baseUrl });
    }
    if (req.method === "POST" && url.pathname === "/api/settings") {
      const store = normalizeStore(await readStore());
      store.settings = { ...store.settings, ...(await readBody(req)) };
      await writeStore(store);
      return json(res, 200, store.settings);
    }
    if (req.method === "POST" && url.pathname === "/api/interviewers") {
      const store = normalizeStore(await readStore());
      const body = await readBody(req);
      const interviewer = { id: id(), name: body.name, email: body.email || "", meetUrl: body.meetUrl || "", priority: store.interviewers.length + 1, createdAt: new Date().toISOString() };
      store.interviewers.push(interviewer);
      await writeStore(store);
      return json(res, 201, interviewer);
    }
    if (req.method === "PATCH" && url.pathname.startsWith("/api/interviewers/")) {
      const store = normalizeStore(await readStore());
      const body = await readBody(req);
      const interviewer = store.interviewers.find((item) => item.id === url.pathname.split("/").pop());
      if (!interviewer) return json(res, 404, { error: "面接官が見つかりません" });
      if (body.priority !== undefined) interviewer.priority = Number(body.priority);
      if (body.name !== undefined) interviewer.name = body.name;
      if (body.email !== undefined) interviewer.email = body.email;
      if (body.meetUrl !== undefined) interviewer.meetUrl = body.meetUrl;
      normalizeStore(store);
      await writeStore(store);
      return json(res, 200, interviewer);
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/api/interviewers/")) {
      const store = normalizeStore(await readStore());
      const interviewerId = url.pathname.split("/").pop();
      store.interviewers = store.interviewers.filter((item) => item.id !== interviewerId);
      store.availabilities = store.availabilities.filter((item) => item.interviewerId !== interviewerId);
      store.links = store.links.filter((item) => item.interviewerId !== interviewerId);
      normalizeStore(store);
      await writeStore(store);
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/availabilities") {
      const store = normalizeStore(await readStore());
      const body = await readBody(req);
      const interviewer = store.interviewers.find((item) => item.id === body.interviewerId);
      if (!interviewer) return json(res, 404, { error: "面接官が見つかりません" });
      const starts = [...new Set(body.starts || [])].filter((start) => isAllowedAvailabilityStart(start, store.settings.timezone));
      for (const start of starts) {
        if (!store.availabilities.some((item) => item.interviewerId === body.interviewerId && item.start === start)) {
          store.availabilities.push({ id: id(), interviewerId: body.interviewerId, start });
        }
      }
      await writeStore(store);
      return json(res, 201, { count: starts.length });
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/api/availabilities/")) {
      const store = normalizeStore(await readStore());
      store.availabilities = store.availabilities.filter((item) => item.id !== url.pathname.split("/").pop());
      await writeStore(store);
      return json(res, 200, { ok: true });
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/api/bookings/")) {
      const store = normalizeStore(await readStore());
      const bookingId = url.pathname.split("/").pop();
      const booking = store.bookings.find((item) => item.id === bookingId);
      if (!booking) return json(res, 404, { error: "面接予定が見つかりません" });
      await deleteCalendarEvent(store, booking);
      store.bookings = store.bookings.filter((item) => item.id !== bookingId);
      await writeStore(store);
      return json(res, 200, { ok: true });
    }
    if (req.method === "PATCH" && url.pathname.startsWith("/api/bookings/")) {
      const store = normalizeStore(await readStore());
      const bookingId = url.pathname.split("/").pop();
      const booking = store.bookings.find((item) => item.id === bookingId);
      if (!booking) return json(res, 404, { error: "面接予定が見つかりません" });
      const body = await readBody(req);
      const newStart = body.start;
      if (!newStart || localDateKey(newStart, store.settings.timezone) <= localDateKey(new Date(), store.settings.timezone)) return json(res, 400, { error: "変更先の日程が正しくありません" });
      const interviewerId = booking.interviewerId || bookingInterviewerId(store, booking);
      const hasAvailability = store.availabilities.some((item) => item.interviewerId === interviewerId && item.start === newStart);
      if (!hasAvailability) return json(res, 400, { error: "担当面接官の空き枠にない日時です" });
      const originalStart = booking.start;
      booking.start = newStart;
      const conflict = isInterviewerBooked(store, interviewerId, newStart, booking.duration || 60);
      booking.start = originalStart;
      if (conflict) return json(res, 409, { error: "変更先の日時は既に予約されています" });
      booking.start = newStart;
      booking.updatedAt = new Date().toISOString();
      let calendarError = null;
      try {
        await updateCalendarEvent(store, booking);
      } catch (error) {
        calendarError = error.message;
      }
      await writeStore(store);
      return json(res, 200, { booking, calendarError });
    }
    if (req.method === "POST" && url.pathname === "/api/links") {
      const store = normalizeStore(await readStore());
      const body = await readBody(req);
      const interviewer = store.interviewers.find((item) => item.id === body.interviewerId);
      if (!interviewer) return json(res, 404, { error: "面接官を選択してください" });
      const link = { id: id(), title: body.title, interviewerId: interviewer.id, interviewer: interviewer.name, duration: Number(body.duration), active: true, createdAt: new Date().toISOString() };
      store.links.unshift(link);
      await writeStore(store);
      return json(res, 201, { ...link, url: `${baseUrl}/book/${link.id}` });
    }
    if (req.method === "POST" && url.pathname === "/api/blocks") {
      const store = normalizeStore(await readStore());
      const body = await readBody(req);
      store.blocks.unshift({ id: id(), interviewerId: body.interviewerId || "", label: body.label || "ブロック", start: body.start, end: body.end });
      await writeStore(store);
      return json(res, 201, store.blocks[0]);
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/api/blocks/")) {
      const store = normalizeStore(await readStore());
      store.blocks = store.blocks.filter((block) => block.id !== url.pathname.split("/").pop());
      await writeStore(store);
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/api/book/all") {
      const store = normalizeStore(await readStore());
      await writeStore(store);
      const slots = aggregateSlots(store).filter((item) => isCandidateVisibleSlot(store, item.start));
      return json(res, 200, { link: { ...commonLink(), slots: slots.map((item) => item.start), slotCounts: Object.fromEntries(slots.map((item) => [item.start, item.count])) }, teamName: store.settings.teamName, timezone: store.settings.timezone, todayKey: localDateKey(new Date(), store.settings.timezone) });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/book/")) {
      const store = normalizeStore(await readStore());
      const link = store.links.find((item) => item.id === url.pathname.split("/").pop() && item.active);
      if (!link) return json(res, 404, { error: "この調整リンクは無効です" });
      const interviewer = store.interviewers.find((item) => item.id === link.interviewerId);
      const slots = store.availabilities.filter((item) => item.interviewerId === link.interviewerId).map((item) => item.start);
      const todayKey = localDateKey(new Date(), store.settings.timezone);
      const availableSlots = slots.filter((slot) => {
        const start = new Date(slot).getTime();
        const end = start + link.duration * 60_000;
        if (localDateKey(slot, store.settings.timezone) <= todayKey) return false;
        return !store.bookings.some((item) => {
          const bookedLink = store.links.find((candidate) => candidate.id === item.linkId);
          const bookedStart = new Date(item.start).getTime();
          const bookedEnd = bookedStart + (bookedLink?.duration || 30) * 60_000;
          return bookedLink?.interviewerId === link.interviewerId && start < bookedEnd && end > bookedStart;
        }) && !store.blocks.some((block) => (!block.interviewerId || block.interviewerId === link.interviewerId) && start < new Date(block.end).getTime() && end > new Date(block.start).getTime());
      });
      return json(res, 200, { link: { ...link, interviewer: interviewer?.name || link.interviewer, slots: availableSlots }, teamName: store.settings.teamName, timezone: store.settings.timezone, todayKey });
    }
    if (req.method === "POST" && url.pathname === "/api/book/all") {
      const store = normalizeStore(await readStore());
      const body = await readBody(req);
      if (localDateKey(body.start, store.settings.timezone) <= localDateKey(new Date(), store.settings.timezone)) return json(res, 400, { error: "今日以前の日程は選択できません" });
      if (!isCandidateVisibleSlot(store, body.start)) return json(res, 400, { error: "選択できる日程は直近5日分のみです" });
      const interviewer = availableInterviewersForSlot(store, body.start)[0];
      if (!interviewer) return json(res, 409, { error: "この日時は先に予約されました。別の日時をお選びください" });
      const link = { ...commonLink(), interviewerId: interviewer.id, interviewer: interviewer.name };
      const booking = { id: id(), linkId: "all", interviewerId: interviewer.id, duration: 60, candidateName: body.candidateName, candidateEmail: "", note: "", start: body.start, meetUrl: interviewer.meetUrl || "", createdAt: new Date().toISOString() };
      let calendarEvent = null;
      let calendarError = null;
      let notificationError = null;
      if (store.google.accessToken) {
        try {
          calendarEvent = await createCalendarEvent(store, link, booking);
          booking.calendarEventId = calendarEvent.id;
        } catch (error) {
          calendarError = error.message;
        }
        if (!calendarError) {
          try {
          await sendBookingNotification(store, booking);
        } catch (error) {
            notificationError = error.message;
          }
        }
      }
      store.bookings.unshift(booking);
      await writeStore(store);
      return json(res, 201, { booking, calendarConnected: Boolean(store.google.accessToken), calendarError, notificationError });
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/book/")) {
      const store = normalizeStore(await readStore());
      const link = store.links.find((item) => item.id === url.pathname.split("/").pop() && item.active);
      const body = await readBody(req);
      const available = store.availabilities.some((item) => item.interviewerId === link?.interviewerId && item.start === body.start);
      if (!link || !available) return json(res, 400, { error: "選択された日時は利用できません" });
      if (localDateKey(body.start, store.settings.timezone) <= localDateKey(new Date(), store.settings.timezone)) return json(res, 400, { error: "今日以前の日程は選択できません" });
      const start = new Date(body.start).getTime();
      const end = start + link.duration * 60_000;
      const blocked = store.blocks.some((block) => (!block.interviewerId || block.interviewerId === link.interviewerId) && start < new Date(block.end).getTime() && end > new Date(block.start).getTime());
      const booked = store.bookings.some((item) => {
        const bookedLink = store.links.find((candidate) => candidate.id === item.linkId);
        const bookedStart = new Date(item.start).getTime();
        const bookedEnd = bookedStart + (bookedLink?.duration || 30) * 60_000;
        return bookedLink?.interviewerId === link.interviewerId && start < bookedEnd && end > bookedStart;
      });
      if (blocked || booked) return json(res, 409, { error: "この日時は先に予約またはブロックされました。別の日時をお選びください" });
      const interviewer = store.interviewers.find((item) => item.id === link.interviewerId);
      const booking = { id: id(), linkId: link.id, interviewerId: link.interviewerId, duration: link.duration, candidateName: body.candidateName, candidateEmail: body.candidateEmail || "", note: body.note || "", start: body.start, meetUrl: interviewer?.meetUrl || "", createdAt: new Date().toISOString() };
      let calendarEvent = null;
      let calendarError = null;
      if (store.google.accessToken) {
        try {
          calendarEvent = await createCalendarEvent(store, link, booking);
          booking.calendarEventId = calendarEvent.id;
        } catch (error) {
          calendarError = error.message;
        }
      }
      store.bookings.unshift(booking);
      await writeStore(store);
      return json(res, 201, { booking, calendarConnected: Boolean(store.google.accessToken), calendarError });
    }
    if (req.method === "GET" && url.pathname === "/auth/google") {
      if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
        res.writeHead(302, { location: "/?google=missing" });
        return res.end();
      }
      const params = new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        redirect_uri: `${baseUrl}/auth/google/callback`,
        response_type: "code",
        access_type: "offline",
        prompt: "consent",
        scope: "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/gmail.send",
        login_hint: "frt.shibuya@gmail.com",
        state: crypto.randomBytes(12).toString("hex")
      });
      res.writeHead(302, { location: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
      return res.end();
    }
    if (req.method === "GET" && url.pathname === "/auth/google/callback") {
      const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code: url.searchParams.get("code") || "",
          client_id: process.env.GOOGLE_CLIENT_ID || "",
          client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
          redirect_uri: `${baseUrl}/auth/google/callback`,
          grant_type: "authorization_code"
        })
      });
      const token = await response.json();
      if (!response.ok) throw new Error(token.error_description || "Google連携に失敗しました");
      const store = normalizeStore(await readStore());
      store.google = { accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: Date.now() + token.expires_in * 1000 };
      await writeStore(store);
      res.writeHead(302, { location: "/?google=connected" });
      return res.end();
    }
    if (url.pathname === "/" || url.pathname === "/index.html") return sendFile(res, "index.html", "text/html; charset=utf-8");
    if (url.pathname.startsWith("/book/")) return sendFile(res, "book.html", "text/html; charset=utf-8");
    if (url.pathname === "/app.js") return sendFile(res, "app.js", "text/javascript; charset=utf-8");
    if (url.pathname === "/book.js") return sendFile(res, "book.js", "text/javascript; charset=utf-8");
    if (url.pathname === "/styles.css") return sendFile(res, "styles.css", "text/css; charset=utf-8");
    if (url.pathname === "/enhancements.css") return sendFile(res, "enhancements.css", "text/css; charset=utf-8");
    res.writeHead(404); res.end("Not found");
  } catch (error) {
    console.error(error);
    json(res, 500, { error: error.message || "サーバーエラー" });
  }
});

server.listen(port, host, () => console.log(`面接調整ツール: ${baseUrl}`));
