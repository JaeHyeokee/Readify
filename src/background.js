/** Service Worker — 파이프라인 오케스트레이션 및 메시지 라우팅 */

let offscreenReady = false;
let stopRequested = false;

// 현재 작업 상태 (팝업이 다시 열릴 때 조회용)
let scanState = { status: "idle" }; // idle | scanning | done | stopped | error

/** 팝업 등에 메시지 전송 (수신자 없어도 무시) */
function safeSend(msg) {
  try {
    chrome.runtime.sendMessage(msg, () => {
      if (chrome.runtime.lastError) { /* 팝업 닫힘 — 무시 */ }
    });
  } catch (e) { /* 무시 */ }
}

/** offscreen document 생성 (이미 있으면 스킵) */
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

/** offscreen에 메시지를 보내고 응답을 기다림 */
function sendToOffscreen(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response);
      }
    });
  });
}

/** content script에 메시지를 보내고 응답을 기다림 */
function sendToTab(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response);
      }
    });
  });
}

/** 현재 탭 화면을 캡처하고 offscreen에서 크롭 */
async function captureAndCrop(rect) {
  const dataUrl = await chrome.tabs.captureVisibleTab(null, {
    format: "png",
  });

  if (!rect) return dataUrl;

  // offscreen에서 크롭 처리
  await ensureOffscreen();
  const cropResult = await sendToOffscreen({
    type: "CROP",
    dataUrl,
    rect,
    devicePixelRatio: 1, // captureVisibleTab은 실제 픽셀로 캡처
  });

  return cropResult?.dataUrl || dataUrl;
}

// 메시지 수신
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "START_SCAN") {
    stopRequested = false;
    runPipeline(msg.config);
    return false;
  }

  if (msg.type === "STOP_SCAN") {
    stopRequested = true;
    safeSend({ type: "STOP" });
    scanState = { status: "stopped" };
    safeSend({ type: "STOPPED" });
    return false;
  }

  if (msg.type === "GET_STATE") {
    sendResponse(scanState);
    return false;
  }

  // offscreen → background → popup 진행률 중계
  if (msg.type === "PROGRESS" && sender.url?.includes("offscreen")) {
    scanState = { status: "scanning", step: msg.step, current: msg.current, total: msg.total };
    safeSend(msg);
    return false;
  }
});

/** 전체 파이프라인 실행 */
async function runPipeline(config) {
  try {
    scanState = { status: "scanning", step: "페이지 읽는 중", current: 0, total: 0 };

    // 1. 현재 탭에 content script 주입
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });

    // 2. 레이아웃 측정
    const measureResult = await sendToTab(tab.id, { type: "MEASURE" });
    if (!measureResult?.success) {
      throw new Error(measureResult?.error || "레이아웃 측정 실패");
    }

    const { totalPages, pageStep } = measureResult;
    if (totalPages === 0) throw new Error("페이지를 찾을 수 없습니다");

    const startPage = config.pageRange ? Math.max(1, config.pageRange.from) : 1;
    const endPage = config.pageRange?.to ? Math.min(config.pageRange.to, totalPages) : totalPages;
    const pageCount = endPage - startPage + 1;

    // 3. 페이지별 스크롤 → 스크린샷 → 크롭
    const images = [];

    for (let i = startPage - 1; i < endPage; i++) {
      if (stopRequested) {
        scanState = { status: "stopped" };
        safeSend({ type: "STOPPED" });
        return;
      }

      const scrollResult = await sendToTab(tab.id, {
        type: "SCROLL_TO",
        scrollTop: i * pageStep,
      });

      const rect = scrollResult?.rect || null;
      const dataUrl = await captureAndCrop(rect);
      images.push(dataUrl);

      const current = i - (startPage - 1) + 1;
      scanState = { status: "scanning", step: "페이지 읽는 중", current, total: pageCount };
      safeSend({ type: "PROGRESS", step: "페이지 읽는 중", current, total: pageCount });
    }

    if (images.length === 0) throw new Error("캡처된 페이지가 없습니다");

    if (stopRequested) {
      scanState = { status: "stopped" };
      safeSend({ type: "STOPPED" });
      return;
    }

    // 4. offscreen document에서 OCR + PDF 처리
    await ensureOffscreen();

    const pdfResult = await sendToOffscreen({
      type: "PROCESS",
      images,
      config: { quality: config.quality, ocr: config.ocr },
    });

    if (stopRequested) {
      scanState = { status: "stopped" };
      safeSend({ type: "STOPPED" });
      return;
    }

    if (!pdfResult?.success) {
      throw new Error(pdfResult?.error || "PDF 생성 실패 (응답 없음)");
    }

    // 5. PDF 다운로드
    const url = `data:application/pdf;base64,${pdfResult.pdfBase64}`;

    const today = new Date();
    const dateStr = [
      today.getFullYear(),
      String(today.getMonth() + 1).padStart(2, "0"),
      String(today.getDate()).padStart(2, "0"),
    ].join("");

    const filename = config.filename || "Readify";

    // PDF 준비 완료 → 팝업에 알림
    scanState = { status: "saving" };
    safeSend({ type: "SAVE_READY" });

    const downloadId = await chrome.downloads.download({
      url,
      filename: `${filename}_${dateStr}.pdf`,
      saveAs: true,
    });

    // 다운로드 완료/취소 감지
    await new Promise((resolve) => {
      function onChanged(delta) {
        if (delta.id !== downloadId) return;
        if (delta.state?.current === "complete" || delta.state?.current === "interrupted") {
          chrome.downloads.onChanged.removeListener(onChanged);
          resolve();
        }
      }
      chrome.downloads.onChanged.addListener(onChanged);
    });

    scanState = { status: "done" };
    safeSend({ type: "SAVE_DONE" });
  } catch (err) {
    scanState = { status: "error", message: err.message };
    safeSend({ type: "ERROR", message: err.message });
  }
}
