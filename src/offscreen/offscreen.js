/** Offscreen Document — 메시지 핸들러 + OCR/PDF 파이프라인 조합
 *
 * background로부터 3종류의 메시지를 처리한다:
 *   PROCESS — 이미지 배열을 받아 OCR + PDF 생성 후 base64 반환
 *   STOP    — 진행 중인 OCR 작업을 중단
 *   CROP    — 전체 화면 스크린샷에서 특정 영역만 크롭
 */

const Tesseract = require("tesseract.js");
const { MESSAGE_TYPES: MSG, OCR_CONFIG, IMAGE_CONFIG, UI_TEXT } = require("../constants.js");
const { loadImage, preprocess, imageDataToBlob, getCanvas, getCtx } = require("./preprocess.js");
const { detectTableCells, mapWordsToCells, buildTableStructure } = require("./tableDetect.js");
const { PDFDocument, loadKoreanFont, drawTable, drawWords, embedImage, encodePdf } = require("./pdfBuilder.js");

/** 사용자 중지 요청 플래그 — STOP 메시지 수신 시 true */
let stopped = false;
/** 현재 활성화된 Tesseract 스케줄러 — 중지 시 terminate 호출용 */
let activeScheduler = null;

/** stopped가 true이면 에러를 던져 파이프라인을 중단한다. */
function throwIfStopped() {
  if (stopped) throw new Error("사용자가 중지했습니다");
}

/** 팝업에 진행률을 전송한다. 팝업이 닫혀 있으면 무시. */
function sendProgress(step, current, total) {
  try { chrome.runtime.sendMessage({ type: MSG.PROGRESS, step, current, total }); } catch (e) {}
}

/** activeScheduler를 안전하게 종료하고 null로 초기화한다. */
function cleanupScheduler() {
  if (activeScheduler) {
    try { activeScheduler.terminate(); } catch (e) {}
    activeScheduler = null;
  }
}

// ─── OCR 파이프라인 ───

/** 이미지를 OCR 입력용 Blob 배열로 변환한다. (스크린샷은 전처리 없이 원본 사용) */
async function preprocessAll(images) {
  const blobs = [];
  for (let i = 0; i < images.length; i++) {
    const rawImageData = await loadImage(images[i]);
    const blob = await imageDataToBlob(rawImageData);
    blobs.push(blob);
  }
  return blobs;
}

/**
 * Tesseract 스케줄러로 병렬 OCR을 실행한다.
 * 워커 수: (CPU 코어 수 - 1), 최소 1개, 최대 8개.
 * 워커 수만큼 배치 처리하여 중지 요청 시 다음 배치부터 즉시 중단 가능.
 */
async function runOcr(preprocessed, total) {
  const numWorkers = Math.min(
    Math.max(1, (navigator.hardwareConcurrency || 4) - 1),
    8
  );
  const scheduler = Tesseract.createScheduler();
  activeScheduler = scheduler;

  // 로컬 번들된 Tesseract 파일 사용 (CSP 제약 우회)
  const workerOpts = {
    langPath: "https://tessdata.projectnaptha.com/4.0.0",
    workerPath: chrome.runtime.getURL("tesseract-worker.min.js"),
    corePath: chrome.runtime.getURL("tesseract-core-lstm.wasm.js"),
    workerBlobURL: false, // MV3 확장에서 blob URL 사용 불가
  };

  for (let w = 0; w < numWorkers; w++) {
    const worker = await Tesseract.createWorker(OCR_CONFIG.lang, 1, workerOpts);
    await worker.setParameters({ tessedit_pageseg_mode: OCR_CONFIG.pageSegMode });
    scheduler.addWorker(worker);
  }

  let ocrDone = 0;
  const allWords = [];

  // 워커 수 단위로 배치 처리 — 각 배치 사이에서 중지 확인
  const batchSize = numWorkers;
  for (let start = 0; start < preprocessed.length; start += batchSize) {
    if (stopped) break;

    const batch = preprocessed.slice(start, start + batchSize);
    const batchPromises = batch.map((blob) =>
      scheduler.addJob("recognize", blob).then((ocrResult) => {
        ocrDone++;
        sendProgress(UI_TEXT.steps.recognizingText, ocrDone, total);
        // 신뢰도가 낮은 단어는 제외
        return ocrResult.data.words.filter((w) => w.confidence > OCR_CONFIG.confidence);
      })
    );
    const batchResults = await Promise.all(batchPromises);
    allWords.push(...batchResults);
  }

  cleanupScheduler();
  return allWords;
}

