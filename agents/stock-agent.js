/**
 * 종목 에이전트 (Stock Agent)
 * LLM: 불필요 — 네이버 금융 API 숫자 계산만 수행
 * 역할: 현재가 fetch → 방한확정比 / 뉴스기준比 등락률 계산
 */

// 방한확정 기준 2026-05-27 종가
export const BASE_VISIT = {
  '005935': 192040, '005930': 307000, '000660': 224300,
  '066570': 235000, '066575': 81000,  '454910': 103000,
  '034020': 108500, '035420': 198800, '017670': 100400,
  '005380': 681000, '005387': 269500, '005385': 277500,
  '005389': 261500, '000150': 1715000,'000155': 606000,
  '000157': 515000, '336260': 101500, '241560': 68100,
  '034220': 16090,  '131970': 157300,
};

// 뉴스 기준 2026-06-01 종가
export const BASE_NEWS = {
  '005935': 202500, '005930': 317000, '000660': 233300,
  '066570': 293000, '066575': 95700,  '454910': 106500,
  '034020': 105600, '035420': 234000, '017670': 100600,
  '005380': 723000, '005387': 272000, '005385': 274000,
  '005389': 258500, '000150': 1972000,'000155': 659000,
  '000157': 535000, '336260': 91400,  '241560': 64700,
  '034220': 16090,  '131970': 157300,
};

const CODES = Object.keys(BASE_VISIT);

async function fetchNaverPrice(code) {
  const resp = await fetch(`https://m.stock.naver.com/api/stock/${code}/basic`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
      'Referer': 'https://m.stock.naver.com/',
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(6000),
  });
  if (!resp.ok) throw new Error(`${code} HTTP ${resp.status}`);
  return resp.json();
}

/**
 * 현재가 기반 통계적 목표가 레인지 추정
 * 방문 이후 수익률(v)에 따라 레인지 폭 확대 — 모멘텀 ↑ → 변동성 ↑
 * @returns {{ low: number, base: number, high: number }}
 */
function estimatePriceTargetRange(px, v) {
  const absV = Math.abs(v);
  // 모멘텀 구간별 레인지 폭 결정
  let upMult, dnMult;
  if (absV >= 30) { upMult = 0.18; dnMult = 0.14; }       // 고모멘텀 — ±18%/14%
  else if (absV >= 15) { upMult = 0.12; dnMult = 0.10; }  // 중모멘텀 — ±12%/10%
  else if (absV >= 5)  { upMult = 0.08; dnMult = 0.07; }  // 저모멘텀 — ±8%/7%
  else                 { upMult = 0.05; dnMult = 0.05; }  // 기본 — ±5%

  // 방향성 반영: 상승 추세면 상단 더 넓게, 하락 추세면 하단 더 넓게
  const adj = v > 0 ? 1 : -1;
  const base   = Math.round(px / 1000) * 1000;
  const high   = Math.round(px * (1 + upMult + (v > 0 ? adj * absV / 1000 : 0)) / 1000) * 1000;
  const low    = Math.round(px * (1 - dnMult - (v < 0 ? Math.abs(adj) * absV / 1000 : 0)) / 1000) * 1000;
  return { low: Math.max(low, Math.round(px * 0.7 / 1000) * 1000), base, high };
}

/**
 * 모든 종목 현재가 조회 및 등락률 계산
 * @returns {{ ok: boolean, data: Object, count: number, ts: number }}
 */
export async function runStockAgent() {
  const results = await Promise.allSettled(CODES.map(fetchNaverPrice));

  const data = {};
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') return;
    const code = CODES[i];
    const s = r.value;
    const px = parseFloat((s.closePrice || '0').replace(/,/g, ''));
    if (!px) return;
    const v  = BASE_VISIT[code] ? +((px - BASE_VISIT[code]) / BASE_VISIT[code] * 100).toFixed(2) : 0;
    const nw = BASE_NEWS[code]  ? +((px - BASE_NEWS[code])  / BASE_NEWS[code]  * 100).toFixed(2) : 0;
    data[code] = {
      px, v, nw,
      state: s.marketStatus || 'CLOSED',
      ptr: estimatePriceTargetRange(px, v),   // 통계적 목표가 레인지 추정
    };
  });

  const count = Object.keys(data).length;
  return { ok: count > 0, data, count, ts: Date.now() };
}
