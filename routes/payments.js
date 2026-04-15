const { Router } = require('express');
const supabase = require('../lib/supabase');
const { requireAdmin } = require('../lib/middleware');
const { parseContent } = require('../parseContent');
const { assignToSlots, derivePaymentStatus, buildResultMessages, toKST } = require('../lib/slots');

const router = Router();

// ─── 헬퍼 ──────────────────────────────────────────────────

/**
 * dates별 이벤트를 조회해 총 예상 금액을 계산한다. 벙이 없으면 null을 반환한다.
 * slotIndex(1-based)가 주어지면 1슬롯만 계산, null이면 해당 날짜 전체 슬롯 수를 사용한다.
 * slotTime이 주어지면 1슬롯 계산 (관리자 수동 배정용).
 */
async function calcExpectedAmount(names, dates, slotIndex = null, slotTime = null) {
  let total = 0;
  for (const date of dates) {
    const { data: event, error } = await supabase
      .from('events')
      .select('amount_per_person, event_slots(id)')
      .eq('event_date', date)
      .single();

    if (error && error.code === 'PGRST116') return { total: null, missingDate: date };
    if (error) throw error;

    const effectiveSlots = (slotIndex !== null || slotTime) ? 1 : event.event_slots.length;

    total += event.amount_per_person * names.length * effectiveSlots;
  }
  return { total, missingDate: null };
}

async function savePayment(fields) {
  const { data, error } = await supabase.from('payments').insert(fields).select('id').single();
  if (error) throw error;
  return data.id;
}

async function updatePayment(id, fields) {
  const { error } = await supabase.from('payments').update(fields).eq('id', id);
  if (error) throw error;
}

// ─── 입금 처리 ─────────────────────────────────────────────

/**
 * POST /payment
 * Tasker → 서버로 입금 알림 전송.
 * 파싱 실패 포함 모든 수신 내역을 payments에 기록한다.
 *
 * Body: { "content": "홍길동 김철수 0416", "amount": 3000 }
 */
