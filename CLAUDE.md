# Bung Tracker — 백엔드 API 문서

배드민턴 벙(모임) 참석자 등록 및 입금 관리 서버.

## 기술 스택

- **Runtime**: Node.js + Express
- **DB**: Supabase (PostgreSQL)
- **인증**: `x-admin-key` 헤더 (관리자 전용 엔드포인트)

## 서버 정보

- 기본 포트: `3000`
- Base URL (로컬): `http://localhost:3000`

## 인증

관리자 전용 API는 요청 헤더에 아래를 포함해야 합니다.

```
x-admin-key: <ADMIN_KEY>
```

## 데이터 모델

### events (벙)

| 필드              | 타입        | 설명                         |
| ----------------- | ----------- | ---------------------------- |
| id                | integer     | PK                           |
| event_date        | date        | 벙 날짜 (YYYY-MM-DD, unique) |
| amount_per_person | integer     | 1인당 참가비 (원)            |
| created_at        | timestamptz | 생성 시각                    |

### event_slots (타임슬롯)

| 필드      | 타입    | 설명                             |
| --------- | ------- | -------------------------------- |
| id        | integer | PK                               |
| event_id  | integer | FK → events.id                   |
| slot_time | varchar | 시작 시각 (예: "10:30", "12:00") |
| capacity  | integer | 정원                             |

### attendees (참석자)

| 필드          | 타입        | 설명                        |
| ------------- | ----------- | --------------------------- |
| id            | integer     | PK                          |
| event_slot_id | integer     | FK → event_slots.id         |
| name          | text        | 참석자 이름                 |
| payment_id    | integer     | FK → payments.id (nullable) |
| registered_at | timestamptz | 등록 시각                   |

### payments (입금 내역)

| 필드         | 타입        | 설명                                             |
| ------------ | ----------- | ------------------------------------------------ |
| id           | integer     | PK                                               |
| raw_content  | text        | Tasker에서 수신한 원본 문자열                    |
| amount       | integer     | 입금액 (원)                                      |
| parsed_names | text[]      | 파싱된 이름 목록                                 |
| parsed_dates | text[]      | 파싱된 날짜 목록                                 |
| status       | enum        | `pending` \| `assigned` \| `partial` \| `failed` |
| fail_reason  | text        | 실패 사유 (nullable)                             |
| created_at   | timestamptz | 수신 시각                                        |

**payment status 의미**

- `pending`: 처리 중
- `assigned`: 전원 배정 완료
- `partial`: 일부만 배정됨 (만석 등)
- `failed`: 파싱 실패·금액 불일치·벙 없음 등

---

## API 엔드포인트

### 벙 조회 (공개)

#### `GET /events`

전체 벙 목록 (슬롯 현황 포함, 참석자 이름 미포함)

**응답**

```json
{
  "success": true,
  "events": [
    {
      "id": 1,
      "event_date": "2026-04-17",
      "amount_per_person": 1500,
      "created_at": "2026-04-14 10:00:00",
      "slots": [
        { "slot_time": "10:30", "capacity": 10, "count": 7, "remaining": 3 },
        { "slot_time": "12:00", "capacity": 10, "count": 2, "remaining": 8 }
      ]
    }
  ]
}
```

#### `GET /events/:date`

특정 날짜 벙 상세 (슬롯별 참석자 이름 포함)

**파라미터**: `date` — YYYY-MM-DD

**응답**

```json
{
  "event_date": "2026-04-17",
  "amount_per_person": 1500,
  "total_attendees": 9,
  "slots": [
    {
      "slot_time": "10:30",
      "capacity": 10,
      "count": 7,
      "remaining": 3,
      "attendees": [
        { "name": "홍길동", "registered_at": "2026-04-14 09:00:00" }
      ]
    }
  ]
}
```

---

### 벙 관리 (관리자)

#### `POST /events`

벙 생성

**Body**

```json
{
  "event_date": "2026-04-17",
  "amount_per_person": 1500,
  "slots": [
    { "slot_time": "10:30", "capacity": 10 },
    { "slot_time": "12:00", "capacity": 10 }
  ]
}
```

