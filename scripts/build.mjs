import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://ilyaezy.dev';

// Главная (/) — английская, русская версия — /ru/. Обе собираются из index.html.
const PAGES = {
  en: {
    dir: '',
    locale: 'en_US',
    altLocale: 'ru_RU',
    author: 'Ilya Petrosyan',
    title: 'Ilya Petrosyan — Senior Fullstack Developer, React Native, Node.js',
    description:
      'Ilya Petrosyan — Senior Fullstack Developer building web, mobile and backend systems since 2019: TypeScript, React, React Native, Node.js, PostgreSQL.',
    ogDescription:
      'Web, mobile and backend systems with TypeScript, React, React Native and Node.js. Commercial development since 2019.',
    imageAlt: 'Ilya Petrosyan — Senior Fullstack Developer',
    h1: ['ILYA', 'PETROSYAN'],
  },
  ru: {
    dir: 'ru/',
    locale: 'ru_RU',
    altLocale: 'en_US',
    author: 'Илья Петросян',
    title: 'Илья Петросян (Ilya Petrosyan) — Senior Fullstack Developer',
    description:
      'Илья Петросян — Senior Fullstack Developer, в коммерческой разработке веб-, мобильных и backend-систем с 2019 года: TypeScript, React, React Native, Node.js.',
    ogDescription:
      'Веб-, мобильные и backend-системы на TypeScript, React, React Native и Node.js. В коммерческой разработке с 2019 года.',
    imageAlt: 'Илья Петросян — Senior Fullstack Developer',
    h1: ['ИЛЬЯ', 'ПЕТРОСЯН'],
  },
};

async function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const fixed = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  for (const p of fixed) if (existsSync(p)) return p;
  // headless-shell из кэша puppeteer или Playwright
  const caches = [
    [path.join(homedir(), '.cache/puppeteer/chrome-headless-shell'), 'chrome-headless-shell'],
    [path.join(homedir(), 'Library/Caches/ms-playwright'), 'headless_shell'],
    [path.join(homedir(), '.cache/ms-playwright'), 'headless_shell'],
  ];
  for (const [dir, bin] of caches) {
    if (!existsSync(dir)) continue;
    const stack = [dir];
    while (stack.length) {
      const d = stack.pop();
      for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
        const p = path.join(d, e.name);
        if (e.isDirectory() && !e.name.endsWith('.app')) stack.push(p);
        else if (e.isFile() && e.name === bin) return p;
      }
    }
  }
  throw new Error('Не найден Chrome/Chromium. Укажите путь в переменной CHROME_PATH.');
}

// Минимальный клиент Chrome DevTools Protocol на встроенном WebSocket (Node 22+)
async function launchBrowser() {
  const bin = await findChrome();
  const profile = await mkdtemp(path.join(tmpdir(), 'ilyaezy-chrome-'));
  const proc = spawn(bin, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    // на Linux-машинах GitHub Actions песочница Chrome недоступна
    ...(process.env.CI ? ['--no-sandbox'] : []),
    'about:blank',
  ]);
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('Chromium не запустился:\n' + buf)), 20000);
    proc.stderr.on('data', (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(t);
        resolve(m[1]);
      }
    });
    proc.on('exit', (code) => reject(new Error(`Chromium завершился с кодом ${code}:\n${buf}`)));
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else listeners.forEach((fn) => fn(msg));
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
    });
  const once = (method, sessionId) =>
    new Promise((resolve) => {
      const fn = (msg) => {
        if (msg.method === method && msg.sessionId === sessionId) {
          listeners.delete(fn);
          resolve(msg.params);
        }
      };
      listeners.add(fn);
    });

  async function open(url, { width = 1280, height = 900 } = {}) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    await send(
      'Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );
    const loaded = once('Page.loadEventFired', sessionId);
    await send('Page.navigate', { url }, sessionId);
    await loaded;
    return {
      evaluate: async (expression) => {
        const r = await send(
          'Runtime.evaluate',
          { expression, awaitPromise: true, returnByValue: true },
          sessionId,
        );
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
        return r.result.value;
      },
      screenshot: async () =>
        Buffer.from(
          (await send('Page.captureScreenshot', { format: 'png' }, sessionId)).data,
          'base64',
        ),
      close: () => send('Target.closeTarget', { targetId }),
    };
  }

  async function close() {
    ws.close();
    proc.kill();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
  return { open, close };
}

const EXTRACT = `(async () => {
  await document.fonts.ready;
  await new Promise((r) => setTimeout(r, 300));
  const clean = (el) => {
    const c = el.cloneNode(true);
    c.querySelectorAll('[data-reveal]').forEach((e) => {
      e.removeAttribute('data-reveal');
      e.classList.remove('in');
      e.style.removeProperty('--d');
      if (!e.getAttribute('style')) e.removeAttribute('style');
      if (!e.getAttribute('class')) e.removeAttribute('class');
    });
    return c.innerHTML;
  };
  const i18n = {};
  document.querySelectorAll('[data-i18n]').forEach((e) => (i18n[e.dataset.i18n] = e.innerHTML));
  const ph = {};
  document.querySelectorAll('[data-i18n-ph]').forEach((e) => (ph[e.dataset.i18nPh] = e.placeholder));
  const aria = {};
  document
    .querySelectorAll('[data-i18n-aria]')
    .forEach((e) => (aria[e.dataset.i18nAria] = e.getAttribute('aria-label')));
  return {
    plist: clean(document.getElementById('plist')),
    glog: clean(document.getElementById('glog')),
    i18n,
    ph,
    aria,
  };
})()`;

