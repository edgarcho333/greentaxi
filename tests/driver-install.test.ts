import test from 'node:test';
import assert from 'node:assert/strict';
import { androidChromeIntent } from '../shared/driver-install';

test('Android Chrome links keep the HTTPS origin and discard paths, queries and fragments', () => {
  for (const origin of ['https://green-taxi.ge', 'https://greentaxi.vercel.app']) {
    const intent = androidChromeIntent(`${origin}/admin?phone=test-only&token=test-only#private`);
    assert.equal(intent, `intent://${new URL(origin).host}/driver#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(`${origin}/driver`)};end`);
    assert.ok(!intent!.includes('test-only'));
    assert.ok(!intent!.includes('/admin'));
  }
});

test('Android Chrome links preserve a nondefault HTTPS port for the same origin', () => {
  assert.equal(androidChromeIntent('https://example.test:8443/other'), 'intent://example.test:8443/driver#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=https%3A%2F%2Fexample.test%3A8443%2Fdriver;end');
});

test('Android Chrome links reject HTTP, credentials and non-web URLs', () => {
  for (const value of ['http://127.0.0.1:3100', 'http://green-taxi.ge', 'https://user:password@green-taxi.ge', 'https://user@green-taxi.ge', 'javascript:alert(1)', 'file:///driver', 'intent://green-taxi.ge/driver', 'not a URL']) {
    assert.equal(androidChromeIntent(value), null, value);
  }
});
