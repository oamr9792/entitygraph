import fs from 'node:fs';
import tls from 'node:tls';
import path from 'node:path';

/**
 * TLS trust setup.
 *
 * A lot of corporate and consumer machines run TLS-inspecting software — AVG,
 * Avast, Kaspersky, ESET, Zscaler, Netskope — which terminates HTTPS locally
 * and re-signs it with its own CA. That CA is installed in the OS trust store,
 * so browsers are fine, but Node only picks it up if `NODE_EXTRA_CA_CERTS` is
 * set *before the process starts*. Launch the app from a shell that has it and
 * everything works; launch it from a service manager, an IDE or a task runner
 * that does not, and every outbound call dies with
 * `UNABLE_TO_VERIFY_LEAF_SIGNATURE` — with no hint as to why.
 *
 * This module removes that dependency on how the process happened to be
 * started, by loading the certificates at runtime instead.
 *
 * What this does NOT do, and must never do: disable certificate verification.
 * `NODE_TLS_REJECT_UNAUTHORIZED=0` would make every one of these calls succeed
 * and every one of them unverifiable. Trusting a CA that the machine's owner
 * already installed is a different thing entirely from trusting nothing.
 */

/**
 * Well-known locations for locally-installed interception CAs. Only files that
 * actually exist are read, and each is parsed before being trusted.
 */
const KNOWN_CA_PATHS = [
  'C:/ProgramData/AVG/Antivirus/wscert.pem',
  'C:/ProgramData/AVAST Software/Avast/wscert.pem',
  'C:/ProgramData/Kaspersky Lab/AVP*/Data/Cert/(fake)Kaspersky Anti-Virus personal root certificate.cer',
  'C:/ProgramData/ESET/ESET Security/CA/ca.pem',
  'C:/ProgramData/Zscaler/ZscalerRootCertificate.pem',
  '/usr/local/share/ca-certificates/zscaler.crt',
  '/etc/ssl/certs/ca-certificates.crt',
];

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

function readPemFile(file) {
  try {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return [];
    const text = fs.readFileSync(file, 'utf8');
    return text.match(PEM_BLOCK) ?? [];
  } catch {
    return [];
  }
}

/**
 * Installs extra CA certificates into Node's default trust store.
 *
 * @param extraPaths additional PEM paths from configuration
 * @returns a short summary for the startup log
 */
export function installTrustStore(extraPaths = []) {
  if (typeof tls.setDefaultCACertificates !== 'function') {
    return { applied: false, reason: 'this Node build has no tls.setDefaultCACertificates' };
  }

  const candidates = [
    ...(process.env.NODE_EXTRA_CA_CERTS ? [process.env.NODE_EXTRA_CA_CERTS] : []),
    ...extraPaths,
    ...KNOWN_CA_PATHS,
  ].filter(Boolean);

  const added = [];
  const pems = new Set();
  for (const candidate of candidates) {
    // Windows paths from the environment can carry doubled separators.
    const file = path.normalize(candidate);
    const blocks = readPemFile(file);
    if (!blocks.length) continue;
    let usable = 0;
    for (const pem of blocks) {
      try {
        // Parsing proves it is a real certificate before we trust it.
        tls.createSecureContext({ ca: pem });
        if (!pems.has(pem)) {
          pems.add(pem);
          usable += 1;
        }
      } catch {
        /* not a usable certificate — skip it */
      }
    }
    if (usable) added.push({ file, certificates: usable });
  }

  if (!pems.size) return { applied: false, added: [], reason: 'no extra CA files found' };

  try {
    // getCACertificates('default') is already bundled + system + anything from
    // NODE_EXTRA_CA_CERTS; we union our finds on top rather than replacing it,
    // so nothing that previously verified stops verifying.
    const existing = tls.getCACertificates('default');
    tls.setDefaultCACertificates([...new Set([...existing, ...pems])]);
    return { applied: true, added, total: existing.length + pems.size };
  } catch (err) {
    return { applied: false, added, reason: err.message };
  }
}

/**
 * Recognises the failure modes that are about the local machine rather than
 * the credential, so the UI can say "your antivirus is intercepting HTTPS"
 * instead of "fetch failed".
 */
export function diagnoseNetworkError(message = '') {
  const text = String(message);
  if (/UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT|CERT_SIGNATURE_FAILURE|DEPTH_ZERO_SELF_SIGNED/i.test(text)) {
    return {
      kind: 'tls_interception',
      message:
        'TLS certificate verification failed. Something on this machine is intercepting HTTPS — antivirus web shields (AVG, Avast, Kaspersky, ESET) and corporate proxies (Zscaler, Netskope) all do this. The app tries to load those CAs automatically at startup; if it could not find yours, set EXTRA_CA_CERTS in .env to the CA file path, or start the app with NODE_EXTRA_CA_CERTS pointing at it.',
    };
  }
  if (/UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT|ECONNRESET|ECONNREFUSED/i.test(text)) {
    return {
      kind: 'network',
      message:
        'Could not reach the provider — the connection timed out or was reset. This is usually a transient network problem, an antivirus web shield blocking the request, or a firewall. Retry; if it persists, check whether the endpoint is reachable from this machine at all.',
    };
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(text)) {
    return { kind: 'dns', message: 'DNS lookup failed for the provider hostname. Check this machine has working DNS and is online.' };
  }
  return null;
}
