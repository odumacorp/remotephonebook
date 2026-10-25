import { config } from '../config.js';
import { query, queryOne } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { formatPhone, maskEmail, maskPhone, normalizeAccountPhone, normalizePhone } from '../lib/normalize.js';
import { audit } from '../services/audit.js';
import { checkUserCredentials, consumeCode, deliverCode, type UserRow } from '../services/auth.js';
import {
  countContacts, getContact, listContacts, markSync, recentContacts, searchContacts, syncStatus, touchContact,
  type ContactDto, type Page,
} from '../services/contacts.js';
import { sendSms } from '../services/messaging.js';
import { hitLimit } from '../services/rateLimit.js';
import { con, digestText, end, latestInput, ussdRequestSchema, type UssdRequest } from './protocol.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
type ListKind = 'all' | 'search' | 'recent';

/** Everything a numbered option can do. Options are stored server-side, never trusted from input. */
type Action =
  | { t: 'welcome' }
  | { t: 'login' }
  | { t: 'login_other' }
  | { t: 'demo' }
  | { t: 'help' }
  | { t: 'exit' }
  | { t: 'main' }
  | { t: 'list'; kind: ListKind; offset: number; q?: string; prev?: number[] }
  | { t: 'search' }
  | { t: 'account' }
  | { t: 'sync' }
  | { t: 'simulate_sync' }
  | { t: 'logout' }
  | { t: 'contact'; id: string; numberIndex?: number }
  | { t: 'view_number' }
  | { t: 'next_number' }
  | { t: 'sms_confirm' }
  | { t: 'sms_send' }
  | { t: 'contact_back' };

/** Screens that take free-text input instead of a numbered choice. */
type InputMenu = 'login_identifier' | 'login_secret' | 'login_otp' | 'search_input';

interface State {
  menu?: string;
  /** The view action that drew the current screen, used to redraw it after invalid input. */
  current?: Action;
  options?: Record<string, Action>;
  mode?: 'user' | 'demo';
  demoUserId?: string;
  /** Login in progress. Holds who is being authenticated, never what they typed. */
  login?: { userId: string | null; kind: 'pin' | 'password' | 'otp'; trustedShortcut?: boolean };
  /** Last list shown, so "Return to Contacts" can go back to it. */
  list?: { kind: ListKind; offset: number; q?: string; prev?: number[] };
  contact?: { id: string; numberIndex: number };
}

interface SessionRow {
  id: string;
  provider_session_id: string;
  caller_phone: string;
  authenticated_user_id: string | null;
  session_state: State;
  last_input_digest: string | null;
  last_input_length: number;
  last_response: string | null;
  request_seq: number;
  failed_attempts: number;
  ended_at: Date | null;
  expires_at: Date;
}

interface Out {
  kind: 'CON' | 'END';
  body: string;
}

class Ctx {
  constructor(
    public session: SessionRow,
    public state: State,
    public caller: string,
    public req: UssdRequest,
  ) {}

  get ownerId(): string | null {
    if (this.state.mode === 'demo') return this.state.demoUserId ?? null;
    return this.session.authenticated_user_id;
  }
  get isDemo() {
    return this.state.mode === 'demo';
  }
}

const ABSOLUTE_SESSION_MINUTES = 15;

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------
function maxBody() {
  return config().USSD_MAX_CHARS - 4; // room for "CON "/"END "
}

function truncate(s: string, n: number) {
  return s.length <= n ? s : `${s.slice(0, Math.max(n - 1, 1))}…`;
}

/** Builds a menu screen and registers its numbered options. */
function menu(ctx: Ctx, current: Action, header: string[], items: [string, Action][], notice?: string): Out {
  const options: Record<string, Action> = {};
  const lines = [...(notice ? [notice] : []), ...header];
  items.forEach(([label, action], i) => {
    options[String(i + 1)] = action;
    lines.push(`${i + 1}. ${label}`);
  });
  ctx.state.menu = 'options';
  ctx.state.current = current;
  ctx.state.options = options;
  return { kind: 'CON', body: lines.join('\n') };
}

