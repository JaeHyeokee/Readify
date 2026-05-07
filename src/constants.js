/** 공통 상수 — 메시지 타입, 상태, 도메인 설정, 타이밍 */

/**
 * 컨텍스트 간 메시지 타입.
 * 메시지 type으로만 사용한다. (상태 표현용 SCAN_STATUS와 분리)
 */
const MESSAGE_TYPES = {
  // 명령 (popup → background → offscreen/content)
  START_SCAN: "START_SCAN",
  STOP_SCAN: "STOP_SCAN",
  GET_STATE: "GET_STATE",
  CROP: "CROP",
  PROCESS: "PROCESS",
  MEASURE: "MEASURE",
  SCROLL_TO: "SCROLL_TO",
  HIDE_OVERLAYS: "HIDE_OVERLAYS",
  RESTORE_OVERLAYS: "RESTORE_OVERLAYS",
  STOP: "STOP",
  REVOKE_URL: "REVOKE_URL",
  // 이벤트 (background → popup)
  PROGRESS: "PROGRESS",
  STATE: "STATE",
};

/**
 * 파이프라인 상태값.
 * scanState.status에만 사용한다. (메시지 type으로 사용 금지)
 */
const SCAN_STATUS = {
  idle: "idle",
  scanning: "scanning",
  saving: "saving",
  done: "done",
  stopped: "stopped",
  error: "error",
};

const OCR_CONFIG = {
  lang: "kor+eng",
  confidence: 60,
  pageSegMode: "6",
};

const IMAGE_CONFIG = {
  binarizationThreshold: 130,
  qualityMap: { high: 1.0, medium: 0.7, low: 0.4 },
};

const TABLE_CONFIG = {
  minLineLen: 40,
  minCellSize: 20,
  lineScanStep: 2,
  clusterTolerance: 10,
  rowMatchTolerance: 20,
};

/** 타이밍 관련 상수 (ms) */
const TIMING = {
  downloadTimeout: 300000,
  imageWaitTimeout: 5000,
  imagePollInterval: 200,
  pageStepMargin: 10,
};

const UI_TEXT = {
  steps: {
    readingPages: "페이지 읽는 중",
    recognizingText: "텍스트 인식 중",
    creatingFile: "파일 만드는 중",
  },
  buttons: {
    startScan: "PDF 생성 시작",
    stopScan: "생성 중지",
  },
  status: {
    preparing: "준비 중...",
  },
};

module.exports = {
  MESSAGE_TYPES,
  SCAN_STATUS,
  OCR_CONFIG,
  IMAGE_CONFIG,
  TABLE_CONFIG,
  TIMING,
  UI_TEXT,
};
