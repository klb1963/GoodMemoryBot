import 'dotenv/config';
import { Telegraf, Markup, Context } from 'telegraf';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error('Missing TELEGRAM_BOT_TOKEN in .env');

const bot = new Telegraf(token);

// MVP: in-memory store (потом заменим на sqlite/kv)
type Draft = {
  text: string;
  sourceChatTitle?: string;
  sourceSenderName?: string;
  receivedAt: number;
  reminderTime?: Date;
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

async function handleTimeSelection(ctx: Context, date: Date) {
    const userId = requireUserId(ctx);
    if (!userId) {
        await (ctx as any).answerCbQuery?.();
        return;
    }

    const draft = draftsByUser.get(userId);

  if (!draft) return;

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

bot.action('CONFIRM_REMINDER', async (ctx) => {
  await ctx.answerCbQuery();
  await editOrReply(ctx, '✅ Напоминание создано (в MVP пока без календаря).');
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
        [
            'Ок, делаем встречу.',
            '',
            'Следующий шаг (в MVP): выбрать дату/время.',
            'Пока просто подтверждаю, что контекст сохранён:',
            `— Текст: ${draft.text.slice(0, 200)}`
        ].join('\n')
    );
});

bot.launch();
console.log('GoodMemoryBot is running...');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));