function replaceInner(html, id, inner) {
  const at = html.indexOf(`id="${id}"`);
  if (at < 0) throw new Error(`Нет элемента #${id}`);
  const start = html.lastIndexOf('<', at);
  const tag = html.slice(start + 1).match(/^[a-z0-9]+/i)[0];
  const openEnd = html.indexOf('>', at) + 1;
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  re.lastIndex = openEnd;
  let depth = 1;
  let m;
  while ((m = re.exec(html))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(0, openEnd) + inner + html.slice(m.index);
  }
  throw new Error(`Не найден конец #${id}`);
}

function replaceI18n(html, texts) {
  for (const [key, value] of Object.entries(texts)) {
    const re = new RegExp(
      `(<([a-z0-9]+)\\b[^>]*\\bdata-i18n="${key}"[^>]*>)([\\s\\S]*?)(</\\2\\s*>)`,
      'i',
    );
    html = html.replace(re, (_, open, tag, old, close) => open + value + close);
  }
  return html;
}

const attr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

// Меняет значение атрибута name у тега, помеченного data-атрибутом marker="key"
function replaceAttr(html, marker, values, name) {
  for (const [key, value] of Object.entries(values)) {
    const tag = new RegExp(`<[a-z0-9]+\\b[^>]*\\b${marker}="${key}"[^>]*>`, 'i');
    html = html.replace(tag, (t) =>
      t.replace(new RegExp(`(\\b${name}=")[^"]*(")`), `$1${attr(value)}$2`),
    );
  }
  return html;
}

function setMeta(html, selector, value) {
  // selector: ['name', 'description'] или ['property', 'og:title']
  const re = new RegExp(`(<meta\\s+${selector[0]}="${selector[1]}"\\s+content=")[^"]*(")`);
  if (!re.test(html)) throw new Error(`Нет мета-тега ${selector.join('=')}`);
  return html.replace(re, `$1${attr(value)}$2`);
}

function makePage(html, lang, data) {
  const p = PAGES[lang];
  const url = `${SITE}/${p.dir}`;
  // data-root — путь к папке img/ относительно страницы (у /ru/ это ../)
  const root = p.dir ? '../' : '';
  html = html.replace(
    /<html lang="[a-z]+"(?: data-root="[^"]*")?/,
    `<html lang="${lang}" data-root="${root}"`,
  );
  html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${p.title}</title>`);
  html = setMeta(html, ['name', 'description'], p.description);
  html = setMeta(html, ['name', 'author'], p.author);
  html = setMeta(html, ['property', 'og:title'], p.title);
  html = setMeta(html, ['property', 'og:description'], p.ogDescription);
  html = setMeta(html, ['property', 'og:image:alt'], p.imageAlt);
  html = setMeta(html, ['property', 'og:url'], url);
  html = setMeta(html, ['property', 'og:locale'], p.locale);
  html = setMeta(html, ['property', 'og:locale:alternate'], p.altLocale);
  html = html.replace(/(<link\s+rel="canonical"\s+href=")[^"]*(")/, `$1${url}$2`);
  html = html.replace(/(<span[^>]*id="ht1"[^>]*>)[^<]*(<)/, `$1${p.h1[0]}$2`);
  html = html.replace(/(<span[^>]*id="ht2"[^>]*>)[^<]*(<)/, `$1${p.h1[1]}$2`);
  html = replaceI18n(html, data.i18n);
  html = replaceAttr(html, 'data-i18n-ph', data.ph, 'placeholder');
  html = replaceAttr(html, 'data-i18n-aria', data.aria, 'aria-label');
  html = replaceInner(html, 'plist', data.plist);
  html = replaceInner(html, 'glog', data.glog);
  return html;
}

function sitemap() {
  const day = new Date().toISOString().slice(0, 10);
  const alt =
    `    <xhtml:link rel="alternate" hreflang="en" href="${SITE}/"/>\n` +
    `    <xhtml:link rel="alternate" hreflang="ru" href="${SITE}/ru/"/>\n` +
    `    <xhtml:link rel="alternate" hreflang="x-default" href="${SITE}/"/>\n`;
  const url = (loc) =>
    `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${day}</lastmod>\n${alt}  </url>\n`;
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' +
    url(`${SITE}/`) +
    url(`${SITE}/ru/`) +
    '</urlset>\n'
  );
}

const onlyOg = process.argv.includes('--og');
const browser = await launchBrowser();
try {
  if (onlyOg || !existsSync(path.join(ROOT, 'og.png'))) {
    const page = await browser.open(pathToFileURL(path.join(ROOT, 'scripts/og.html')).href, {
      width: 1200,
      height: 630,
    });
    await page.evaluate('document.fonts.ready.then(() => new Promise((r) => setTimeout(r, 300)))');
    await writeFile(path.join(ROOT, 'og.png'), await page.screenshot());
    await page.close();
    console.log('og.png готов');
  }
  if (!onlyOg) {
    const file = path.join(ROOT, 'index.html');
    const url = pathToFileURL(file).href;
    const render = async (lang) => {
      const page = await browser.open(`${url}?lang=${lang}`);
      const data = await page.evaluate(EXTRACT);
      await page.close();
      return data;
    };
    const rendered = { en: await render('en'), ru: await render('ru') };
    const source = await readFile(file, 'utf8');
    for (const lang of Object.keys(PAGES)) {
      const out = path.join(ROOT, PAGES[lang].dir, 'index.html');
      await mkdir(path.dirname(out), { recursive: true });
      await writeFile(out, makePage(source, lang, rendered[lang]));
    }
    await writeFile(path.join(ROOT, 'sitemap.xml'), sitemap());
    console.log('index.html (en), ru/index.html и sitemap.xml обновлены');
  }
} finally {
  await browser.close();
}
