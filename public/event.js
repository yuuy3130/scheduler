const view = document.querySelector("#view");
const eventId = location.pathname.split("/").pop();
const fmt = (value) => new Intl.DateTimeFormat("ja-JP", { month: "long", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
let eventData;
let selected = new Set();

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "エラーが発生しました");
  return result;
}

const countForSlot = (slot) => (eventData.responses || []).filter((response) => response.availableSlots.includes(slot)).length;
const namesForSlot = (slot) => (eventData.responses || []).filter((response) => response.availableSlots.includes(slot)).map((response) => response.name).join("、") || "まだ回答なし";

function renderScores() {
  return eventData.slots.map((slot) => `
    <div class="score">
      <span>${fmt(slot)}<br><small>${namesForSlot(slot)}</small></span>
      <b>${countForSlot(slot)}名 OK</b>
      <button class="copy confirm-slot" data-slot="${slot}">${eventData.confirmedSlot === slot ? "確定済み" : "確定"}</button>
    </div>
  `).join("");
}

function renderSlots() {
  return eventData.slots.map((slot) => `
    <article class="slot-card ${selected.has(slot) ? "selected" : ""}">
      <strong>${fmt(slot)}</strong>
      <span>${countForSlot(slot)}名が参加可能</span>
      <button type="button" class="toggle-slot" data-slot="${slot}">${selected.has(slot) ? "選択中" : "参加できます"}</button>
    </article>
  `).join("");
}

function render() {
  view.innerHTML = `
    ${eventData.confirmedSlot ? `<div class="success">確定日時：${fmt(eventData.confirmedSlot)}</div>` : ""}
    <p class="eyebrow">INTERNAL SCHEDULER</p>
    <h1>${eventData.title}</h1>
    ${eventData.memo ? `<p class="note">${eventData.memo}</p>` : ""}
    <div class="layout">
      <form id="responseForm">
        <h2>参加できる日時を選択</h2>
        <div class="slot-grid">${renderSlots()}</div>
        <label>お名前<input name="name" required placeholder="山田 太郎"></label>
        <label>メモ<textarea name="note" rows="3" placeholder="補足があれば入力"></textarea></label>
        <button class="primary full">回答する</button>
      </form>
      <aside>
        <h2>集計</h2>
        <div class="list">${renderScores()}</div>
      </aside>
    </div>
  `;
  document.querySelectorAll(".toggle-slot").forEach((button) => {
    button.onclick = () => {
      const slot = button.dataset.slot;
      selected.has(slot) ? selected.delete(slot) : selected.add(slot);
      render();
    };
  });
  document.querySelectorAll(".confirm-slot").forEach((button) => {
    button.onclick = async () => {
      eventData = await api(`/api/events/${eventId}/confirm`, { method: "PATCH", body: JSON.stringify({ slot: button.dataset.slot }) });
      render();
    };
  });
  document.querySelector("#responseForm").onsubmit = async (event) => {
    event.preventDefault();
    const data = new FormData(event.target);
    eventData = await api(`/api/events/${eventId}/responses`, {
      method: "POST",
      body: JSON.stringify({
        name: data.get("name"),
        note: data.get("note"),
        availableSlots: [...selected]
      })
    });
    selected = new Set();
    render();
  };
}

async function load() {
  try {
    eventData = await api(`/api/events/${eventId}`);
    render();
  } catch (error) {
    view.innerHTML = `<div class="empty">${error.message}</div>`;
  }
}

load();
