/** PDF 생성 — pdf-lib 기반 이미지 임베드 + 검색용 텍스트 오버레이
 *
 * 각 페이지 이미지를 PDF에 임베드하고, OCR 결과 텍스트를
 * 투명(opacity: 0)으로 겹쳐 그려서 PDF 뷰어에서 텍스트 검색/복사가 가능하게 한다.
 */

const { PDFDocument } = require("pdf-lib");
const fontkit = require("@pdf-lib/fontkit");

/** 폰트 바이너리 캐시 — 첫 요청 시 확장 자산에서 로드 후 재사용 */
let fontCache = null;

/** 한글 폰트(Noto Sans CJK KR)를 PDF에 임베드한다. 빌드 단계에서 dist/에 번들된 자산을 사용. */
async function loadKoreanFont(pdfDoc) {
  pdfDoc.registerFontkit(fontkit);

  if (!fontCache) {
    const fontUrl = chrome.runtime.getURL("NotoSansCJKkr-Regular.otf");
    const response = await fetch(fontUrl);
    if (!response.ok) throw new Error("한글 폰트를 로드할 수 없습니다");
    fontCache = await response.arrayBuffer();
  }

  return pdfDoc.embedFont(fontCache, { subset: true });
}

/** 이미지 좌표(좌상단 원점)의 y를 PDF 좌표(좌하단 원점)로 변환한다. */
function toPdfY(imgHeight, yBottom) {
  return imgHeight - yBottom;
}

/** OCR 단어 배열을 PDF 페이지에 투명 텍스트로 렌더링한다. (검색/복사 전용) */
function drawWords(pdfPage, words, imgHeight, font) {
  for (const word of words) {
    pdfPage.drawText(word.text, {
      x: word.bbox.x0,
      y: toPdfY(imgHeight, word.bbox.y1),
      size: 8,
      font,
      opacity: 0,
    });
  }
}

/** 표 구조를 PDF 페이지에 렌더링 (셀 → 단어 평탄화 후 drawWords 재사용) */
function drawTable(pdfPage, table, imgHeight, font) {
  const words = table.flatMap((row) => row.cells.flatMap((cell) => cell.words));
  drawWords(pdfPage, words, imgHeight, font);
}

/** data URL의 base64 페이로드를 Uint8Array로 변환한다. */
function dataUrlToBytes(dataUrl) {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

/** 이미 그려진 캔버스에서 JPEG로 인코딩하여 PDF에 임베드한다. */
async function embedJpegFromCanvas(pdfDoc, canvas, quality) {
  const dataUrl = canvas.toDataURL("image/jpeg", quality);
  return pdfDoc.embedJpg(dataUrlToBytes(dataUrl));
}

/** 원본 PNG data URL을 그대로 PDF에 임베드한다. (캔버스 라운드트립 없음) */
async function embedPngFromDataUrl(pdfDoc, dataUrl) {
  return pdfDoc.embedPng(dataUrlToBytes(dataUrl));
}

/** PDF 문서를 Uint8Array로 직렬화한다. */
async function savePdfBytes(pdfDoc) {
  return pdfDoc.save();
}

module.exports = {
  PDFDocument,
  loadKoreanFont,
  drawTable,
  drawWords,
  embedJpegFromCanvas,
  embedPngFromDataUrl,
  savePdfBytes,
};
