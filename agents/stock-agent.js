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

// ── 글로벌 종목 + ETF (Yahoo Finance) ──────────────────
// type: stock | etf | etf-lev(레버리지ETF)
// country: US·KR·TW·JP (거래소 소재지)
// base: 2026-05-27 종가 기준 (방한확정比 계산용, 0이면 당일 등락만 표시)
export const GLOBAL_TICKERS = [
  // ── NVIDIA (항상 표시) ──
  { code:'NVDA',      name:'NVIDIA',                 exchange:'NASDAQ', country:'US', type:'stock',   base:110.50 },
  // ── 미국 반도체/AI ETF ──
  { code:'SMH',       name:'VanEck Semiconductor',   exchange:'NASDAQ', country:'US', type:'etf',     base:213.20 },
  { code:'SOXX',      name:'iShares Semiconductor',  exchange:'NASDAQ', country:'US', type:'etf',     base:218.40 },
  { code:'SOXL',      name:'3x Semicon Bull (레버리지)',exchange:'NYSE', country:'US', type:'etf-lev', base:42.10  },
  { code:'NVDL',      name:'2x NVIDIA (레버리지)',    exchange:'NYSE',   country:'US', type:'etf-lev', base:22.50  },
  { code:'BOTZ',      name:'로보틱스·AI ETF',         exchange:'NASDAQ', country:'US', type:'etf',     base:28.30  },
  { code:'AIQ',       name:'AI & Big Data ETF',       exchange:'NYSE',   country:'US', type:'etf',     base:34.60  },
  { code:'QQQ',       name:'Nasdaq-100 ETF',          exchange:'NASDAQ', country:'US', type:'etf',     base:465.20 },
  // ── 미국 관련주 (파트너사) ──
  { code:'TSM',       name:'TSMC',                   exchange:'NYSE',   country:'TW', type:'stock',   base:178.40 },
  { code:'MSFT',      name:'Microsoft',               exchange:'NASDAQ', country:'US', type:'stock',   base:420.80 },
  { code:'AAPL',      name:'Apple',                   exchange:'NASDAQ', country:'US', type:'stock',   base:207.30 },
  { code:'AVGO',      name:'Broadcom',                exchange:'NASDAQ', country:'US', type:'stock',   base:184.20 },
  { code:'AMD',       name:'AMD',                     exchange:'NASDAQ', country:'US', type:'stock',   base:118.60 },
  // ── 한국 ETF ──
  { code:'091160.KS', name:'KODEX 반도체',            exchange:'KRX',    country:'KR', type:'etf',     base:33800  },
  { code:'452990.KS', name:'TIGER AI반도체핵심장비',  exchange:'KRX',    country:'KR', type:'etf',     base:14950  },
  { code:'379800.KS', name:'KODEX 미국S&P500',       exchange:'KRX',    country:'KR', type:'etf',     base:15420  },
];

// Yahoo Finance 가격 조회
async function fetchYahooPrice(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    signal: AbortSignal.timeout(7000),
  });
  if (!resp.ok) throw new Error(`${symbol} HTTP ${resp.status}`);
  const data = await resp.json();
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta || !meta.regularMarketPrice) throw new Error('no price');
  return {
    px:         meta.regularMarketPrice,
    dayChange:  +(meta.regularMarketChangePercent || 0).toFixed(2),
    currency:   meta.currency || 'USD',
    marketState: meta.marketState || 'CLOSED',
  };
}

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
 * 네이버 frgn.naver에서 외국인/기관 순매수 파싱
 * 행 구조: 날짜|종가|방향|등락폭|등락률|거래량|외국인순매수|기관순매수|외국인보유주수|외국인보유비율
 * @returns {{ frgn: number, inst: number, vol: number, frgnRatio: number } | null}
 */
async function fetchNaverInvestor(code) {
  try {
    const resp = await fetch(`https://finance.naver.com/item/frgn.naver?code=${code}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Referer': 'https://finance.naver.com/',
      },
      signal: AbortSignal.timeout(7000),
    });
    if (!resp.ok) return null;

    const buf = await resp.arrayBuffer();
    const text = new TextDecoder('euc-kr').decode(buf);

    // <tr> 행에서 날짜 패턴(YYYY.MM.DD) 포함 첫 번째 행 = 최신 데이터
    const rows = text.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || [];
    for (const row of rows) {
      const plain = row.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, '0').replace(/\s+/g, ' ').trim();
      if (!/^\d{4}\.\d{2}\.\d{2}/.test(plain)) continue;

      const parts = plain.split(/\s+/);
      // parts: [날짜, 종가, 방향, 등락폭, 등락률, 거래량, 외국인순매수, 기관순매수, 외국인보유주수, 외국인보유비율]
      const toNum = s => parseInt((s || '0').replace(/[+,]/g, ''), 10) || 0;
      const toFloat = s => parseFloat((s || '0').replace('%', '')) || 0;

      return {
        frgn: toNum(parts[6]),       // 외국인 순매수 (주)
        inst: toNum(parts[7]),       // 기관 순매수 (주)
        vol:  toNum(parts[5]),       // 거래량
        frgnRatio: toFloat(parts[9]), // 외국인 보유비율 (%)
      };
    }
    return null;
  } catch {
    return null;
  }
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
  const [priceResults, investorResults, globalResults] = await Promise.all([
    Promise.allSettled(CODES.map(fetchNaverPrice)),
    Promise.allSettled(CODES.map(fetchNaverInvestor)),
    Promise.allSettled(GLOBAL_TICKERS.map(t => fetchYahooPrice(t.code))),
  ]);

  const data = {};

  // ── 한국 종목 (Naver) ──
  priceResults.forEach((r, i) => {
    if (r.status !== 'fulfilled') return;
    const code = CODES[i];
    const s = r.value;
    const px = parseFloat((s.closePrice || '0').replace(/,/g, ''));
    if (!px) return;
    const v  = BASE_VISIT[code] ? +((px - BASE_VISIT[code]) / BASE_VISIT[code] * 100).toFixed(2) : 0;
    const nw = BASE_NEWS[code]  ? +((px - BASE_NEWS[code])  / BASE_NEWS[code]  * 100).toFixed(2) : 0;
    const inv = investorResults[i]?.value || null;
    data[code] = {
      px, v, nw,
      currency: 'KRW', exchange: 'KRX', country: 'KR', type: 'stock',
      state: s.marketStatus || 'CLOSED',
      ptr: estimatePriceTargetRange(px, v),
      vol:       inv?.vol        ?? null,
      frgn:      inv?.frgn       ?? null,
      inst:      inv?.inst       ?? null,
      frgnRatio: inv?.frgnRatio  ?? null,
    };
  });

  // ── 글로벌 종목 + ETF (Yahoo Finance) ──
  globalResults.forEach((r, i) => {
    if (r.status !== 'fulfilled') return;
    const meta = GLOBAL_TICKERS[i];
    const { px, dayChange, currency, marketState } = r.value;
    const v = meta.base > 0 ? +((px - meta.base) / meta.base * 100).toFixed(2) : dayChange;
    data[meta.code] = {
      px, v, nw: dayChange,
      currency, exchange: meta.exchange, country: meta.country, type: meta.type,
      name: meta.name,
      state: marketState,
      ptr: null, vol: null, frgn: null, inst: null, frgnRatio: null,
    };
  });

  const count = Object.keys(data).length;
  console.log(`[stock-agent] 한국 ${CODES.length}개 + 글로벌 ${GLOBAL_TICKERS.length}개 → 성공 ${count}개`);
  return { ok: count > 0, data, count, ts: Date.now() };
}
