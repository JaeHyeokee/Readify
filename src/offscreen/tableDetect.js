/** 표 감지 — 이진화된 이미지에서 수평/수직 선을 검출하여 표 구조를 추출한다.
 *
 * 알고리즘:
 *   1) 수평선/수직선을 런렝스 인코딩(run-length encoding)으로 검출
 *   2) 선의 좌표를 클러스터링하여 그리드 교차점 추출
 *   3) 교차점으로 셀 영역 생성
 *   4) OCR 단어를 셀에 매핑 → 행 단위 구조화
 */

const { TABLE_CONFIG } = require("../constants.js");

/** 이진 이미지에서 표 셀 영역 배열을 반환한다. */
function detectTableCells(imageData) {
  const { width, height, data } = imageData;
  const { minLineLen, minCellSize, lineScanStep } = TABLE_CONFIG;

  // 픽셀이 어두운지 판별 (RGBA 배열에서 R 채널 기준, 4바이트 간격)
  const isDark = (x, y) => data[(y * width + x) * 4] < 128;

  // 수평/수직 방향으로 연속된 어두운 픽셀(선)을 검출
  const hLines = scanLines(width, height, lineScanStep, minLineLen, isDark, "horizontal");
  const vLines = scanLines(width, height, lineScanStep, minLineLen, isDark, "vertical");

  // 검출된 선의 위치를 클러스터링하여 그리드 좌표 추출
  const hYs = clusterValues(hLines.map((l) => l.pos), TABLE_CONFIG.clusterTolerance);
  const vXs = clusterValues(vLines.map((l) => l.pos), TABLE_CONFIG.clusterTolerance);

  // 최소 2개의 수평선 + 2개의 수직선이 있어야 표로 인정
  if (hYs.length < 2 || vXs.length < 2) return [];

  hYs.sort((a, b) => a - b);
  vXs.sort((a, b) => a - b);

  // 인접한 그리드 선 쌍으로 셀 영역 생성
  const cells = [];
  for (let r = 0; r < hYs.length - 1; r++) {
    for (let c = 0; c < vXs.length - 1; c++) {
      const x = vXs[c];
      const y = hYs[r];
      const width = vXs[c + 1] - x;
      const height = hYs[r + 1] - y;
      if (width > minCellSize && height > minCellSize) {
        cells.push({ x, y, width, height });
      }
    }
  }

  return cells;
}

/**
 * 런렝스 인코딩으로 수평 또는 수직 방향의 선을 검출한다.
 * scanDim 방향으로 step 간격으로 스캔하며, lineDim 방향으로 연속된 어두운 픽셀을 찾는다.
 *
 * @param {string} direction - "horizontal"이면 행 단위 스캔, "vertical"이면 열 단위 스캔
 * @returns {{ pos: number, start: number, end: number }[]} 검출된 선 배열
 */
function scanLines(imgWidth, imgHeight, step, minLen, isDark, direction) {
  const lines = [];
  const isHorizontal = direction === "horizontal";
  // 스캔할 축(행 또는 열)의 크기
  const scanDim = isHorizontal ? imgHeight : imgWidth;
  // 선을 따라가는 축의 크기
  const lineDim = isHorizontal ? imgWidth : imgHeight;

  for (let row = 0; row < scanDim; row += step) {
    let run = 0;
    for (let col = 0; col < lineDim; col++) {
      // 수평 스캔: isDark(x=col, y=row), 수직 스캔: isDark(x=row, y=col)
      const dark = isHorizontal ? isDark(col, row) : isDark(row, col);
      if (dark) {
        run++;
      } else {
        if (run >= minLen) {
          lines.push({ pos: row, start: col - run, end: col });
        }
        run = 0;
      }
    }
    // 행/열 끝까지 연속된 경우 처리
    if (run >= minLen) {
      lines.push({ pos: row, start: lineDim - run, end: lineDim });
    }
  }

  return lines;
}

/** 값 배열을 tolerance 이내의 근접한 값끼리 묶고, 각 클러스터의 평균값을 반환한다. */
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

  // 각 클러스터의 중심값(평균)을 반환
  return clusters.map(
    (c) => Math.round(c.reduce((a, b) => a + b, 0) / c.length)
  );
}

/**
 * OCR로 인식된 단어들을 좌표 기준으로 해당 셀에 매핑한다.
 * 셀을 y로 정렬한 인덱스 + 이진 탐색으로 단어별 후보 셀을 좁혀 O(W·log C + matches)로 처리.
 */
function mapWordsToCells(words, cells) {
  for (const cell of cells) cell.words = [];
  if (cells.length === 0 || words.length === 0) return cells;

  // 셀을 y(상단) 기준으로 정렬한 사본을 인덱스로 사용
  const sorted = cells.slice().sort((a, b) => a.y - b.y);
  const yStarts = sorted.map((c) => c.y);

  // yStarts에서 target보다 큰 첫 인덱스 (upper_bound)
  const upperBound = (target) => {
    let lo = 0, hi = yStarts.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (yStarts[mid] <= target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  for (const word of words) {
    const { x0, x1, y0, y1 } = word.bbox;
    // 단어의 y0보다 yStarts가 더 큰 첫 셀까지가 후보 끝 — 그 이후 셀은 word.y0 < cell.y이므로 포함 불가
    const end = upperBound(y0);
    for (let i = 0; i < end; i++) {
      const cell = sorted[i];
      if (
        x0 >= cell.x &&
        x1 <= cell.x + cell.width &&
        y1 <= cell.y + cell.height
      ) {
        cell.words.push(word);
      }
    }
  }
  return cells;
}

/** 셀들을 y좌표 근접도 기준으로 행(row) 단위로 묶어 구조화한다. */
function buildTableStructure(cells) {
  cells.sort((a, b) => a.y - b.y);
  const rows = [];

  for (const cell of cells) {
    // y좌표가 tolerance 이내이면 같은 행으로 간주
    const row = rows.find((r) => Math.abs(r.y - cell.y) < TABLE_CONFIG.rowMatchTolerance);
    if (row) {
      row.cells.push(cell);
    } else {
      rows.push({ y: cell.y, cells: [cell] });
    }
  }

  // 각 행 내 셀을 x좌표 순으로 정렬
  for (const row of rows) row.cells.sort((a, b) => a.x - b.x);
  return rows;
}

module.exports = { detectTableCells, mapWordsToCells, buildTableStructure };
