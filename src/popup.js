/** popup UI 로직 — 설정 전달, 진행률 표시 */

const startBtn = document.getElementById("startBtn");
const progressEl = document.getElementById("progress");
const progressFill = document.getElementById("progressFill");
const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
const rangeType = document.getElementById("rangeType");
const customRange = document.getElementById("customRange");

let scanning = false;

function setScanning(active) {
  scanning = active;
  startBtn.textContent = active ? "생성 중지" : "PDF 생성 시작";
  startBtn.classList.toggle("btn-stop", active);

  // 설정 입력 비활성화/활성화
  for (const el of document.querySelectorAll(".settings select, .settings input")) {
    el.disabled = active;
  }
}

// 설정 저장/복원
const settingEls = {
  filename: document.getElementById("filename"),
  rangeType: rangeType,
  pageFrom: document.getElementById("pageFrom"),
  pageTo: document.getElementById("pageTo"),
  ocrEnabled: document.getElementById("ocrEnabled"),
  quality: document.getElementById("quality"),
};

function saveSettings() {
  const data = {};
  for (const [key, el] of Object.entries(settingEls)) {
    data[key] = el.type === "checkbox" ? el.checked : el.value;
  }
  chrome.storage.local.set({ settings: data });
}

// 설정 복원
chrome.storage.local.get("settings", ({ settings }) => {
  if (settings) {
    for (const [key, el] of Object.entries(settingEls)) {
      if (settings[key] == null) continue;
      if (el.type === "checkbox") {
        el.checked = settings[key];
      } else {
        el.value = settings[key];
      }
    }
    customRange.classList.toggle("hidden", rangeType.value !== "custom");
  }
});

// 설정 변경 시 자동 저장
for (const el of Object.values(settingEls)) {
  el.addEventListener("change", saveSettings);
  el.addEventListener("input", saveSettings);
}

// 페이지 범위 토글
rangeType.addEventListener("change", () => {
  customRange.classList.toggle("hidden", rangeType.value !== "custom");
});

// 팝업 열릴 때 현재 상태 복원
chrome.runtime.sendMessage({ type: "GET_STATE" }, (state) => {
  if (!state || state.status === "idle") return;

  if (state.status === "scanning") {
    setScanning(true);
    progressEl.classList.remove("hidden");
    if (state.total > 0) {
      const pct = Math.round((state.current / state.total) * 100);
      progressFill.style.width = `${pct}%`;
      statusEl.textContent = `${state.step} (${state.current}/${state.total})`;
    } else {
      statusEl.textContent = "준비 중...";
    }
  } else if (state.status === "saving") {
    startBtn.classList.add("hidden");
    resultEl.classList.remove("hidden");
  } else if (state.status === "done") {
    resultEl.classList.add("hidden");
  } else if (state.status === "error") {
    progressEl.classList.remove("hidden");
    statusEl.textContent = `오류: ${state.message}`;
  } else if (state.status === "stopped") {
    // 중지 시 진행률 숨김
  }
});

startBtn.addEventListener("click", async () => {
  if (scanning) {
    showModal();
    return;
  }

  setScanning(true);
  progressEl.classList.remove("hidden");
  resultEl.classList.add("hidden");
  progressFill.style.width = "0%";
  statusEl.textContent = "준비 중...";

  const config = {
    filename: document.getElementById("filename").value.trim() || "Readify",
    quality: document.getElementById("quality").value,
    ocr: document.getElementById("ocrEnabled").checked,
    pageRange: rangeType.value === "all" ? null : {
      from: parseInt(document.getElementById("pageFrom").value, 10) || 1,
      to: parseInt(document.getElementById("pageTo").value, 10) || null,
    },
  };

  chrome.runtime.sendMessage({ type: "START_SCAN", config });
});

// background로부터 진행 상태 수신
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "PROGRESS") {
    const pct = Math.round((msg.current / msg.total) * 100);
    progressFill.style.width = `${pct}%`;
    statusEl.textContent = `${msg.step} (${msg.current}/${msg.total})`;
  }

  if (msg.type === "SAVE_READY") {
    progressEl.classList.add("hidden");
    startBtn.classList.add("hidden");
    resultEl.classList.remove("hidden");
  }

  if (msg.type === "SAVE_DONE") {
    startBtn.classList.remove("hidden");
    resultEl.classList.add("hidden");
    setScanning(false);
  }

  if (msg.type === "STOPPED") {
    progressEl.classList.add("hidden");
    setScanning(false);
  }

  if (msg.type === "ERROR") {
    statusEl.textContent = `오류: ${msg.message}`;
    setScanning(false);
  }
});

// 툴팁
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

function positionTooltip(e) {
  if (!tooltipEl) return;
  tooltipEl.style.left = `${e.clientX + 10}px`;
  tooltipEl.style.top = `${e.clientY - tooltipEl.offsetHeight - 8}px`;
}

// 중지 확인 모달
const modal = document.getElementById("modal");

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
  chrome.runtime.sendMessage({ type: "STOP_SCAN" });
});
