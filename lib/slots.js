const supabase = require('./supabase');

const toKST = (ts) =>
  new Date(ts).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).replace('T', ' ');

/**
 * names × dates 조합을 슬롯에 배정한다.
 * slotIndex: 1-based 슬롯 순서. null이면 해당 날짜 모든 슬롯에 배정.
 * slotTime: 관리자 수동 배정 시 슬롯 시각 직접 지정 (slotIndex보다 우선순위 낮음).
 * 이미 등록된 경우 'duplicate', 만석이면 'full', 벙이 없으면 'no_event'를 반환한다.
 */
async function assignToSlots(names, dates, paymentId = null, slotIndex = null, slotTime = null) {
  const results = [];

  for (const date of dates) {
    const { data: event, error } = await supabase
      .from('events')
      .select('id, event_slots(id, slot_time, capacity)')
      .eq('event_date', date)
      .single();

    if (error && error.code === 'PGRST116') {
      for (const name of names) results.push({ name, date, status: 'no_event' });
      continue;
    }
    if (error) throw error;

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

    // 슬롯 후보 결정: slotIndex(1-based) → slotTime → 전체
    let candidateSlots;
    if (slotIndex !== null) {
      const target = sortedSlots[slotIndex - 1];
      candidateSlots = target ? [target] : [];
    } else if (slotTime) {
      candidateSlots = sortedSlots.filter((s) => s.slot_time === slotTime);
    } else {
      candidateSlots = sortedSlots;
    }

    const effectiveSlotsPerPerson = candidateSlots.length;

    const candidateSlotIds = new Set(candidateSlots.map((s) => s.id));

    for (const name of names) {
      const existingRows = attendeeRows.filter((r) => r.name === name);
      // 후보 슬롯 내에서만 중복 여부 판단
      const existingInCandidates = existingRows.filter((r) => candidateSlotIds.has(r.event_slot_id));

      // 이미 후보 슬롯 전부 배정된 경우 → 전부 duplicate
      if (existingInCandidates.length >= effectiveSlotsPerPerson) {
        for (const row of existingInCandidates) {
          const slot = event.event_slots.find((s) => s.id === row.event_slot_id);
          results.push({ name, date, status: 'duplicate', slot_time: slot?.slot_time });
        }
        continue;
      }

      // 이미 배정된 슬롯 ID 집합 (중복 배정 방지)
      const assignedSlotIds = new Set(existingInCandidates.map((r) => r.event_slot_id));
      const needed = effectiveSlotsPerPerson - existingInCandidates.length;

      let assigned = 0;
      for (const slot of candidateSlots) {
        if (assigned >= needed) break;
        if (assignedSlotIds.has(slot.id)) continue;
        if ((slotCounts[slot.id] || 0) >= slot.capacity) continue;

        const { error: insertError } = await supabase
          .from('attendees')
          .insert({ event_slot_id: slot.id, name, payment_id: paymentId });
        if (insertError) throw insertError;

        slotCounts[slot.id] = (slotCounts[slot.id] || 0) + 1;
        assignedSlotIds.add(slot.id);
        results.push({ name, date, status: 'ok', slot_time: slot.slot_time });
        assigned++;
      }

      // 빈 슬롯 부족으로 배정 못한 수만큼 full 처리
      for (let i = assigned; i < needed; i++) {
        results.push({ name, date, status: 'full' });
      }
    }
  }

  return results;
}

/**
 * results 배열로 payment_status를 결정한다.
 * 'duplicate'는 이미 배정 완료 상태이므로 'ok'와 동일하게 처리한다.
 * 덕분에 partial 재시도 시 기존 배정분이 duplicate로 돌아와도
 * 전체가 assigned로 올바르게 판정된다.
 */
function derivePaymentStatus(results) {
  const handled = results.filter((r) => r.status === 'ok' || r.status === 'duplicate').length;
  const failed  = results.filter((r) => r.status === 'full' || r.status === 'no_event').length;
  if (handled === 0) return 'failed';
  if (failed  === 0) return 'assigned';
  return 'partial';
}

/** results 배열을 사람이 읽기 쉬운 메시지 배열로 변환한다. */
function buildResultMessages(results) {
  return results.map((r) => {
    const loc = [r.date, r.slot_time].filter(Boolean).join(' ');
    switch (r.status) {
      case 'ok':        return `✅ ${r.name} ${loc} 등록 완료`;
      case 'duplicate': return `⚠️ ${r.name} ${loc} 이미 등록됨`;
      case 'full':      return `❌ ${r.name} ${loc} 만석`;
      case 'no_event':  return `❌ ${r.name} ${r.date} 벙 없음`;
      default:          return `? ${r.name} ${r.status}`;
    }
  });
}

module.exports = { assignToSlots, derivePaymentStatus, buildResultMessages, toKST };
