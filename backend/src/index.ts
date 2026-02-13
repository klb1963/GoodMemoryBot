import 'dotenv/config';
import { Telegraf, Markup, Context } from 'telegraf';

import { google } from 'googleapis';
import { getAuthUrl, exchangeCode, getUserTokens, setUserTokens, oauth2Client } from './googleAuth';

import express from 'express';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error('Missing TELEGRAM_BOT_TOKEN in .env');

const bot = new Telegraf(token);

// Чтобы бот не "молчал", если где-то выбросило исключение
bot.catch((err) => {
  console.error('[bot.catch]', err);
});

// MVP: in-memory store (потом заменим на sqlite/kv)
type Draft = {
  text: string;
  sourceChatTitle?: string;
  sourceSenderName?: string;
  receivedAt: number;
  reminderTime?: Date;
  meetingTime?: Date;
};

const draftsByUser = new Map<number, Draft>();

bot.start(async (ctx) => {
  await ctx.reply(
    [
      'Привет! Я GoodMemoryBot.',
      '',
      'Как пользоваться:',
      '1) Перешли мне сообщение из чата',
      '2) Я помогу создать напоминание или встречу в календаре',
      '',
      'Совет: закрепи чат со мной вверху списка Telegram.'
    ].join('\n')
  );
});

bot.command('ping', async (ctx) => ctx.reply('pong'));