**응답** `201`

````json
{
  "success": true,
  "message": "벙이 생성되었습니다.",
  "event": { "id": 1, "event_date": "2026-04-17", "amount_per_person": 1500, "slots": [...] }
}
```f

**에러**

- `400` — 필드 누락 또는 날짜 형식 오류
- `409` — 해당 날짜에 벙이 이미 존재

#### `PATCH /events/:date`

벙 수정 (참가비, 슬롯 정원 변경 / 슬롯 추가·삭제)

**Body** (모두 선택, 하나 이상 필요)

```json
{
  "amount_per_person": 2000,
  "slots": [
    { "slot_time": "10:30", "capacity": 12 },
    { "slot_time": "14:00", "capacity": 10 }
  ],
  "delete_slots": ["12:00"]
}
```

- `slots`: 기존 슬롯이면 정원 변경, 없는 슬롯이면 새로 추가
- `delete_slots`: 해당 슬롯 삭제 — 참석자가 있으면 `409` 반환

**응답** `200`

```json
{
  "success": true,
  "message": "2026-04-17 벙이 수정되었습니다.",
  "event": { "id": 1, "event_date": "2026-04-17", "amount_per_person": 2000, "slots": [...] }
}
```

**에러**

- `400` — 수정 필드 없음
- `404` — 벙 없음 또는 슬롯 없음
- `409` — 삭제하려는 슬롯에 참석자 존재

#### `DELETE /events/:date`

벙 삭제 (슬롯·참석자 cascade 삭제)

**응답** `200`

```json
{ "success": true, "message": "2026-04-17 벙이 삭제되었습니다." }
```

---

### 참석자 직접 관리 (관리자)

#### `POST /events/:date/attendees`

특정 벙에 참석자 직접 추가

**Body**

```json
{
  "names": ["홍길동", "김철수"],
  "slot_time": "10:30"
}
```

- `slot_time` 생략 시 빈 슬롯 자동 배정
- `slot_time` 지정 시 정원 초과도 허용 (관리자 권한)

**응답** `201`

```json
{
  "success": true,
  "message": "✅ 홍길동 10:30 등록 완료\n✅ 김철수 10:30 등록 완료",
  "results": [
    { "name": "홍길동", "status": "ok", "slot_time": "10:30" },
    { "name": "김철수", "status": "ok", "slot_time": "10:30" }
  ]
}
```

**result status 값**

- `ok`: 신규 등록 성공
- `duplicate`: 이미 등록됨
- `full`: 빈 슬롯 없음 (자동 배정 시)

#### `DELETE /events/:date/attendees/:name`

특정 참석자 제거 (`name`은 URL 인코딩)

**응답** `200`

```json
{
  "success": true,
  "message": "홍길동님의 2026-04-17 벙 등록이 취소되었습니다."
}
```

---

### 입금 처리

#### `POST /payment`

토스 입금 알림 전문 수신. 파싱·검증·슬롯 배정을 자동으로 처리하며 모든 수신 내역을 payments에 기록한다.

**Body**

```json
{ "content": "1500원 입금 길동 17 -> 모임통장(1248)" }
```

---

#### content 파싱 규칙

토스 알림 형식: `{amount}원 입금 {name} {day} -> 모임통장(NNNN)`

- `amount`: 콤마 포함 숫자 (예: `1,500` → `1500`)
- `name`: 입금자 이름
- `day`: 이번 달 일자 (1~31), 올해 연도·현재 월 자동 적용

**파싱 예시**

| content | names | dates |
|---------|-------|-------|
| `홍길동 0417` | `["홍길동"]` | `["2026-04-17"]` |
| `홍길동 김철수 0417` | `["홍길동", "김철수"]` | `["2026-04-17"]` |
| `1500원 입금 길동 17 -> 모임통장(1248)` | `["길동"]` | `["2026-04-17"]` | `1500` |
| `1,500원 입금 홍길동 17 -> 모임통장(1248)` | `["홍길동"]` | `["2026-04-17"]` | `1500` |

**파싱 실패 케이스**

- 형식이 맞지 않음 → `status: failed`, `422` 반환

---

**금액 검증**

`amount` = `각 날짜별 amount_per_person` × `이름 수` 합산과 일치해야 함.

예: 홍길동·김철수 / 0417(1500원) → `1500 × 2 = 3000원`

불일치 시 `status: failed`, `400` 반환.

---

**처리 흐름**

```
수신
 └─ 파싱 실패?          → payments(failed) 저장 후 422
 └─ pending 저장
 └─ 벙 존재 확인        → 없으면 failed 업데이트 후 400
 └─ 금액 검증           → 불일치면 failed 업데이트 후 400
 └─ 슬롯 배정
     ├─ 전원 성공        → assigned
     ├─ 일부 성공        → partial
     └─ 전원 실패        → failed
