import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  APP_BASE_URL = 'http://localhost:3100',
} = process.env;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  throw new Error('Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env');
}

export const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  `${APP_BASE_URL}/oauth2callback`
);

console.log('[oauth] redirect_uri =', `${APP_BASE_URL}/oauth2callback`);

// ===== File storage (MVP) =====
// ВАЖНО: пишем относительно папки backend/, независимо от process.cwd()
// __dirname = backend/src (в рантайме ts-node)
const TOKENS_FILE = path.resolve(__dirname, '..', 'data', 'tokens.json');

console.log('[tokens] TOKENS_FILE =', TOKENS_FILE);

function loadTokens(): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveTokens(data: Record<string, any>) {
  try {
    fs.mkdirSync(path.dirname(TOKENS_FILE), { recursive: true });
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('[tokens] saveTokens FAILED:', e);
    throw e;
  }
}

export function setUserTokens(userId: number, tokens: any) {
  console.log('[tokens] setUserTokens userId=', userId);
  const all = loadTokens();
  all[userId] = tokens;
  saveTokens(all);

  console.log(`[tokens] setUserTokens userId=${userId}`);
  console.log('[tokens] saved OK ->', TOKENS_FILE);
  // Мини-лог для отладки: куда реально записали
  console.log(`[tokens] saved for userId=${userId} -> ${TOKENS_FILE}`);
}

export function getUserTokens(userId: number) {
  const all = loadTokens();
  return all[userId];
}

// ===== OAuth flow =====
export function getAuthUrl(state: string) {
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/calendar'],
    state,
  });
}

export async function exchangeCode(code: string) {
  const { tokens } = await oauth2Client.getToken(code);
  return tokens;
}