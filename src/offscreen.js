/** Offscreen Document — 이미지 전처리, OCR, 표 감지, PDF 생성 */

const Tesseract = require("tesseract.js");
const { PDFDocument } = require("pdf-lib");
const fontkit = require("@pdf-lib/fontkit");

// ─── 이미지 전처리 (Sharp 대체 → Canvas) ───

/** data URL을 ImageData로 변환 */
function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.getElementById("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      resolve(ctx.getImageData(0, 0, canvas.width, canvas.height));
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

/** 그레이스케일 → 이진화 전처리 */
function preprocess(imageData) {
  const data = imageData.data;
  const threshold = 130;

  for (let i = 0; i < data.length; i += 4) {
    // 그레이스케일 변환
    const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    // 이진화
    const val = gray > threshold ? 255 : 0;
    data[i] = data[i + 1] = data[i + 2] = val;
  }

  return imageData;
}

/** ImageData를 PNG Blob으로 변환 */
function imageDataToBlob(imageData) {
  const canvas = document.getElementById("canvas");
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  canvas.getContext("2d", { willReadFrequently: true }).putImageData(imageData, 0, 0);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

// ─── 표 감지 (OpenCV 대체 → Canvas 기반) ───

/** 이진 이미지에서 수평/수직 선을 검출하여 표 셀 영역 반환 */
function detectTableCells(imageData) {
  const { width, height, data } = imageData;
  const minLineLen = 40;
  const minCellSize = 20;

  // 픽셀이 어두운지 확인 (이진화된 이미지 기준)
  const isDark = (x, y) => data[(y * width + x) * 4] < 128;

  // 수평선 검출: 각 행에서 연속된 어두운 픽셀 구간
  const hLines = [];
  for (let y = 0; y < height; y += 2) {
    let run = 0;
    for (let x = 0; x < width; x++) {
      if (isDark(x, y)) {
        run++;
      } else {
        if (run >= minLineLen) hLines.push({ y, x0: x - run, x1: x });
        run = 0;
      }
    }
    if (run >= minLineLen) hLines.push({ y, x0: width - run, x1: width });
  }

  // 수직선 검출: 각 열에서 연속된 어두운 픽셀 구간
  const vLines = [];
  for (let x = 0; x < width; x += 2) {
    let run = 0;
    for (let y = 0; y < height; y++) {
      if (isDark(x, y)) {
        run++;
      } else {
        if (run >= minLineLen) vLines.push({ x, y0: y - run, y1: y });
        run = 0;
      }
    }
    if (run >= minLineLen) vLines.push({ x, y0: height - run, y1: height });
  }

  // Y좌표 클러스터링 (수평선)
  const hYs = clusterValues(hLines.map((l) => l.y), 10);
  // X좌표 클러스터링 (수직선)
  const vXs = clusterValues(vLines.map((l) => l.x), 10);

  if (hYs.length < 2 || vXs.length < 2) return [];

  hYs.sort((a, b) => a - b);
  vXs.sort((a, b) => a - b);

  // 그리드 교차점에서 셀 생성
  const cells = [];
  for (let r = 0; r < hYs.length - 1; r++) {
    for (let c = 0; c < vXs.length - 1; c++) {
      const x = vXs[c];
      const y = hYs[r];
      const w = vXs[c + 1] - x;
      const h = hYs[r + 1] - y;
      if (w > minCellSize && h > minCellSize) {
        cells.push({ x, y, w, h });
      }
    }
  }

  return cells;
}

/** 값 배열을 tolerance 내 클러스터로 묶어 평균값 반환 */
function clusterValues(values, tolerance) {
  if (values.length === 0) return [];
  values.sort((a, b) => a - b);

  const clusters = [[values[0]]];
  for (let i = 1; i < values.length; i++) {
    const last = clusters[clusters.length - 1];
    if (values[i] - last[last.length - 1] <= tolerance) {
      last.push(values[i]);
    } else {
      clusters.push([values[i]]);
    }
  }

  return clusters.map(
    (c) => Math.round(c.reduce((a, b) => a + b, 0) / c.length)
  );
}

// ─── 표 구조 처리 (tableProcessor 포팅) ───

/** OCR 단어를 해당 셀에 매핑 */
function mapWordsToCells(words, cells) {
  for (const cell of cells) cell.words = [];

  for (const word of words) {
    for (const cell of cells) {
      if (
        word.bbox.x0 >= cell.x &&
        word.bbox.x1 <= cell.x + cell.w &&
        word.bbox.y0 >= cell.y &&
        word.bbox.y1 <= cell.y + cell.h
      ) {
        cell.words.push(word);
      }
    }
  }
  return cells;
}

/** 셀을 행 단위로 구조화 */
function buildTableStructure(cells) {
  cells.sort((a, b) => a.y - b.y);
  const rows = [];

  for (const cell of cells) {
    const row = rows.find((r) => Math.abs(r.y - cell.y) < 20);
    if (row) {
      row.cells.push(cell);
    } else {
      rows.push({ y: cell.y, cells: [cell] });
    }
  }

  for (const row of rows) row.cells.sort((a, b) => a.x - b.x);
  return rows;
}

// ─── PDF 생성 (pdfBuilder 포팅) ───

/** Google Fonts에서 한글 폰트를 가져와 임베드 */
async function loadKoreanFont(pdfDoc) {
  pdfDoc.registerFontkit(fontkit);

  // Noto Sans KR Regular (Google Fonts CDN)
  const fontUrl =
    "https://cdn.jsdelivr.net/gh/notofonts/noto-cjk/Sans/OTF/Korean/NotoSansCJKkr-Regular.otf";

  const response = await fetch(fontUrl);
  if (!response.ok) throw new Error("한글 폰트를 다운로드할 수 없습니다");

  const fontBytes = await response.arrayBuffer();
  return pdfDoc.embedFont(fontBytes, { subset: true });
}

/** 표를 PDF에 렌더링 */
function drawTable(pdfPage, table, imgHeight, font) {
  for (const row of table) {
    for (const cell of row.cells) {
      const x = cell.x;
      const y = imgHeight - cell.y - cell.h;
      const w = cell.w * (cell.colspan || 1);
      const h = cell.h * (cell.rowspan || 1);

      pdfPage.drawRectangle({ x, y, width: w, height: h, borderWidth: 0.5 });

      for (const word of cell.words) {
        pdfPage.drawText(word.text, {
          x: word.bbox.x0,
          y: imgHeight - word.bbox.y1,
          size: 8,
          font,
          opacity: 0,
        });
      }
    }
  }
}

/** 일반 텍스트를 PDF에 투명 레이어로 렌더링 */
function drawWords(pdfPage, words, imgHeight, font) {
  for (const word of words) {
    pdfPage.drawText(word.text, {
      x: word.bbox.x0,
      y: imgHeight - word.bbox.y1,
      size: 8,
      font,
      opacity: 0,
    });
  }
}

// ─── 메인 파이프라인 ───

/** 이미지 배열을 받아 OCR → PDF 생성 후 base64 반환 */
async function processImages(images, config) {
  const lang = "kor+eng";
  const confidence = 60;
  const qualityMap = { high: 1.0, medium: 0.7, low: 0.4 };
  const jpegQuality = qualityMap[config.quality] || 0.7;
  const ocrEnabled = config.ocr !== false;
  const total = images.length;

  let allWords = null;

  if (ocrEnabled) {
    // tesseract scheduler + 병렬 worker 생성
    const numWorkers = Math.max(1, (navigator.hardwareConcurrency || 4) - 1);
    const scheduler = Tesseract.createScheduler();
    activeScheduler = scheduler;

    const workerOpts = {
      langPath: "https://tessdata.projectnaptha.com/4.0.0",
      workerPath: chrome.runtime.getURL("tesseract-worker.min.js"),
      corePath: chrome.runtime.getURL("tesseract-core-lstm.wasm.js"),
      workerBlobURL: false,
    };

    for (let w = 0; w < numWorkers; w++) {
      const worker = await Tesseract.createWorker(lang, 1, workerOpts);
      await worker.setParameters({ tessedit_pageseg_mode: "6" });
      scheduler.addWorker(worker);
    }

    // 1. 전처리 + OCR 병렬 실행
    const preprocessed = [];
    for (let i = 0; i < images.length; i++) {
      const rawImageData = await loadImage(images[i]);
      const processedImageData = preprocess(rawImageData);
      const processedBlob = await imageDataToBlob(processedImageData);
      preprocessed.push(processedBlob);
    }

    let ocrDone = 0;
    allWords = [];

    // 병렬이지만 중지 가능하도록 배치 처리
    const batchSize = numWorkers;
    for (let start = 0; start < preprocessed.length; start += batchSize) {
      if (stopped) break;

      const batch = preprocessed.slice(start, start + batchSize);
      const batchPromises = batch.map((blob) =>
        scheduler.addJob("recognize", blob).then((ocrResult) => {
          ocrDone++;
          try { chrome.runtime.sendMessage({ type: "PROGRESS", step: "텍스트 인식 중", current: ocrDone, total }); } catch (e) {}
          return ocrResult.data.words.filter((w) => w.confidence > confidence);
        })
      );
      const batchResults = await Promise.all(batchPromises);
      allWords.push(...batchResults);
    }

    await scheduler.terminate();
    activeScheduler = null;
  }

  if (stopped) throw new Error("사용자가 중지했습니다");

  // 2. PDF 조립 (순차 — canvas 공유)
  const pdfDoc = await PDFDocument.create();
  const font = ocrEnabled ? await loadKoreanFont(pdfDoc) : null;

  for (let i = 0; i < images.length; i++) {
    if (stopped) throw new Error("사용자가 중지했습니다");

    const words = ocrEnabled ? allWords[i] : [];

    // 표 감지 (OCR 활성 시에만)
    let table = null;
    if (ocrEnabled) {
      const originalImageData = await loadImage(images[i]);
      const binaryForTable = preprocess(originalImageData);
      const cells = detectTableCells(binaryForTable);

      if (cells.length > 0) {
        const mapped = mapWordsToCells(words, cells);
        table = buildTableStructure(mapped);
      }
    }

    // PDF 페이지 생성 (품질 적용)
    const origImageData = await loadImage(images[i]);
    const canvas = document.getElementById("canvas");
    canvas.width = origImageData.width;
    canvas.height = origImageData.height;
    canvas.getContext("2d", { willReadFrequently: true }).putImageData(origImageData, 0, 0);

    let imgBytes, img;
    if (jpegQuality < 1.0) {
      const jpegDataUrl = canvas.toDataURL("image/jpeg", jpegQuality);
      const jpegBase64 = jpegDataUrl.replace(/^data:image\/jpeg;base64,/, "");
      imgBytes = Uint8Array.from(atob(jpegBase64), (c) => c.charCodeAt(0));
      img = await pdfDoc.embedJpg(imgBytes);
    } else {
      const pngBase64 = images[i].replace(/^data:image\/png;base64,/, "");
      imgBytes = Uint8Array.from(atob(pngBase64), (c) => c.charCodeAt(0));
      img = await pdfDoc.embedPng(imgBytes);
    }
    const page = pdfDoc.addPage([img.width, img.height]);

    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });

    if (table) {
      drawTable(page, table, img.height, font);
    } else {
      drawWords(page, words, img.height, font);
    }

    try { chrome.runtime.sendMessage({ type: "PROGRESS", step: "파일 만드는 중", current: i + 1, total }); } catch (e) {}
  }



  // PDF를 base64로 반환
  const pdfBytes = await pdfDoc.save();
  const binary = Array.from(new Uint8Array(pdfBytes))
    .map((b) => String.fromCharCode(b))
    .join("");
  return btoa(binary);
}

// 중지 플래그
let stopped = false;
let activeScheduler = null;

// 메시지 수신
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "PROCESS") {
    stopped = false;
    processImages(msg.images, msg.config)
      .then((pdfBase64) => sendResponse({ success: true, pdfBase64 }))
      .catch((err) => sendResponse({ success: false, error: `[offscreen] ${err?.message || err?.toString() || JSON.stringify(err)}` }));
    return true;
  }

  if (msg.type === "STOP") {
    stopped = true;
    if (activeScheduler) {
      activeScheduler.terminate();
      activeScheduler = null;
    }
    return false;
  }

  if (msg.type === "CROP") {
    const { dataUrl, rect } = msg;
    const img = new Image();
    img.onload = () => {
      const dpr = window.devicePixelRatio || 1;
      const sx = rect.x * dpr;
      const sy = rect.y * dpr;
      const sw = rect.width * dpr;
      const sh = rect.height * dpr;
      const canvas = document.getElementById("canvas");
      canvas.width = sw;
      canvas.height = sh;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
      sendResponse({ dataUrl: canvas.toDataURL("image/png") });
    };
    img.onerror = () => sendResponse({ dataUrl });
    img.src = dataUrl;
    return true;
  }
});
