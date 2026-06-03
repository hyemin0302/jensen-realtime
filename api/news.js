// RSS 피드에서 젠슨 황 관련 뉴스 수집
const FEEDS = [
  { url: 'https://www.yna.co.kr/rss/economy.xml',       src: '연합뉴스' },
  { url: 'https://www.hankyung.com/feed/all-news',       src: '한국경제' },
  { url: 'https://www.newsis.com/rss/realnews.xml',      src: '뉴시스'  },
  { url: 'https://rss.mt.co.kr/mt/mt.xml',              src: '머니투데이' },
  { url: 'https://biz.chosun.com/site/data/rss/rss.xml', src: '조선비즈' },
];

const KEYWORDS = ['젠슨황', '젠슨 황', 'Jensen Huang', '엔비디아 방한', 'NVIDIA 방한'];

function extract(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}

function parseRSS(xml, src) {
  const items = [];
  const re = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const title   = extract(block, 'title');
    const link    = extract(block, 'link') || extract(block, 'guid');
    const pubDate = extract(block, 'pubDate');
    if (!title) continue;
    if (!KEYWORDS.some(kw => title.includes(kw))) continue;
    items.push({ s: src, t: title, u: link, m: pubDate ? new Date(pubDate).toLocaleString('ko-KR', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }) : '' });
  }
  return items;
}

export default async function handler(req, res) {
  try {
    const results = await Promise.allSettled(
      FEEDS.map(({ url, src }) =>
        fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/rss+xml, application/xml, text/xml' },
          signal: AbortSignal.timeout(6000),
        })
          .then(r => r.ok ? r.text() : '')
          .then(xml => xml ? parseRSS(xml, src) : [])
          .catch(() => [])
      )
    );

    const all = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
    // 중복 제거 (제목 기준)
    const seen = new Set();
    const unique = all.filter(item => {
      const key = item.t.slice(0, 30);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json({ ok: true, items: unique.slice(0, 40), ts: Date.now() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
