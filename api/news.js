// 수능·입시·진로 헤드라인을 모아 중복과 부적절한 기사를 걸러 내려준다.
// 브라우저에서는 CORS 때문에 RSS를 직접 못 읽어서 서버(Vercel 함수)가 대신 가져온다.
// 기본 소스는 Bing News RSS(기사 원문 주소를 바로 준다), 기사가 모자라면 Google News RSS로 보충한다.

const BING_QUERIES = [
  { cat: "수능", q: "수능 입시" },
  { cat: "진로", q: "진로 진학 직업 학과" },
  { cat: "입시", q: "대입 수시 정시" },
  { cat: "수능", q: "고3 수험생" },
];

const GOOGLE_QUERIES = [
  { cat: "수능", q: "수능 when:2d" },
  { cat: "진로", q: "진로 진학 직업 학과 when:7d" },
  { cat: "입시", q: "대입 입시 수시 정시 when:3d" },
];

// 학생들이 보는 화면이라 사건·사고·자극적인 기사는 뺀다. ('사고력'은 허용)
const BLOCK = /사망|숨진|숨져|자살|극단적|유서|살인|성범죄|성폭|성추행|폭행|구속|마약|학폭|학교폭력|사고(?!력)|참변|투신|불법|비리|부정행위/;

// 영화·드라마 홍보나 광고성 콘텐츠도 뺀다. (영화 '수능, 출제의 비밀' 기사가 수능 검색에 많이 섞인다)
const NOISE = /티저|포스터|드라마|영화|배우|예능|연예|TV리포트|스포츠|시사회|개봉|출제의 비밀|무료 배포|무료배포|프리미엄|이벤트 당첨|할인/;

const MAX_ITEMS = 12;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_BING_ITEMS = 6;

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

// Bing의 클릭 추적 주소(apiclick.aspx?...&url=원문)에서 원문 주소만 꺼낸다.
function bingRealUrl(link) {
  try {
    return new URL(link).searchParams.get("url") || "";
  } catch (e) {
    return "";
  }
}

function safeUrl(u) {
  return /^https?:\/\//.test(u) ? u : "";
}

function accept(item) {
  if (item.title.length < 8) return false;
  if (isNaN(item.pub) || Date.now() - item.pub > MAX_AGE_MS || item.pub - Date.now() > 86400000) return false;
  return !(BLOCK.test(item.title) || NOISE.test(item.title) || NOISE.test(item.source));
}

function parseBing(xml, cat) {
  const out = [];
  for (const it of xml.match(/<item>[\s\S]*?<\/item>/g) || []) {
    const title = pick(it, "title").replace(/\s+/g, " ").trim();
    const source = pick(it, "News:Source").replace(/ on MSN$/, "");
    const link = safeUrl(bingRealUrl(pick(it, "link")));
    const item = { title, source, link, cat, pub: new Date(pick(it, "pubDate")).getTime() };
    if (accept(item)) out.push(item);
  }
  return out;
}

function parseGoogle(xml, cat) {
  const out = [];
  for (const it of xml.match(/<item>[\s\S]*?<\/item>/g) || []) {
    let title = pick(it, "title");
    const source = pick(it, "source");
    if (source && title.endsWith(" - " + source)) title = title.slice(0, -(source.length + 3));
    title = title.replace(/\s+/g, " ").trim();
    const item = { title, source, link: safeUrl(pick(it, "link")), cat, pub: new Date(pick(it, "pubDate")).getTime() };
    if (accept(item)) out.push(item);
  }
  return out;
}

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0" } });
    return res.ok ? await res.text() : "";
  } catch (e) {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

const fetchBing = async (f) =>
  parseBing(
    await fetchText(
      "https://www.bing.com/news/search?format=rss&setmkt=ko-KR&setlang=ko&q=" + encodeURIComponent(f.q)
    ),
    f.cat
  );

const fetchGoogle = async (f) =>
  parseGoogle(
    await fetchText("https://news.google.com/rss/search?hl=ko&gl=KR&ceid=KR:ko&q=" + encodeURIComponent(f.q)),
    f.cat
  );

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

// 같은 기사가 여러 매체에 실리므로 비슷한 제목은 버리고, 목록마다 최신순으로 정리한다.
function dedupe(lists) {
  const seen = [];
  return lists.map((list) => {
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
}

// 주제별 목록을 번갈아 섞어서 한쪽 주제로 쏠리지 않게 한다.
function interleave(byCat) {
  const items = [];
  for (let i = 0; items.length < MAX_ITEMS; i++) {
    let added = false;
    for (const list of byCat) {
      if (list[i] && items.length < MAX_ITEMS) {
        const x = list[i];
        items.push({ title: x.title, source: x.source, link: x.link, cat: x.cat, pub: new Date(x.pub).toISOString() });
        added = true;
      }
    }
    if (!added) break;
  }
  return items;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=3600");

  let lists = await Promise.all(BING_QUERIES.map(fetchBing));
  let total = lists.reduce((n, l) => n + l.length, 0);

  if (total < MIN_BING_ITEMS) {
    lists = lists.concat(await Promise.all(GOOGLE_QUERIES.map(fetchGoogle)));
  }

  const items = interleave(dedupe(lists));
  res.status(200).json({ updated: new Date().toISOString(), items });
};
