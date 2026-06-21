const STORAGE_KEY = "hu-peng-yin-ban-tool";
const LEGACY_STORAGE_KEY = "road-help-mvp";
const CARD_TTL_MS = 120 * 60 * 1000;
const NEARBY_TTL_MINUTES = 30;
const CARD_TTL_MINUTES = 120;

const defaultState = {
  profile: {
    id: createId("local"),
    nickname: "",
    vehicle: "機車",
  },
  status: "我已出發",
  lastLocation: null,
  rallyCards: [],
  nearbyPeople: [],
  selectedTemplate: "我在附近，想找人一起走一段。",
  checklist: {},
  checklistConfirmed: {},
  antiTheft: {
    enabled: false,
    anchor: null,
    radius: 100,
    lastCheck: null,
  },
};

const checklistItems = {
  "機車": ["胎壓與胎紋", "煞車手感", "燈號與方向燈", "油量/電量", "安全帽與雨具"],
  "重機": ["胎壓與胎溫", "煞車與離合器", "燈號與後照鏡", "油量與鏈條", "護具與證件"],
  "自行車": ["胎壓與快拆", "煞車皮與變速", "前後燈", "水壺與補給", "安全帽"],
  "徒步": [
    "手機電量與行動電源",
    "離線地圖與今日路線",
    "飲水與高熱量補給",
    "鞋襪狀態與足部防磨",
    "雨具、反光配件與頭燈",
    "住宿點、撤退點與交通備案",
    "天氣、紫外線與路況",
    "緊急聯絡方式與常用藥品",
  ],
};

const templates = [
  "我在附近，想找人一起走一段。",
  "前方路況如何？有人剛經過嗎？",
  "附近有補給點或休息點嗎？",
  "我需要協助，請在「發起附近揪團卡」發布可協助狀態。",
  "我先休息一下，位置稍後關閉。",
  "已抵達，這張卡可以忽略。",
];

let state = loadState();

const els = {
  rangeRadar: document.querySelector("#rangeRadar"),
  profileForm: document.querySelector("#profileForm"),
  nickname: document.querySelector("#nickname"),
  locationConsent: document.querySelector("#locationConsent"),
  updateLocation: document.querySelector("#updateLocation"),
  openGoogleMaps: document.querySelector("#openGoogleMaps"),
  locationStatus: document.querySelector("#locationStatus"),
  lastUpdated: document.querySelector("#lastUpdated"),
  rallyForm: document.querySelector("#rallyForm"),
  rallyType: document.querySelector("#rallyType"),
  rallyNote: document.querySelector("#rallyNote"),
  rallyCards: document.querySelector("#rallyCards"),
  activeCardCount: document.querySelector("#activeCardCount"),
  nearbyList: document.querySelector("#nearbyList"),
  refreshNearby: document.querySelector("#refreshNearby"),
  checklist: document.querySelector("#checklist"),
  checklistStatus: document.querySelector("#checklistStatus"),
  confirmChecklist: document.querySelector("#confirmChecklist"),
  resetChecklist: document.querySelector("#resetChecklist"),
  templateMessages: document.querySelector("#templateMessages"),
  shortMessage: document.querySelector("#shortMessage"),
  composeMessage: document.querySelector("#composeMessage"),
  messageOutput: document.querySelector("#messageOutput"),
  usageCount: document.querySelector("#usageCount"),
  antiTheftStatus: document.querySelector("#antiTheftStatus"),
  antiTheftState: document.querySelector("#antiTheftState"),
  antiTheftDistance: document.querySelector("#antiTheftDistance"),
  antiTheftRadius: document.querySelector("#antiTheftRadius"),
  enableAntiTheft: document.querySelector("#enableAntiTheft"),
  checkAntiTheft: document.querySelector("#checkAntiTheft"),
  disableAntiTheft: document.querySelector("#disableAntiTheft"),
  deleteData: document.querySelector("#deleteData"),
  reportAbuse: document.querySelector("#reportAbuse"),
};

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return cloneDefaultState();
    const nextState = { ...cloneDefaultState(), ...JSON.parse(raw) };
    nextState.profile = { ...cloneDefaultState().profile, ...nextState.profile };
    if (!nextState.profile.id) nextState.profile.id = createId("local");
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    return nextState;
  } catch {
    return cloneDefaultState();
  }
}

function cloneDefaultState() {
  return JSON.parse(JSON.stringify(defaultState));
}

