/** Content Script — streamdocs 뷰어에서 페이지 스크롤 및 레이아웃 측정 */

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** 문서 레이아웃(스크롤 높이, 페이지 간격, 페이지 영역) 측정 */
function measureLayout() {
  const container = document.querySelector(".pre-scrollable");
  const pages = document.querySelectorAll("sd-page");

  let pageStep = 0;
  if (pages.length >= 2) {
    const r0 = pages[0].getBoundingClientRect();
    const r1 = pages[1].getBoundingClientRect();
    pageStep = r1.top - r0.top;
  } else if (pages.length === 1) {
    pageStep = pages[0].offsetHeight + 10;
  }

  return {
    scrollHeight: container ? container.scrollHeight : 0,
    pageStep,
  };
}

/** 뷰포트 중앙에 가장 가까운 sd-page의 화면 내 좌표 반환 */
function getPageRect() {
  const container = document.querySelector(".pre-scrollable");
  if (!container) return null;

  const centerY =
    container.getBoundingClientRect().top +
    container.getBoundingClientRect().height / 2;

  let best = null;
  let bestDist = Infinity;
  for (const p of document.querySelectorAll("sd-page")) {
    const r = p.getBoundingClientRect();
    const dist = Math.abs(r.top + r.height / 2 - centerY);
    if (dist < bestDist) {
      bestDist = dist;
      best = p;
    }
  }

  if (!best) return null;
  const r = best.getBoundingClientRect();
  return {
    x: Math.round(r.left),
    y: Math.round(r.top),
    width: Math.round(r.width),
    height: Math.round(r.height),
  };
}

/** 이미지 로드 완료 대기 */
function waitForImage(timeout = 5000) {
  return new Promise((resolve) => {
    const container = document.querySelector(".pre-scrollable");
    if (!container) return resolve(false);

    const centerY =
      container.getBoundingClientRect().top +
      container.getBoundingClientRect().height / 2;

    let best = null;
    let bestDist = Infinity;
    for (const p of document.querySelectorAll("sd-page")) {
      const r = p.getBoundingClientRect();
      const dist = Math.abs(r.top + r.height / 2 - centerY);
      if (dist < bestDist) {
        bestDist = dist;
        best = p;
      }
    }

    if (!best) return resolve(false);
    const img = best.querySelector("sd-image img");
    if (!img) return resolve(false);

    const timer = setTimeout(() => resolve(false), timeout);
    const check = () => {
      if (img.complete && img.naturalWidth > 0) {
        clearTimeout(timer);
        resolve(true);
      } else {
        setTimeout(check, 200);
      }
    };
    check();
  });
}

// background로부터 메시지 수신
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "MEASURE") {
    const container = document.querySelector(".pre-scrollable");
    if (!container) {
      sendResponse({ success: false, error: "streamdocs 뷰어를 찾을 수 없습니다" });
      return false;
    }
    const layout = measureLayout();
    const totalPages =
      layout.pageStep > 0
        ? Math.round(layout.scrollHeight / layout.pageStep)
        : 0;
    sendResponse({ success: true, totalPages, pageStep: layout.pageStep });
    return false;
  }

  if (msg.type === "SCROLL_TO") {
    const container = document.querySelector(".pre-scrollable");
    if (container) {
      container.scrollTop = msg.scrollTop;
    }
    // 스크롤 후 이미지 로드 대기 → 페이지 좌표 반환
    delay(400)
      .then(() => waitForImage())
      .then(() => {
        const rect = getPageRect();
        sendResponse({ success: true, rect });
      });
    return true;
  }
});
