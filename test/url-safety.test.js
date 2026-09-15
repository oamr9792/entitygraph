import test from 'node:test';
import assert from 'node:assert/strict';

import { isPrivateAddress, assertPublicUrl } from '../src/services/url-safety.js';

/**
 * A pasted URL is fetched by the server, from inside its own network. These pin
 * the addresses that must never be reachable that way.
 */

test('private, loopback, link-local and metadata addresses are refused', () => {
  for (const ip of [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', 'not-an-ip',
  ]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '151.101.1.69', '2606:4700::6810:84e5']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test('only plain public http(s) URLs are accepted', async () => {
  const refused = async (url, pattern) => {
    await assert.rejects(assertPublicUrl(url), (err) => err.status === 400 && pattern.test(err.message), url);
  };
  await refused('not a url', /not a valid URL/);
  await refused('ftp://example.com/file', /Only http and https/);
  await refused('file:///etc/passwd', /Only http and https/);
  await refused('http://user:secret@example.com/', /username or password/);
  await refused('http://127.0.0.1:8788/api/me', /private network/);
  await refused('http://169.254.169.254/latest/meta-data/', /private network/);
  await refused('http://[::1]/', /private network/);
});
