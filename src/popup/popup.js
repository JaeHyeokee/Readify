/** popup UI 로직 — 설정 관리, 스캔 제어, 진행률 표시
 *
 * 팝업이 열릴 때마다 background에서 현재 상태를 조회하여 UI를 복원하고,
 * 사용자 설정은 chrome.storage.local에 자동 저장/복원한다.
 */

const { MESSAGE_TYPES: MSG, SCAN_STATUS, UI_TEXT } = require("../constants.js");

// ─── DOM 요소 ───

const startBtn = document.getElementById("startBtn");
const progressEl = document.getElementById("progress");
const progressFill = document.getElementById("progressFill");
const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
const rangeType = document.getElementById("rangeType");
const customRange = document.getElementById("customRange");
const modal = document.getElementById("modal");

/** 설정 폼 요소 맵 — 저장/복원 시 일괄 순회용 */
const settingEls = {
  filename: document.getElementById("filename"),
  rangeType,
  pageFrom: document.getElementById("pageFrom"),
  pageTo: document.getElementById("pageTo"),
  ocrEnabled: document.getElementById("ocrEnabled"),
  quality: document.getElementById("quality"),
};

// ─── 상태 관리 ───

let scanning = false;

/** 스캔 중/대기 상태에 따라 버튼 텍스트, 스타일, 입력 폼 활성화를 전환한다. */
function setScanning(active) {
  scanning = active;
  startBtn.textContent = active ? UI_TEXT.buttons.stopScan : UI_TEXT.buttons.startScan;
  startBtn.classList.toggle("btn-stop", active);

  // 스캔 중에는 모든 설정 입력을 비활성화
  for (const el of document.querySelectorAll(".settings select, .settings input")) {
    el.disabled = active;
  }
}

// ─── 설정 저장/복원 ───

/** 현재 폼 값을 chrome.storage.local에 저장한다. (체크박스는 checked, 나머지는 value) */
function saveSettings() {
  const data = {};
  for (const [key, el] of Object.entries(settingEls)) {
    data[key] = el.type === "checkbox" ? el.checked : el.value;
  }
  chrome.storage.local.set({ settings: data });
}

/** chrome.storage.local에서 저장된 설정을 읽어 폼에 반영한다. */
function restoreSettings() {
  chrome.storage.local.get("settings", ({ settings }) => {
    if (!settings) return;
    for (const [key, el] of Object.entries(settingEls)) {
      if (settings[key] == null) continue;
      if (el.type === "checkbox") {
        el.checked = settings[key];
      } else {
        el.value = settings[key];
      }
    }
    // "직접 지정" 선택 시 커스텀 범위 입력 표시
    customRange.classList.toggle("hidden", rangeType.value !== "custom");
  });
}

// change: 드롭다운/체크박스 변경, input: 텍스트/숫자 입력 — 둘 다 감지하여 즉시 저장
for (const el of Object.values(settingEls)) {
  el.addEventListener("change", saveSettings);
  el.addEventListener("input", saveSettings);
}

restoreSettings();

// ─── 입력 검증 ───

/** 폼 값을 검증하고 background에 전달할 config 객체를 생성한다. */
function buildConfig() {
  const from = parseInt(settingEls.pageFrom.value, 10) || 1;
  // 빈 값은 null (= 마지막 페이지까지)
  const to = parseInt(settingEls.pageTo.value, 10) || null;

  if (rangeType.value === "custom" && to !== null && from > to) {
    throw new Error("시작 페이지가 끝 페이지보다 클 수 없습니다.");
  }

  return {
    filename: settingEls.filename.value.trim() || "Readify",
    quality: settingEls.quality.value,
    ocr: settingEls.ocrEnabled.checked,
    pageRange: rangeType.value === "all" ? null : { from, to },
  };
}

// ─── 상태 적용 (STATE 이벤트 + 팝업 재오픈 시) ───