```

**payment status 전이**

| 상태 | 의미 |
|------|------|
| `pending` | 처리 시작 직후 |
| `assigned` | names × dates 전원 배정 완료 |
| `partial` | 일부만 배정 (만석 등) |
| `failed` | 파싱 실패·금액 불일치·벙 없음·전원 만석 |

**응답** `201` (성공)

```json
{
  "success": true,
  "payment_id": 5,
  "message": "✅ 홍길동 2026-04-17 10:30 등록 완료\n✅ 김철수 2026-04-17 10:30 등록 완료",
  "results": [
    {
      "name": "홍길동",
      "date": "2026-04-17",
      "status": "ok",
      "slot_time": "10:30"
    }
  ]
}
```

**응답** `422` (파싱 실패)

```json
{
  "success": false,
  "payment_id": 3,
  "message": "파싱 실패: 날짜을 찾을 수 없습니다. 관리자가 수동 배정할 수 있습니다."
}
```

---

### 입금 내역 관리 (관리자)

#### `GET /payments`

입금 내역 목록

**Query**

- `status` — `pending` | `assigned` | `partial` | `failed` (생략 시 전체)
- `limit` — 기본 50
- `offset` — 기본 0

**응답**

```json
{
  "total": 42,
  "limit": 50,
  "offset": 0,
  "payments": [
    {
      "id": 3,
      "raw_content": "홍길동사월십칠일",
      "amount": 1500,
      "parsed_names": null,
      "parsed_dates": null,
      "status": "failed",
      "fail_reason": "파싱 실패 — 날짜을 찾을 수 없습니다.",
      "created_at": "2026-04-14 09:30:00"
    }
  ]
}
```

#### `POST /payments/:id/assign`

파싱 실패·금액 불일치 등 미배정 입금을 관리자가 수동으로 배정.
`names × dates` 전체 조합을 배정하며 이미 배정된 조합은 건너뛴다.

**Body**

```json
{
  "names": ["홍길동", "김철수"],
  "dates": ["2026-04-17", "2026-04-24"]
}
```

**응답**

```json
{
  "success": true,
  "payment_id": 3,
  "message": "✅ 홍길동 2026-04-17 10:30 등록 완료\n...",
  "results": [...]
}
```

**에러**

- `404` — payment를 찾을 수 없음
- `409` — 이미 완전히 배정된 입금
- `400` — 금액 불일치 또는 벙 없음

---

## 공통 에러 응답

```json
{ "success": false, "message": "오류 설명" }
```

| 상태 코드 | 의미                                               |
| --------- | -------------------------------------------------- |
| `400`     | 잘못된 요청 (필드 누락, 형식 오류, 금액 불일치 등) |
| `403`     | 관리자 인증 실패                                   |
| `404`     | 리소스를 찾을 수 없음                              |
| `409`     | 중복 또는 충돌                                     |
| `422`     | 파싱 실패                                          |
| `500`     | 서버 내부 오류                                     |

## 프로젝트 구조

```
bung-tracker/
├── server.js           # 앱 진입점
├── parseContent.js     # 입금 문자열 파서
├── lib/
│   ├── supabase.js     # Supabase 클라이언트
│   ├── middleware.js   # requireAdmin 미들웨어
│   └── slots.js        # 슬롯 배정 로직
└── routes/
    ├── events.js       # 벙·참석자 라우터
    └── payments.js     # 입금 라우터
```
