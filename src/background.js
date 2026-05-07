/** Service Worker — 파이프라인 오케스트레이션 및 메시지 라우팅
 *
 * 전체 흐름: 팝업 → START_SCAN → runPipeline()
 *   1) content script 주입 + 레이아웃 측정
 *   2) 페이지별 스크롤 → captureVisibleTab → 크롭
 *   3) offscreen에서 OCR + PDF 생성
 *   4) 다운로드 + 저장 완료 감지
 */

const { MESSAGE_TYPES: MSG, SCAN_STATUS, UI_TEXT, TIMING } = require("./constants.js");
const { safeSendRuntimeMessage } = require("./messaging.js");

/** offscreen document가 이미 생성되었는지 여부 */
let offscreenReady = false;
/** 사용자 중지 요청 플래그 */
let stopFlag = false;
/** 파이프라인 중복 실행 방지 플래그 */
let pipelineRunning = false;

/** 현재 작업 상태 — 팝업이 다시 열릴 때 GET_STATE로 조회 */
let scanState = { status: SCAN_STATUS.idle };

// ─── 유틸리티 ───

/** scanState를 갱신하고 팝업에 STATE 이벤트로 알린다. */
function updateState(status, extra = {}) {
  scanState = { status, ...extra };
  safeSendRuntimeMessage({ type: MSG.STATE, ...scanState });
}

/**
 * 중지 요청 여부를 확인한다.
 * @returns {boolean} true면 호출자는 즉시 return해야 한다.
 */
function checkStop() {
  if (stopFlag) {
    updateState(SCAN_STATUS.stopped);
    return true;
  }
  return false;
}

/**
 * chrome 메시지 API를 Promise로 감싸 응답을 기다린다.
 * tabId가 주어지면 탭(content script)으로, 아니면 확장 런타임(offscreen)으로 전송한다.
 */
function sendMessageAsync(tabId, message) {
  return new Promise((resolve) => {
    const callback = (response) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response);
      }
    };
    if (tabId != null) {
      chrome.tabs.sendMessage(tabId, message, callback);
    } else {
      chrome.runtime.sendMessage(message, callback);
    }
  });
}

const sendToTab = (tabId, message) => sendMessageAsync(tabId, message);
const sendToRuntime = (message) => sendMessageAsync(null, message);

// ─── offscreen 관리 ───

/** offscreen document가 없으면 생성한다. Canvas/OCR/PDF 처리에 DOM이 필요하기 때문. */
async function ensureOffscreen() {
  if (offscreenReady) return;

  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });

  if (contexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["DOM_PARSER"],
      justification: "Canvas 이미지 처리, OCR, PDF 생성을 위해 DOM 접근 필요",
    });
  }

  offscreenReady = true;
}

// ─── 파이프라인 단계별 함수 ───

/** 1단계: content script를 현재 탭에 주입하고 문서 레이아웃(총 페이지 수, 페이지 간격)을 측정한다. */
async function injectAndMeasure(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
  });

  const result = await sendToTab(tabId, { type: MSG.MEASURE });
  if (!result?.success) {
    throw new Error(result?.error || "레이아웃 측정 실패");
  }

  if (result.totalPages === 0) throw new Error("페이지를 찾을 수 없습니다");
  return result;
}

/** 2단계: 페이지별로 스크롤 → 브라우저 스크린샷 → 페이지 영역만 크롭하여 이미지 배열을 반환한다. */
async function capturePages(tabId, pageStep, startPage, endPage) {
  const pageCount = endPage - startPage + 1;
  const images = [];

  // 캡처 시작 전 오버레이(컨트롤바 등)를 숨기고, 전체 캡처 완료 후 복원
  await sendToTab(tabId, { type: MSG.HIDE_OVERLAYS });

  for (let i = startPage - 1; i < endPage; i++) {
    if (checkStop()) break;

    // content script에 스크롤 요청 → 이미지 로드 대기 후 페이지 좌표 반환
    const scrollResult = await sendToTab(tabId, {
      type: MSG.SCROLL_TO,
      scrollTop: i * pageStep,
    });

    const rect = scrollResult?.rect || null;
    const dataUrl = await captureAndCrop(rect);
    images.push(dataUrl);

    // 0-based 인덱스를 1-based 진행률로 변환
    const current = i - (startPage - 1) + 1;
    updateState(SCAN_STATUS.scanning, {
      step: UI_TEXT.steps.readingPages,
      current,
      total: pageCount,
    });
    safeSendRuntimeMessage({ type: MSG.PROGRESS, step: UI_TEXT.steps.readingPages, current, total: pageCount });
  }

  // 캡처 완료 후 오버레이 복원
  await sendToTab(tabId, { type: MSG.RESTORE_OVERLAYS });

  return images;
}

/** 현재 탭의 보이는 화면을 캡처하고, rect가 있으면 offscreen에서 해당 영역만 크롭한다. */
async function captureAndCrop(rect) {
  const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: "png" });
  if (!rect) return dataUrl;

  await ensureOffscreen();
  const cropResult = await sendToRuntime({
    type: MSG.CROP,
    dataUrl,
    rect,
  });

  return cropResult?.dataUrl || dataUrl;
}

