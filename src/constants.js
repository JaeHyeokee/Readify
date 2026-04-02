/** 공통 상수 — 매직 넘버, 문자열, 메시지 타입 모음 */

const MESSAGE_TYPES = {
  START_SCAN: "START_SCAN",
  STOP_SCAN: "STOP_SCAN",
  GET_STATE: "GET_STATE",
  PROGRESS: "PROGRESS",
  STOP: "STOP",
  CROP: "CROP",
  PROCESS: "PROCESS",
  MEASURE: "MEASURE",
  SCROLL_TO: "SCROLL_TO",
  SAVE_READY: "SAVE_READY",
  SAVE_DONE: "SAVE_DONE",
  STOPPED: "STOPPED",
  ERROR: "ERROR",
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

const SCAN_STATUS = {
  idle: "idle",
  scanning: "scanning",
  saving: "saving",
  done: "done",
  stopped: "stopped",
  error: "error",
};

module.exports = {
  MESSAGE_TYPES,
  OCR_CONFIG,
  IMAGE_CONFIG,
  TABLE_CONFIG,
  UI_TEXT,
  SCAN_STATUS,
};
