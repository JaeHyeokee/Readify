/** chrome.runtime.sendMessage 공통 유틸 — 컨텍스트 간 fire-and-forget 메시징 */

/**
 * 응답을 기대하지 않는 메시지를 보내고 에러는 조용히 무시한다.
 * 팝업이 닫혀 있거나 수신자가 없을 때 발생하는 lastError 노이즈를 차단.
 */
function safeSendRuntimeMessage(message) {
  try {
    chrome.runtime.sendMessage(message, () => {
      if (chrome.runtime.lastError) { /* 수신자 없음 — 무시 */ }
    });
  } catch (e) { /* 무시 */ }
}

module.exports = { safeSendRuntimeMessage };
