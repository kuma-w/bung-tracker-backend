require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.PORT || '3000');
const SLOT_CAPACITY = parseInt(process.env.SLOT_CAPACITY || '10');

// ─── Supabase 클라이언트 ────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── 헬퍼 함수 ─────────────────────────────────────────────

function getBungType(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  const dow = date.getDay(); // 0=일, 4=목
  if (dow === 4) return 'thursday';
  if (dow === 0) return 'sunday';
  return null;
}

function getExpectedAmount(bungType) {
  if (bungType === 'thursday') return 1500;
  if (bungType === 'sunday')   return 2000;
  return null;
}

function getBungTypeLabel(bungType) {
  if (bungType === 'thursday') return '목요일(평일)';
  if (bungType === 'sunday')   return '일요일(주말)';
  return '미정';
}

async function assignSlot(eventDate) {
  const { data, error } = await supabase
    .from('attendees')
    .select('time_slot')
    .eq('event_date', eventDate);

  if (error) throw error;

  const filled = {};
  for (const row of data) {
    filled[row.time_slot] = (filled[row.time_slot] || 0) + 1;
  }

  if ((filled['10:30'] || 0) < SLOT_CAPACITY) return '10:30';
  if ((filled['12:00'] || 0) < SLOT_CAPACITY) return '12:00';
  return null;
}

// ─── content 파싱 ──────────────────────────────────────────

