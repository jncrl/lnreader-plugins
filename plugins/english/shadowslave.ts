import { CheerioAPI, load as parseHTML } from 'cheerio';
import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin'; // older repo versions: '@typings/plugin'
import { NovelStatus } from '@libs/novelStatus';
import { defaultCover } from '@libs/defaultCover';

// Primary source: telegra.ph volume index -> volume pages -> chapter pages.
const INDEX_PATH = '/List-of-all-volumes-01-08';
const NOVEL_NAME = 'Shadow Slave';

// Matches "Chapter 123: Title" and the bare "123 : Title" style.
const CHAPTER_RE = /^(?:Chapter\s*)?(\d+)/;

// Secondary source: one rentry page per chapter at rentry.co/<number>ss.
// Used only for chapter numbers beyond the last one Telegraph lists.
const RENTRY = 'https://rentry.co';
const MIN_RENTRY_CHARS = 500; // less body text than this = placeholder
const RENTRY_BATCH = 8; // pages probed in parallel
const RENTRY_MAX_BATCHES = 40; // safety cap: 320 chapters per refresh

type Link = { title: string; path: string };

class ShadowSlave implements Plugin.PluginBase {
  id = 'shadowslave-telegraph';
  name = 'Shadow Slave (Telegraph/Rentry)';
  icon = 'src/en/shadowslave/icon.png';
  site = 'https://telegra.ph';
  version = '1.1.1';

  private isRentry(path: string): boolean {
    return path.startsWith(RENTRY);
  }

  private url(path: string): string {
    return path.startsWith('http') ? path : this.site + path;
  }

  private toPath(href: string): string {
    return href.startsWith(this.site) ? href.slice(this.site.length) : href;
  }

  private async load(path: string): Promise<CheerioAPI> {
    const body = await fetchApi(this.url(path)).then(r => r.text());
    return parseHTML(body);
  }

  private collectLinks($: CheerioAPI, test: (text: string) => boolean): Link[] {
    const out: Link[] = [];
    $('article a').each((_, el) => {
      const a = $(el);
      const text = a.text().trim();
      const href = a.attr('href');
      if (href && test(text)) {
        out.push({ title: text, path: this.toPath(href) });
      }
    });
    return out;
  }

  // Returns the chapter if rentry.co/<num>ss exists, otherwise null.
  private async fetchRentryChapter(
    num: number,
  ): Promise<Plugin.ChapterItem | null> {
    const url = `${RENTRY}/${num}ss`;
    try {
      const res = await fetchApi(url);
      if (!res.ok) return null;
      const $ = parseHTML(await res.text());
      const title =
        $('meta[property="og:title"]').attr('content')?.trim() ||
        $('title').text().trim();
      // Guards against error pages / Cloudflare challenge pages.
      if (!title.startsWith(String(num))) return null;
      // Placeholder pages hold only a title and prev/next links.
      let bodyChars = 0;
      $('article')
        .first()
        .find('p')
        .each((_, el) => {
          const p = $(el);
          const text = p.text().trim();
          const kids = p.children();
          const navOnly =
            kids.length === 1 &&
            kids.first().is('a') &&
            kids.first().text().trim() === text;
          if (!navOnly) bodyChars += text.length;
        });
      if (bodyChars < MIN_RENTRY_CHARS) return null;
      return { name: title, path: url };
    } catch {
      return null;
    }
  }

  // Probe num+1, num+2, ... in parallel batches until the first miss.
  private async collectRentry(afterNum: number): Promise<Plugin.ChapterItem[]> {
    const found: Plugin.ChapterItem[] = [];
    for (let b = 0; b < RENTRY_MAX_BATCHES; b++) {
      const start = afterNum + 1 + b * RENTRY_BATCH;
      const nums = Array.from({ length: RENTRY_BATCH }, (_, i) => start + i);
      const results = await Promise.all(
        nums.map(n => this.fetchRentryChapter(n)),
      );
      const firstMiss = results.findIndex(r => r === null);
      const hits = firstMiss === -1 ? results : results.slice(0, firstMiss);
      found.push(...(hits as Plugin.ChapterItem[]));
      if (firstMiss !== -1) break;
    }
    return found;
  }

  private item(): Plugin.NovelItem {
    return { name: NOVEL_NAME, path: INDEX_PATH, cover: defaultCover };
  }

  async popularNovels(pageNo: number): Promise<Plugin.NovelItem[]> {
    return pageNo > 1 ? [] : [this.item()];
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    if (pageNo > 1) return [];
    const term = searchTerm.toLowerCase().trim();
    return NOVEL_NAME.toLowerCase().includes(term) ? [this.item()] : [];
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    // Pass 1: master index -> volume pages
    const index = await this.load(novelPath);
    const volumes = this.collectLinks(index, t => t.startsWith('Volume'));

    // Pass 2: each volume page -> chapter links (parallel, order preserved)
    const volumePages = await Promise.all(volumes.map(v => this.load(v.path)));

    const chapters: Plugin.ChapterItem[] = [];
    const seenTitles = new Set<string>(); // author double-published some chapters
    let maxNum = NaN;
    for (const page of volumePages) {
      for (const ch of this.collectLinks(page, t => CHAPTER_RE.test(t))) {
        if (seenTitles.has(ch.title)) continue;
        seenTitles.add(ch.title);
        const n = parseInt(ch.title.match(CHAPTER_RE)?.[1] ?? '', 10);
        if (!isNaN(n) && (isNaN(maxNum) || n > maxNum)) maxNum = n;
        chapters.push({
          name: ch.title,
          path: ch.path,
          chapterNumber: chapters.length + 1,
        });
      }
    }

    // Pass 3: newer chapters from rentry. Failure here must never break the
    // Telegraph chapter list, so any error just means "no extra chapters".
    if (!isNaN(maxNum)) {
      try {
        const extra = await this.collectRentry(maxNum);
        for (const ch of extra) {
          chapters.push({ ...ch, chapterNumber: chapters.length + 1 });
        }
      } catch {
        // ignore
      }
    }

    return {
      path: novelPath,
      name: NOVEL_NAME,
      cover: defaultCover,
      author: 'Guiltythree',
      summary:
        'Telegraph volume index, extended with newer chapters from Rentry.',
      status: NovelStatus.Unknown,
      chapters,
    };
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const rentry = this.isRentry(chapterPath);
    const $ = await this.load(chapterPath);

    let scope = $('article').first();
    if (rentry && $('.entry-text').length) scope = $('.entry-text').first();

    const parts: string[] = [];
    scope.find(rentry ? 'p, hr' : 'p').each((_, el) => {
      const node = $(el);
      if (node.is('hr')) {
        parts.push('<hr>'); // scene break
        return;
      }
      const text = node.text().trim();
      const kids = node.children();
      // Skip empty paragraphs and nav paragraphs (prev/next/all-chapters
      // links) whose only content is a single link.
      const navOnly =
        kids.length === 1 &&
        kids.first().is('a') &&
        kids.first().text().trim() === text;
      if (text === '' || navOnly) return;
      if (text.startsWith('You are about to visit a link')) return;
      parts.push(`<p>${node.html()}</p>`);
    });

    if (!parts.length) throw new Error('No chapter text found');
    return parts.join('\n');
  }
}

export default new ShadowSlave();