function prompt(ctx: Ctx, menuName: InputMenu, lines: string[], notice?: string): Out {
  ctx.state.menu = menuName;
  ctx.state.options = undefined;
  return { kind: 'CON', body: [...(notice ? [notice] : []), ...lines].join('\n') };
}

function fit(out: Out): string {
  const limit = maxBody();
  const body = out.body.length <= limit ? out.body : truncate(out.body, limit);
  return out.kind === 'CON' ? con(body) : end(body);
}

function formatWhen(d: Date | null): string {
  if (!d) return 'never';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: config().DISPLAY_TIMEZONE, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(d);
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------
function welcome(ctx: Ctx, notice?: string): Out {
  ctx.state.mode = undefined;
  ctx.state.login = undefined;
  const items: [string, Action][] = [['Login', { t: 'login' }]];
  if (config().demoModeEnabled) items.push(['Demo Contacts', { t: 'demo' }]);
  items.push(['Help', { t: 'help' }], ['Exit', { t: 'exit' }]);
  return menu(ctx, { t: 'welcome' }, ['RemotePhonebook'], items, notice);
}

function help(ctx: Ctx): Out {
  const code = config().AFRICASTALKING_USSD_SERVICE_CODE;
  return menu(ctx, { t: 'help' }, [
    'Help',
    'Sync contacts with the RemotePhonebook app, then dial ' + code + ' from any phone to look them up.',
    'Forgot password? Reset it in the app.',
  ], [['Back', { t: 'welcome' }]]);
}

async function mainMenu(ctx: Ctx, notice?: string): Promise<Out> {
  ctx.state.list = undefined;
  ctx.state.contact = undefined;
  if (ctx.isDemo) {
    return menu(ctx, { t: 'main' }, ['Demo Contacts (test data)'], [
      ['View Contacts', { t: 'list', kind: 'all', offset: 0 }],
      ['Search Contacts', { t: 'search' }],
      ['Recent Contacts', { t: 'list', kind: 'recent', offset: 0 }],
      ['About Demo', { t: 'account' }],
      ['Sync Status', { t: 'sync' }],
      ['Exit Demo', { t: 'logout' }],
    ], notice);
  }
  return menu(ctx, { t: 'main' }, ['Welcome to RemotePhonebook'], [
    ['View Contacts', { t: 'list', kind: 'all', offset: 0 }],
    ['Search Contacts', { t: 'search' }],
    ['Recent Contacts', { t: 'list', kind: 'recent', offset: 0 }],
    ['My Account', { t: 'account' }],
    ['Sync Status', { t: 'sync' }],
    ['Logout', { t: 'logout' }],
  ], notice);
}

async function contactList(ctx: Ctx, action: Extract<Action, { t: 'list' }>, notice?: string): Promise<Out> {
  const owner = ctx.ownerId!;
  const pageSize = config().USSD_PAGE_SIZE;
  const fetchPage = (offset: number, limit: number): Promise<Page<ContactDto>> =>
    action.kind === 'search'
      ? searchContacts(owner, action.q ?? '', { offset, limit })
      : action.kind === 'recent'
        ? recentContacts(owner, { offset, limit })
        : listContacts(owner, { offset, limit });

  const page = await fetchPage(action.offset, pageSize);
  ctx.state.list = { kind: action.kind, offset: action.offset, q: action.q, prev: action.prev };

  if (page.total === 0 || page.items.length === 0) {
    if (action.kind === 'search') {
      return menu(ctx, action, [`No contacts match "${truncate(action.q ?? '', 20)}".`], [
        ['Search again', { t: 'search' }],
        ['Main Menu', { t: 'main' }],
      ], notice);
    }
    if (action.kind === 'recent') {
      return menu(ctx, action, ['No recent contacts yet. Contacts you open will appear here.'], [
        ['View Contacts', { t: 'list', kind: 'all', offset: 0 }],
        ['Main Menu', { t: 'main' }],
      ], notice);
    }
    return menu(ctx, action, [
      ctx.isDemo ? 'Demo data is not loaded.' : 'No synced contacts yet. Open the RemotePhonebook app and sync your phonebook.',
    ], [['Main Menu', { t: 'main' }]], notice);
  }

  const prev = action.prev ?? [];
  const pageNo = prev.length + 1;
  const title =
    action.kind === 'search' ? `Results "${truncate(action.q ?? '', 12)}" - Page ${pageNo}`
    : action.kind === 'recent' ? `Recent Contacts - Page ${pageNo}`
    : `${ctx.isDemo ? 'Demo' : 'My'} Contacts - Page ${pageNo}`;

  const build = (items: ContactDto[], nameLen: number) => {
    // Navigation options are numbered after the contacts.
    const nav: [string, Action][] = [];
    if (page.hasMore || items.length < page.items.length) {
      nav.push(['Next Page', { ...action, offset: action.offset + items.length, prev: [...prev, action.offset] }]);
    }
    if (prev.length) nav.push(['Previous Page', { ...action, offset: prev[prev.length - 1], prev: prev.slice(0, -1) }]);
    if (action.kind !== 'recent') nav.push(['Search', { t: 'search' }]);
    nav.push(['Back', { t: 'main' }]);
    const rows = items.map((c): [string, Action] => [truncate(c.displayName, nameLen), { t: 'contact', id: c.id }]);
    return menu(ctx, action, [title], [...rows, ...nav], notice);
  };

  // Fit inside the carrier's limit: shorten names first, then show fewer contacts on this page.
  for (let count = page.items.length; count >= 1; count--) {
    for (const nameLen of [28, 20, 14]) {
      const out = build(page.items.slice(0, count), nameLen);
      if (out.body.length <= maxBody()) return out;
    }
  }
  return build(page.items.slice(0, 1), 14);
}

async function loadContact(ctx: Ctx): Promise<ContactDto | null> {
  if (!ctx.state.contact) return null;
  try {
    return await getContact(ctx.ownerId!, ctx.state.contact.id);
  } catch {
    return null;
  }
}

function listBack(ctx: Ctx): Action {
  return ctx.state.list ? { t: 'list', ...ctx.state.list } : { t: 'list', kind: 'all', offset: 0 };
}

async function contactDetail(ctx: Ctx, action: Extract<Action, { t: 'contact' }>, notice?: string): Promise<Out> {
  let contact: ContactDto;
  try {
    contact = await getContact(ctx.ownerId!, action.id);
  } catch {
    return contactList(ctx, listBack(ctx) as Extract<Action, { t: 'list' }>, 'That contact is no longer available.');
  }
  const idx = Math.min(action.numberIndex ?? 0, Math.max(contact.numbers.length - 1, 0));
  ctx.state.contact = { id: contact.id, numberIndex: idx };
  await touchContact(ctx.ownerId!, contact.id);
  const num = contact.numbers[idx];
  const header = [
    `Contact: ${truncate(contact.displayName, 40)}`,
    `Phone: ${num ? num.normalized : 'none'}${num?.label ? ` (${truncate(num.label, 12)})` : ''}`,
  ];
  if (contact.numbers.length > 1) header.push(`Number ${idx + 1} of ${contact.numbers.length}`);
  const items: [string, Action][] = [['View Number', { t: 'view_number' }]];
  if (contact.numbers.length > 1) items.push(['Next Number', { t: 'next_number' }]);
  items.push(['Send SMS', { t: 'sms_confirm' }], ['Return to Contacts', { t: 'contact_back' }], ['Main Menu', { t: 'main' }]);
  return menu(ctx, { t: 'contact', id: contact.id, numberIndex: idx }, header, items, notice);
}

async function viewNumber(ctx: Ctx): Promise<Out> {
  const contact = await loadContact(ctx);
  if (!contact) return mainMenu(ctx, 'That contact is no longer available.');
  const num = contact.numbers[ctx.state.contact!.numberIndex] ?? contact.numbers[0];
  const lines = [truncate(contact.displayName, 30), num.normalized];
  if (num.formatted !== num.normalized) lines.push(`(${num.formatted})`);
  lines.push('Write it down, then enter it in your dialer or SMS app. USSD cannot copy it.');
  return menu(ctx, { t: 'view_number' }, lines, [
    ['Back to Contact', { t: 'contact', id: contact.id, numberIndex: ctx.state.contact!.numberIndex }],
    ['Main Menu', { t: 'main' }],
  ]);
}

async function smsConfirm(ctx: Ctx): Promise<Out> {
  const contact = await loadContact(ctx);
  if (!contact) return mainMenu(ctx, 'That contact is no longer available.');
  const back: Action = { t: 'contact', id: contact.id, numberIndex: ctx.state.contact!.numberIndex };
  const header = ctx.isDemo
    ? [`Demo: simulate texting ${truncate(contact.displayName, 24)}'s number to your phone? No SMS is sent in demo mode.`]
    : [`Text ${truncate(contact.displayName, 24)}'s number to your phone (${maskPhone(ctx.caller)}) so you can tap it to call or copy?`];
  return menu(ctx, { t: 'sms_confirm' }, header, [['Send', { t: 'sms_send' }], ['Cancel', back]]);
}

async function smsSend(ctx: Ctx): Promise<Out> {
  const contact = await loadContact(ctx);
  if (!contact) return mainMenu(ctx, 'That contact is no longer available.');
  const idx = ctx.state.contact!.numberIndex;
  const num = contact.numbers[idx] ?? contact.numbers[0];
  const back: Extract<Action, { t: 'contact' }> = { t: 'contact', id: contact.id, numberIndex: idx };
  if (ctx.isDemo) return contactDetail(ctx, back, 'Demo: SMS simulated, nothing was sent.');

  const limit = await hitLimit(`ussd_sms:${ctx.ownerId}`, config().USSD_SMS_DAILY_LIMIT, 24 * 3600);
  if (!limit.allowed) return contactDetail(ctx, back, 'Daily SMS limit reached. Try tomorrow.');
  const result = await sendSms(
    ctx.caller,
    `RemotePhonebook: ${contact.displayName} ${num.normalized}${num.label ? ` (${num.label})` : ''}`,
    { userId: ctx.ownerId },
  );
  await audit(ctx.ownerId, 'ussd_sms_sent', { ok: result.ok, provider: result.provider });
  return contactDetail(ctx, back, result.ok ? 'SMS requested. It may take a minute to arrive.' : 'SMS could not be sent. Please write the number down.');
}

async function account(ctx: Ctx): Promise<Out> {
  if (ctx.isDemo) {
    return menu(ctx, { t: 'account' }, [
      'About Demo',
      'Fictional test contacts. Numbers are not real and must not be dialled. Log in to see your own contacts.',
    ], [['Main Menu', { t: 'main' }]]);
  }
  const user = await queryOne<UserRow>('SELECT * FROM users WHERE id = $1', [ctx.ownerId]);
  if (!user) return welcome(ctx);
  const total = await countContacts(user.id);
  return menu(ctx, { t: 'account' }, [
    'My Account',
    `Name: ${truncate(user.full_name, 30)}`,
    ...(user.normalized_phone ? [`Phone: ${maskPhone(user.normalized_phone)}`] : []),
    ...(user.email ? [`Email: ${truncate(maskEmail(user.email), 30)}`] : []),
    `Contacts: ${total}`,
  ], [['Main Menu', { t: 'main' }], ['Logout', { t: 'logout' }]]);
}

async function sync(ctx: Ctx, notice?: string): Promise<Out> {
  const status = await syncStatus(ctx.ownerId!);
  const statusText =
    status.status === 'never' ? 'Never synced. Open the app to sync.'
    : status.status === 'error' ? `Error: ${truncate(status.lastError ?? 'unknown', 50)}. Open the app to fix.`
    : status.status === 'in_progress' ? 'Sync in progress'
    : 'Up to date with last sync';
  const header = [
    ctx.isDemo ? 'Sync Status (demo)' : 'Sync Status',
    `Last sync: ${formatWhen(status.lastSuccessfulSyncAt)}`,
    `Contacts: ${status.totalContacts}`,
    `Status: ${statusText}`,
  ];
  const items: [string, Action][] = [];
  if (ctx.isDemo) items.push(['Simulate Sync', { t: 'simulate_sync' }]);
  items.push(['Main Menu', { t: 'main' }]);
  return menu(ctx, { t: 'sync' }, header, items, notice);
}

async function simulateSync(ctx: Ctx): Promise<Out> {
  if (!ctx.isDemo) return sync(ctx);
  const device = await queryOne<{ id: string }>(
    `INSERT INTO devices (user_id, device_identifier, platform, name) VALUES ($1, 'demo-device-0001', 'other', 'Demo phone')
     ON CONFLICT (user_id, device_identifier) DO UPDATE SET last_seen_at = now() RETURNING id`,
    [ctx.ownerId],
  );
  await markSync(ctx.ownerId!, device!.id, 'success', null, { simulated: 1 });
  return sync(ctx, 'Demo sync simulated.');
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
async function usersTrustingPhone(caller: string): Promise<UserRow[]> {
  return query<UserRow>(
    `SELECT u.* FROM users u
     WHERE u.ussd_pin_hash IS NOT NULL AND u.account_status = 'active' AND (
       (u.normalized_phone = $1 AND u.phone_verified_at IS NOT NULL)
       OR EXISTS (SELECT 1 FROM linked_phones lp WHERE lp.user_id = u.id AND lp.normalized_phone = $1
                  AND lp.verified_at IS NOT NULL AND lp.ussd_trusted))
     LIMIT 2`,
    [caller],
  );
}

async function isTrustedPhone(user: UserRow, caller: string): Promise<boolean> {
  if (user.normalized_phone === caller && user.phone_verified_at) return true;
  const row = await queryOne(
    'SELECT 1 FROM linked_phones WHERE user_id = $1 AND normalized_phone = $2 AND verified_at IS NOT NULL AND ussd_trusted',
    [user.id, caller],
  );
  return Boolean(row);
}

function identifierPrompt(ctx: Ctx, notice?: string): Out {
  ctx.state.login = undefined;
  return prompt(ctx, 'login_identifier', ['Enter phone number or email:', '0. Back'], notice);
}

function secretPrompt(ctx: Ctx, notice?: string): Out {
  const login = ctx.state.login!;
  if (login.kind === 'pin') {
    const lines = ['Enter your USSD PIN:'];
    if (login.trustedShortcut) lines.push('0. Use another account');
    return prompt(ctx, 'login_secret', lines, notice);
  }
  return prompt(ctx, 'login_secret', [
    'Enter password:',
    'Warning: USSD input is shown on screen and is not hidden. Make sure no one can see.',
    'Safer: set a USSD PIN in the app.',
  ], notice);
}

async function startLogin(ctx: Ctx): Promise<Out> {
  const trusted = await usersTrustingPhone(ctx.caller);
  if (trusted.length === 1) {
    ctx.state.login = { userId: trusted[0].id, kind: 'pin', trustedShortcut: true };
    return secretPrompt(ctx);
  }
  return identifierPrompt(ctx);
}

async function onIdentifier(ctx: Ctx, input: string): Promise<Out> {
  const value = input.trim();
  if (value === '0') return welcome(ctx);
  if (!value || value.length > 254 || /[\s*#]/.test(value.replace(/^\+/, ''))) {
    return identifierPrompt(ctx, 'Enter a valid phone number or email.');
  }
  let user: UserRow | undefined;
  if (value.includes('@')) {
    user = await queryOne<UserRow>('SELECT * FROM users WHERE email = $1', [value.toLowerCase()]);
  } else {
    const phone = normalizeAccountPhone(value) ?? normalizePhone(value);
    user = await queryOne<UserRow>('SELECT * FROM users WHERE normalized_phone = $1', [phone]);
  }
  const usePin = Boolean(user?.ussd_pin_hash && (await isTrustedPhone(user!, ctx.caller)));
  // Unknown accounts continue to the password step, so the flow looks the same either way.
  ctx.state.login = { userId: user?.id ?? null, kind: usePin ? 'pin' : 'password' };
  return secretPrompt(ctx);
}

async function loginFailed(ctx: Ctx, reason: string): Promise<Out> {
  ctx.session.failed_attempts += 1;
  await audit(ctx.state.login?.userId ?? null, 'ussd_login_failed', { reason, network: ctx.req.networkCode ?? null });
  const trustedShortcut = ctx.state.login?.trustedShortcut;
  if (ctx.session.failed_attempts >= config().USSD_MAX_LOGIN_ATTEMPTS) {
    ctx.state.login = undefined;
    return { kind: 'END', body: 'Login failed. Too many attempts. Please try again later.' };
  }
  const notice = 'Login failed. Check your details and try again.';
  if (trustedShortcut && ctx.state.login) {
    ctx.state.login.kind = 'pin';
    return secretPrompt(ctx, notice);
  }
  return identifierPrompt(ctx, notice);
}

async function onSecret(ctx: Ctx, input: string): Promise<Out> {
  const login = ctx.state.login;
  if (!login) return identifierPrompt(ctx);
  if (input === '0' && login.trustedShortcut) return identifierPrompt(ctx);

  const callerLimit = await hitLimit(`ussd_login_caller:${ctx.caller}`, 10, 3600);
  if (!callerLimit.allowed) return { kind: 'END', body: 'Too many login attempts from this phone. Try again later.' };

  const user = login.userId ? await queryOne<UserRow>('SELECT * FROM users WHERE id = $1', [login.userId]) : undefined;
  const secret = input.slice(0, 128);
  if (login.kind === 'pin' && !/^\d{4,6}$/.test(secret)) return loginFailed(ctx, 'bad_pin_format');
  const result = await checkUserCredentials(user, secret, login.kind === 'pin' ? 'pin' : 'password');
  if (!result.ok) {
    if (result.reason === 'unverified') return { kind: 'END', body: 'Please verify your account in the RemotePhonebook app first.' };
    return loginFailed(ctx, result.reason);
  }

  const trusted = login.kind === 'pin' || (await isTrustedPhone(result.user, ctx.caller));
  if (!trusted && config().USSD_REQUIRE_OTP_FOR_UNTRUSTED) {
    const u = result.user;
    const dest = u.normalized_phone && u.phone_verified_at
      ? { channel: 'sms' as const, to: u.normalized_phone, shown: maskPhone(u.normalized_phone) }
      : u.email && u.email_verified_at
        ? { channel: 'email' as const, to: u.email, shown: maskEmail(u.email) }
        : null;
    if (!dest) return loginFailed(ctx, 'no_otp_channel');
    await deliverCode(u.id, 'ussd_login', dest.channel, dest.to);
    ctx.state.login = { userId: u.id, kind: 'otp' };
    return prompt(ctx, 'login_otp', [`Enter the 6-digit code sent to ${dest.shown}:`, '0. Cancel']);
  }
  return completeLogin(ctx, result.user, login.kind);
}

async function onOtp(ctx: Ctx, input: string): Promise<Out> {
  const login = ctx.state.login;
  if (!login?.userId || login.kind !== 'otp') return identifierPrompt(ctx);
  if (input.trim() === '0') return welcome(ctx);
  const used = /^\d{6}$/.test(input.trim()) ? await consumeCode(login.userId, ['ussd_login'], input.trim()) : null;
  if (!used) return loginFailed(ctx, 'bad_otp');
  const user = await queryOne<UserRow>('SELECT * FROM users WHERE id = $1', [login.userId]);
  if (!user) return loginFailed(ctx, 'invalid');
  return completeLogin(ctx, user, 'password+otp');
}

async function completeLogin(ctx: Ctx, user: UserRow, method: string): Promise<Out> {
  ctx.state.login = undefined;
  if (user.account_status === 'demo' && config().isProd) return loginFailed(ctx, 'demo_in_production');
  if (!user.ussd_enabled) {
    return { kind: 'END', body: 'USSD access is turned off for this account. Turn it on in the RemotePhonebook app.' };
  }
  ctx.session.authenticated_user_id = user.id;
  ctx.session.failed_attempts = 0;
  ctx.state.mode = 'user';
  await audit(user.id, 'ussd_login_success', { method, network: ctx.req.networkCode ?? null });
  return mainMenu(ctx, 'Login successful.');
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------
const REQUIRES_OWNER = new Set<Action['t']>([
  'main', 'list', 'search', 'account', 'sync', 'simulate_sync', 'contact', 'view_number', 'next_number',
  'sms_confirm', 'sms_send', 'contact_back',
]);

async function perform(ctx: Ctx, action: Action, notice?: string): Promise<Out> {
  if (REQUIRES_OWNER.has(action.t) && !ctx.ownerId) return welcome(ctx);
  switch (action.t) {
    case 'welcome': return welcome(ctx, notice);
    case 'help': return help(ctx);
    case 'exit': return { kind: 'END', body: 'Thank you for using RemotePhonebook.' };
    case 'login': return startLogin(ctx);
    case 'login_other': return identifierPrompt(ctx);
    case 'demo': {
      if (!config().demoModeEnabled) return welcome(ctx, 'Demo is not available.');
      const demo = await queryOne<{ id: string }>("SELECT id FROM users WHERE account_status = 'demo' ORDER BY created_at LIMIT 1");
      if (!demo) return { kind: 'END', body: 'Demo data is not loaded. Run the seed script (npm run seed).' };
      ctx.state.mode = 'demo';
      ctx.state.demoUserId = demo.id;
      return mainMenu(ctx, 'Demo mode: fictional contacts.');
    }
    case 'main': return mainMenu(ctx, notice);
    case 'list': return contactList(ctx, action, notice);
    case 'search': return prompt(ctx, 'search_input', ['Search contacts', 'Enter a name or number:', '0. Back'], notice);
    case 'account': return account(ctx);
    case 'sync': return sync(ctx, notice);
    case 'simulate_sync': return simulateSync(ctx);
    case 'contact': return contactDetail(ctx, action, notice);
    case 'view_number': return viewNumber(ctx);
    case 'next_number': {
      const contact = await loadContact(ctx);
      if (!contact) return mainMenu(ctx, 'That contact is no longer available.');
      const next = (ctx.state.contact!.numberIndex + 1) % Math.max(contact.numbers.length, 1);
      return contactDetail(ctx, { t: 'contact', id: contact.id, numberIndex: next });
    }
    case 'sms_confirm': return smsConfirm(ctx);
    case 'sms_send': return smsSend(ctx);
    case 'contact_back': return contactList(ctx, listBack(ctx) as Extract<Action, { t: 'list' }>);
    case 'logout': {
      if (ctx.isDemo) return { kind: 'END', body: 'Demo ended. Thank you for trying RemotePhonebook.' };
      await audit(ctx.session.authenticated_user_id, 'ussd_logout', {});
      ctx.session.authenticated_user_id = null;
      ctx.state.mode = undefined;
      return { kind: 'END', body: 'You have been logged out. Goodbye.' };
    }
  }
}

const SEARCH_ALLOWED = /^[\p{L}\p{N} +'.\-]{1,30}$/u;

async function dispatch(ctx: Ctx, input: string): Promise<Out> {
  switch (ctx.state.menu as InputMenu | 'options' | undefined) {
    case 'login_identifier': return onIdentifier(ctx, input);
    case 'login_secret': return onSecret(ctx, input);
    case 'login_otp': return onOtp(ctx, input);
    case 'search_input': {
      const q = input.trim();
      if (q === '0') return mainMenu(ctx);
      if (!SEARCH_ALLOWED.test(q)) return perform(ctx, { t: 'search' }, 'Invalid search. Use letters or numbers (max 30).');
      return perform(ctx, { t: 'list', kind: 'search', offset: 0, q });
    }
    default: {
      const action = ctx.state.options?.[input.trim()];
      if (!action) {
        const current = ctx.state.current ?? { t: 'welcome' };
        // List screens fit the notice into their own layout; others get it prepended if there is room.
        if (current.t === 'list') return perform(ctx, current, 'Invalid choice.');
        const again = await perform(ctx, current);
        const body = `Invalid choice.\n${again.body}`;
        return body.length <= maxBody() ? { ...again, body } : again;
      }
      return perform(ctx, action);
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
/**
 * Handles one Africa's Talking USSD callback and returns the response body ("CON ..." / "END ...").
 * Never throws: every failure becomes a polite END screen.
 */
export async function handleUssd(raw: unknown): Promise<string> {
  const cfg = config();
  const parsed = ussdRequestSchema.safeParse(raw);
  if (!parsed.success) return end('Invalid request.');
  const req = parsed.data;
  const caller = normalizeAccountPhone(req.phoneNumber) ?? normalizePhone(req.phoneNumber);

  // Accept the configured code and its extensions (*123# also matches *123*1#).
  const dialled = normalizeCode(req.serviceCode);
  const expected = normalizeCode(cfg.AFRICASTALKING_USSD_SERVICE_CODE);
  if (dialled !== expected && !dialled.startsWith(`${expected}*`)) {
    await audit(null, 'callback_rejected', { reason: 'service_code_mismatch' });
    return end('This service is not available on this code.');
  }

  try {
    let session = await queryOne<SessionRow>('SELECT * FROM ussd_sessions WHERE provider_session_id = $1', [req.sessionId]);
    const isNew = !session;
    if (!session) {
      session = await queryOne<SessionRow>(
        `INSERT INTO ussd_sessions (provider_session_id, caller_phone, service_code, network_code, expires_at)
         VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))
         ON CONFLICT (provider_session_id) DO NOTHING RETURNING *`,
        [req.sessionId, caller, req.serviceCode, req.networkCode ?? null, cfg.USSD_SESSION_TTL_SECONDS],
      );
      session ??= await queryOne<SessionRow>('SELECT * FROM ussd_sessions WHERE provider_session_id = $1', [req.sessionId]);
    }
    if (!session) return end('Sorry, something went wrong. Please dial again.');
    if (session.caller_phone !== caller) {
      await audit(null, 'callback_rejected', { reason: 'session_phone_mismatch' });
      return end('Session error. Please dial again.');
    }

    const { input, duplicate } = latestInput(req.sessionId, req.text, {
      digest: isNew ? null : session.last_input_digest,
      length: session.last_input_length,
    });
    if (duplicate && session.last_response) return session.last_response;
    if (session.ended_at) return end('This session has ended. Please dial again.');
    if (new Date(session.expires_at) < new Date()) {
      await query('UPDATE ussd_sessions SET ended_at = now(), authenticated_user_id = NULL WHERE id = $1', [session.id]);
      return end('Your session expired. Please dial again.');
    }

    const ctx = new Ctx(session, { ...(session.session_state ?? {}) }, caller, req);
    let out: Out;
    if (!ctx.state.menu) {
      out = welcome(ctx);
      if (input !== null) out = await dispatch(ctx, input);
    } else if (input === null) {
      out = await perform(ctx, ctx.state.current ?? { t: 'welcome' });
    } else {
      out = await dispatch(ctx, input);
    }

    const response = fit(out);
    const updated = await query(
      `UPDATE ussd_sessions SET
         session_state = $2, current_menu = $3, authenticated_user_id = $4, failed_attempts = $5,
         last_input_digest = $6, last_input_length = $7, last_response = $8, request_seq = request_seq + 1,
         expires_at = LEAST(now() + make_interval(secs => $9), created_at + make_interval(mins => $10)),
         ended_at = CASE WHEN $11 THEN now() ELSE NULL END,
         updated_at = now()
       WHERE id = $1 AND request_seq = $12 RETURNING id`,
      [
        session.id, ctx.state, ctx.state.menu === 'options' ? ctx.state.current?.t ?? 'options' : ctx.state.menu ?? 'welcome',
        ctx.session.authenticated_user_id, ctx.session.failed_attempts,
        digestText(req.sessionId, req.text), req.text.length, response,
        cfg.USSD_SESSION_TTL_SECONDS, ABSOLUTE_SESSION_MINUTES, out.kind === 'END', session.request_seq,
      ],
    );
    if (!updated.length) {
      // A concurrent request for the same session won; answer with what it produced.
      const latest = await queryOne<SessionRow>('SELECT last_response FROM ussd_sessions WHERE id = $1', [session.id]);
      return latest?.last_response ?? response;
    }
    return response;
  } catch (err) {
    logger.error('ussd handler failed', { error: (err as Error).message });
    return end('Sorry, something went wrong. Please try again later.');
  }
}

function normalizeCode(code: string) {
  return code.replace(/\s/g, '').replace(/#$/, '');
}