function createId(prefix) {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  localStorage.removeItem(LEGACY_STORAGE_KEY);
}

function getRangeMode() {
  if (state.status === "需要協助") {
    return { name: "協助擴大", rings: [5, 15, 50] };
  }

  if (state.profile.vehicle === "徒步") {
    return { name: "徒步環島", rings: [1, 5, 15] };
  }

  if (state.profile.vehicle === "機車" || state.profile.vehicle === "重機") {
    return { name: "騎乘擴大", rings: [3, 10, 30] };
  }

  return { name: "一般環島", rings: [1, 3, 10] };
}

function formatRangeLabel(km) {
  return `${km}km`;
}

function formatTime(ts) {
  if (!ts) return "未更新";
  return new Intl.DateTimeFormat("zh-TW", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ts));
}

function formatDistance(meters) {
  if (!Number.isFinite(meters)) return "距離未知";
  if (meters < 1000) return `約 ${Math.max(100, Math.round(meters / 100) * 100)} 公尺`;
  return `約 ${(meters / 1000).toFixed(meters < 10000 ? 1 : 0)} 公里`;
}

function distanceMeters(from, to) {
  const radius = 6371000;
  const lat1 = from.lat * Math.PI / 180;
  const lat2 = to.lat * Math.PI / 180;
  const dLat = (to.lat - from.lat) * Math.PI / 180;
  const dLng = (to.lng - from.lng) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * radius * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function minutesLeft(expiresAt) {
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / 60000));
}

function pruneExpiredCards() {
  state.rallyCards = state.rallyCards.filter((card) => card.expiresAt > Date.now());
  saveState();
}

function renderProfile() {
  els.nickname.value = state.profile.nickname;
  document.querySelectorAll("input[name='vehicle']").forEach((input) => {
    input.checked = input.value === state.profile.vehicle;
  });
}

function renderStatus() {
  renderRadar();
  document.querySelectorAll(".segmented.status button").forEach((button) => {
    button.classList.toggle("active", button.dataset.status === state.status);
  });

  if (state.status === "關閉位置") {
    els.locationStatus.textContent = "位置已關閉，不會出現在附近使用者列表中";
  } else if (state.lastLocation) {
    els.locationStatus.textContent = "已取得使用中定位，僅用於約略距離";
  } else {
    els.locationStatus.textContent = "尚未取得定位";
  }

  els.lastUpdated.textContent = state.lastLocation
    ? `更新 ${formatTime(state.lastLocation.updatedAt)}`
    : "未更新";
  els.openGoogleMaps.disabled = !state.lastLocation || state.status === "關閉位置";
}

function renderRadar() {
  const mode = getRangeMode();
  const isLocated = Boolean(state.lastLocation && state.status !== "關閉位置");
  const maxDistance = mode.rings[mode.rings.length - 1] * 1000;
  const people = isLocated ? state.nearbyPeople.slice(0, 8) : [];
  const peopleDots = people.map((person, index) => {
    const distance = Math.min(Number(person.distanceMeters || 0), maxDistance);
    const bearing = Number(person.bearingDegrees || 0);
    const radiusPercent = 43 * Math.min(1, distance / maxDistance);
    const angle = (bearing - 90) * Math.PI / 180;
    const left = 50 + Math.cos(angle) * radiusPercent;
    const top = 50 + Math.sin(angle) * radiusPercent;
    const label = person.vehicle === "自行車" ? "自" : person.vehicle === "重機" ? "重" : person.vehicle === "徒步" ? "步" : "機";

    return `
      <span class="radar-person person-${index % 4}" style="left:${left.toFixed(1)}%; top:${top.toFixed(1)}%;" title="${escapeAttr(person.nickname || "匿名")} ${formatDistance(distance)}">
        ${escapeHtml(label)}
      </span>
    `;
  }).join("");

  els.rangeRadar.innerHTML = `
    <span class="radar-ring ring-outer"></span>
    <span class="radar-ring ring-middle"></span>
    <span class="radar-ring ring-inner"></span>
    <span class="ring-label label-inner">${formatRangeLabel(mode.rings[0])}</span>
    <span class="ring-label label-middle">${formatRangeLabel(mode.rings[1])}</span>
    <span class="ring-label label-outer">${formatRangeLabel(mode.rings[2])}</span>
    ${peopleDots}
    <span class="radar-self ${isLocated ? "" : "muted"}">${isLocated ? "我" : "未定位"}</span>
    <span class="radar-caption">${people.length ? "附近點為約略方位與距離，非精準座標" : `${mode.name}距離圈層；更新附近後顯示約略點`}</span>
  `;
}

