/** PDF 생성 — pdf-lib 기반 이미지 임베드 + 검색용 텍스트 오버레이
 *
 * 각 페이지 이미지를 PDF에 임베드하고, OCR 결과 텍스트를
 * 투명(opacity: 0)으로 겹쳐 그려서 PDF 뷰어에서 텍스트 검색/복사가 가능하게 한다.
 */

const { PDFDocument } = require("pdf-lib");
const fontkit = require("@pdf-lib/fontkit");

const FONT_URL = "https://cdn.jsdelivr.net/gh/notofonts/noto-cjk/Sans/OTF/Korean/NotoSansCJKkr-Regular.otf";

/** 폰트 바이너리 캐시 — 첫 요청 시 CDN에서 다운로드 후 재사용 */
let fontCache = null;

/** 한글 폰트(Noto Sans CJK KR)를 PDF에 임베드한다. 캐시된 바이너리가 있으면 재사용. */
async function loadKoreanFont(pdfDoc) {
  pdfDoc.registerFontkit(fontkit);

  if (!fontCache) {
    const response = await fetch(FONT_URL);
    if (!response.ok) throw new Error("한글 폰트를 다운로드할 수 없습니다");
    fontCache = await response.arrayBuffer();
  }

  return pdfDoc.embedFont(fontCache, { subset: true });
}

/**
 * 표 구조를 PDF 페이지에 렌더링한다.
 * 셀 테두리를 그리고, 셀 내 텍스트를 투명하게 겹쳐 그린다.
 * (투명 텍스트는 PDF 뷰어에서 검색/복사용으로 사용됨)
 */
function drawTable(pdfPage, table, imgHeight, font) {
  for (const row of table) {
    for (const cell of row.cells) {
      const x = cell.x;
      // PDF 좌표계는 좌하단 원점이므로, 이미지 좌표(좌상단 원점)를 변환
      const y = imgHeight - cell.y - cell.height;

      pdfPage.drawRectangle({ x, y, width: cell.width, height: cell.height, borderWidth: 0.5 });

      for (const word of cell.words) {
        pdfPage.drawText(word.text, {
          x: word.bbox.x0,
          y: imgHeight - word.bbox.y1,
          size: 8,
          font,
          opacity: 0, // 투명 — 검색/복사 전용
        });
      }
    }
  }
}

/** 일반 텍스트(표 외부)를 PDF 페이지에 투명하게 렌더링한다. */
function drawWords(pdfPage, words, imgHeight, font) {
  for (const word of words) {
    pdfPage.drawText(word.text, {
      x: word.bbox.x0,
      y: imgHeight - word.bbox.y1, // 좌표계 변환: 이미지(좌상단) → PDF(좌하단)
      size: 8,
      font,
      opacity: 0,
    });
  }
}

/**
 * 이미지를 PDF에 임베드한다.
 * jpegQuality < 1.0이면 canvas에서 JPEG로 변환하여 용량을 줄이고,
 * 1.0이면 원본 PNG를 그대로 임베드한다.
 */
async function embedImage(pdfDoc, dataUrl, canvas, jpegQuality) {
  if (jpegQuality < 1.0) {
    const jpegDataUrl = canvas.toDataURL("image/jpeg", jpegQuality);
    // data URL 헤더를 제거하고 base64 디코딩
    const jpegBase64 = jpegDataUrl.replace(/^data:image\/jpeg;base64,/, "");
    const bytes = Uint8Array.from(atob(jpegBase64), (c) => c.charCodeAt(0));
    return pdfDoc.embedJpg(bytes);
  } else {
    const pngBase64 = dataUrl.replace(/^data:image\/png;base64,/, "");
    const bytes = Uint8Array.from(atob(pngBase64), (c) => c.charCodeAt(0));
    return pdfDoc.embedPng(bytes);
  }
}

/** PDF 문서를 base64 문자열로 인코딩한다. (data URL이나 다운로드에 사용) */
async function encodePdf(pdfDoc) {
  const pdfBytes = await pdfDoc.save();
  // Uint8Array → binary string → base64
  const binary = Array.from(new Uint8Array(pdfBytes))
    .map((b) => String.fromCharCode(b))
    .join("");
  return btoa(binary);
}

module.exports = { PDFDocument, loadKoreanFont, drawTable, drawWords, embedImage, encodePdf };
