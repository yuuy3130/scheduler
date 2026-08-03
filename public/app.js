const $ = (q) => document.querySelector(q);
const fmtDate = (value) => new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", weekday: "short" }).format(new Date(value));
const fmtTime = (value) => new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
const fmtDateTime = (value) => `${fmtDate(value)} ${fmtTime(value)}`;
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
  "'": "&#039;"
}[char]));
const dateKey = (value) => {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
let state;
let weekStart = startOfWeek(new Date());
let selectedCalendarStart = null;
let selectedEventDetail = null;
let toastTimer = null;
let selectedMemberFilter = "all";
let pendingScrollStart = null;
const availabilityDraft = {};
const dayStartMinutes = 7 * 60;
const dayEndMinutes = 24 * 60;
const hourHeight = 66;

function pageMode() {
  if (location.pathname === "/view") return "view";
  if (location.pathname === "/manage") return "manage";
  return "landing";
}
function applyPageMode() {
  const mode = pageMode();
  $("#landingPage").hidden = mode !== "landing";
  $("#appPage").hidden = mode === "landing";
  if (mode === "landing") return;
  const isView = mode === "view";
  $("#pageTitle").textContent = isView ? "空き時間確認" : "予定入力・管理";
  $("#appHeader").classList.toggle("view-toolbar", isView);
  $("#weeklyPanel").hidden = isView;
  $("#availabilityPanel").hidden = !isView;
  $("#managementGrid").hidden = isView;
  $("#switchPageLink").href = isView ? "/manage" : "/view";
  $("#switchPageLink").textContent = isView ? "管理用へ" : "確認用へ";
  document.querySelectorAll("[data-open]").forEach((button) => {
    button.hidden = isView;
  });
}

function startOfWeek(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - date.getDay());
  return date;
}
function addDays(value, days) {
  const date = new Date(value);
  date.setDate(date.getDate() + days);
  return date;
}
function isoLocal(date, time) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  return new Date(year, month - 1, day, hour, minute, 0, 0).toISOString();
}
function timeToMinutes(value) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}
function minutesToTime(minutes) {
  const clamped = Math.max(dayStartMinutes, Math.min(dayEndMinutes, minutes));
  const hour = Math.floor(clamped / 60);
  const minute = clamped % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}
