import assert from 'node:assert/strict';
import test from 'node:test';
import { formatPhone, legacyPhoneKey, normalizePhone, phoneAliases, phoneDialNumber } from '../shared/phone.js';

test('Georgian phone input formats share one national storage key and familiar display', () => {
  for (const value of ['568694879', '568 69 48 79', '+995 568 69 48 79', '995568694879', '00995568694879', '+995(568)69-48-79']) {
    assert.equal(normalizePhone(value), '568694879', value);
    assert.equal(formatPhone(value), '568 69 48 79', value);
    assert.equal(phoneDialNumber(value), '+995568694879', value);
    assert.equal(legacyPhoneKey(value), '+995568694879', value);
  }
  assert.deepEqual(phoneAliases('+995568694879'), ['568694879', '+995568694879', '995568694879', '00995568694879']);
  assert.equal(normalizePhone('000000001'), '000000001');
});

test('foreign phone numbers keep their country code and are never truncated into Georgian numbers', () => {
  for (const value of ['+44 7911 123456', '00447911123456', '447911123456']) {
    assert.equal(normalizePhone(value), '+447911123456');
    assert.equal(formatPhone(value), '+447911123456');
    assert.equal(phoneDialNumber(value), '+447911123456');
  }
  assert.equal(normalizePhone('+123456789'), '+123456789');
  assert.deepEqual(phoneAliases('+447911123456'), ['+447911123456']);
});

test('phone validation rejects malformed numbers without destroying incomplete form input', () => {
  for (const value of ['', '568', 'call568694879', '568+694879', '++995568694879', '+01234567890', '995568694879000000']) {
    assert.equal(normalizePhone(value), null, value);
    assert.equal(phoneDialNumber(value), null, value);
    assert.equal(formatPhone(value), value);
    assert.deepEqual(phoneAliases(value), []);
  }
});
