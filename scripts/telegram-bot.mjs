// Дежурит на линии у Telegram и дописывает присланные ссылки в videos.json.
// Запускается из .github/workflows/telegram.yml.
//
// Вебхука нет намеренно: его негде держать. Вместо набегов по расписанию
// задание держит открытый запрос (long polling) весь отведённый срок и
// коммитит прямо по ходу смены — поэтому ответ приходит за секунды.

import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.log('TELEGRAM_BOT_TOKEN не задан — бот ещё не настроен, пропускаю.');
  process.exit(0);
}

// Хозяева: задаются переменной репозитория и могут раздавать доступ.
// Пусто — бот никого не слушает и только подсказывает ID.
const OWNERS = (process.env.TELEGRAM_ALLOWED_IDS || '')
  .split(/[,\s]+/).map(s => s.trim()).filter(Boolean);

const VIDEOS = 'videos.json';
const SETTINGS = 'settings.json';
const STATE = '.github/bot-state.json';
// Кого хозяева впустили командой /allow — лежит в репозитории, чтобы
// добавлять жену или бабушку, не трогая настройки GitHub.
const ALLOWLIST = '.github/bot-allowed.json';
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

async function tg(method, payload, timeoutMs = 30000) {
  const r = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const data = await r.json();
  if (!data.ok) throw new Error(`${method}: ${data.description}`);
  return data.result;
}

const say = (chat, text) =>
  tg('sendMessage', { chat_id: chat, text, disable_web_page_preview: true })
    .catch(e => console.error('Ответ не ушёл:', e.message));

