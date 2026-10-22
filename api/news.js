// 수능·입시·진로 헤드라인을 Google News RSS에서 모아 중복과 부적절한 기사를 걸러 내려준다.
// 브라우저에서는 CORS 때문에 RSS를 직접 못 읽어서 서버(Vercel 함수)가 대신 가져온다.

const FEEDS = [
  { cat: "수능", q: "수능 when:2d" },
  { cat: "진로", q: "진로 진학 직업 학과 when:7d" },
  { cat: "입시", q: "대입 입시 수시 정시 when:3d" },
];

// 학생들이 보는 화면이라 사건·사고·자극적인 기사는 뺀다. ('사고력'은 허용)
const BLOCK = /사망|숨진|숨져|자살|극단적|유서|살인|성범죄|성폭|성추행|폭행|구속|마약|학폭|학교폭력|사고(?!력)|참변|투신|불법|비리|부정행위/;

// 드라마·영화 홍보나 광고성 콘텐츠도 뺀다.
const NOISE = /티저|포스터|드라마|영화|배우|예능|무료 배포|무료배포|프리미엄|이벤트 당첨|할인/;

const MAX_ITEMS = 12;

function decodeXml(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

function pick(block, tag) {
  const m = block.match(new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">"));
  return m ? decodeXml(m[1]).trim() : "";
}

function parseFeed(xml, cat) {
  const out = [];
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const it of items) {
    let title = pick(it, "title");
    const source = pick(it, "source");
    const pub = new Date(pick(it, "pubDate"));
    if (source && title.endsWith(" - " + source)) {
      title = title.slice(0, -(source.length + 3));
    }
    title = title.replace(/\s+/g, " ").trim();
    if (title.length < 8 || isNaN(pub.getTime())) continue;
    if (BLOCK.test(title) || NOISE.test(title) || NOISE.test(source)) continue;
    out.push({ title, source, cat, pub: pub.getTime() });
  }
  return out;
}

function bigrams(s) {
  const t = s.replace(/[^가-힣a-zA-Z0-9]/g, "");
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}

function similar(a, b) {
  if (!a.size || !b.size) return false;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter) > 0.45;
}

async function fetchFeed(feed) {
  const url =
    "https://news.google.com/rss/search?hl=ko&gl=KR&ceid=KR:ko&q=" + encodeURIComponent(feed.q);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return [];
    return parseFeed(await res.text(), feed.cat);
  } catch (e) {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=3600");

  const lists = await Promise.all(FEEDS.map(fetchFeed));

  // 같은 기사가 여러 매체에 실리므로 카테고리 순서대로 훑으며 비슷한 제목은 버린다.
  const seen = [];
  const byCat = lists.map((list) => {
    list.sort((a, b) => b.pub - a.pub);
    const kept = [];
    for (const item of list) {
      const bg = bigrams(item.title);
      if (seen.some((s) => similar(s, bg))) continue;
      seen.push(bg);
      kept.push(item);
    }
    return kept;
  });

  // 수능·진로·입시를 번갈아 섞어서 한쪽 주제로 쏠리지 않게 한다.
  const items = [];
  for (let i = 0; items.length < MAX_ITEMS; i++) {
    let added = false;
    for (const list of byCat) {
      if (list[i] && items.length < MAX_ITEMS) {
        items.push({
          title: list[i].title,
          source: list[i].source,
          cat: list[i].cat,
          pub: new Date(list[i].pub).toISOString(),
        });
        added = true;
      }
    }
    if (!added) break;
  }

  res.status(200).json({ updated: new Date().toISOString(), items });
};