function renderRallyCards() {
  pruneExpiredCards();
  els.activeCardCount.textContent = state.rallyCards.length;

  if (!state.rallyCards.length) {
    els.rallyCards.className = "card-list empty-state";
    els.rallyCards.textContent = "目前沒有有效卡片";
    return;
  }

  els.rallyCards.className = "card-list";
  els.rallyCards.innerHTML = state.rallyCards.map((card) => `
    <article class="rally-card">
      <div class="rally-card-head">
        <strong>${escapeHtml(card.type)}</strong>
        ${card.ownerId === state.profile.id ? `
          <button class="icon-action danger" type="button" data-delete-card="${escapeAttr(card.id)}" aria-label="刪除 ${escapeAttr(card.type)} 卡片">
            <svg class="icon"><use href="#i-trash"></use></svg>
          </button>
        ` : ""}
      </div>
      <p>${escapeHtml(card.note || "無補充文字")}</p>
      <div class="meta">
        <span>${escapeHtml(card.nickname || "匿名")}</span>
        <span>${escapeHtml(card.vehicle || "未設定")}</span>
        ${Number.isFinite(card.distanceMeters) ? `<span>${formatDistance(card.distanceMeters)}</span>` : ""}
        <span>剩 ${minutesLeft(card.expiresAt)} 分鐘</span>
      </div>
    </article>
  `).join("");
}

function renderNearby() {
  if (state.status === "關閉位置") {
    els.nearbyList.className = "nearby-list empty-state";
    els.nearbyList.textContent = "位置已關閉，不會更新或顯示附近使用者。";
    state.nearbyPeople = [];
    return;
  }

  if (!state.lastLocation) {
    els.nearbyList.className = "nearby-list empty-state";
    els.nearbyList.textContent = "請先勾選定位同意並更新定位，才能查看附近使用者。";
    state.nearbyPeople = [];
    return;
  }

  els.nearbyList.className = "nearby-list empty-state";
  els.nearbyList.textContent = "已取得你的定位；按「檢查狀態」更新附近列表。";
}

function renderNearbyPeople(people) {
  state.nearbyPeople = people;
  saveState();
  renderRadar();

  if (!people.length) {
    const rings = getRangeMode().rings;
    els.nearbyList.className = "nearby-list empty-state";
    els.nearbyList.textContent = `目前 ${rings[rings.length - 1]} 公里內沒有其他 ${NEARBY_TTL_MINUTES} 分鐘內更新的使用者。`;
    return;
  }

  els.nearbyList.className = "nearby-list";
  els.nearbyList.innerHTML = people.map((person) => `
    <article class="nearby-item">
      <strong>${escapeHtml(person.nickname || "匿名")}</strong>
      <span>${escapeHtml(person.vehicle || "未設定")}｜${escapeHtml(person.status || "未更新")}</span>
      <span>${formatDistance(Number(person.distanceMeters))}｜更新 ${formatTime(person.updatedAt)}</span>
    </article>
  `).join("");
}

function renderChecklist() {
  const vehicle = state.profile.vehicle;
  const items = checklistItems[vehicle] || checklistItems["機車"];
  const checked = state.checklist[vehicle] || {};
  const doneCount = items.filter((item) => checked[item]).length;
  const confirmedAt = state.checklistConfirmed[vehicle];

  els.checklistStatus.innerHTML = `
    <span>${vehicle === "徒步" ? "徒步環島檢核" : `${vehicle}檢核`}｜${confirmedAt ? `已確認：${formatTime(confirmedAt)}` : "尚未確認檢核"}</span>
    <strong>${doneCount}/${items.length}</strong>
  `;
  els.confirmChecklist.disabled = doneCount !== items.length;

  els.checklist.innerHTML = items.map((item) => {
    const done = Boolean(checked[item]);
    return `
      <label class="check-item ${done ? "done" : ""}">
        <input type="checkbox" data-check="${escapeAttr(item)}" ${done ? "checked" : ""}>
        <span>${escapeHtml(item)}</span>
      </label>
    `;
  }).join("");
}

function renderTemplates() {
  els.templateMessages.innerHTML = templates.map((template) => `
    <button type="button" class="${state.selectedTemplate === template ? "active" : ""}" data-template="${escapeAttr(template)}">
      ${escapeHtml(template)}
    </button>
  `).join("");
}