// ─── PDF 조립 ───

/** OCR 결과와 원본 이미지를 합쳐 검색 가능한 PDF를 생성한다. */
async function buildPdf(images, allWords, ocrEnabled, jpegQuality) {
  const pdfDoc = await PDFDocument.create();
  const font = ocrEnabled ? await loadKoreanFont(pdfDoc) : null;
  const total = images.length;
  const canvas = getCanvas();

  for (let i = 0; i < images.length; i++) {
    throwIfStopped();

    // 이미지를 1회만 로드하고 표 감지와 PDF 임베드에 재사용
    const origImageData = await loadImage(images[i]);

    // 표 감지: 원본을 복사하여 이진화 (원본 데이터 보존을 위해 deep copy)
    let table = null;
    if (ocrEnabled) {
      const binaryData = new ImageData(
        new Uint8ClampedArray(origImageData.data),
        origImageData.width,
        origImageData.height
      );
      const binary = preprocess(binaryData);
      const cells = detectTableCells(binary);

      if (cells.length > 0) {
        const words = allWords[i];
        const mapped = mapWordsToCells(words, cells);
        table = buildTableStructure(mapped);
      }
    }

    // 원본 이미지를 캔버스에 복원하여 PDF용 인코딩
    canvas.width = origImageData.width;
    canvas.height = origImageData.height;
    getCtx().putImageData(origImageData, 0, 0);

    const img = await embedImage(pdfDoc, images[i], canvas, jpegQuality);
    const page = pdfDoc.addPage([img.width, img.height]);

    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });

    // OCR 활성 시 투명 텍스트 오버레이 (검색/복사용)
    if (ocrEnabled) {
      const words = allWords[i];
      if (table) {
        drawTable(page, table, img.height, font);
      } else {
        drawWords(page, words, img.height, font);
      }
    }

    sendProgress(UI_TEXT.steps.creatingFile, i + 1, total);
  }

  return encodePdf(pdfDoc);
}

// ─── 메인 파이프라인 ───

/** PROCESS 메시지의 진입점. OCR 여부에 따라 전처리 → OCR → PDF 생성을 수행한다. */
async function processImages(images, config) {
  const jpegQuality = IMAGE_CONFIG.qualityMap[config.quality] || IMAGE_CONFIG.qualityMap.medium;
  const ocrEnabled = config.ocr !== false;

  let allWords = null;

  try {
    if (ocrEnabled) {
      const preprocessed = await preprocessAll(images);
      allWords = await runOcr(preprocessed, images.length);
      throwIfStopped();
    }

    return await buildPdf(images, allWords, ocrEnabled, jpegQuality);
  } finally {
    // 에러/중지 시에도 워커가 남아있지 않도록 정리
    cleanupScheduler();
  }
}

// ─── 메시지 핸들러 ───

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === MSG.PROCESS) {
    stopped = false;
    processImages(msg.images, msg.config)
      .then((pdfBase64) => sendResponse({ success: true, pdfBase64 }))
      .catch((err) => sendResponse({
        success: false,
        // [offscreen] 접두사로 에러 출처 식별
        error: `[offscreen] ${err?.message || err?.toString() || JSON.stringify(err)}`
      }));
    return true; // 비동기 응답
  }

  if (msg.type === MSG.STOP) {
    stopped = true;
    cleanupScheduler();
    return false;
  }

  // 전체 화면 스크린샷에서 특정 영역만 크롭
  if (msg.type === MSG.CROP) {
    const { dataUrl, rect } = msg;
    if (!dataUrl || !rect) {
      sendResponse({ dataUrl: dataUrl || "" });
      return false;
    }

    const img = new Image();
    img.onload = () => {
      // devicePixelRatio로 CSS 좌표를 실제 픽셀 좌표로 변환
      const dpr = window.devicePixelRatio || 1;
      const sx = rect.x * dpr;
      const sy = rect.y * dpr;
      const sw = rect.width * dpr;
      const sh = rect.height * dpr;
      const canvas = getCanvas();
      canvas.width = sw;
      canvas.height = sh;
      getCtx().drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
      sendResponse({ dataUrl: canvas.toDataURL("image/png") });
    };
    img.onerror = () => sendResponse({ dataUrl });
    img.src = dataUrl;
    return true; // 비동기 응답
  }
});
