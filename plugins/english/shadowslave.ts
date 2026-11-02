import { CheerioAPI, load as parseHTML } from 'cheerio';
import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin'; // older repo versions: '@typings/plugin'
import { NovelStatus } from '@libs/novelStatus';
import { defaultCover } from '@libs/defaultCover';

// Master TOC page. telegra.ph has no catalog, so this plugin is single-novel.
const INDEX_PATH = '/List-of-all-volumes-01-08';
const NOVEL_NAME = 'Shadow Slave';

// Matches "Chapter 123: Title" and the bare "123 : Title" style the author
// switched to partway through Volume 9.
const CHAPTER_RE = /^(?:Chapter\s*)?\d+/;

type Link = { title: string; path: string };

class ShadowSlaveTelegraph implements Plugin.PluginBase {
  id = 'shadowslave-telegraph';
  name = 'Shadow Slave (Telegraph)';
  icon = 'src/en/shadowslave/icon.png';
  site = 'https://telegra.ph';
  version = '1.0.0';

  private toPath(href: string): string {
    return href.startsWith(this.site) ? href.slice(this.site.length) : href;
  }

  private async load(path: string): Promise<CheerioAPI> {
    const body = await fetchApi(this.site + path).then(r => r.text());
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

    // Pass 2: each volume page -> chapter links (fetched in parallel;
    // Promise.all keeps the volume order intact)
    const volumePages = await Promise.all(volumes.map(v => this.load(v.path)));

    const chapters: Plugin.ChapterItem[] = [];
    const seenTitles = new Set<string>(); // author double-published some chapters
    for (const page of volumePages) {
      for (const ch of this.collectLinks(page, t => CHAPTER_RE.test(t))) {
        if (seenTitles.has(ch.title)) continue;
        seenTitles.add(ch.title);
        chapters.push({
          name: ch.title,
          path: ch.path,
          chapterNumber: chapters.length + 1,
        });
      }
    }

    return {
      path: novelPath,
      name: NOVEL_NAME,
      cover: defaultCover,
      author: 'Guiltythree',
      summary: 'Aggregated from the telegra.ph volume index.',
      status: NovelStatus.Unknown,
      chapters,
    };
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const $ = await this.load(chapterPath);
    const parts: string[] = [];

    $('article p').each((_, el) => {
      const p = $(el);
      const text = p.text().trim();
      const kids = p.children();
      // Skip empty paragraphs and nav paragraphs ("All chapters of...",
      // "Next chapter ->") whose only content is a single link.
      const navOnly =
        kids.length === 1 &&
        kids.first().is('a') &&
        kids.first().text().trim() === text;
      if (text === '' || navOnly) return;
      parts.push(`<p>${p.html()}</p>`);
    });

    if (!parts.length) throw new Error('No chapter text found');
    return parts.join('\n');
  }
}

export default new ShadowSlaveTelegraph();
