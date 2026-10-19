// Забирает новые сообщения бота и дописывает присланные ссылки в videos.json.
// Запускается по расписанию из .github/workflows/telegram.yml.
// Вебхука нет намеренно: его негде держать, а опрос раз в несколько минут
// для этой задачи достаточно быстр и не требует отдельного сервера.

import { readFile, writeFile } from 'node:fs/promises';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.log('TELEGRAM_BOT_TOKEN не задан — бот ещё не настроен, пропускаю.');
  process.exit(0);
}

// Кому можно командовать ботом. Пусто — бот отвечает только своим ID.
const ALLOWED = (process.env.TELEGRAM_ALLOWED_IDS || '')
  .split(/[,\s]+/).map(s => s.trim()).filter(Boolean);

const VIDEOS = 'videos.json';
const STATE = '.github/bot-state.json';
const API = `https://api.telegram.org/bot${TOKEN}`;

// Тот же разбор ссылок, что и в приложении.
const LINK_RE = /instagram\.com\/(?:[A-Za-z0-9_.]+\/)?(p|reels?|tv)\/([A-Za-z0-9_-]+)\/?(\?[^\s"'<>]*)?/gi;

function extract(text) {
  const out = [];
  for (const m of String(text).matchAll(LINK_RE)) {
    out.push({
      code: m[2],
      reel: m[1].toLowerCase().startsWith('reel'),
      slide: /[?&]img_index=/i.test(m[3] || '')
    });
  }
  return out;
}

const pageUrl = v => `https://www.instagram.com/${v.reel ? 'reel' : 'p'}/${v.code}/`;

// В videos.json лежат ссылки строками, но руками мог появиться и объект.
const codeOf = v => typeof v === 'string'
  ? (extract(v)[0]?.code ?? null)
  : (v && typeof v.code === 'string' ? v.code : null);

async function tg(method, payload) {
  const r = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await r.json();
  if (!data.ok) throw new Error(`${method}: ${data.description}`);
  return data.result;
}

const say = (chat, text) =>
  tg('sendMessage', { chat_id: chat, text, disable_web_page_preview: true })
    .catch(e => console.error('Ответ не ушёл:', e.message));

const readJson = async (file, fallback) => {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
};

const HELP = [
  'Кидай сюда ссылку на Reels или пост из Instagram — добавлю в ленту дочки.',
  'Можно несколько ссылок одним сообщением.',
  '',
  '/list — что сейчас в ленте',
  '/del <код> — убрать видео'
].join('\n');

async function main() {
  const state = await readJson(STATE, { offset: 0 });
  let videos = await readJson(VIDEOS, []);
  if (!Array.isArray(videos)) videos = [];
  const before = JSON.stringify(videos);

  const updates = await tg('getUpdates', {
    offset: state.offset || 0,
    timeout: 0,
    allowed_updates: ['message']
  });

  if (!updates.length) {
    console.log('Новых сообщений нет.');
    return;
  }

  let nextOffset = state.offset || 0;

  for (const u of updates) {
    nextOffset = Math.max(nextOffset, u.update_id + 1);

    const msg = u.message;
    if (!msg || typeof msg.text !== 'string') continue;

    const chat = String(msg.chat.id);
    const text = msg.text.trim();

    if (!ALLOWED.length) {
      // Первый запуск: подсказываем владельцу его ID и ничего не меняем.
      console.log(`Белый список пуст. Chat ID этого сообщения: ${chat}`);
      await say(chat, [
        'Бот ещё не настроен.',
        `Ваш ID: ${chat}`,
        '',
        'Добавьте его в переменную TELEGRAM_ALLOWED_IDS в настройках репозитория,',
        'и я начну принимать ссылки.'
      ].join('\n'));
      continue;
    }

    if (!ALLOWED.includes(chat)) {
      console.log(`Чужой чат ${chat} — молча пропускаю.`);
      continue;
    }

    if (/^\/(start|help)\b/i.test(text)) {
      await say(chat, HELP);
      continue;
    }

    if (/^\/list\b/i.test(text)) {
      await say(chat, videos.length
        ? `В ленте ${videos.length}:\n` + videos.map((v, i) => `${i + 1}. ${codeOf(v) || v}`).join('\n')
        : 'Лента пока пустая.');
      continue;
    }

    const del = text.match(/^\/del\b\s*(\S+)?/i);
    if (del) {
      const target = del[1] ? (codeOf(del[1]) || del[1]) : null;
      if (!target) { await say(chat, 'Напишите так: /del <код>. Коды показывает /list.'); continue; }
      const was = videos.length;
      videos = videos.filter(v => codeOf(v) !== target);
      await say(chat, videos.length < was
        ? `Убрал ${target}. Осталось ${videos.length}.`
        : `Не нашёл ${target} в ленте.`);
      continue;
    }

    const found = extract(text);
    if (!found.length) {
      await say(chat, 'Не вижу здесь ссылки на Instagram.\n\n' + HELP);
      continue;
    }

    const have = new Set(videos.map(codeOf).filter(Boolean));
    const fresh = [];
    let dup = 0, carousel = 0;

    for (const v of found) {
      if (have.has(v.code)) { dup++; continue; }
      have.add(v.code);
      fresh.push(pageUrl(v));
      if (v.slide) carousel++;
    }

    videos = [...fresh, ...videos];

    const reply = [];
    if (fresh.length) reply.push(`Добавил ${fresh.length}. Теперь в ленте ${videos.length}.`);
    if (dup) reply.push(`Уже были: ${dup}.`);
    if (carousel) reply.push('Внимание: ссылка ведёт на слайд карусели — плеер покажет только первый слайд.');
    if (fresh.length) reply.push('У дочки появится через пару минут.');
    await say(chat, reply.join('\n'));
  }

  const changed = JSON.stringify(videos) !== before;
  if (changed) await writeFile(VIDEOS, JSON.stringify(videos, null, 2) + '\n');
  await writeFile(STATE, JSON.stringify({ offset: nextOffset }, null, 2) + '\n');
  console.log(changed ? `videos.json обновлён, видео: ${videos.length}` : 'Список не менялся.');
}

main().catch(e => { console.error(e); process.exit(1); });
