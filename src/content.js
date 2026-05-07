/** Content Script — 문서 뷰어 DOM과 상호작용 (범용)
 *
 * background에서 MEASURE / SCROLL_TO 메시지를 받아
 * 문서 레이아웃 측정, 페이지 스크롤, 이미지 로드 대기를 처리한다.
 * 실제 화면 캡처는 background의 captureVisibleTab이 담당.
 *
 * 여러 문서 뷰어를 자동 감지하며, 알려진 뷰어가 없으면
 * 범용 휴리스틱으로 스크롤 컨테이너와 페이지 요소를 찾는다.
 */

const { MESSAGE_TYPES: MSG, TIMING } = require("./constants.js");

/** 두 번의 requestAnimationFrame을 기다려 layout/paint가 적용되도록 한다. */
function nextFrames(count = 2) {
  return new Promise((resolve) => {
    let n = count;
    const tick = () => {
      if (--n <= 0) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

// ─── 뷰어 프로필 ───

/**
 * 알려진 문서 뷰어별 셀렉터 정의. 순서대로 매칭을 시도한다.
 * 각 프로필은 단일 형태: { name, getContainer, pageSelector, imageSelector }
 */
const VIEWER_PROFILES = [
  {
    name: "streamdocs",
    getContainer: () => document.querySelector(".pre-scrollable"),
    pageSelector: "sd-page",
    imageSelector: "sd-image img",
  },
  {
    name: "pdfjs",
    getContainer: () => document.querySelector("#viewerContainer"),
    pageSelector: ".page",
    imageSelector: ".canvasWrapper canvas",
  },
  {
    name: "google-docs-viewer",
    getContainer: () => document.querySelector(".ndfHFb-c4YZDc-cYSp0e-s2gQvd"),
    pageSelector: ".ndfHFb-c4YZDc-cYSp0e-DARUcf-PLDbbf",
    imageSelector: "img",
  },
  {
    name: "issuu",
    getContainer: () => document.querySelector("[class*='reader']"),
    pageSelector: "[class*='page']",
    imageSelector: "img, canvas",
  },
  {
    name: "fliphtml5",
    getContainer: () => document.querySelector(".fliphtml5-container, #flipbook"),
    pageSelector: ".page",
    imageSelector: "canvas, img",
  },
];

/** 캐시된 감지 결과 */
let detectedProfile = null;

/** 현재 페이지에 맞는 뷰어 프로필을 감지한다. 알려진 뷰어가 없으면 범용 감지를 시도. */
function detectViewer() {
  if (detectedProfile) return detectedProfile;

  // 알려진 프로필 매칭
  for (const profile of VIEWER_PROFILES) {
    const container = profile.getContainer();
    if (container) {
      const pages = container.querySelectorAll(profile.pageSelector);
      if (pages.length > 0) {
        detectedProfile = profile;
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
    getContainer: () => container,
    pageSelector,
    imageSelector: "img, canvas",
  };
}

/**
 * 문서 영역에서 가장 유력한 스크롤 컨테이너를 찾는다.
 * BFS로 body부터 탐색하며 크기/오버플로우 기반으로 빠르게 가지치기.
 */
function findScrollableContainer() {
  const candidates = [];
  const queue = [document.body];
  const MAX_NODES = 5000; // 매우 큰 페이지에서도 안정적인 상한
  let visited = 0;

  while (queue.length && visited < MAX_NODES) {
    const el = queue.shift();
    visited++;

    // 작은 요소는 자식까지 통째로 가지치기 (스크롤 컨테이너가 그 안에 있을 가능성 매우 낮음)
    if (el.clientHeight < 200 || el.clientWidth < 200) continue;

    const style = getComputedStyle(el);
    const overflowY = style.overflowY;

    if ((overflowY === "auto" || overflowY === "scroll") &&
        el.scrollHeight > el.clientHeight + 10) {
      candidates.push({
        el,
        area: el.clientWidth * el.clientHeight,
        scrollRange: el.scrollHeight - el.clientHeight,
      });
    }

    if (overflowY === "hidden") continue; // 더 들어가도 외부에 스크롤 노출 안 됨
    for (const child of el.children) queue.push(child);
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

/** 뷰포트 중앙에 가장 가까운 페이지 요소를 찾아 반환한다. */
function findCenteredPage() {
  const profile = detectViewer();
  if (!profile) return null;

  const container = profile.getContainer();
  if (!container) return null;

  const containerRect = container.getBoundingClientRect();
  const centerY = containerRect.top + containerRect.height / 2;

  let best = null;
  let bestDist = Infinity;
  // querySelectorAll 결과 캐시는 매 호출마다 새로 — DOM이 동적으로 변할 수 있어 안전성 우선
  const pages = container.querySelectorAll(profile.pageSelector);
  for (const p of pages) {
    const r = p.getBoundingClientRect();
    const center = r.top + r.height / 2;
    const dist = center > centerY ? center - centerY : centerY - center;
    if (dist < bestDist) {
      bestDist = dist;
      best = p;
    }
  }
  return best;
}

/** 문서의 총 페이지 수와 페이지 간 간격(pageStep)을 측정한다. */
function measureLayout() {
  const profile = detectViewer();
  if (!profile) return { totalPages: 0, pageStep: 0 };

  const container = profile.getContainer();
  const pages = container ? container.querySelectorAll(profile.pageSelector) : [];

  let pageStep = 0;
  if (pages.length >= 2) {
    const r0 = pages[0].getBoundingClientRect();
    const r1 = pages[1].getBoundingClientRect();
    pageStep = r1.top - r0.top;
  } else if (pages.length === 1) {
    pageStep = pages[0].offsetHeight + TIMING.pageStepMargin;
  }

  return {
    totalPages: pages.length,
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
  const profile = detectViewer();
  const container = profile ? profile.getContainer() : null;

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
function waitForImage(timeout = TIMING.imageWaitTimeout) {
  return new Promise((resolve) => {
    const profile = detectViewer();
    const page = findCenteredPage();
    if (!page || !profile) return resolve(false);

    const media = page.querySelector(profile.imageSelector || "img, canvas");
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
        setTimeout(check, TIMING.imagePollInterval);
      }
    };
    check();
  });
}

// ─── 메시지 핸들러 ───

// 같은 탭에 content script가 여러 번 주입될 때 listener 중복 등록 방지
if (!window.__readifyInjected) {
  window.__readifyInjected = true;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === MSG.MEASURE) {
      // SPA 라우팅 등으로 DOM이 바뀐 경우를 대비해 매 측정 시 캐시를 초기화한다.
      detectedProfile = null;
      const profile = detectViewer();
      if (!profile) {
        sendResponse({ success: false, error: "문서 뷰어를 찾을 수 없습니다" });
        return false;
      }
      const layout = measureLayout();
      sendResponse({
        success: true,
        totalPages: layout.totalPages,
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
      const profile = detectViewer();
      const container = profile ? profile.getContainer() : null;
      if (container) {
        // documentElement인 경우 window.scrollTo 사용
        if (container === document.documentElement) {
          window.scrollTo(0, msg.scrollTop);
        } else {
          container.scrollTop = msg.scrollTop;
        }
      }
      // 두 프레임 동안 layout/paint를 기다린 뒤 이미지 로드 완료를 폴링
      nextFrames(2)
        .then(() => waitForImage())
        .then(() => {
          const rect = getPageRect();
          sendResponse({ success: true, rect });
        });
      return true;
    }
  });
}
