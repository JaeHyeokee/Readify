/** Content Script — 문서 뷰어 DOM과 상호작용 (범용)
 *
 * background에서 MEASURE / SCROLL_TO 메시지를 받아
 * 문서 레이아웃 측정, 페이지 스크롤, 이미지 로드 대기를 처리한다.
 * 실제 화면 캡처는 background의 captureVisibleTab이 담당.
 *
 * 여러 문서 뷰어를 자동 감지하며, 알려진 뷰어가 없으면
 * 범용 휴리스틱으로 스크롤 컨테이너와 페이지 요소를 찾는다.
 */

const { MESSAGE_TYPES: MSG } = require("./constants.js");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── 뷰어 프로필 ───

/** 알려진 문서 뷰어별 셀렉터 정의. 순서대로 매칭을 시도한다. */
const VIEWER_PROFILES = [
  {
    name: "streamdocs",
    container: ".pre-scrollable",
    page: "sd-page",
    image: "sd-image img",
  },
  {
    name: "pdfjs",
    container: "#viewerContainer",
    page: ".page",
    image: ".canvasWrapper canvas",
  },
  {
    name: "google-docs-viewer",
    container: ".ndfHFb-c4YZDc-cYSp0e-s2gQvd",
    page: ".ndfHFb-c4YZDc-cYSp0e-DARUcf-PLDbbf",
    image: "img",
  },
  {
    name: "issuu",
    container: "[class*='reader']",
    page: "[class*='page']",
    image: "img, canvas",
  },
  {
    name: "fliphtml5",
    container: ".fliphtml5-container, #flipbook",
    page: ".page",
    image: "canvas, img",
  },
];

/** 캐시된 감지 결과 */
let detectedProfile = null;

/** 현재 페이지에 맞는 뷰어 프로필을 감지한다. 알려진 뷰어가 없으면 범용 감지를 시도. */
function detectViewer() {
  if (detectedProfile) return detectedProfile;

  // 알려진 프로필 매칭
  for (const profile of VIEWER_PROFILES) {
    const container = document.querySelector(profile.container);
    if (container) {
      const pages = container.querySelectorAll(profile.page);
      if (pages.length > 0) {
        detectedProfile = { ...profile, generic: false };
        return detectedProfile;
      }
    }
  }

  // 범용 감지: 스크롤 가능한 컨테이너 + 반복되는 페이지형 자식 요소
  detectedProfile = detectGenericViewer();
  return detectedProfile;
}

/** 범용 뷰어 감지 — 스크롤 컨테이너와 페이지 요소를 휴리스틱으로 찾는다. */
function detectGenericViewer() {
  const container = findScrollableContainer();
  if (!container) return null;

  const pageSelector = findPageSelector(container);
  if (!pageSelector) return null;

  return {
    name: "generic",
    container: null, // DOM 요소를 직접 캐시
    _containerEl: container,
    page: pageSelector,
    image: "img, canvas",
    generic: true,
  };
}

/** 문서 영역에서 가장 유력한 스크롤 컨테이너를 찾는다. */
function findScrollableContainer() {
  const candidates = [];

  for (const el of document.querySelectorAll("*")) {
    const style = getComputedStyle(el);
    const overflowY = style.overflowY;
    if (overflowY !== "auto" && overflowY !== "scroll") continue;
    if (el.scrollHeight <= el.clientHeight + 10) continue;
    // 너무 작은 요소는 제외
    if (el.clientHeight < 200 || el.clientWidth < 200) continue;

    candidates.push({
      el,
      area: el.clientWidth * el.clientHeight,
      scrollRange: el.scrollHeight - el.clientHeight,
    });
  }

  if (candidates.length === 0) {
    // body/documentElement 자체가 스크롤 컨테이너인 경우
    if (document.documentElement.scrollHeight > window.innerHeight + 10) {
      return document.documentElement;
    }
    return null;
  }

  // 스크롤 범위가 크고 화면을 많이 차지하는 컨테이너를 선호
  candidates.sort((a, b) => b.scrollRange * b.area - a.scrollRange * a.area);
  return candidates[0].el;
}

/** 컨테이너 내에서 반복되는 페이지형 자식 요소의 셀렉터를 찾는다. */
function findPageSelector(container) {
  // 태그+클래스 조합별로 자식 요소를 그룹화
  const groups = new Map();

  for (const child of container.children) {
    const rect = child.getBoundingClientRect();
    // 너무 작은 요소는 무시
    if (rect.height < 100 || rect.width < 100) continue;

    const key = buildSelector(child);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(child);
  }

  // 2개 이상 반복되고, 크기가 비슷한 그룹을 찾는다
  let bestSelector = null;
  let bestCount = 0;

  for (const [selector, elements] of groups) {
    if (elements.length < 2) continue;

    // 크기 일관성 확인: 높이 표준편차가 평균의 30% 이내
    const heights = elements.map((el) => el.getBoundingClientRect().height);
    const avgH = heights.reduce((a, b) => a + b, 0) / heights.length;
    const stdH = Math.sqrt(
      heights.reduce((s, h) => s + (h - avgH) ** 2, 0) / heights.length
    );
    if (avgH > 0 && stdH / avgH > 0.3) continue;

    if (elements.length > bestCount) {
      bestCount = elements.length;
      bestSelector = selector;
    }
  }

  // 직접 자식에서 못 찾으면 일반적인 페이지 관련 셀렉터로 시도
  if (!bestSelector) {
    const fallbacks = [
      "[class*='page']", "[class*='slide']", "[class*='sheet']",
      "[data-page]", "[data-page-number]",
      ".page", ".slide",
    ];
    for (const sel of fallbacks) {
      const found = container.querySelectorAll(sel);
      if (found.length >= 2) return sel;
    }
  }

  return bestSelector;
}