/** scanState 객체를 받아 UI를 그에 맞게 갱신한다. */
function applyState(state) {
  if (!state) return;

  switch (state.status) {
    case SCAN_STATUS.idle:
      setScanning(false);
      progressEl.classList.add("hidden");
      resultEl.classList.add("hidden");
      startBtn.classList.remove("hidden");
      break;

    case SCAN_STATUS.scanning:
      setScanning(true);
      progressEl.classList.remove("hidden");
      resultEl.classList.add("hidden");
      if (state.total > 0) {
        const pct = Math.round((state.current / state.total) * 100);
        progressFill.style.width = `${pct}%`;
        statusEl.textContent = `${state.step} (${state.current}/${state.total})`;
      } else {
        progressFill.style.width = "0%";
        statusEl.textContent = UI_TEXT.status.preparing;
      }
      break;

    case SCAN_STATUS.saving:
      progressEl.classList.add("hidden");
      startBtn.classList.add("hidden");
      resultEl.classList.remove("hidden");
      break;

    case SCAN_STATUS.done:
      startBtn.classList.remove("hidden");
      resultEl.classList.add("hidden");
      progressEl.classList.add("hidden");
      setScanning(false);
      break;

    case SCAN_STATUS.stopped:
      progressEl.classList.add("hidden");
      resultEl.classList.add("hidden");
      startBtn.classList.remove("hidden");
      setScanning(false);
      break;

    case SCAN_STATUS.error:
      progressEl.classList.remove("hidden");
      statusEl.textContent = `오류: ${state.message || "알 수 없는 오류"}`;
      startBtn.classList.remove("hidden");
      setScanning(false);
      break;
  }
}

// 팝업이 열릴 때 background의 현재 상태를 조회하여 UI를 동기화
chrome.runtime.sendMessage({ type: MSG.GET_STATE }, (state) => {
  if (chrome.runtime.lastError) return;
  applyState(state);
});

// ─── 이벤트 핸들러 ───

// "직접 지정" 선택 시 페이지 범위 입력 표시/숨김
rangeType.addEventListener("change", () => {
  customRange.classList.toggle("hidden", rangeType.value !== "custom");
});

startBtn.addEventListener("click", () => {
  // 스캔 중이면 중지 확인 모달 표시
  if (scanning) {
    showModal();
    return;
  }

  // 입력 검증
  let config;
  try {
    config = buildConfig();
  } catch (err) {
    statusEl.textContent = `오류: ${err.message}`;
    progressEl.classList.remove("hidden");
    return;
  }

  // UI를 스캔 모드로 전환 후 background에 시작 요청
  setScanning(true);
  progressEl.classList.remove("hidden");
  resultEl.classList.add("hidden");
  progressFill.style.width = "0%";
  statusEl.textContent = UI_TEXT.status.preparing;

  chrome.runtime.sendMessage({ type: MSG.START_SCAN, config });
});

// ─── 메시지 수신 (background → popup) ───

chrome.runtime.onMessage.addListener((msg) => {
  // 진행률 업데이트
  if (msg.type === MSG.PROGRESS) {
    const pct = Math.round((msg.current / msg.total) * 100);
    progressFill.style.width = `${pct}%`;
    statusEl.textContent = `${msg.step} (${msg.current}/${msg.total})`;
    return;
  }

  // 상태 변화 — applyState가 모든 분기를 처리
  if (msg.type === MSG.STATE) {
    applyState(msg);
  }
});

// ─── 툴팁 (ⓘ 아이콘 hover 시 마우스 근처에 설명 표시) ───

let tooltipEl = null;

document.querySelectorAll(".info-icon").forEach((icon) => {
  icon.addEventListener("mouseenter", (e) => {
    tooltipEl = document.createElement("div");
    tooltipEl.className = "tooltip";
    tooltipEl.textContent = icon.dataset.tooltip;
    document.body.appendChild(tooltipEl);
    positionTooltip(e);
  });

  icon.addEventListener("mousemove", positionTooltip);

  icon.addEventListener("mouseleave", () => {
    if (tooltipEl) {
      tooltipEl.remove();
      tooltipEl = null;
    }
  });
});

/** 툴팁을 마우스 커서의 오른쪽 위에 위치시킨다. */
function positionTooltip(e) {
  if (!tooltipEl) return;
  tooltipEl.style.left = `${e.clientX + 10}px`;
  tooltipEl.style.top = `${e.clientY - tooltipEl.offsetHeight - 8}px`;
}

// ─── 중지 확인 모달 ───

function showModal() {
  modal.classList.remove("hidden");
}

function hideModal() {
  modal.classList.add("hidden");
}

document.getElementById("modalCancel").addEventListener("click", hideModal);
document.querySelector(".modal-backdrop").addEventListener("click", hideModal);

document.getElementById("modalConfirm").addEventListener("click", () => {
  hideModal();
  chrome.runtime.sendMessage({ type: MSG.STOP_SCAN });
});