function parseContent(content) {
  const year = new Date().getFullYear();
  const tokens = content.trim().split(/\s+/);
  const dates = [];
  const names = [];

  for (const token of tokens) {
    let date = null;

    // YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(token)) {
      date = token;
    }
    // M/DD, MM/DD, M-DD, MM-DD, M.DD, MM.DD
    else if (/^\d{1,2}[\/\-\.]\d{1,2}$/.test(token)) {
      const [m, d] = token.split(/[\/\-\.]/).map(Number);
      date = `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    // MMDD (4자리) 또는 MDD (3자리)
    else if (/^\d{3,4}$/.test(token)) {
      const s = token.padStart(4, '0');
      date = `${year}-${s.slice(0, 2)}-${s.slice(2, 4)}`;
    }

    if (date) {
      dates.push(date);
    } else {
      names.push(token);
    }
  }

  return { names, dates };
}

// ─── API ───────────────────────────────────────────────────

/**
 * POST /payment
 * Tasker → 서버로 입금 알림 전송
 *
 * Body: { "content": "홍길동 김철수 0416", "amount": 3000 }
 * content: 이름(들) + 날짜(들) 혼합. 날짜 패턴(숫자)은 자동 감지.
 */
app.post('/payment', async (req, res) => {
  const { content, amount } = req.body;

  if (!content || amount === undefined) {
    return res.status(400).json({
      success: false,
      message: 'content, amount 필드가 모두 필요합니다.',
    });
  }

  const { names, dates } = parseContent(String(content));

  if (names.length === 0) {
    return res.status(400).json({ success: false, message: 'content에서 이름을 찾을 수 없습니다.' });
  }
  if (dates.length === 0) {
    return res.status(400).json({ success: false, message: 'content에서 날짜를 찾을 수 없습니다. (예: 홍길동 0416)' });
  }

  // 날짜별 벙 타입 검증 및 총 예상 금액 계산
  let totalExpected = 0;
  for (const date of dates) {
    const bungType = getBungType(date);
    if (!bungType) {
      return res.status(400).json({
        success: false,
        message: `${date}은 벙 개설 요일(목요일/일요일)이 아닙니다.`,
      });
    }
    totalExpected += getExpectedAmount(bungType) * names.length;
  }

  if (Number(amount) !== totalExpected) {
    return res.status(400).json({
      success: false,
      message: `금액 불일치. 예상 금액: ${totalExpected}원 (${names.length}명 × ${dates.length}개 날짜). 받은 금액: ${amount}원`,
    });
  }

  try {
    const results = [];

    for (const date of dates) {
      const perPersonAmount = getExpectedAmount(getBungType(date));

      for (const name of names) {
        // 중복 확인
        const { data: existing, error: selectError } = await supabase
          .from('attendees')
          .select('time_slot')
          .eq('event_date', date)
          .eq('name', name)
          .maybeSingle();

        if (selectError) throw selectError;

        if (existing) {
          results.push({ name, date, status: 'duplicate', time_slot: existing.time_slot });
          continue;
        }

        // 슬롯 배정
        const slot = await assignSlot(date);
        if (!slot) {
          results.push({ name, date, status: 'full' });
          continue;
        }

        const { error: insertError } = await supabase
          .from('attendees')
          .insert({ event_date: date, time_slot: slot, name, amount: perPersonAmount });

        if (insertError) throw insertError;

        results.push({ name, date, status: 'ok', time_slot: slot });
      }
    }

    const ok       = results.filter((r) => r.status === 'ok');
    const dup      = results.filter((r) => r.status === 'duplicate');
    const full     = results.filter((r) => r.status === 'full');

    const messages = [];
    ok.forEach((r)   => messages.push(`✅ ${r.name} ${r.date} ${r.time_slot} 등록 완료`));
    dup.forEach((r)  => messages.push(`⚠️ ${r.name} ${r.date} 이미 등록됨 (${r.time_slot})`));
    full.forEach((r) => messages.push(`❌ ${r.name} ${r.date} 만석`));

    console.log(`[POST /payment] ${messages.join(' | ')}`);
    const statusCode = ok.length > 0 ? 201 : 409;
    return res.status(statusCode).json({ success: ok.length > 0, message: messages.join('\n'), results });
  } catch (err) {
    console.error('POST /payment 오류:', err.message);
    return res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

/**
 * GET /attendance/:date
 * 특정 날짜 벙 참석자 조회
 */
app.get('/attendance/:date', async (req, res) => {
  const { date } = req.params;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ success: false, message: 'date 형식은 YYYY-MM-DD 이어야 합니다.' });
  }

  try {
    const { data: rows, error } = await supabase
      .from('attendees')
      .select('name, time_slot, amount, registered_at')
      .eq('event_date', date)
      .order('time_slot')
      .order('registered_at');

    if (error) throw error;

    const bungType = getBungType(date);
    const slot1030 = rows.filter((r) => r.time_slot === '10:30');
    const slot1200 = rows.filter((r) => r.time_slot === '12:00');

    const toKST = (ts) =>
      new Date(ts).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).replace('T', ' ');

    return res.json({
      date,
      bung_type: bungType,
      bung_type_label: getBungTypeLabel(bungType),
      expected_amount: bungType ? getExpectedAmount(bungType) : null,
      total: rows.length,
      slots: {
        '10:30': {
          count: slot1030.length,
          capacity: SLOT_CAPACITY,
          remaining: Math.max(0, SLOT_CAPACITY - slot1030.length),
          attendees: slot1030.map((r) => ({ name: r.name, registered_at: toKST(r.registered_at) })),
        },
        '12:00': {
          count: slot1200.length,
          capacity: SLOT_CAPACITY,
          remaining: Math.max(0, SLOT_CAPACITY - slot1200.length),
          attendees: slot1200.map((r) => ({ name: r.name, registered_at: toKST(r.registered_at) })),
        },
      },
    });
  } catch (err) {
    console.error('GET /attendance/:date 오류:', err.message);
    return res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

/**
 * GET /attendance
 * 전체 참석자 조회
 *
 * Query: ?limit=100&offset=0
 */
app.get('/attendance', async (req, res) => {
  const limit  = parseInt(req.query.limit  || '100');
  const offset = parseInt(req.query.offset || '0');

  try {
    const { data: rows, error, count } = await supabase
      .from('attendees')
      .select('event_date, time_slot, name, amount, registered_at', { count: 'exact' })
      .order('event_date', { ascending: false })
      .order('time_slot')
      .order('registered_at')
      .range(offset, offset + limit - 1);

    if (error) throw error;

    const toKST = (ts) =>
      new Date(ts).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).replace('T', ' ');

    return res.json({
      total: count,
      limit,
      offset,
      attendees: rows.map((r) => ({ ...r, registered_at: toKST(r.registered_at) })),
    });
  } catch (err) {
    console.error('GET /attendance 오류:', err.message);
    return res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

/**
 * DELETE /attendance/:date/:name
 * 특정 등록 취소
 */
app.delete('/attendance/:date/:name', async (req, res) => {
  const { date, name } = req.params;

  try {
    const { error, count } = await supabase
      .from('attendees')
      .delete({ count: 'exact' })
      .eq('event_date', date)
      .eq('name', decodeURIComponent(name));

    if (error) throw error;

    if (count === 0) {
      return res.status(404).json({
        success: false,
        message: `${name}님의 ${date} 벙 등록 정보를 찾을 수 없습니다.`,
      });
    }

    return res.json({
      success: true,
      message: `${name}님의 ${date} 벙 등록이 취소되었습니다.`,
    });
  } catch (err) {
    console.error('DELETE /attendance 오류:', err.message);
    return res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ─── 서버 시작 ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Bung Tracker 서버 실행 중 → http://localhost:${PORT}`);
  console.log(`슬롯 정원: ${SLOT_CAPACITY}명 / 타임`);
});