function setSlotActionStart(value) {
  selectedCalendarStart = value;
  $("#slotActionDate").value = toDateInput(value);
  $("#slotActionStart").value = toTimeInput(value);
  setSlotActionEndOneHourLater();
  updateSlotActionPreview();
}
function slotActionStartIso() {
  return isoLocal($("#slotActionDate").value, $("#slotActionStart").value);
}
function slotActionEndIso() {
  return isoLocal($("#slotActionDate").value, $("#slotActionEnd").value);
}
function slotActionDurationMinutes() {
  return timeToMinutes($("#slotActionEnd").value) - timeToMinutes($("#slotActionStart").value);
}
function updateSlotActionPreview() {
  if (!$("#slotActionDate").value || !$("#slotActionStart").value || !$("#slotActionEnd").value) return;
  selectedCalendarStart = slotActionStartIso();
  $("#slotActionTime").textContent = `${fmtDateTime(selectedCalendarStart)} - ${fmtTime(slotActionEndIso())}`;
}
function toDateInput(value) {
  const date = new Date(value);
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
function toTimeInput(value) {
  const date = new Date(value);
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${min}`;
}
function fillQuarterTimeSelects() {
  document.querySelectorAll(".quarter-time-select").forEach((select) => {
    const current = select.value;
    const lastMinute = select.dataset.includeEnd === "true" ? dayEndMinutes : dayEndMinutes - 15;
    const options = [];
    for (let minutes = dayStartMinutes; minutes <= lastMinute; minutes += 15) {
      const hour = Math.floor(minutes / 60);
      const minute = minutes % 60;
      const value = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
      options.push(`<option value="${value}">${value}</option>`);
    }
    select.innerHTML = options.join("");
    if (current) select.value = current;
  });
}
function setSlotActionEndOneHourLater() {
  const start = timeToMinutes($("#slotActionStart").value || "07:00");
  $("#slotActionEnd").value = minutesToTime(Math.min(dayEndMinutes, start + 60));
}
function setMeetingEndFromDuration(duration) {
  const start = timeToMinutes($("#meetingTime").value || "07:00");
  $("#meetingEnd").value = minutesToTime(Math.min(dayEndMinutes, start + Number(duration || 60)));
}
function setMeetingEndOneHourLater() {
  setMeetingEndFromDuration(60);
}
function meetingDurationMinutes() {
  return timeToMinutes($("#meetingEnd").value) - timeToMinutes($("#meetingTime").value);
}
function scrollCalendarTo(value) {
  requestAnimationFrame(() => {
    const body = document.querySelector(".week-body");
    if (!body) return;
    const top = ((minutesOfDay(value) - dayStartMinutes) / 60) * hourHeight;
    body.scrollTop = Math.max(0, top - 90);
  });
}
async function api(path, options = {}) {
  const response = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "エラーが発生しました");
  return result;
}
function showToast(message, type = "success") {
  const toast = $("#toast");
  if (!toast) return;
  toast.textContent = message;
  toast.className = `toast ${type}`;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 4200);
}
function buildCompletionMessage(start, location) {
  return `面接が設定されました。
下記のメッセージを送信してください。

-以下インフラメッセージ-
{name}様

ご連絡いただきありがとうございます。
下記の通りで面接を確定させてさせていただきます！

内容をご確認いただけましたら、
「確認した旨」をご返信よろしくお願いいたします。

◆面接開始時刻
${fmtDateTime(start)}
※面接は30分から1時間ほどを想定しています。

◆場所（オンライン）
${location || "担当者の固定URL未登録"}

当日はこちらのURLからよろしくお願いいたします。

◆服装
指定はございません。
普段通りの服装でご参加ください。

以上、ご確認のほどよろしくお願いいたします。

フロンティア株式会社 採用担当`;
}
function integrationItem(label, result, fallback) {
  if (!result) return `<div class="integration-item pending"><strong>${label}</strong><span>${fallback}</span></div>`;
  const type = result.ok ? "success" : "error";
  const status = result.ok ? "完了" : "確認が必要";
  return `<div class="integration-item ${type}"><strong>${label}: ${status}</strong><span>${escapeHtml(result.message || "")}</span></div>`;
}
function integrationStatusHtml(integration) {
  if (!integration) return "";
  if (integration.status === "disabled") {
    return `<div class="integration-item pending"><strong>外部連携: 未設定</strong><span>Apps ScriptのURLが設定されていません。</span></div>`;
  }
  if (integration.status === "failed" && !integration.calendar && !integration.sheet) {
    return `<div class="integration-item error"><strong>外部連携: 確認が必要</strong><span>${escapeHtml(integration.error || "連携に失敗しました。")}</span></div>`;
  }
  return [
    integrationItem("カレンダー登録", integration.calendar, "Apps Scriptを最新版にすると詳細が表示されます。"),
    integrationItem("スプレッドシート入力", integration.sheet, "Apps Scriptを最新版にすると詳細が表示されます。")
  ].join("");
}
function showCompletionMessage(message, integration = null) {
  $("#completionMessage").value = message;
  $("#copyCompletionMessage").textContent = "文章をコピー";
  const status = $("#integrationStatus");
  const html = integrationStatusHtml(integration);
  status.hidden = !html;
  status.innerHTML = html;
  $("#completionDialog").showModal();
}
function showMeetingMessageFromDetail(item) {
  showCompletionMessage(buildCompletionMessage(item.start, item.location || memberFixedLink(item.memberId)));
}
function memberName(id) {
  return state.members.find((member) => member.id === id)?.name || "メンバー";
}
function memberById(id) {
  return state.members.find((member) => member.id === id);
}
function memberColor(id) {
  return memberById(id)?.color || "#2453d6";
}
function memberFixedLink(id) {
  return memberById(id)?.fixedLink || "";
}
function memberMatchesFilter(memberId) {
  return selectedMemberFilter === "all" || selectedMemberFilter === memberId;
}
function findAvailability(id) {
  return state.availabilities.find((slot) => slot.id === id);
}
function findMeeting(id) {
  return state.meetings.find((meeting) => meeting.id === id);
}
function fillMemberSelects() {
  document.querySelectorAll(".member-select").forEach((select) => {
    select.innerHTML = state.members.map((member) => `<option value="${member.id}">${member.name}</option>`).join("");
  });
  const filter = $("#memberFilter");
  if (filter) {
    filter.innerHTML = `<option value="all">全員</option>${state.members.map((member) => `<option value="${member.id}">${member.name}</option>`).join("")}`;
    filter.value = selectedMemberFilter;
  }
}
function applyMemberFixedLinkToMeeting() {
  const link = memberFixedLink($("#meetingForm [name=memberId]").value);
  $("#meetingForm [name=location]").value = link;
  updateGeneratedMeetingTitle();
}
function meetingTitleFromTemplate(template) {
  const interviewer = memberName($("#meetingForm [name=memberId]").value);
  return template.replace("面接者", interviewer);
}
function generatedMeetingTitle() {
  const type = $("#meetingType")?.value || "custom";
  const name = $("#candidateName")?.value.trim() || "〇〇";
  const interviewer = memberName($("#meetingForm [name=memberId]").value);
  if (type === "first") return `【1次面接】${name}様-${interviewer}-`;
  if (type === "second") return `【2次面接】${name}様-${interviewer}-`;
  if (type === "training") return `新人研修-${name}さん/${name}さん-`;
  return "";
}
function updateGeneratedMeetingTitle() {
  const title = generatedMeetingTitle();
  if (title) $("#meetingTitle").value = title;
}
function resetMeetingForm() {
  $("#meetingForm").reset();
  $("#editingMeetingId").value = "";
  $("#meetingDialog .modal-head h2").textContent = "予定を登録";
  $("#meetingForm .primary.full").textContent = "登録する";
  $("#meetingType").value = "custom";
  $("#candidateName").value = "";
  applyMemberFixedLinkToMeeting();
  setMeetingEndOneHourLater();
}
function hourlyTimeOptions(includeEnd = false) {
  const lastMinute = includeEnd ? dayEndMinutes : dayEndMinutes - 60;
  const options = [];
  for (let minutes = dayStartMinutes; minutes <= lastMinute; minutes += 60) {
    options.push(minutesToTime(minutes));
  }
  return options;
}
function availabilityDateLabel(date) {
  return fmtDate(new Date(`${date}T00:00:00`));
}
function isBusyForAvailability(memberId, date, time) {
  const start = new Date(isoLocal(date, time));
  const end = new Date(start.getTime() + 60 * 60_000);
  return state.meetings.some((meeting) => (
    meeting.memberId === memberId &&
    new Date(meeting.start) < end &&
    new Date(meeting.end) > start
  ));
}
function ensureAvailabilityDate(date) {
  if (!date) return;
  availabilityDraft[date] ||= new Set();
  renderAvailabilityBulkList();
}
function selectedAvailabilityStarts() {
  return Object.entries(availabilityDraft).flatMap(([date, times]) => (
    [...times].sort().map((time) => isoLocal(date, time))
  ));
}
function renderAvailabilityBulkList() {
  const list = $("#availabilityBulkList");
  if (!list || !state) return;
  const memberId = $("#availabilityForm [name=memberId]").value || state.members[0]?.id;
  const dates = Object.keys(availabilityDraft).sort();
  if (!dates.length) {
    list.innerHTML = `<div class="empty compact">日付を追加すると、ここで時間をまとめて選べます</div>`;
    return;
  }
  const startOptions = hourlyTimeOptions(false);
  const endOptions = hourlyTimeOptions(true).filter((time) => time !== "07:00");
  list.innerHTML = dates.map((date) => `
    <article class="bulk-day">
      <div class="bulk-head">
        <strong>${availabilityDateLabel(date)}</strong>
        <button type="button" class="ghost remove-bulk-date" data-date="${date}">削除</button>
      </div>
      <div class="range-tools">
        <select class="bulk-range-start" data-date="${date}">
          ${startOptions.map((time) => `<option value="${time}">${time}</option>`).join("")}
        </select>
        <span>から</span>
        <select class="bulk-range-end" data-date="${date}">
          ${endOptions.map((time) => `<option value="${time}">${time}</option>`).join("")}
        </select>
        <button type="button" class="secondary add-range" data-date="${date}">範囲で追加</button>
      </div>
      <div class="time-chip-grid">
        ${startOptions.map((time) => {
          const selected = availabilityDraft[date].has(time);
          const busy = isBusyForAvailability(memberId, date, time);
          return `
            <button type="button" class="time-chip ${selected ? "selected" : ""} ${busy ? "busy" : ""}" data-date="${date}" data-time="${time}" ${busy ? "disabled" : ""}>
              ${time}${busy ? " 予定あり" : ""}
            </button>
          `;
        }).join("")}
      </div>
    </article>
  `).join("");
  document.querySelectorAll(".time-chip").forEach((button) => {
    button.onclick = () => {
      const set = availabilityDraft[button.dataset.date];
      if (set.has(button.dataset.time)) set.delete(button.dataset.time);
      else set.add(button.dataset.time);
      renderAvailabilityBulkList();
    };
  });
  document.querySelectorAll(".remove-bulk-date").forEach((button) => {
    button.onclick = () => {
      delete availabilityDraft[button.dataset.date];
      renderAvailabilityBulkList();
    };
  });
  document.querySelectorAll(".add-range").forEach((button) => {
    button.onclick = () => {
      const date = button.dataset.date;
      const start = timeToMinutes(document.querySelector(`.bulk-range-start[data-date="${date}"]`).value);
      const end = timeToMinutes(document.querySelector(`.bulk-range-end[data-date="${date}"]`).value);
      if (end <= start) return alert("終了時刻は開始時刻より後にしてください");
      for (let minutes = start; minutes < end; minutes += 60) {
        const time = minutesToTime(minutes);
        if (!isBusyForAvailability(memberId, date, time)) availabilityDraft[date].add(time);
      }
      renderAvailabilityBulkList();
    };
  });
}
function minutesOfDay(value) {
  const date = new Date(value);
  return date.getHours() * 60 + date.getMinutes();
}
function localStartForDay(day, minutes) {
  const date = new Date(day);
  date.setHours(0, minutes, 0, 0);
  return date;
}
function eventStyle(item) {
  const start = Math.max(dayStartMinutes, minutesOfDay(item.start));
  const rawEnd = minutesOfDay(item.end);
  const end = Math.min(dayEndMinutes, rawEnd <= start ? dayEndMinutes : rawEnd);
  const top = ((start - dayStartMinutes) / 60) * hourHeight;
  const height = Math.max(((end - start) / 60) * hourHeight, 26);
  const lane = item.lane || 0;
  const lanes = item.lanes || 1;
  return `top:${top}px;height:${height}px;--event-color:${memberColor(item.memberId)};--lane:${lane};--lanes:${lanes}`;
}
function availabilityStyle(item) {
  const start = Math.max(dayStartMinutes, minutesOfDay(item.start));
  const rawEnd = minutesOfDay(item.end);
  const end = Math.min(dayEndMinutes, rawEnd <= start ? dayEndMinutes : rawEnd);
  const top = ((start - dayStartMinutes) / 60) * hourHeight;
  const height = Math.max(((end - start) / 60) * hourHeight, 26);
  const lane = item.lane || 0;
  const lanes = item.lanes || 1;
  return `top:${top}px;height:${height}px;--lane:${lane};--lanes:${lanes}`;
}
function itemsForDay(items, day) {
  const key = dateKey(day);
  return items.filter((item) => dateKey(item.start) === key);
}
function overlapsInCalendar(a, b) {
  return new Date(a.start) < new Date(b.end) && new Date(a.end) > new Date(b.start);
}
function assignEventLanes(items) {
  const sorted = [...items].sort((a, b) => new Date(a.start) - new Date(b.start) || new Date(a.end) - new Date(b.end));
  let active = [];
  let group = [];
  let groupLaneCount = 1;
  const finishGroup = () => {
    group.forEach((item) => {
      item.lanes = groupLaneCount;
    });
    group = [];
    groupLaneCount = 1;
  };
  sorted.forEach((item) => {
    active = active.filter((activeItem) => overlapsInCalendar(activeItem, item));
    if (!active.length && group.length) finishGroup();
    const used = new Set(active.map((activeItem) => activeItem.lane));
    let lane = 0;
    while (used.has(lane)) lane++;
    item.lane = lane;
    active.push(item);
    group.push(item);
    groupLaneCount = Math.max(groupLaneCount, lane + 1, active.length);
  });
  if (group.length) finishGroup();
  return sorted;
}
function calendarItemsForDay(day) {
  const meetings = itemsForDay(state.meetings, day)
    .filter((meeting) => memberMatchesFilter(meeting.memberId))
    .map((meeting) => ({ ...meeting, kind: "meeting" }));
  const availabilities = itemsForDay(state.availabilities, day)
    .filter((slot) => memberMatchesFilter(slot.memberId))
    .filter((slot) => !meetings.some((meeting) => meeting.memberId === slot.memberId && overlapsInCalendar(slot, meeting)))
    .map((slot) => ({ ...slot, kind: "availability" }));
  return assignEventLanes([...availabilities, ...meetings]);
}
function visibleAvailabilities() {
  return state.availabilities
    .filter((slot) => memberMatchesFilter(slot.memberId))
    .filter((slot) => !state.meetings.some((meeting) => meeting.memberId === slot.memberId && overlapsInCalendar(slot, meeting)))
    .sort((a, b) => new Date(a.start) - new Date(b.start) || memberName(a.memberId).localeCompare(memberName(b.memberId), "ja"));
}
function openSlotsForHour(day, hour) {
  const start = new Date(day);
  start.setHours(hour, 0, 0, 0);
  const end = new Date(start.getTime() + 60 * 60_000);
  return visibleAvailabilities().filter((slot) => new Date(slot.start) < end && new Date(slot.end) > start);
}
function startFromCalendarClick(event, day) {
  const rect = event.currentTarget.getBoundingClientRect();
  const rawMinutes = dayStartMinutes + ((event.clientY - rect.top) / hourHeight) * 60;
  const rounded = Math.round(rawMinutes / 15) * 15;
  const clamped = Math.max(dayStartMinutes, Math.min(dayEndMinutes - 15, rounded));
  return localStartForDay(day, clamped).toISOString();
}
function renderCalendar() {
  const days = Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
  const hours = Array.from({ length: dayEndMinutes / 60 - dayStartMinutes / 60 }, (_, index) => dayStartMinutes / 60 + index);
  const calendarHeight = hours.length * hourHeight;
  $("#weekLabel").textContent = `${fmtDate(days[0])} - ${fmtDate(days[6])}`;
  $("#calendar").innerHTML = `
    <div class="week-calendar">
      <div class="week-header">
        <div class="time-head"></div>
        ${days.map((day) => `<div class="day-head"><strong>${fmtDate(day)}</strong></div>`).join("")}
      </div>
      <div class="week-body" style="--calendar-height:${calendarHeight}px;--hour-height:${hourHeight}px">
        <div class="time-axis">
          ${hours.map((hour) => `<div class="time-marker">${String(hour).padStart(2, "0")}:00</div>`).join("")}
        </div>
        ${days.map((day) => `
          <div class="day-column quick-day" data-day="${day.toISOString()}" style="height:${calendarHeight}px">
            ${calendarItemsForDay(day).map((item) => item.kind === "availability" ? `
              <button class="calendar-event open show-event-detail" data-kind="availability" data-id="${item.id}" style="${availabilityStyle(item)}">
                <strong>空き</strong>
                <span>${fmtTime(item.start)}-${fmtTime(item.end)} ・ ${memberName(item.memberId)}</span>
              </button>
            ` : `
              <button class="calendar-event busy show-event-detail" data-kind="meeting" data-id="${item.id}" style="${eventStyle(item)}">
                <strong>${item.title}</strong>
                <span>${fmtTime(item.start)}-${fmtTime(item.end)} ・ ${memberName(item.memberId)}</span>
              </button>
            `).join("")}
          </div>
        `).join("")}
      </div>
    </div>
  `;
}
function renderMembers() {
  $("#members").innerHTML = state.members.length ? state.members.map((member) => `
    <article class="row member-row">
      <span class="dot" style="background:${member.color}"></span>
      <div class="row-main">
        <strong>${member.name}</strong>
        <span>${escapeHtml(member.email || "メール未登録")} ・ ${member.fixedLink ? "固定リンク登録済み" : "固定リンク未登録"}</span>
      </div>
      <button class="secondary small edit-member" data-id="${member.id}">編集</button>
    </article>
  `).join("") : `<div class="empty">メンバーを追加してください</div>`;
}
function renderMeetings() {
  const meetings = [...state.meetings]
    .filter((meeting) => memberMatchesFilter(meeting.memberId))
    .sort((a, b) => new Date(a.start) - new Date(b.start));
  $("#meetings").innerHTML = meetings.length ? meetings.map((meeting) => `
    <article class="row">
      <div class="row-main"><strong>${meeting.title}</strong><span>${fmtDate(meeting.start)} ${fmtTime(meeting.start)} ・ ${memberName(meeting.memberId)}</span></div>
      <button class="delete delete-meeting" data-id="${meeting.id}">削除</button>
    </article>
  `).join("") : `<div class="empty">予定はまだありません</div>`;
}
function renderAvailabilityTable() {
  const slots = visibleAvailabilities();
  const days = Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
  $("#openWeekLabel").textContent = `${fmtDate(days[0])} - ${fmtDate(days[6])}`;
  const weekSlots = slots.filter((slot) => days.some((day) => dateKey(slot.start) === dateKey(day)));
  if (!weekSlots.length) {
    $("#availabilityTable").innerHTML = `<div class="empty">この週の空き時間はありません</div>`;
    return;
  }
  const hours = Array.from({ length: dayEndMinutes / 60 - dayStartMinutes / 60 }, (_, index) => dayStartMinutes / 60 + index);
  $("#availabilityTable").innerHTML = `
    <div class="availability-calendar">
      <div class="availability-row availability-head">
        <div class="availability-time"></div>
        ${days.map((day) => `<div class="availability-day">${fmtDate(day)}</div>`).join("")}
      </div>
      ${hours.map((hour) => `
        <div class="availability-row">
          <div class="availability-time">${String(hour).padStart(2, "0")}:00</div>
          ${days.map((day) => {
            const hourSlots = openSlotsForHour(day, hour);
            return `
              <div class="availability-cell ${hourSlots.length ? "has-open" : ""}">
                ${hourSlots.map((slot) => `
                  <button type="button" class="open-chip show-event-detail" data-kind="availability" data-id="${slot.id}">
                    ${memberName(slot.memberId)} <span>${fmtTime(slot.start)}-${fmtTime(slot.end)}</span>
                  </button>
                `).join("")}
              </div>
            `;
          }).join("")}
        </div>
      `).join("")}
    </div>
  `;
}
function bindActions() {
  document.querySelectorAll(".show-event-detail").forEach((button) => {
    button.onclick = (event) => {
      event.stopPropagation();
      openEventDetail(button.dataset.kind, button.dataset.id);
    };
  });
  document.querySelectorAll(".quick-day").forEach((column) => {
    column.onclick = (event) => {
      if (!state.members.length) return alert("先にメンバーを追加してください");
      setSlotActionStart(startFromCalendarClick(event, new Date(column.dataset.day)));
      $("#slotActionMember").value = selectedMemberFilter === "all" ? state.members[0].id : selectedMemberFilter;
      $("#slotTimeEditor").hidden = true;
      $("#slotActionDialog").showModal();
    };
  });
  document.querySelectorAll(".delete-meeting").forEach((button) => {
    button.onclick = async (event) => {
      event.stopPropagation();
      if (!confirm("この予定を削除しますか？")) return;
      await api(`/api/meetings/${button.dataset.id}`, { method: "DELETE" });
      render();
    };
  });
  document.querySelectorAll(".edit-member").forEach((button) => {
    button.onclick = () => openMemberEditor(button.dataset.id);
  });
}
function resetMemberForm() {
  $("#memberForm").reset();
  $("#editingMemberId").value = "";
  $("#memberDialog .modal-head h2").textContent = "メンバー追加";
  $("#memberForm .primary.full").textContent = "追加する";
  $("#memberForm [name=color]").value = "#2453d6";
}
function openMemberEditor(id) {
  const member = memberById(id);
  if (!member) return;
  $("#editingMemberId").value = member.id;
  $("#memberDialog .modal-head h2").textContent = "メンバー編集";
  $("#memberForm .primary.full").textContent = "保存する";
  $("#memberForm [name=name]").value = member.name || "";
  $("#memberForm [name=email]").value = member.email || "";
  $("#memberForm [name=fixedLink]").value = member.fixedLink || "";
  $("#memberForm [name=color]").value = member.color || "#2453d6";
  $("#memberDialog").showModal();
}
function openEventDetail(kind, id) {
  const item = kind === "availability" ? findAvailability(id) : findMeeting(id);
  if (!item) return alert("詳細が見つかりませんでした");
  selectedEventDetail = { kind, id };
  $("#eventDetailTitle").textContent = kind === "availability" ? "空き時間の詳細" : "予定の詳細";
  $("#eventDetailBody").innerHTML = `
    <dl class="detail-list">
      <div><dt>種別</dt><dd>${kind === "availability" ? "空き時間" : "予定"}</dd></div>
      ${kind === "meeting" ? `<div><dt>予定名</dt><dd>${item.title}</dd></div>` : ""}
      ${kind === "meeting" && item.location ? `<div><dt>場所・URL</dt><dd>${item.location}</dd></div>` : ""}
      <div><dt>日時</dt><dd>${fmtDate(item.start)} ${fmtTime(item.start)}-${fmtTime(item.end)}</dd></div>
      <div><dt>メンバー</dt><dd>${memberName(item.memberId)}</dd></div>
      ${kind === "availability" && memberFixedLink(item.memberId) ? `<div><dt>固定リンク</dt><dd>${escapeHtml(memberFixedLink(item.memberId))}</dd></div>` : ""}
      ${item.note ? `<div><dt>メモ</dt><dd>${item.note}</dd></div>` : ""}
    </dl>
  `;
  const isView = pageMode() === "view";
  $("#eventDetailPrimary").hidden = false;
  $("#eventDetailPrimary").textContent = kind === "availability" ? "この空き時間に予定を登録" : "メッセージを表示";
  $("#eventDetailEdit").hidden = kind !== "meeting" || isView;
  $("#eventDetailDelete").hidden = isView;
  $("#eventDetailDelete").textContent = kind === "availability" ? "空き枠を削除" : "予定を削除";
  $("#eventDetailActions").classList.toggle("single-action", isView);
  $("#eventDetailDialog").showModal();
}
async function render() {
  applyPageMode();
  const params = new URLSearchParams({ start: weekStart.toISOString() });
  state = await api(`/api/week?${params}`);
  fillMemberSelects();
  renderCalendar();
  renderAvailabilityTable();
  renderMembers();
  renderMeetings();
  renderAvailabilityBulkList();
  bindActions();
  if (pendingScrollStart) {
    scrollCalendarTo(pendingScrollStart);
    pendingScrollStart = null;
  }
}

document.querySelectorAll("[data-open]").forEach((button) => button.onclick = () => {
  if (button.dataset.open === "memberDialog") resetMemberForm();
  if (button.dataset.open === "availabilityDialog") renderAvailabilityBulkList();
  if (button.dataset.open === "meetingDialog") resetMeetingForm();
  $(`#${button.dataset.open}`).showModal();
});
document.querySelectorAll("[data-close]").forEach((button) => button.onclick = () => $(`#${button.dataset.close}`).close());
function moveWeek(days) {
  weekStart = addDays(weekStart, days);
  render();
}
$("#prevWeek").onclick = () => moveWeek(-7);
$("#nextWeek").onclick = () => moveWeek(7);
$("#prevOpenWeek").onclick = () => moveWeek(-7);
$("#nextOpenWeek").onclick = () => moveWeek(7);
$("#todayWeek").onclick = () => {
  weekStart = startOfWeek(new Date());
  render();
};
$("#todayOpenWeek").onclick = () => {
  weekStart = startOfWeek(new Date());
  render();
};
$("#memberFilter").onchange = () => {
  selectedMemberFilter = $("#memberFilter").value;
  render();
};
$("#slotActionDate").onchange = updateSlotActionPreview;
$("#slotActionTime").onclick = () => {
  $("#slotTimeEditor").hidden = !$("#slotTimeEditor").hidden;
};
$("#slotActionStart").onchange = () => {
  setSlotActionEndOneHourLater();
  updateSlotActionPreview();
};
$("#slotActionEnd").onchange = updateSlotActionPreview;
$("#addAvailabilityDate").onclick = () => ensureAvailabilityDate($("#availabilityDate").value);
$("#availabilityForm [name=memberId]").onchange = renderAvailabilityBulkList;
$("#addSlotFromCalendar").onclick = async () => {
  if (!selectedCalendarStart) return;
  const duration = slotActionDurationMinutes();
  if (duration <= 0) return alert("終了時刻は開始時刻より後にしてください");
  const start = slotActionStartIso();
  const memberId = $("#slotActionMember").value;
  await api("/api/availabilities", {
    method: "POST",
    body: JSON.stringify({ memberId, starts: [start], duration })
  });
  $("#slotActionDialog").close();
  weekStart = startOfWeek(new Date(start));
  selectedMemberFilter = memberId;
  pendingScrollStart = start;
  selectedCalendarStart = null;
  showToast("空き時間を追加しました。");
  await render();
};
$("#addMeetingFromCalendar").onclick = () => {
  if (!selectedCalendarStart) return;
  const duration = slotActionDurationMinutes();
  if (duration <= 0) return alert("終了時刻は開始時刻より後にしてください");
  $("#meetingForm [name=memberId]").value = $("#slotActionMember").value;
  applyMemberFixedLinkToMeeting();
  $("#meetingDate").value = $("#slotActionDate").value;
  $("#meetingTime").value = $("#slotActionStart").value;
  setMeetingEndFromDuration(duration);
  $("#slotActionDialog").close();
  $("#meetingDialog").showModal();
};
function openMeetingEditor(item) {
  $("#editingMeetingId").value = item.id;
  $("#meetingDialog .modal-head h2").textContent = "予定を編集";
  $("#meetingForm .primary.full").textContent = "保存する";
  $("#meetingForm [name=memberId]").value = item.memberId;
  $("#meetingType").value = "custom";
  $("#candidateName").value = "";
  $("#meetingTitle").value = item.title;
  $("#meetingForm [name=location]").value = item.location || memberFixedLink(item.memberId);
  $("#meetingDate").value = toDateInput(item.start);
  $("#meetingTime").value = toTimeInput(item.start);
  setMeetingEndFromDuration(Math.round((new Date(item.end) - new Date(item.start)) / 60_000));
  $("#meetingForm [name=note]").value = item.note || "";
  $("#eventDetailDialog").close();
  $("#meetingDialog").showModal();
}
$("#eventDetailPrimary").onclick = () => {
  if (!selectedEventDetail) return;
  if (selectedEventDetail.kind === "meeting") {
    const item = findMeeting(selectedEventDetail.id);
    if (!item) return;
    $("#eventDetailDialog").close();
    showMeetingMessageFromDetail(item);
    return;
  }
  const item = findAvailability(selectedEventDetail.id);
  if (!item) return;
  $("#meetingForm [name=memberId]").value = item.memberId;
  applyMemberFixedLinkToMeeting();
  $("#meetingDate").value = toDateInput(item.start);
  $("#meetingTime").value = toTimeInput(item.start);
  setMeetingEndFromDuration(Math.round((new Date(item.end) - new Date(item.start)) / 60_000));
  $("#eventDetailDialog").close();
  $("#meetingDialog").showModal();
};
$("#eventDetailEdit").onclick = () => {
  if (!selectedEventDetail || selectedEventDetail.kind !== "meeting") return;
  const item = findMeeting(selectedEventDetail.id);
  if (!item) return;
  openMeetingEditor(item);
};
$("#eventDetailDelete").onclick = async () => {
  if (!selectedEventDetail) return;
  const isAvailability = selectedEventDetail.kind === "availability";
  if (!confirm(isAvailability ? "この空き枠を削除しますか？" : "この予定を削除しますか？")) return;
  await api(`/${isAvailability ? "api/availabilities" : "api/meetings"}/${selectedEventDetail.id}`, { method: "DELETE" });
  $("#eventDetailDialog").close();
  selectedEventDetail = null;
  render();
};
$("#memberForm").onsubmit = async (event) => {
  event.preventDefault();
  const data = new FormData(event.target);
  const memberId = data.get("memberId");
  await api(memberId ? `/api/members/${memberId}` : "/api/members", {
    method: memberId ? "PATCH" : "POST",
    body: JSON.stringify({
      name: data.get("name"),
      email: data.get("email"),
      fixedLink: data.get("fixedLink"),
      color: data.get("color")
    })
  });
  event.target.reset();
  $("#editingMemberId").value = "";
  $("#memberDialog").close();
  render();
};
$("#availabilityForm").onsubmit = async (event) => {
  event.preventDefault();
  const data = new FormData(event.target);
  const starts = selectedAvailabilityStarts();
  if (!starts.length) return alert("追加する空き時間を選択してください");
  const result = await api("/api/availabilities", {
    method: "POST",
    body: JSON.stringify({ memberId: data.get("memberId"), starts, duration: 60, skipBusy: true })
  });
  const firstStart = [...starts].sort()[0];
  weekStart = startOfWeek(new Date(firstStart));
  selectedMemberFilter = String(data.get("memberId") || "all");
  pendingScrollStart = firstStart;
  Object.keys(availabilityDraft).forEach((date) => delete availabilityDraft[date]);
  event.target.reset();
  $("#availabilityDialog").close();
  if (result.skipped) {
    showToast(`${result.count}件追加しました。予定あり・重複のため${result.skipped}件はスキップしました。`, "warning");
  } else {
    showToast(`${result.count}件の空き時間を追加しました。`);
  }
  await render();
};
$("#meetingForm [name=memberId]").onchange = applyMemberFixedLinkToMeeting;
$("#meetingTime").onchange = setMeetingEndOneHourLater;
$("#meetingType").onchange = updateGeneratedMeetingTitle;
$("#candidateName").oninput = updateGeneratedMeetingTitle;
$("#meetingTitle").onfocus = () => {
  $("#titleSuggestions").hidden = false;
};
$("#meetingTitle").oninput = () => {
  $("#titleSuggestions").hidden = false;
};
$("#meetingTitle").onblur = () => {
  setTimeout(() => {
    $("#titleSuggestions").hidden = true;
  }, 120);
};
document.querySelectorAll(".suggestion-chip").forEach((button) => {
  button.onclick = () => {
    $("#meetingTitle").value = meetingTitleFromTemplate(button.dataset.title);
    $("#titleSuggestions").hidden = true;
    $("#meetingTitle").focus();
  };
});
$("#meetingForm").onsubmit = async (event) => {
  event.preventDefault();
  const data = new FormData(event.target);
  const duration = meetingDurationMinutes();
  if (duration <= 0) return alert("終了時刻は開始時刻より後にしてください");
  const memberId = data.get("memberId");
  const start = isoLocal($("#meetingDate").value, $("#meetingTime").value);
  const location = data.get("location") || memberFixedLink(memberId);
  const editingId = data.get("editingMeetingId");
  try {
    const result = await api(editingId ? `/api/meetings/${editingId}` : "/api/meetings", {
      method: editingId ? "PATCH" : "POST",
      body: JSON.stringify({
        memberId,
        title: data.get("title"),
        location,
        start,
        duration,
        note: data.get("note")
      })
    });
    event.target.reset();
    $("#editingMeetingId").value = "";
    $("#meetingDialog").close();
    weekStart = startOfWeek(new Date(start));
    selectedMemberFilter = memberId;
    pendingScrollStart = start;
    await render();
    if (editingId) {
      showToast("予定を編集しました。カレンダー・シート側は必要に応じて確認してください。", "warning");
      return;
    }
    if (result.integration?.status === "failed") {
      showToast("予定は登録されました。外部連携だけ確認してください。", "warning");
    } else {
      showToast("予定を登録しました。");
    }
    showCompletionMessage(buildCompletionMessage(start, location), result.integration);
  } catch (error) {
    showToast(error.message || "予定登録に失敗しました。", "error");
  }
};
$("#copyCompletionMessage").onclick = async () => {
  const textarea = $("#completionMessage");
  const marker = "{name}様";
  const copyText = textarea.value.includes(marker)
    ? textarea.value.slice(textarea.value.indexOf(marker))
    : textarea.value;
  try {
    await navigator.clipboard.writeText(copyText);
    $("#copyCompletionMessage").textContent = "コピー済み";
    showToast("文章をコピーしました。");
  } catch {
    textarea.select();
    document.execCommand("copy");
    $("#copyCompletionMessage").textContent = "コピー済み";
    showToast("文章をコピーしました。");
  }
};

fillQuarterTimeSelects();
setMeetingEndOneHourLater();
render();
