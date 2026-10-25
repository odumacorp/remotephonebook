import { describe, expect, it } from 'vitest';
import { dedupeKey, escapeLike, formatPhone, normalizeAccountPhone, normalizeName, normalizePhone } from '../src/lib/normalize.js';
import { digestText, latestInput } from '../src/ussd/protocol.js';
import { passwordProblems } from '../src/services/auth.js';
import { prepareContact } from '../src/services/contacts.js';

describe('phone normalisation', () => {
  it('normalises Kenyan local and international formats to E.164', () => {
    expect(normalizePhone('0712 345 678')).toBe('+254712345678');
    expect(normalizePhone('+254 712-345-678')).toBe('+254712345678');
    expect(normalizePhone('254712345678')).toBe('+254712345678');
    expect(normalizePhone('+1 (415) 555-2671')).toBe('+14155552671');
  });
  it('keeps unparseable numbers as digits', () => {
    expect(normalizePhone('*144#')).toBe('144');
    expect(normalizePhone('100')).toBe('100');
  });
  it('validates account phones strictly', () => {
    expect(normalizeAccountPhone('0712345678')).toBe('+254712345678');
    expect(normalizeAccountPhone('12345')).toBeNull();
  });
  it('formats for display', () => {
    expect(formatPhone('+254712345678')).toBe('+254 712 345678');
  });
});

describe('names and keys', () => {
  it('normalises names for search', () => {
    expect(normalizeName('  ÉSTHER   Achieng ')).toBe('esther achieng');
  });
  it('builds order-independent dedupe keys', () => {
    expect(dedupeKey('a', ['+2', '+1'])).toBe(dedupeKey('a', ['+1', '+2', '+1']));
  });
  it('escapes LIKE wildcards', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
  });
});

describe('USSD cumulative input parsing', () => {
  const sid = 'S';
  const prev = (text: string | null) => ({ digest: text === null ? null : digestText(sid, text), length: text?.length ?? 0 });

  it('treats the first request as having no input', () => {
    expect(latestInput(sid, '', prev(null))).toEqual({ input: null, duplicate: false });
  });
  it('treats dial-string shortcuts on the first request as input', () => {
    expect(latestInput(sid, '2', prev(null))).toEqual({ input: '2', duplicate: false });
  });
  it('extracts the newest segment', () => {
    expect(latestInput(sid, '1', prev(''))).toEqual({ input: '1', duplicate: false });
    expect(latestInput(sid, '1*alice@x.com', prev('1'))).toEqual({ input: 'alice@x.com', duplicate: false });
  });
  it('keeps "*" characters inside an input', () => {
    expect(latestInput(sid, '1*me@x.com*pa*ss*word', prev('1*me@x.com'))).toEqual({ input: 'pa*ss*word', duplicate: false });
  });
  it('detects a retried request', () => {
    expect(latestInput(sid, '1*2', prev('1*2'))).toEqual({ input: null, duplicate: true });
  });
  it('handles non-cumulative gateways', () => {
    expect(latestInput(sid, '3', prev('1*2'))).toEqual({ input: '3', duplicate: false });
  });
});

describe('password policy', () => {
  it('rejects weak passwords', () => {
    expect(passwordProblems('short1')).not.toHaveLength(0);
    expect(passwordProblems('onlyletterslong')).not.toHaveLength(0);
    expect(passwordProblems('password123')).not.toHaveLength(0);
    expect(passwordProblems('janedoe12345', ['janedoe'])).not.toHaveLength(0);
  });
  it('accepts a reasonable password', () => {
    expect(passwordProblems('Correct-Horse-42')).toHaveLength(0);
  });
});

describe('contact preparation', () => {
  it('dedupes numbers, keeps one primary and cleans names', () => {
    const p = prepareContact({
      displayName: '  Alice \n Wanjiku ',
      numbers: [{ number: '0712345678' }, { number: '+254712345678' }, { number: '0722 000 111', isPrimary: true }],
    });
    expect(p.displayName).toBe('Alice Wanjiku');
    expect(p.numbers.map((n) => n.normalized)).toEqual(['+254712345678', '+254722000111']);
    expect(p.numbers.filter((n) => n.isPrimary)).toHaveLength(1);
    expect(p.numbers[1].isPrimary).toBe(true);
  });
  it('rejects non-numeric input', () => {
    expect(() => prepareContact({ displayName: 'x', numbers: [{ number: "1'; DROP TABLE users;--" }] })).toThrow();
  });
  it('requires a name', () => {
    expect(() => prepareContact({ displayName: '   ', numbers: [] })).toThrow();
  });
});