function render() {
  renderProfile();
  renderStatus();
  renderRallyCards();
  renderNearby();
  renderChecklist();
  renderTemplates();
  renderAntiTheft();
}

async function recordUsage() {
  if (!els.usageCount) return;

  if (!shouldCountUsage()) {
    els.usageCount.textContent = "正式部署後開始統計";
    return;
  }

  try {
    const response = await fetch("/api/usage/visit", { method: "POST" });
    if (!response.ok) throw new Error("usage failed");
    const data = await response.json();
    els.usageCount.textContent = data.configured === false
      ? "統計尚未綁定"
      : `${Number(data.visits || 0).toLocaleString("zh-TW")} 次`;
  } catch {
    els.usageCount.textContent = "統計尚未啟用";
  }
}

function shouldCountUsage() {
  const host = window.location.hostname;
  const isLocal = host === "localhost"
    || host === "127.0.0.1"
    || host.startsWith("192.168.")
    || host.startsWith("10.")
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    || window.location.protocol === "file:";
  return !isLocal;
}

function renderAntiTheft() {
  const anti = state.antiTheft || defaultState.antiTheft;
  els.antiTheftRadius.value = String(anti.radius || 100);
  els.antiTheftStatus.classList.toggle("alert", false);

  if (!anti.enabled || !anti.anchor) {
    els.antiTheftState.textContent = "尚未啟用";
    els.antiTheftDistance.textContent = "將目前位置設為停放點後，可檢查是否超出警戒範圍。";
    return;
  }

  els.antiTheftState.textContent = "警戒中";
  els.antiTheftDistance.textContent = anti.lastCheck
    ? `上次檢查：${formatTime(anti.lastCheck.checkedAt)}，距離停放點約 ${Math.round(anti.lastCheck.distance)} 公尺。`
    : `停放點已設定，警戒半徑 ${anti.radius} 公尺。`;
  els.antiTheftStatus.classList.toggle("alert", Boolean(anti.lastCheck && anti.lastCheck.distance > anti.radius));
}

function updateLocation() {
  if (!els.locationConsent.checked) {
    els.locationStatus.textContent = "請先勾選定位同意，再更新定位";
    return;
  }

  if (!navigator.geolocation) {
    els.locationStatus.textContent = "此瀏覽器不支援定位";
    return;
  }

  els.locationStatus.textContent = "正在取得定位...";
  navigator.geolocation.getCurrentPosition(
    (position) => {
      state.lastLocation = {
        lat: Number(position.coords.latitude.toFixed(4)),
        lng: Number(position.coords.longitude.toFixed(4)),
        accuracy: Math.round(position.coords.accuracy || 0),
        updatedAt: Date.now(),
      };
      if (state.status === "關閉位置") state.status = "我已出發";
      saveState();
      render();
    },
    () => {
      els.locationStatus.textContent = "定位被拒絕或暫時無法取得";
    },
    { enableHighAccuracy: false, timeout: 9000, maximumAge: 60000 },
  );
}

function handleRefreshNearby() {
  if (state.status === "關閉位置") {
    renderNearby();
    els.messageOutput.textContent = "位置已關閉，不會更新附近列表。";
    return;
  }

  if (!els.locationConsent.checked) {
    els.locationConsent.focus();
    renderNearby();
    els.messageOutput.textContent = "請先勾選定位同意，再查看附近使用者。";
    return;
  }

  if (!state.lastLocation) {
    els.messageOutput.textContent = "正在取得本次定位，完成後請再按一次檢查狀態。";
    updateLocation();
    return;
  }

  refreshNearbyPeople();
}

async function refreshNearbyPeople() {
  els.messageOutput.textContent = "正在更新附近使用者列表...";

  try {
    const mode = getRangeMode();
    const response = await fetch("/api/nearby", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: state.profile.id,
        nickname: state.profile.nickname || "匿名",
        vehicle: state.profile.vehicle,
        status: state.status,
        radiusKm: mode.rings[mode.rings.length - 1],
        location: state.lastLocation,
      }),
    });

    if (!response.ok) throw new Error("nearby_failed");

    const data = await response.json();
    if (!data.configured) {
      els.messageOutput.textContent = "附近功能尚未綁定後端資料庫。";
      return;
    }

    renderNearbyPeople(Array.isArray(data.people) ? data.people : []);
    await refreshSharedCards(false);
    els.messageOutput.textContent = `附近列表已更新；你的約略位置會保留 ${data.ttlMinutes || NEARBY_TTL_MINUTES} 分鐘。`;
  } catch {
    els.messageOutput.textContent = "附近功能暫時無法連線，請稍後再試。";
  }
}

