// 방한확정 기준 2026-05-27 종가 (역산값, 고정)
const BASE_VISIT = {
  '005935': 192040,  '005930': 307000,  '000660': 224300,
  '066570': 235000,  '066575': 81000,   '454910': 103000,
  '034020': 108500,  '035420': 198800,  '017670': 100400,
  '005380': 681000,  '005387': 269500,  '005385': 277500,
  '005389': 261500,  '000150': 1715000, '000155': 606000,
  '000157': 515000,  '336260': 101500,  '241560': 68100,
  '034220': 16090,   '131970': 157300,
};
// 뉴스 기준 2026-06-01 종가 (역산값, 고정)
const BASE_NEWS = {
  '005935': 202500,  '005930': 317000,  '000660': 233300,
  '066570': 293000,  '066575': 95700,   '454910': 106500,
  '034020': 105600,  '035420': 234000,  '017670': 100600,
  '005380': 723000,  '005387': 272000,  '005385': 274000,
  '005389': 258500,  '000150': 1972000, '000155': 659000,
  '000157': 535000,  '336260': 91400,   '241560': 64700,
  '034220': 16090,   '131970': 157300,
};

const TICKERS = Object.keys(BASE_VISIT).map(c => c + '.KS').join(',');

export default async function handler(req, res) {
  try {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${TICKERS}&lang=ko-KR&region=KR`;
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://finance.yahoo.com/',
      },
    });
    if (!resp.ok) throw new Error(`Yahoo ${resp.status}`);

    const json = await resp.json();
    const quotes = json.quoteResponse?.result || [];
    if (!quotes.length) throw new Error('empty response');

    const data = {};
    quotes.forEach(q => {
      const code = q.symbol.replace('.KS', '');
      const px = q.regularMarketPrice || 0;
      data[code] = {
        px,
        v: BASE_VISIT[code] ? +((px - BASE_VISIT[code]) / BASE_VISIT[code] * 100).toFixed(2) : 0,
        nw: BASE_NEWS[code]  ? +((px - BASE_NEWS[code])  / BASE_NEWS[code]  * 100).toFixed(2) : 0,
        state: q.marketState || 'CLOSED',
      };
    });

    res.setHeader('Cache-Control', 's-maxage=180, stale-while-revalidate=60');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json({ ok: true, data, ts: Date.now(), count: quotes.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
