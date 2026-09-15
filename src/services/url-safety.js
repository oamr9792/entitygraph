import net from 'node:net';
import { lookup } from 'node:dns/promises';
import { badRequest } from '../http.js';

/**
 * Guards for URLs a person types in.
 *
 * Reading a page on the server's behalf means the server makes the request,
 * from inside whatever network it runs in. Without this, a pasted URL could
 * reach the host's own services or a cloud metadata endpoint. Every hop of a
 * redirect is checked again, because a public page can redirect to a private
 * address.
 */

export function isPrivateAddress(address) {
  const ip = String(address ?? '').replace(/^\[|\]$/g, '');
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || /^ff/.test(lower);
  }
  // Not an address at all: refuse rather than guess.
  return true;
}

/** Throws a readable 400 unless the URL is http(s) and resolves only to public addresses. */
export async function assertPublicUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw badRequest('That is not a valid URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw badRequest('Only http and https pages can be read.');
  if (url.username || url.password) throw badRequest('URLs with a username or password in them are not accepted.');

  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true }).catch(() => []);
  if (!addresses.length) throw badRequest(`Could not find the site ${host}.`);
  if (addresses.some((a) => isPrivateAddress(a.address))) {
    throw badRequest('That address points to a private network, so it cannot be read.');
  }
  return url;
}