async function refreshSharedCards(showMessage = true) {
  if (!state.lastLocation || state.status === "關閉位置") {
    state.rallyCards = [];
    renderRallyCards();
    return;
  }

  try {
    const mode = getRangeMode();
    const params = new URLSearchParams({
      lat: String(state.lastLocation.lat),
      lng: String(state.lastLocation.lng),
      radiusKm: String(mode.rings[mode.rings.length - 1]),
    });
    const response = await fetch(`/api/cards?${params.toString()}`);
    if (!response.ok) throw new Error("cards_failed");
    const data = await response.json();
    if (!data.configured) throw new Error("cards_not_configured");
    state.rallyCards = Array.isArray(data.cards) ? data.cards : [];
    renderRallyCards();
    if (showMessage) els.messageOutput.textContent = "附近揪團卡已更新。";
  } catch {
    if (showMessage) els.messageOutput.textContent = "附近揪團卡暫時無法連線。";
  }
}

async function publishSharedCard(type, note) {
  if (!state.lastLocation || state.status === "關閉位置") {
    els.messageOutput.textContent = "請先開啟位置並更新定位，才能發布給附近使用者。";
    return false;
  }

  try {
    const response = await fetch("/api/cards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ownerId: state.profile.id,
        nickname: state.profile.nickname || "匿名",
        vehicle: state.profile.vehicle,
        type,
        note,
        location: state.lastLocation,
      }),
    });
    if (!response.ok) throw new Error("publish_failed");
    const data = await response.json();
    if (!data.configured) throw new Error("cards_not_configured");
    await refreshSharedCards(false);
    els.messageOutput.textContent = `已發布給附近使用者，${data.ttlMinutes || CARD_TTL_MINUTES} 分鐘後自動過期。`;
    return true;
  } catch {
    els.messageOutput.textContent = "卡片發布失敗，請確認 Cloudflare KV 已綁定並稍後再試。";
    return false;
  }
}

async function deleteSharedCard(cardId) {
  try {
    const response = await fetch("/api/cards", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardId, ownerId: state.profile.id }),
    });
    if (!response.ok) throw new Error("delete_failed");
    await refreshSharedCards(false);
    els.messageOutput.textContent = "已刪除公開卡片。";
  } catch {
    els.messageOutput.textContent = "刪除公開卡片失敗，請稍後再試。";
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}

els.profileForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = new FormData(els.profileForm);
  state.profile.nickname = String(form.get("nickname") || "").trim().slice(0, 16);
  state.profile.vehicle = String(form.get("vehicle") || "機車");
  saveState();
  render();
});

els.profileForm.addEventListener("change", (event) => {
  const input = event.target.closest("input[name='vehicle']");
  if (!input) return;

  state.profile.vehicle = input.value;
  saveState();
  renderRadar();
  renderChecklist();
  renderNearby();
});

document.querySelectorAll(".segmented.status button").forEach((button) => {
  button.addEventListener("click", () => {
    state.status = button.dataset.status;
    if (state.status === "關閉位置") {
      state.lastLocation = null;
      state.nearbyPeople = [];
    }
    saveState();
    render();
  });
});

els.updateLocation.addEventListener("click", updateLocation);
els.openGoogleMaps.addEventListener("click", () => {
  if (!state.lastLocation || state.status === "關閉位置") {
    els.locationStatus.textContent = "請先更新定位，再開啟 Google Maps";
    return;
  }

  const { lat, lng } = state.lastLocation;
  window.open(`https://www.google.com/maps?q=${lat},${lng}`, "_blank", "noopener,noreferrer");
});
els.refreshNearby.addEventListener("click", handleRefreshNearby);
els.antiTheftRadius.addEventListener("change", () => {
  state.antiTheft.radius = Number(els.antiTheftRadius.value);
  saveState();
  renderAntiTheft();
});