// Запрос висит до `seconds` и возвращается сразу, как только пришло
// сообщение. Сеть иногда рвёт его на полпути — просто спрашиваем заново.
async function waitForUpdates(offset, seconds) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await tg('getUpdates', { offset, timeout: seconds, allowed_updates: ['message'] },
        (seconds + 20) * 1000);
    } catch (e) {
      if (attempt >= 3) throw e;
      console.error(`Опрос сорвался (${e.message}) — пробую ещё раз.`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

const readJson = async (file, fallback) => {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
};

// ---------- Git ----------

function git(...args) {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${(r.stderr || '').trim()}`);
  return (r.stdout || '').trim();
}

function commitAndPush(message) {
  if (!git('status', '--porcelain')) return false;
  git('config', 'user.name', 'kids-reels bot');
  git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com');
  git('add', VIDEOS, SETTINGS, STATE, ALLOWLIST);
  git('commit', '-m', message);

  // Пока шла смена, в ветку могли закоммитить руками — подбираем и пробуем снова.
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (spawnSync('git', ['push'], { encoding: 'utf8' }).status === 0) {
      console.log('Запушил:', message);
      return true;
    }
    console.error(`Пуш не прошёл (попытка ${attempt}), подтягиваю ветку.`);
    git('pull', '--rebase', 'origin', 'main');
  }
  throw new Error('Пуш не прошёл трижды.');
}

// ---------- Разговор ----------

const HELP = [
  'Кидай сюда ссылку на Reels или пост из Instagram — добавлю в ленту дочки.',
  'Можно несколько ссылок одним сообщением.',
  '',
  '/list — что сейчас в ленте',
  '/del <код> — убрать видео',
  '/crop <срез сверху> <высота> — подгонка кадра со всех телефонов'
].join('\n');

const HELP_OWNER = HELP + '\n\n' + [
  'Только для вас:',
  '/who — кто имеет доступ',
  '/allow <ID> — впустить человека',
  '/deny <ID> — закрыть доступ'
].join('\n');

async function main() {
  // Кому принадлежит токен и не перехвачен ли опрос вебхуком —
  // без этого «сообщений нет» не отличить от «пишете не туда».
  const me = await tg('getMe', {});
  console.log(`Токен принадлежит боту @${me.username} (${me.first_name}).`);
  const hook = await tg('getWebhookInfo', {});
  if (hook.url) console.log(`ВНИМАНИЕ: на боте стоит вебхук ${hook.url} — он забирает сообщения себе.`);

  const state = await readJson(STATE, { offset: 0 });
  let videos = await readJson(VIDEOS, []);
  if (!Array.isArray(videos)) videos = [];
  let settings = await readJson(SETTINGS, { head: 56, ar: 1.23 });
  const allowFile = await readJson(ALLOWLIST, { ids: [] });
  let guests = new Set((allowFile.ids || []).map(String));
  let offset = state.offset || 0;

  const isOwner = chat => OWNERS.includes(chat);
  const mayUse = chat => isOwner(chat) || guests.has(chat);
  const tellOwners = text => Promise.all(OWNERS.map(o => say(o, text)));
  const announced = new Set(); // о каждом незнакомце пишем один раз за смену

  const budgetMs = Math.max(1, Number(process.env.POLL_MINUTES) || 50) * 60_000;
  const started = Date.now();
  console.log(`Дежурю до ${Math.round(budgetMs / 60000)} минут, видео сейчас: ${videos.length}.`);

  async function handle(msg) {
    const chat = String(msg.chat.id);
    const text = msg.text.trim();
    const who = [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(' ')
      || (msg.chat.username ? '@' + msg.chat.username : 'без имени');

    if (!OWNERS.length) {
      console.log(`Хозяин не назначен. Chat ID этого сообщения: ${chat}`);
      await say(chat, [
        'Бот ещё не настроен.',
        `Ваш ID: ${chat}`,
        '',
        'Добавьте его в переменную TELEGRAM_ALLOWED_IDS в настройках репозитория,',
        'и я начну принимать ссылки.'
      ].join('\n'));
      return;
    }

    if (!mayUse(chat)) {
      console.log(`Чужой чат ${chat} (${who}) — не пускаю.`);
      if (!announced.has(chat)) {
        announced.add(chat);
        await tellOwners([
          'Вам пишет незнакомый человек.',
          `Имя: ${who}`,
          `ID: ${chat}`,
          '',
          `Впустить: /allow ${chat}`
        ].join('\n'));
      }
      return;
    }

    if (/^\/(start|help)\b/i.test(text)) { await say(chat, isOwner(chat) ? HELP_OWNER : HELP); return; }

    if (/^\/who\b/i.test(text)) {
      if (!isOwner(chat)) { await say(chat, 'Это умеет только хозяин бота.'); return; }
      await say(chat, [
        `Хозяева: ${OWNERS.join(', ')}`,
        guests.size ? `Впущены: ${[...guests].join(', ')}` : 'Больше никого не впущено.'
      ].join('\n'));
      return;
    }

    const access = text.match(/^\/(allow|deny)\b\s*(\S+)?/i);
    if (access) {
      const what = access[1].toLowerCase();
      if (!isOwner(chat)) { await say(chat, 'Это умеет только хозяин бота.'); return; }
      const id = (access[2] || '').replace(/[^\d-]/g, '');
      if (!id) { await say(chat, `Напишите так: /${what} 123456789\nID присылаю, когда человек пишет боту впервые.`); return; }
      if (OWNERS.includes(id)) {
        await say(chat, what === 'allow' ? 'Этот человек и так хозяин.' : 'Хозяина так не убрать — он задан в настройках репозитория.');
        return;
      }
      if (what === 'allow') {
        guests.add(id);
        await say(chat, `Впустил ${id}. Пусть кидает ссылки.`);
        await say(id, 'Вам открыли доступ к боту. Кидайте сюда ссылки на Reels — добавлю их в ленту.');
      } else {
        await say(chat, guests.delete(id) ? `Закрыл доступ ${id}.` : `${id} и так не был впущен.`);
      }
      return;
    }

    if (/^\/list\b/i.test(text)) {
      await say(chat, videos.length
        ? `В ленте ${videos.length}:\n` + videos.map((v, i) => `${i + 1}. ${codeOf(v) || v}`).join('\n')
        : 'Лента пока пустая.');
      return;
    }

    const crop = text.match(/^\/crop\b\s*(-?[\d.]+)?\s*(-?[\d.]+)?/i);
    if (crop) {
      const head = Number(crop[1]);
      const ar = Number(crop[2]);
      if (!Number.isFinite(head) || !Number.isFinite(ar) ||
          head < 0 || head > 400 || ar < 0.5 || ar > 3) {
        await say(chat, [
          'Нужны два числа: срез сверху в пикселях и высота кадра.',
          'Например: /crop 56 1.23',
          '',
          `Сейчас: /crop ${settings.head} ${settings.ar}`,
          'Проще не считать руками: в приложении шестерёнка → Вид → ползунки → «Применить у дочки».'
        ].join('\n'));
        return;
      }
      settings = { head, ar };
      await say(chat, `Готово: срез сверху ${head} px, высота кадра ${ar} ширины.\nНа телефонах применится через минуту.`);
      return;
    }

    const del = text.match(/^\/del\b\s*(\S+)?/i);
    if (del) {
      const target = del[1] ? (codeOf(del[1]) || del[1]) : null;
      if (!target) { await say(chat, 'Напишите так: /del <код>. Коды показывает /list.'); return; }
      const was = videos.length;
      videos = videos.filter(v => codeOf(v) !== target);
      await say(chat, videos.length < was
        ? `Убрал ${target}. Осталось ${videos.length}.`
        : `Не нашёл ${target} в ленте.`);
      return;
    }

    const found = extract(text);
    if (!found.length) { await say(chat, 'Не вижу здесь ссылки на Instagram.\n\n' + HELP); return; }

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
    if (fresh.length) reply.push('У дочки появится через минуту.');
    await say(chat, reply.join('\n'));
  }

  // Что лежит на диске — чтобы не трогать файлы впустую.
  const guestList = () => JSON.stringify({ ids: [...guests] });
  let onDisk = {
    videos: JSON.stringify(videos),
    settings: JSON.stringify(settings),
    guests: guestList(),
    offset
  };

  async function persist() {
    if (guestList() !== onDisk.guests) {
      await writeFile(ALLOWLIST, JSON.stringify({ ids: [...guests] }, null, 2) + '\n');
      console.log(`Впущены: ${[...guests].join(', ') || 'никто'}`);
    }
    if (JSON.stringify(videos) !== onDisk.videos) {
      await writeFile(VIDEOS, JSON.stringify(videos, null, 2) + '\n');
      console.log(`videos.json: ${videos.length}`);
    }
    if (JSON.stringify(settings) !== onDisk.settings) {
      await writeFile(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
      console.log(`settings.json: head=${settings.head} ar=${settings.ar}`);
    }
    if (offset !== onDisk.offset) {
      await writeFile(STATE, JSON.stringify({ offset }, null, 2) + '\n');
    }
    onDisk = {
      videos: JSON.stringify(videos),
      settings: JSON.stringify(settings),
      guests: guestList(),
      offset
    };
  }

  while (true) {
    const left = budgetMs - (Date.now() - started);
    if (left < 8000) { console.log('Смена окончена.'); break; }

    const updates = await waitForUpdates(offset, Math.min(25, Math.floor(left / 1000) - 3));
    if (!updates.length) continue;

    console.log(`Сообщений: ${updates.length}`);
    for (const u of updates) {
      offset = Math.max(offset, u.update_id + 1);
      if (u.message && typeof u.message.text === 'string') await handle(u.message);
    }

    // Коммитим сразу, не дожидаясь конца смены: иначе видео ждало бы
    // в воздухе, а при обрыве задания терялся бы и номер сообщения.
    await persist();
    commitAndPush('Бот: обновил список видео');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