bot.command('connect', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const state = `${userId}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  const url = getAuthUrl(state);

  await ctx.reply(
    [
      'Подключение Google Calendar:',
      '1) Открой ссылку',
      '2) Разреши доступ',
      '3) Вернись в Telegram',
      '',
      url,
    ].join('\n')
  );
});

const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3100';
const PORT = Number(new URL(APP_BASE_URL).port || 3100);

const app = express();

app.use((req, _res, next) => {
  console.log('[http]', req.method, req.url);
  next();
});

app.get('/health', (_req, res) => res.send('ok'));

app.get('/oauth2callback', async (req, res) => {
  try {
    console.log('[oauth2callback] HIT', req.query);
    const code = String(req.query.code || '');
    const stateRaw = String(req.query.state || '');

    // Express обычно уже декодит query-параметры. Двойной decode может ломаться.
    let state = stateRaw;
    try {
      // на всякий случай, если прилетит реально encoded
      if (/%[0-9A-Fa-f]{2}/.test(stateRaw)) state = decodeURIComponent(stateRaw);
    } catch (e) {
      console.warn('[oauth2callback] state decode failed, using raw state');
      state = stateRaw;
    }

    console.log('[oauth2callback] hit', { hasCode: Boolean(code), state });


    if (!code) {
      res.status(400).send('Missing code.');
      return;
    }

    const userId = Number(state.split(':')[0]);
    if (!Number.isFinite(userId) || userId <= 0) {
      res.status(400).send('Invalid state. Please /connect again in Telegram.');
      return;
    }

    const tokens = await exchangeCode(code);
    console.log('[oauth2callback] got tokens keys=', Object.keys(tokens || {}));
    console.log('[oauth2callback] saving tokens for userId=', userId);

    console.log('[oauth2callback] tokens:', {
      hasAccessToken: !!tokens?.access_token,
      hasRefreshToken: !!tokens?.refresh_token,
      expiryDate: tokens?.expiry_date,
    });

    setUserTokens(userId, tokens);
    console.log('[oauth2callback] saved tokens for userId=', userId);

    console.log('[oauth2callback] saved OK');

    res.send('✅ Google Calendar connected. You can go back to Telegram.');
  } catch (e: any) {
    console.error('[oauth2callback]', e);
    res.status(500).send(`OAuth error: ${e?.message || e}`);
  }
});

app.listen(PORT, () => {
  console.log(`OAuth callback server listening on ${APP_BASE_URL}`);
});

bot.on('message', async (ctx) => {
  const msg = ctx.message;

  const isForwarded =
    ('forward_date' in msg) ||
    ('forward_from' in msg) ||
    ('forward_sender_name' in msg) ||
    ('forward_from_chat' in msg);

  // Для MVP берём текст: у текстовых сообщений это msg.text
  // Для медиа — подпись msg.caption (если есть). Иначе дадим заглушку.
  const text =
    ('text' in msg && typeof msg.text === 'string' && msg.text.trim()) ? msg.text.trim()
    : ('caption' in msg && typeof (msg as any).caption === 'string' && (msg as any).caption.trim()) ? (msg as any).caption.trim()
    : '[сообщение без текста]';

  if (!isForwarded) {
    await ctx.reply('Ок. Для создания напоминания/встречи перешли мне сообщение из другого чата 🙂');
    return;
  }

  // Попробуем вытащить немного метаданных (не критично)
  const sourceChatTitle =
    ('forward_from_chat' in msg && (msg as any).forward_from_chat?.title) ? (msg as any).forward_from_chat.title : undefined;

  const sourceSenderName =
    ('forward_sender_name' in msg && (msg as any).forward_sender_name) ? (msg as any).forward_sender_name : undefined;

  draftsByUser.set(ctx.from.id, {
    text,
    sourceChatTitle,
    sourceSenderName,
    receivedAt: Date.now(),
  });

  await ctx.reply(
    'Сообщение получено. Что создать?',
    Markup.inlineKeyboard([
      [Markup.button.callback('⏰ Напоминание', 'CREATE_REMINDER')],
      [Markup.button.callback('📅 Встречу', 'CREATE_MEETING')],
    ])
  );
});

function requireUserId(ctx: any): number | null {
  return ctx.from?.id ?? null;
}

async function editOrReply(ctx: any, text: string, extra?: any) {
  try {
    if (ctx.updateType === 'callback_query') {
      return await ctx.editMessageText(text, extra);
    }
  } catch {
    // ignore and fallback to reply
  }
  return await ctx.reply(text, extra);
}

// Обработчики кнопок
bot.action('CREATE_REMINDER', async (ctx) => {
  const userId = requireUserId(ctx);
  if (!userId) {
    await ctx.answerCbQuery?.();
    return;
  }

  const draft = draftsByUser.get(userId);
  if (!draft) {
    await ctx.answerCbQuery();
    await ctx.reply('Не вижу сообщения. Перешли его ещё раз.');
    return;
  }

  await ctx.answerCbQuery();

  await editOrReply(
    ctx,
    'Когда напомнить?',
    Markup.inlineKeyboard([
      [Markup.button.callback('🕒 Через 1 час', 'TIME_PLUS_1H')],
      [Markup.button.callback('🌆 Сегодня вечером', 'TIME_TONIGHT')],
      [Markup.button.callback('🌅 Завтра утром', 'TIME_TOMORROW_MORNING')],
      [Markup.button.callback('📅 Выбрать дату/время', 'TIME_CUSTOM')]
    ])
  );
});

function addHours(date: Date, h: number) {
  const d = new Date(date);
  d.setHours(d.getHours() + h);
  return d;
}

function todayAt(hour: number) {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  if (d < new Date()) {
    d.setDate(d.getDate() + 1);
  }
  return d;
}

function tomorrowAt(hour: number) {
  const d = todayAt(hour);
  d.setDate(d.getDate() + 1);
  return d;
}

function formatDate(d: Date) {
  return d.toLocaleString();
}

bot.action('TIME_PLUS_1H', async (ctx) => {
  await handleTimeSelection(ctx, addHours(new Date(), 1));
});

bot.action('TIME_TONIGHT', async (ctx) => {
  await handleTimeSelection(ctx, todayAt(19));
});

bot.action('TIME_TOMORROW_MORNING', async (ctx) => {
  await handleTimeSelection(ctx, tomorrowAt(9));
});

bot.action('TIME_CUSTOM', async (ctx) => {
  await ctx.answerCbQuery();
  await editOrReply(ctx, 'В MVP пока используем быстрые кнопки 🙂');
});

bot.action('MEETING_TIME_PLUS_1H', async (ctx) => {
  await handleMeetingTime(ctx, addHours(new Date(), 1));
});

bot.action('MEETING_TIME_TONIGHT', async (ctx) => {
  await handleMeetingTime(ctx, todayAt(19));
});

bot.action('MEETING_TIME_TOMORROW_MORNING', async (ctx) => {
  await handleMeetingTime(ctx, tomorrowAt(9));
});

bot.action('MEETING_TIME_CUSTOM', async (ctx) => {
  await ctx.answerCbQuery();
  await editOrReply(ctx, 'В MVP пока используем быстрые кнопки 🙂');
});

async function handleTimeSelection(ctx: Context, date: Date) {
  const userId = requireUserId(ctx);
  if (!userId) {
    await (ctx as any).answerCbQuery?.();
    return;
  }

  const draft = draftsByUser.get(userId);

  if (!draft) {
    await (ctx as any).answerCbQuery?.();
    return;
  }

  await ctx.answerCbQuery();

  draft.reminderTime = date;
  await editOrReply(
    ctx,
    [
      'Создать напоминание?',
      '',
      `⏰ ${formatDate(date)}`,
      '',
      `📝 ${draft.text.slice(0, 200)}`
    ].join('\n'),
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ Создать', 'CONFIRM_REMINDER')]
    ])
  );
}

async function handleMeetingTime(ctx: Context, date: Date) {
  const userId = requireUserId(ctx);
  if (!userId) {
    await (ctx as any).answerCbQuery?.();
    return;
  }

  const draft = draftsByUser.get(userId);
  if (!draft) {
    await (ctx as any).answerCbQuery?.();
    return;
  }

  await (ctx as any).answerCbQuery?.();

  draft.meetingTime = date;

  await editOrReply(
    ctx,
    [
      'Создать встречу?',
      '',
      `📅 ${formatDate(date)}`,
      '⏱ Длительность: 60 минут',
      '',
      `📝 ${draft.text.slice(0, 200)}`
    ].join('\n'),
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ Создать встречу', 'CONFIRM_MEETING')]
    ])
  );
}

bot.action('CONFIRM_REMINDER', async (ctx) => {
  try {
    await (ctx as any).answerCbQuery?.();

    const userId = ctx.from?.id;
    if (!userId) return;

    const draft = draftsByUser.get(userId);
    if (!draft?.reminderTime) {
      await editOrReply(ctx, 'Не вижу выбранного времени. Выбери время ещё раз.');
      return;
    }

    const tokens = getUserTokens(userId);
    if (!tokens) {
      await editOrReply(ctx, 'Календарь не подключён. Напиши /connect.');
      return;
    }

    oauth2Client.setCredentials(tokens);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    const start = draft.reminderTime;
    const end = new Date(start.getTime() + 30 * 60 * 1000);

    const summary = 'Напоминание';

    const created = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary,
        description: draft.text,
        start: { dateTime: start.toISOString() },
        end: { dateTime: end.toISOString() },
      },
    });

    // сбрасываем, чтобы не было повторных "старыми" кнопками
    draft.reminderTime = undefined;

    await editOrReply(
      ctx,
      `⏰ Напоминание создано.\n${created.data.htmlLink ?? ''}`
    );
  } catch (e: any) {
    console.error('[CONFIRM_REMINDER]', e?.response?.data || e);
    const msg =
      e?.response?.data?.error?.message ||
      e?.message ||
      String(e);
    await editOrReply(ctx, `❌ Не получилось создать напоминание.\n${msg}`);
  }
});

bot.action('CREATE_MEETING', async (ctx) => {
  const userId = requireUserId(ctx);
  if (!userId) {
    await ctx.answerCbQuery?.();
    return;
  }

  const draft = draftsByUser.get(userId);
  if (!draft) {
    await ctx.answerCbQuery();
    await ctx.reply('Не вижу сообщения. Перешли мне сообщение ещё раз 🙂');
    return;
  }

  await ctx.answerCbQuery();
  await editOrReply(
    ctx,
    'Когда встреча?',
    Markup.inlineKeyboard([
      [Markup.button.callback('🕒 Через 1 час', 'MEETING_TIME_PLUS_1H')],
      [Markup.button.callback('🌆 Сегодня вечером', 'MEETING_TIME_TONIGHT')],
      [Markup.button.callback('🌅 Завтра утром', 'MEETING_TIME_TOMORROW_MORNING')],
    ])
  );
});

bot.action('CONFIRM_MEETING', async (ctx) => {

  try {
    await (ctx as any).answerCbQuery?.();

    const userId = ctx.from?.id;
    if (!userId) return;

    const draft = draftsByUser.get(userId);
    if (!draft?.meetingTime) {
      await editOrReply(ctx, 'Не вижу выбранного времени.');
      return;
    }

    const tokens = getUserTokens(userId);
    if (!tokens) {
      await editOrReply(ctx, 'Календарь не подключён. Напиши /connect.');
      return;
    }

    oauth2Client.setCredentials(tokens);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    const start = draft.meetingTime;
    const end = new Date(start.getTime() + 60 * 60 * 1000);

    // summary у Google Calendar не должен быть пустым
    const summary = (draft.text || '').trim().slice(0, 60) || 'Встреча';

    const created = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary,
        description: draft.text,
        start: { dateTime: start.toISOString() },
        end: { dateTime: end.toISOString() },
      },
    });

    // (опционально) можно очистить выбранное время после успеха
    draft.meetingTime = undefined;

    await editOrReply(
      ctx,
      `📅 Встреча создана.\n${created.data.htmlLink ?? ''}`
    );
  } catch (e: any) {
    console.error('[CONFIRM_MEETING]', e?.response?.data || e);
    const msg =
      e?.response?.data?.error?.message ||
      e?.message ||
      String(e);
    await editOrReply(ctx, `❌ Не получилось создать встречу.\n${msg}`);
  }

});

bot.launch();
console.log('GoodMemoryBot is running...');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));