els.enableAntiTheft.addEventListener("click", () => {
  if (!state.lastLocation || state.status === "關閉位置") {
    els.messageOutput.textContent = "請先更新定位，再設定停放點。";
    return;
  }

  state.antiTheft = {
    enabled: true,
    anchor: {
      lat: state.lastLocation.lat,
      lng: state.lastLocation.lng,
      setAt: Date.now(),
    },
    radius: Number(els.antiTheftRadius.value),
    lastCheck: null,
  };
  saveState();
  renderAntiTheft();
  els.messageOutput.textContent = "已設定停放點並啟用位置防盜。";
});

els.checkAntiTheft.addEventListener("click", () => {
  if (!state.antiTheft.enabled || !state.antiTheft.anchor) {
    els.messageOutput.textContent = "請先設定停放點。";
    return;
  }

  if (!state.lastLocation || state.status === "關閉位置") {
    els.messageOutput.textContent = "請先更新定位，再檢查目前位置。";
    return;
  }

  const distance = distanceMeters(state.antiTheft.anchor, state.lastLocation);
  state.antiTheft.lastCheck = { distance, checkedAt: Date.now() };
  saveState();
  renderAntiTheft();
  els.messageOutput.textContent = distance > state.antiTheft.radius
    ? `警示：目前位置已超出警戒半徑，約 ${Math.round(distance)} 公尺。`
    : `目前仍在警戒範圍內，約 ${Math.round(distance)} 公尺。`;
});

els.disableAntiTheft.addEventListener("click", () => {
  state.antiTheft = { enabled: false, anchor: null, radius: Number(els.antiTheftRadius.value), lastCheck: null };
  saveState();
  renderAntiTheft();
  els.messageOutput.textContent = "已解除位置防盜警戒。";
});

els.rallyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.status === "關閉位置") {
    els.messageOutput.textContent = "位置已關閉，不能發布給附近使用者。";
    return;
  }

  const published = await publishSharedCard(els.rallyType.value, els.rallyNote.value.trim().slice(0, 60));
  if (published) els.rallyNote.value = "";
});

els.rallyCards.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delete-card]");
  if (!button) return;

  const confirmed = window.confirm("確定刪除這張揪團卡？");
  if (!confirmed) return;

  await deleteSharedCard(button.dataset.deleteCard);
});

els.checklist.addEventListener("change", (event) => {
  const input = event.target.closest("[data-check]");
  if (!input) return;

  const vehicle = state.profile.vehicle;
  state.checklist[vehicle] = state.checklist[vehicle] || {};
  state.checklist[vehicle][input.dataset.check] = input.checked;
  state.checklistConfirmed[vehicle] = null;
  saveState();
  renderChecklist();
});

els.resetChecklist.addEventListener("click", () => {
  state.checklist[state.profile.vehicle] = {};
  state.checklistConfirmed[state.profile.vehicle] = null;
  saveState();
  renderChecklist();
});

els.confirmChecklist.addEventListener("click", () => {
  const vehicle = state.profile.vehicle;
  const items = checklistItems[vehicle] || checklistItems["機車"];
  const checked = state.checklist[vehicle] || {};
  const doneCount = items.filter((item) => checked[item]).length;

  if (doneCount !== items.length) {
    els.messageOutput.textContent = `還有 ${items.length - doneCount} 個行前檢核項目尚未勾選。`;
    return;
  }

  state.checklistConfirmed[vehicle] = Date.now();
  saveState();
  renderChecklist();
  els.messageOutput.textContent = `${vehicle}行前檢核已確認。`;
});

els.templateMessages.addEventListener("click", (event) => {
  const button = event.target.closest("[data-template]");
  if (!button) return;
  state.selectedTemplate = button.dataset.template;
  saveState();
  renderTemplates();
});

els.composeMessage.addEventListener("click", async () => {
  const extra = els.shortMessage.value.trim();
  const note = extra ? `${state.selectedTemplate} 補充：${extra}` : state.selectedTemplate;
  const published = await publishSharedCard("模板訊息", note.slice(0, 80));
  if (published) els.shortMessage.value = "";
});

els.deleteData.addEventListener("click", () => {
  const confirmed = window.confirm("確定刪除這台裝置上的工具資料？");
  if (!confirmed) return;
  localStorage.removeItem(STORAGE_KEY);
  state = loadState();
  render();
  els.messageOutput.textContent = "已刪除本機資料。";
});

els.reportAbuse.addEventListener("click", () => {
  els.messageOutput.textContent = "工具版先記錄檢舉入口；正式版需接後端保存檢舉證據與停權狀態。";
});

setInterval(renderRallyCards, 30000);
render();
recordUsage();