/** 요소의 태그와 첫 번째 의미 있는 클래스를 조합해 셀렉터를 만든다. */
function buildSelector(el) {
  const tag = el.tagName.toLowerCase();
  const classes = [...el.classList].filter(
    (c) => !/^(ng-|_|svelte-)/.test(c) && c.length < 40
  );
  if (classes.length > 0) return `${tag}.${classes[0]}`;
  return tag;
}

// ─── 뷰어 조작 함수 ───

/** 마지막으로 숨긴 오버레이 목록 — RESTORE_OVERLAYS 시 복원용 */
let lastHidden = [];

/** 감지된 뷰어의 스크롤 컨테이너 요소를 반환한다. */
function getContainer() {
  const profile = detectViewer();
  if (!profile) return null;

  // 범용 감지에서 직접 캐시한 DOM 요소
  if (profile._containerEl) return profile._containerEl;

  return document.querySelector(profile.container);
}

/** 뷰포트 중앙에 가장 가까운 페이지 요소를 찾아 반환한다. */
function findCenteredPage() {
  const profile = detectViewer();
  if (!profile) return null;

  const container = getContainer();
  if (!container) return null;

  const centerY =
    container.getBoundingClientRect().top +
    container.getBoundingClientRect().height / 2;

  let best = null;
  let bestDist = Infinity;
  for (const p of container.querySelectorAll(profile.page)) {
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
  const profile = detectViewer();
  if (!profile) return { scrollHeight: 0, pageStep: 0 };

  const container = getContainer();
  const pages = container
    ? container.querySelectorAll(profile.page)
    : [];

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

/** 페이지 위에 겹치는 UI 요소(컨트롤바 등)를 숨긴다. 캡처 전에 호출. */
function hideOverlays() {
  const selectors = [
    ".controls-bar", ".sd-controls", ".toolbar",
    "[class*='control']", "[class*='toolbar']", "[class*='footer']",
    "[class*='header']", "[class*='nav']", "[class*='overlay']",
    "[class*='sidebar']", "[class*='menu']",
    "[role='toolbar']", "[role='navigation']",
  ];
  const hidden = [];
  const container = getContainer();

  for (const sel of selectors) {
    for (const el of document.querySelectorAll(sel)) {
      // 스크롤 컨테이너 자체나 그 안의 페이지 요소는 숨기면 안 됨
      if (container && (el === container || container.contains(el))) continue;
      if (el.style.display !== "none" && el.offsetParent !== null) {
        hidden.push({ el, prev: el.style.display });
        el.style.display = "none";
      }
    }
  }
  return hidden;
}

/** hideOverlays로 숨긴 요소들을 복원한다. */
function restoreOverlays(hidden) {
  for (const { el, prev } of hidden) {
    el.style.display = prev;
  }
}

/** 뷰포트 중앙 페이지의 화면 좌표(x, y, width, height)를 반환한다. */
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

/** 중앙 페이지의 이미지/캔버스가 완전히 로드될 때까지 폴링 방식으로 대기한다. */
function waitForImage(timeout = 5000) {
  return new Promise((resolve) => {
    const profile = detectViewer();
    const page = findCenteredPage();
    if (!page || !profile) return resolve(false);

    const imageSelector = profile.image || "img, canvas";
    const media = page.querySelector(imageSelector);
    if (!media) return resolve(false);

    const timer = setTimeout(() => resolve(false), timeout);

    const check = () => {
      const loaded =
        media.tagName === "CANVAS"
          ? media.width > 0 && media.height > 0
          : media.complete && media.naturalWidth > 0;
      if (loaded) {
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
  if (msg.type === MSG.MEASURE) {
    const profile = detectViewer();
    if (!profile) {
      sendResponse({ success: false, error: "문서 뷰어를 찾을 수 없습니다" });
      return false;
    }
    const layout = measureLayout();
    const totalPages =
      layout.pageStep > 0
        ? Math.round(layout.scrollHeight / layout.pageStep)
        : 0;
    sendResponse({
      success: true,
      totalPages,
      pageStep: layout.pageStep,
      viewer: profile.name,
    });
    return false;
  }

  if (msg.type === MSG.HIDE_OVERLAYS) {
    lastHidden = hideOverlays();
    sendResponse({ success: true });
    return false;
  }

  if (msg.type === MSG.RESTORE_OVERLAYS) {
    restoreOverlays(lastHidden);
    lastHidden = [];
    sendResponse({ success: true });
    return false;
  }

  if (msg.type === MSG.SCROLL_TO) {
    const container = getContainer();
    if (container) {
      // documentElement인 경우 window.scrollTo 사용
      if (container === document.documentElement) {
        window.scrollTo(0, msg.scrollTop);
      } else {
        container.scrollTop = msg.scrollTop;
      }
    }
    delay(400)
      .then(() => waitForImage())
      .then(() => {
        const rect = getPageRect();
        sendResponse({ success: true, rect });
      });
    return true;
  }
});