router.post('/payment', async (req, res) => {
  const { content, amount } = req.body;
  console.log(`[POST /payment] 수신: content="${content}" amount=${amount}`);

  if (!content || amount === undefined) {
    return res.status(400).json({ success: false, message: 'content, amount 필드가 모두 필요합니다.' });
  }

  const rawContent = String(content);
  const { names, dates, slotIndex } = parseContent(rawContent);

  // 파싱 실패 — failed로 저장 후 반환
  if (names.length === 0 || dates.length === 0) {
    const failReason = `파싱 실패 — ${names.length === 0 ? '이름' : '날짜'}을 찾을 수 없습니다.`;
    const paymentId = await savePayment({
      raw_content: rawContent,
      amount: Number(amount),
      parsed_names: names.length ? names : null,
      parsed_dates: dates.length ? dates : null,
      status: 'failed',
      fail_reason: failReason,
    });
    console.log(`[POST /payment] ${failReason} → payment#${paymentId}`);
    return res.status(422).json({
      success: false,
      payment_id: paymentId,
      message: `${failReason} 관리자가 수동 배정할 수 있습니다.`,
    });
  }

  // pending으로 먼저 저장
  let paymentId;
  try {
    paymentId = await savePayment({
      raw_content: rawContent,
      amount: Number(amount),
      parsed_names: names,
      parsed_dates: dates,
      status: 'pending',
    });
  } catch (err) {
    console.error('payments 저장 오류:', err.message);
    return res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }

  try {
    // 금액 검증
    const { total: expected, missingDate } = await calcExpectedAmount(names, dates, slotIndex);
    if (missingDate) {
      const failReason = `${missingDate}에 개설된 벙이 없습니다.`;
      await updatePayment(paymentId, { status: 'failed', fail_reason: failReason });
      return res.status(400).json({ success: false, payment_id: paymentId, message: failReason });
    }

    if (Number(amount) !== expected) {
      const failReason = `금액 불일치 — 예상: ${expected}원, 수신: ${amount}원`;
      await updatePayment(paymentId, { status: 'failed', fail_reason: failReason });
      return res.status(400).json({ success: false, payment_id: paymentId, message: failReason });
    }

    // 슬롯 배정
    const results = await assignToSlots(names, dates, paymentId, slotIndex);
    const status = derivePaymentStatus(results);
    await updatePayment(paymentId, { status });

    const messages = buildResultMessages(results);
    console.log(`[POST /payment] payment#${paymentId} ${status} | ${messages.join(' | ')}`);

    const ok = results.filter((r) => r.status === 'ok');
    return res.status(ok.length > 0 ? 201 : 409).json({
      success: ok.length > 0,
      payment_id: paymentId,
      message: messages.join('\n'),
      results,
    });
  } catch (err) {
    await updatePayment(paymentId, { status: 'failed', fail_reason: `서버 오류: ${err.message}` });
    console.error('POST /payment 오류:', err.message);
    return res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ─── 입금 내역 조회 (관리자 전용) ──────────────────────────

/**
 * GET /payments
 * 입금 내역 목록
 *
 * Query: ?status=failed&limit=50&offset=0
 */
router.get('/payments', requireAdmin, async (req, res) => {
  const { status, limit = '50', offset = '0' } = req.query;

  try {
    let query = supabase
      .from('payments')
      .select('id, raw_content, amount, parsed_names, parsed_dates, status, fail_reason, created_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (status) query = query.eq('status', status);

    const { data: payments, error, count } = await query;
    if (error) throw error;

    return res.json({
      total: count,
      limit: Number(limit),
      offset: Number(offset),
      payments: payments.map((p) => ({ ...p, created_at: toKST(p.created_at) })),
    });
  } catch (err) {
    console.error('GET /payments 오류:', err.message);
    return res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

/**
 * POST /payments/:id/assign
 * 파싱 실패·금액 불일치 등 미배정 입금을 관리자가 수동으로 배정.
 * names × dates 전체 조합을 배정하며, 이미 배정된 조합은 건너뛴다.
 * partial 재시도 시 기존 배정분은 duplicate로 처리되어 최종적으로 assigned가 된다.
 *
 * Body: { "names": ["홍길동", "김철수"], "dates": ["2026-04-17", "2026-04-24"] }
 */
router.post('/payments/:id/assign', requireAdmin, async (req, res) => {
  const paymentId = Number(req.params.id);
  const { names, dates, slot_index = null, slot_time = null } = req.body;

  if (!Array.isArray(names) || names.length === 0 || !Array.isArray(dates) || dates.length === 0) {
    return res.status(400).json({ success: false, message: 'names, dates 배열이 필요합니다.' });
  }
  const slotIndex = slot_index !== null ? Number(slot_index) : null;

  try {
    const { data: payment, error: payErr } = await supabase
      .from('payments')
      .select('id, amount, status')
      .eq('id', paymentId)
      .single();

    if (payErr && payErr.code === 'PGRST116') {
      return res.status(404).json({ success: false, message: `payment#${paymentId}를 찾을 수 없습니다.` });
    }
    if (payErr) throw payErr;

    const results = await assignToSlots(names, dates, paymentId, slotIndex, slot_time);
    const status = derivePaymentStatus(results);
    await updatePayment(paymentId, {
      status,
      parsed_names: names,
      parsed_dates: dates,
      fail_reason: status === 'failed' ? '수동 배정 후에도 실패' : null,
    });

    const messages = buildResultMessages(results);
    console.log(`[POST /payments/${paymentId}/assign] ${status} | ${messages.join(' | ')}`);

    const ok = results.filter((r) => r.status === 'ok');
    return res.json({
      success: ok.length > 0,
      payment_id: paymentId,
      message: messages.join('\n'),
      results,
    });
  } catch (err) {
    console.error(`POST /payments/${paymentId}/assign 오류:`, err.message);
    return res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

module.exports = router;