/** 3단계: offscreen document에 이미지 배열을 보내 OCR + PDF 생성을 위임한다. */
async function processWithOffscreen(images, config) {
  await ensureOffscreen();

  const result = await sendToRuntime({
    type: MSG.PROCESS,
    images,
    config: { quality: config.quality, ocr: config.ocr },
  });

  // 사용자 중지로 인한 종료는 null을 반환 — 호출자가 checkStop으로 분기
  if (result?.stopped) return null;

  if (!result?.success) {
    throw new Error(result?.error || "PDF 생성 실패 (응답 없음)");
  }

  return result.blobUrl;
}

/**
 * 4단계: PDF Blob URL을 다운로드하고, 저장 대화상자 완료(또는 취소)를 기다린다.
 * 큰 PDF에서 data URL이 실패하는 문제를 피하기 위해 offscreen에서 Blob URL을 생성해 전달받는다.
 * 다운로드 종료 후 offscreen에 revoke 신호를 보내 메모리를 회수한다.
 */
async function downloadPdf(blobUrl, filename) {
  const today = new Date();
  const dateStr = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0"),
  ].join("");

  updateState(SCAN_STATUS.saving);

  try {
    const downloadId = await chrome.downloads.download({
      url: blobUrl,
      filename: `${filename}_${dateStr}.pdf`,
      saveAs: true,
    });

    // 다운로드 상태 변화를 감지하여 완료/취소를 기다린다. 5분 타임아웃으로 무한 대기를 방지.
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        chrome.downloads.onChanged.removeListener(onChanged);
        resolve();
      }, TIMING.downloadTimeout);

      function onChanged(delta) {
        if (delta.id !== downloadId) return;
        if (delta.state?.current === "complete" || delta.state?.current === "interrupted") {
          clearTimeout(timer);
          chrome.downloads.onChanged.removeListener(onChanged);
          resolve();
        }
      }
      chrome.downloads.onChanged.addListener(onChanged);
    });
  } finally {
    // offscreen 컨텍스트에 생성된 Blob URL이므로 그쪽에서 revoke
    safeSendRuntimeMessage({ type: MSG.REVOKE_URL, url: blobUrl });
  }
}

// ─── 메시지 라우팅 ───

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === MSG.START_SCAN) {
    // 이전 파이프라인이 종료되기 전 새 파이프라인을 시작하면 stopFlag/scanState가 공유되어 경합한다.
    // pipelineRunning이 false가 될 때까지(이전 finally 도달까지) 무시.
    if (!pipelineRunning) {
      stopFlag = false;
      runPipeline(msg.config);
    }
    return false;
  }

  if (msg.type === MSG.STOP_SCAN) {
    stopFlag = true;
    // pipelineRunning은 이전 파이프라인 finally에서 false로 떨어진다 (즉시 리셋하지 않음).
    safeSendRuntimeMessage({ type: MSG.STOP }); // offscreen에도 중지 신호 전달
    updateState(SCAN_STATUS.stopped);
    return false;
  }

  if (msg.type === MSG.GET_STATE) {
    sendResponse(scanState);
    return false;
  }

  // offscreen에서 보낸 진행률을 팝업으로 중계
  if (msg.type === MSG.PROGRESS && sender.url?.includes("offscreen")) {
    updateState(SCAN_STATUS.scanning, { step: msg.step, current: msg.current, total: msg.total });
    safeSendRuntimeMessage(msg);
    return false;
  }
});

// ─── 메인 파이프라인 ───

/** 전체 파이프라인 실행. 각 단계 사이에서 중지 요청을 확인한다. */
async function runPipeline(config) {
  pipelineRunning = true;
  try {
    updateState(SCAN_STATUS.scanning, {
      step: UI_TEXT.steps.readingPages,
      current: 0,
      total: 0,
    });

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const { totalPages, pageStep } = await injectAndMeasure(tab.id);

    // 사용자 지정 범위가 없으면 전체 페이지
    const startPage = config.pageRange ? Math.max(1, config.pageRange.from) : 1;
    const endPage = config.pageRange?.to ? Math.min(config.pageRange.to, totalPages) : totalPages;

    const images = await capturePages(tab.id, pageStep, startPage, endPage);
    if (!images || images.length === 0) return; // 중지됨 또는 빈 결과

    if (checkStop()) return;

    const blobUrl = await processWithOffscreen(images, config);

    if (checkStop()) return;
    if (!blobUrl) return; // offscreen에서 중지됨

    await downloadPdf(blobUrl, config.filename || "Readify");

    updateState(SCAN_STATUS.done);
  } catch (err) {
    // 사용자 중지로 인한 reject는 정상 종료로 분류
    if (stopFlag) {
      updateState(SCAN_STATUS.stopped);
    } else {
      updateState(SCAN_STATUS.error, { message: err.message });
    }
  } finally {
    pipelineRunning = false;
    stopFlag = false; // 다음 START_SCAN을 위해 리셋
  }
}
