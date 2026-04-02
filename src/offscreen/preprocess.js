/** 이미지 전처리 — Canvas 기반 grayscale + binarization
 *
 * offscreen document의 <canvas> 요소를 사용하여
 * 이미지를 로드하고 OCR을 위한 이진화 전처리를 수행한다.
 */

const { IMAGE_CONFIG } = require("../constants.js");

/** canvas 요소 + context 캐시 (매번 DOM 조회하지 않도록) */
let _canvas = null;
let _ctx = null;

/** offscreen.html의 <canvas id="canvas"> 요소를 반환한다. */
function getCanvas() {
  if (!_canvas) _canvas = document.getElementById("canvas");
  return _canvas;
}

/** canvas의 2D 렌더링 컨텍스트를 반환한다. willReadFrequently로 읽기 성능 최적화. */
function getCtx() {
  if (!_ctx) _ctx = getCanvas().getContext("2d", { willReadFrequently: true });
  return _ctx;
}

/** data URL 문자열을 canvas에 그려 ImageData로 변환한다. */
function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = getCanvas();
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = getCtx();
      ctx.drawImage(img, 0, 0);
      resolve(ctx.getImageData(0, 0, canvas.width, canvas.height));
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

/**
 * ImageData를 그레이스케일 변환 후 이진화한다. (in-place 수정)
 * OCR 엔진의 인식률을 높이기 위한 전처리 단계.
 * 가중치 0.299/0.587/0.114는 표준 ITU-R BT.601 휘도(luminosity) 계수.
 */
function preprocess(imageData) {
  const data = imageData.data;
  const threshold = IMAGE_CONFIG.binarizationThreshold;

  for (let i = 0; i < data.length; i += 4) {
    // RGBA 중 R/G/B를 가중 평균하여 그레이스케일 변환
    const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    // threshold 기준으로 흑(0) 또는 백(255)으로 이진화
    const val = gray > threshold ? 255 : 0;
    data[i] = data[i + 1] = data[i + 2] = val;
  }

  return imageData;
}

/** ImageData를 canvas에 그려 PNG Blob으로 변환한다. */
function imageDataToBlob(imageData) {
  const canvas = getCanvas();
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  getCtx().putImageData(imageData, 0, 0);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

module.exports = { loadImage, preprocess, imageDataToBlob, getCanvas, getCtx };
