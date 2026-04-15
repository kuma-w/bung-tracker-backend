/**
 * 토스 입금 알림 파서
 *
 * 형식: {amount}원 입금 {name} {day} -> 모임통장(NNNN)
 *
 * 예시:
 *   "1500원 입금 길동 17 -> 모임통장(1248)"  → { names: ["길동"], dates: ["2026-04-17"], slotIndex: null, amount: 1500 }
 *   "1,500원 입금 홍길동 17 -> 모임통장(1248)" → { names: ["홍길동"], dates: ["2026-04-17"], slotIndex: null, amount: 1500 }
 */
function parseContent(content) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  const firstLine = content.split('\n')[0];
  const match = firstLine.match(/^([\d,]+)원\s+입금\s+(\S+)\s+(\d{1,2})/);
  if (!match) return { names: [], dates: [], slotIndex: null, amount: null };

  const amount = parseInt(match[1].replace(/,/g, ''), 10);
  const name = match[2];
  const day = parseInt(match[3], 10);

  if (day < 1 || day > 31) return { names: [], dates: [], slotIndex: null, amount: null };

  const fullDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { names: [name], dates: [fullDate], slotIndex: null, amount };
}

module.exports = { parseContent };
