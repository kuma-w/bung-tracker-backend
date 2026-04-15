const { Router } = require('express');
const supabase = require('../lib/supabase');
const { requireAdmin } = require('../lib/middleware');
const { toKST, buildResultMessages } = require('../lib/slots');

const router = Router();

// ─── 헬퍼 ──────────────────────────────────────────────────

function formatSlots(eventSlots, includeAttendees = false) {
  return (eventSlots || [])
    .sort((a, b) => a.slot_time.localeCompare(b.slot_time))
    .map((s) => {
      const base = {
        slot_time: s.slot_time,
        capacity: s.capacity,
        count: s.attendees.length,
        remaining: Math.max(0, s.capacity - s.attendees.length),
      };
      if (includeAttendees) {
        base.attendees = s.attendees.map((a) => ({
          name: a.name,
          registered_at: toKST(a.registered_at),
        }));
      }
      return base;
    });
}

// ─── 벙 관리 (관리자 전용) ─────────────────────────────────

/**
 * POST /events
 * 벙 생성
 *
 * Body: {
 *   "event_date": "2026-04-17",
 *   "amount_per_person": 1500,
 *   "slots": [{ "slot_time": "10:30", "capacity": 10 }, ...]
 * }
 */
router.post('/events', requireAdmin, async (req, res) => {
  const { event_date, amount_per_person, slots } = req.body;

  if (!event_date || !amount_per_person || !Array.isArray(slots) || slots.length === 0) {
    return res.status(400).json({
      success: false,
      message: 'event_date, amount_per_person, slots(배열) 필드가 필요합니다.',
    });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(event_date)) {
    return res.status(400).json({ success: false, message: 'event_date 형식은 YYYY-MM-DD 이어야 합니다.' });
  }

  try {
    const { data: event, error: eventError } = await supabase
      .from('events')
      .insert({ event_date, amount_per_person })
      .select()
      .single();
    if (eventError) throw eventError;

    const { data: createdSlots, error: slotError } = await supabase
      .from('event_slots')
      .insert(slots.map((s) => ({ event_id: event.id, slot_time: s.slot_time, capacity: s.capacity ?? 10 })))
      .select();
    if (slotError) throw slotError;

    console.log(`[POST /events] ${event_date} / ${slots.length}타임 / ${amount_per_person}원`);
    return res.status(201).json({
      success: true,
      message: '벙이 생성되었습니다.',
      event: { ...event, slots: createdSlots },
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ success: false, message: `${event_date}에 이미 벙이 존재합니다.` });
    }
    console.error('POST /events 오류:', err.message);
    return res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

/**
 * PATCH /events/:date
 * 벙 수정 (amount_per_person, 슬롯 정원 변경 / 슬롯 추가 / 슬롯 삭제)
 *
 * Body: {
 *   "amount_per_person": 2000,          // 선택
 *   "slots": [                           // 선택 — 전달된 슬롯만 처리
 *     { "slot_time": "10:30", "capacity": 12 },  // 기존 슬롯: 정원 변경
 *     { "slot_time": "14:00", "capacity": 10 },  // 새 슬롯: 추가
 *   ]
 *   "delete_slots": ["12:00"]            // 선택 — 삭제할 슬롯 (참석자 없어야 함)
 * }
 */
router.patch('/events/:date', requireAdmin, async (req, res) => {
  const { date } = req.params;
  const { amount_per_person, slots, delete_slots } = req.body;

  if (!amount_per_person && !slots && !delete_slots) {
    return res.status(400).json({
      success: false,
      message: 'amount_per_person, slots, delete_slots 중 하나 이상 필요합니다.',
    });
  }

  try {
    const { data: event, error: evErr } = await supabase
      .from('events')
      .select('id, event_slots(id, slot_time, capacity, attendees(id))')
      .eq('event_date', date)
      .single();

    if (evErr && evErr.code === 'PGRST116') {
      return res.status(404).json({ success: false, message: `${date} 벙을 찾을 수 없습니다.` });
    }
    if (evErr) throw evErr;

    // 1. amount_per_person 변경
    if (amount_per_person !== undefined) {
      const { error } = await supabase
        .from('events')
        .update({ amount_per_person })
        .eq('id', event.id);
      if (error) throw error;
    }

    // 2. 슬롯 삭제
    if (Array.isArray(delete_slots) && delete_slots.length > 0) {
      for (const slot_time of delete_slots) {
        const target = event.event_slots.find((s) => s.slot_time === slot_time);
        if (!target) {
          return res.status(404).json({ success: false, message: `${slot_time} 슬롯이 존재하지 않습니다.` });
        }
        if (target.attendees.length > 0) {
          return res.status(409).json({
            success: false,
            message: `${slot_time} 슬롯에 참석자(${target.attendees.length}명)가 있어 삭제할 수 없습니다.`,
          });
        }
        const { error } = await supabase.from('event_slots').delete().eq('id', target.id);
        if (error) throw error;
      }
    }

    // 3. 슬롯 추가 / 정원 변경
    if (Array.isArray(slots) && slots.length > 0) {
      for (const { slot_time, capacity } of slots) {
        const existing = event.event_slots.find((s) => s.slot_time === slot_time);
        if (existing) {
          // 기존 슬롯 — 정원 변경
          const { error } = await supabase
            .from('event_slots')
            .update({ capacity })
            .eq('id', existing.id);
          if (error) throw error;
        } else {
          // 새 슬롯 — 추가
          const { error } = await supabase
            .from('event_slots')
            .insert({ event_id: event.id, slot_time, capacity: capacity ?? 10 });
          if (error) throw error;
        }
      }
    }

    // 변경 후 최신 상태 조회
    const { data: updated, error: fetchErr } = await supabase
      .from('events')
      .select('id, event_date, amount_per_person, event_slots(id, slot_time, capacity, attendees(id))')
      .eq('id', event.id)
      .single();
    if (fetchErr) throw fetchErr;

    console.log(`[PATCH /events/${date}] 수정 완료`);
    return res.json({
      success: true,
      message: `${date} 벙이 수정되었습니다.`,
      event: {
        id: updated.id,
        event_date: updated.event_date,
        amount_per_person: updated.amount_per_person,
        slots: formatSlots(updated.event_slots),
      },
    });
  } catch (err) {
    console.error('PATCH /events/:date 오류:', err.message);
    return res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

/**
 * DELETE /events/:date
 * 벙 삭제 (슬롯·참석자 cascade 삭제)
 */
router.delete('/events/:date', requireAdmin, async (req, res) => {
  const { date } = req.params;

  try {
    const { error, count } = await supabase
      .from('events')
      .delete({ count: 'exact' })
      .eq('event_date', date);
    if (error) throw error;

    if (count === 0) {
      return res.status(404).json({ success: false, message: `${date} 벙을 찾을 수 없습니다.` });
    }
    return res.json({ success: true, message: `${date} 벙이 삭제되었습니다.` });
  } catch (err) {
    console.error('DELETE /events/:date 오류:', err.message);
    return res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ─── 벙 조회 (공개) ────────────────────────────────────────

/** GET /events — 전체 벙 목록 (슬롯 현황 포함) */
router.get('/events', async (req, res) => {
  try {
    const { data: events, error } = await supabase
      .from('events')
      .select('id, event_date, amount_per_person, created_at, event_slots(id, slot_time, capacity, attendees(id))')
      .order('event_date', { ascending: false });
    if (error) throw error;

    return res.json({
      success: true,
      events: events.map((e) => ({
        id: e.id,
        event_date: e.event_date,
        amount_per_person: e.amount_per_person,
        created_at: toKST(e.created_at),
        slots: formatSlots(e.event_slots),
      })),
    });
  } catch (err) {
    console.error('GET /events 오류:', err.message);
    return res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

/** GET /events/:date — 특정 날짜 벙 상세 (슬롯별 참석자 포함) */
router.get('/events/:date', async (req, res) => {
  const { date } = req.params;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ success: false, message: 'date 형식은 YYYY-MM-DD 이어야 합니다.' });
  }

  try {
    const { data: event, error } = await supabase
      .from('events')
      .select('id, event_date, amount_per_person, created_at, event_slots(id, slot_time, capacity, attendees(name, registered_at))')
      .eq('event_date', date)
      .single();

    if (error && error.code === 'PGRST116') {
      return res.status(404).json({ success: false, message: `${date}에 개설된 벙이 없습니다.` });
    }
    if (error) throw error;

    const slots = formatSlots(event.event_slots, true);
    return res.json({
      event_date: event.event_date,
      amount_per_person: event.amount_per_person,
      total_attendees: slots.reduce((sum, s) => sum + s.count, 0),
      slots,
    });
  } catch (err) {
    console.error('GET /events/:date 오류:', err.message);
    return res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ─── 참석자 직접 관리 (관리자 전용) ───────────────────────

/**
 * POST /events/:date/attendees
 * 관리자가 특정 벙에 참석자를 직접 추가
 *
 * Body: { "names": ["홍길동"], "slot_time": "10:30" }
 *   slot_time 생략 시 자동 배정. 지정 시 정원 초과 허용.
 */
router.post('/events/:date/attendees', requireAdmin, async (req, res) => {
  const { date } = req.params;
  const { names, slot_time } = req.body;

  if (!Array.isArray(names) || names.length === 0) {
    return res.status(400).json({ success: false, message: 'names 배열이 필요합니다.' });
  }

  try {
    const { data: event, error: evErr } = await supabase
      .from('events')
      .select('id, event_slots(id, slot_time, capacity)')
      .eq('event_date', date)
      .single();

    if (evErr && evErr.code === 'PGRST116') {
      return res.status(404).json({ success: false, message: `${date}에 개설된 벙이 없습니다.` });
    }
    if (evErr) throw evErr;

    if (slot_time && !event.event_slots.find((s) => s.slot_time === slot_time)) {
      const available = event.event_slots.map((s) => s.slot_time).join(', ');
      return res.status(400).json({
        success: false,
        message: `${slot_time} 슬롯이 존재하지 않습니다. 가능한 슬롯: ${available}`,
      });
    }

    const slotIds = event.event_slots.map((s) => s.id);
    const { data: attendeeRows, error: aErr } = await supabase
      .from('attendees')
      .select('event_slot_id, name')
      .in('event_slot_id', slotIds);
    if (aErr) throw aErr;

    const slotCounts = {};
    for (const row of attendeeRows) {
      slotCounts[row.event_slot_id] = (slotCounts[row.event_slot_id] || 0) + 1;
    }

    const sortedSlots = [...event.event_slots].sort((a, b) => a.slot_time.localeCompare(b.slot_time));
    const results = [];

    for (const name of names) {
      const existing = attendeeRows.find((r) => r.name === name);
      if (existing) {
        const slot = event.event_slots.find((s) => s.id === existing.event_slot_id);
        results.push({ name, status: 'duplicate', slot_time: slot?.slot_time });
        continue;
      }

      // slot_time 지정 시 정원 초과도 허용 (관리자 권한), 미지정 시 자동 배정
      const targetSlot = slot_time
        ? event.event_slots.find((s) => s.slot_time === slot_time)
        : sortedSlots.find((s) => (slotCounts[s.id] || 0) < s.capacity);

      if (!targetSlot) {
        results.push({ name, status: 'full' });
        continue;
      }

      const { error: insertError } = await supabase
        .from('attendees')
        .insert({ event_slot_id: targetSlot.id, name });
      if (insertError) throw insertError;

      slotCounts[targetSlot.id] = (slotCounts[targetSlot.id] || 0) + 1;
      results.push({ name, status: 'ok', slot_time: targetSlot.slot_time });
    }

    const messages = buildResultMessages(results);
    console.log(`[POST /events/${date}/attendees] ${messages.join(' | ')}`);

    const ok = results.filter((r) => r.status === 'ok');
    return res.status(ok.length > 0 ? 201 : 409).json({
      success: ok.length > 0,
      message: messages.join('\n'),
      results,
    });
  } catch (err) {
    console.error(`POST /events/${date}/attendees 오류:`, err.message);
    return res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

/** DELETE /events/:date/attendees/:name — 관리자가 특정 벙에서 참석자 제거
 *  Query: ?slot_time=10:30  (생략 시 해당 날짜 전체 슬롯에서 삭제)
 */
router.delete('/events/:date/attendees/:name', requireAdmin, async (req, res) => {
  const { date, name } = req.params;
  const { slot_time } = req.query;
  const decodedName = decodeURIComponent(name);

  try {
    const { data: event, error: evErr } = await supabase
      .from('events')
      .select('event_slots(id, slot_time)')
      .eq('event_date', date)
      .single();

    if (evErr && evErr.code === 'PGRST116') {
      return res.status(404).json({ success: false, message: `${date} 벙을 찾을 수 없습니다.` });
    }
    if (evErr) throw evErr;

    let targetSlotIds;
    if (slot_time) {
      const target = event.event_slots.find((s) => s.slot_time === slot_time);
      if (!target) {
        return res.status(404).json({ success: false, message: `${slot_time} 슬롯을 찾을 수 없습니다.` });
      }
      targetSlotIds = [target.id];
    } else {
      targetSlotIds = event.event_slots.map((s) => s.id);
    }

    const { error, count } = await supabase
      .from('attendees')
      .delete({ count: 'exact' })
      .in('event_slot_id', targetSlotIds)
      .eq('name', decodedName);
    if (error) throw error;

    if (count === 0) {
      return res.status(404).json({
        success: false,
        message: `${decodedName}님의 ${date} 벙 등록 정보를 찾을 수 없습니다.`,
      });
    }
    return res.json({ success: true, message: `${decodedName}님의 ${date} 벙 등록이 취소되었습니다.` });
  } catch (err) {
    console.error(`DELETE /events/${date}/attendees 오류:`, err.message);
    return res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

module.exports = router;
