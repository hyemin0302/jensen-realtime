// 젠슨 황 관련 뉴스 RSS 수집 배치 스크립트
// GitHub Actions에서 2시간마다 실행됨 (Node.js 20 built-in fetch 사용)
const fs = require('fs');
const path = require('path');

const FEEDS = [
  { url: 'https://www.yna.co.kr/rss/economy.xml',        src: '연합뉴스' },
  { url: 'https://www.hankyung.com/feed/all-news',        src: '한국경제' },
  { url: 'https://www.newsis.com/rss/realnews.xml',       src: '뉴시스'  },
  { url: 'https://rss.mt.co.kr/mt/mt.xml',               src: '머니투데이' },
  { url: 'https://biz.chosun.com/site/data/rss/rss.xml', src: '조선비즈' },
  { url: 'https://www.mk.co.kr/rss/30000001/',            src: '매일경제' },
  { url: 'https://n.news.naver.com/rss/news.xml',        src: '네이버뉴스' },
];

const KEYWORDS = [
  '젠슨황', '젠슨 황', 'Jensen Huang',
  '엔비디아 방한', 'NVIDIA 방한', '엔비디아 CEO',
  '젠슨황 방한', '젠슨 황 방한', '젠슨황 한국',
];

// 관련주 키워드 매핑
const STOCK_MAP = {
  '삼성전자': ['005930','005935'],  'Samsung': ['005930','005935'],
  'SK하이닉스': ['000660'],         'SK hynix': ['000660'],
  'LG전자': ['066570','066575'],    'LG Electronics': ['066570'],
  '네이버': ['035420'],             'Naver': ['035420'],
  '현대차': ['005380'],             'Hyundai': ['005380'],
  '두산로보틱스': ['454910'],        'Doosan Robotics': ['454910'],
  '두산': ['000150','454910'],      'Doosan': ['000150'],
  'SK텔레콤': ['017670'],           'SKT': ['017670'],
};

function extractTag(xml, tag) {
  const cdataRe = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i');
  const plainRe  = new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i');
  return (xml.match(cdataRe) || xml.match(plainRe) || [])[1]?.trim() || '';
}

function parseRSS(xml, src) {
  const items = [];
  const re = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const b    = m[1];
    const title = extractTag(b, 'title');
    const link  = extractTag(b, 'link') || extractTag(b, 'guid');
    const desc  = extractTag(b, 'description').replace(/<[^>]+>/g, '').slice(0, 200);
    const date  = extractTag(b, 'pubDate');
    if (!title) continue;
    const text = title + ' ' + desc;
    if (!KEYWORDS.some(kw => text.includes(kw))) continue;

    // 관련주 추출
    const stocks = new Set();
    for (const [kw, codes] of Object.entries(STOCK_MAP)) {
      if (text.includes(kw)) codes.forEach(c => stocks.add(c));
    }

    items.push({
      s:  src,
      t:  title,
      d:  desc,
      u:  link,
      m:  date ? new Date(date).toLocaleString('ko-KR', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }) : '',
      ts: date ? new Date(date).getTime() : 0,
      stocks: [...stocks],
    });
  }
  return items;
}

async function main() {
  console.log(`[${new Date().toISOString()}] 뉴스 수집 시작`);
  const all = [];

  for (const { url, src } of FEEDS) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) { console.log(`  SKIP ${src}: HTTP ${res.status}`); continue; }
      const xml = await res.text();
      const items = parseRSS(xml, src);
      console.log(`  ${src}: ${items.length}개`);
      all.push(...items);
    } catch (e) {
      console.log(`  ERROR ${src}: ${e.message}`);
    }
  }

  // 중복 제거 (제목 앞 25자 기준)
  const seen = new Set();
  const unique = all.filter(item => {
    const key = item.t.slice(0, 25);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => b.ts - a.ts).slice(0, 60);

  const out = {
    updatedAt: new Date().toISOString(),
    count: unique.length,
    items: unique,
  };

  const dir = path.join(process.cwd(), 'public');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'news-live.json'), JSON.stringify(out, null, 2));
  console.log(`완료: ${unique.length}개 저장 → public/news-live.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
