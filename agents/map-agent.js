/**
 * 지도 에이전트 (Map Agent)
 * LLM: 사용 (Phase 3 예정) — 뉴스에서 장소 자동 추출
 * 현재: events.json에서 지도/타임라인 데이터 읽기만 수행
 * 역할: events.json → ROUTE / MAP_EXTRAS / MAP_PINS 생성
 */

/**
 * events.json → 타임라인용 ROUTE 배열 변환
 * @param {Array} events - events.json의 events 배열
 * @returns {Array} index.html buildTL() 호환 ROUTE 배열
 */
export function buildRoute(events) {
  return events
    .filter(e => e.views?.timeline && e.location)
    .sort((a, b) => (a.timeline_order || 99) - (b.timeline_order || 99))
    .map(e => ({
      n: String(e.timeline_order),
      d: e.datetime_display,
      b: e.timeline_badge || null,
      pl: e.location.name,
      ds: e.description,
      lng: e.location.lng,
      lat: e.location.lat,
      pin: e.map_pin || { label: e.location.name, pct: null },
      src: e.sources?.[0] ? {
        m: e.sources[0].publisher,
        t: e.sources[0].title,
        u: e.sources[0].url,
      } : undefined,
    }));
}

/**
 * events.json → 지도 전용 핀(MAP_EXTRAS) 배열 변환
 * @param {Array} events - events.json의 events 배열
 * @returns {Array} index.html buildMap() 호환 MAP_EXTRAS 배열
 */
export function buildMapExtras(events) {
  return events
    .filter(e => e.views?.map_only && e.location?.lat)
    .map(e => ({
      label: e.location.name,
      lng: e.location.lng,
      lat: e.location.lat,
      pct: e.map_pin?.pct || null,
    }));
}

/**
 * 지도 에이전트 통합 실행
 * @param {Array} events
 * @returns {{ route: Array, mapExtras: Array }}
 */
export function runMapAgent(events) {
  return {
    route: buildRoute(events),
    mapExtras: buildMapExtras(events),
  };
}
