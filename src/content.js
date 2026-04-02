/** Content Script — streamdocs 뷰어 DOM과 상호작용
 *
 * background에서 MEASURE / SCROLL_TO 메시지를 받아
 * 문서 레이아웃 측정, 페이지 스크롤, 이미지 로드 대기를 처리한다.
 * 실제 화면 캡처는 background의 captureVisibleTab이 담당.
 */

const { MESSAGE_TYPES: MSG } = require("./constants.js");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** streamdocs 뷰어의 스크롤 컨테이너 요소를 반환한다. */
function getContainer() {
  return document.querySelector(".pre-scrollable");
}

/** 뷰포트 중앙에 가장 가까운 sd-page 요소를 찾아 반환한다. */
function findCenteredPage() {
  const container = getContainer();
  if (!container) return null;

  // 컨테이너의 수직 중앙 좌표
  const centerY =
    container.getBoundingClientRect().top +
    container.getBoundingClientRect().height / 2;

  // 모든 페이지 중 중앙에 가장 가까운 것 선택
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
  return best;
}

/** 문서의 총 스크롤 높이와 페이지 간 간격(pageStep)을 측정한다. */
function measureLayout() {
  const container = getContainer();
  const pages = document.querySelectorAll("sd-page");

  let pageStep = 0;
  if (pages.length >= 2) {
    // 첫 두 페이지의 top 차이로 간격 계산
    const r0 = pages[0].getBoundingClientRect();
    const r1 = pages[1].getBoundingClientRect();
    pageStep = r1.top - r0.top;
  } else if (pages.length === 1) {
    // 페이지가 1개일 때는 높이 + 여백으로 추정
    pageStep = pages[0].offsetHeight + 10;
  }

  return {
    scrollHeight: container ? container.scrollHeight : 0,
    pageStep,
  };
}

/** 뷰포트 중앙 sd-page의 화면 좌표(x, y, width, height)를 반환한다. */
function getPageRect() {
  const page = findCenteredPage();
  if (!page) return null;
  const r = page.getBoundingClientRect();
  return {
    x: Math.round(r.left),
    y: Math.round(r.top),
    width: Math.round(r.width),
    height: Math.round(r.height),
  };
}

/** 중앙 페이지의 이미지가 완전히 로드될 때까지 폴링 방식으로 대기한다. */
function waitForImage(timeout = 5000) {
  return new Promise((resolve) => {
    const page = findCenteredPage();
    if (!page) return resolve(false);

    const img = page.querySelector("sd-image img");
    if (!img) return resolve(false);

    const timer = setTimeout(() => resolve(false), timeout);
    // 200ms 간격으로 이미지 로드 완료 여부 확인
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

// ─── 메시지 핸들러 ───

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 레이아웃 측정 요청
  if (msg.type === MSG.MEASURE) {
    const container = getContainer();
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

  // 특정 위치로 스크롤 후 이미지 로드 대기 → 페이지 좌표 반환
  if (msg.type === MSG.SCROLL_TO) {
    const container = getContainer();
    if (container) {
      container.scrollTop = msg.scrollTop;
    }
    delay(400)
      .then(() => waitForImage())
      .then(() => {
        const rect = getPageRect();
        sendResponse({ success: true, rect });
      });
    return true; // 비동기 응답을 위해 true 반환
  }
});
