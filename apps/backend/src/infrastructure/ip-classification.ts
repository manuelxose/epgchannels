/**
 * IP / hostname classification for egress policy (TDT-API-02D, SEC-01).
 *
 * Pure functions, no I/O and no dependencies: given the bytes of an address or a
 * hostname they answer "may egress connect here?". The egress executor
 * (`safe-egress.ts`) calls them *before* a socket is opened and again for every
 * redirect hop, so the answer must be deterministic.
 *
 * The classification is an allow-list shape: anything the parser cannot prove is
 * a *global unicast* address is "not public". That is fail-closed by design —
 * a missed special range must never become an allowed destination.
 *
 * Ranges refused (MODULE-CONTRACT-02D §2):
 *   IPv4  0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24,
 *         192.0.2/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24,
 *         224/4 (multicast), 240/4 (reserved + limited broadcast)
 *   IPv6  ::1, ::, fc00::/7, fe80::/10, ff00::/8, ::ffff:0:0/96 (IPv4-mapped:
 *         the *embedded* IPv4 is classified instead), and every other
 *         non-2000::/3 special-purpose block we can detect statically.
 *   Names localhost, *.localhost, *.local, *.internal, *.home.arpa, anything
 *         ending in `.arpa` or a single label, and IP literals in any notation
 *         the WHATWG URL parser accepts (dotted, bracketed, `2130706433`,
 *         `0x7f.1`, octal, IPv6 brackets).
 */

export type IpVersion = 4 | 6;

/**
 * Why an address is not a public unicast destination, or `null` when it is.
 * The strings are the contract: tests and logs key off them, so new reasons are
 * additive and existing ones never change meaning.
 */
export type Ipv4Refusal =
  | 'this-network' // 0.0.0.0/8
  | 'private' // 10/8, 172.16/12, 192.168/16
  | 'shared' // 100.64/10 carrier-grade NAT
  | 'loopback' // 127/8
  | 'link-local' // 169.254/16 (cloud metadata lives at 169.254.169.254)
  | 'ietf-protocol' // 192.0.0/24
  | 'documentation' // 192.0.2/24, 198.51.100/24, 203.0.113/24
  | 'benchmarking' // 198.18/15
  | 'multicast' // 224/4
  | 'reserved' // 240/4, incl. 255.255.255.255
  | 'malformed';

export type Ipv6Refusal =
  | 'unspecified' // ::
  | 'loopback' // ::1
  | 'ula' // fc00::/7
  | 'link-local' // fe80::/10
  | 'multicast' // ff00::/8
  | 'ipv4-mapped-private' // ::ffff:0:0/96 whose embedded IPv4 is not public
  | 'ipv4-embedded' // ::/96 deprecated IPv4-compatible, 64:ff9b::/96 NAT64
  | 'documentation' // 2001:db8::/32
  | 'discard' // 100::/64
  | '6to4' // 2002::/16 (carries an arbitrary IPv4)
  | 'teredo' // 2001::/32
  | 'not-global-unicast' // outside 2000::/3
  | 'malformed';

export type IpClassification =
  | { readonly ok: true; readonly version: IpVersion }
  | { readonly ok: false; readonly version: IpVersion; readonly reason: Ipv4Refusal | Ipv6Refusal };

const REFUSED: IpClassification = { ok: false, version: 4, reason: 'malformed' };
const REFUSED6: IpClassification = { ok: false, version: 6, reason: 'malformed' };

function refuse4(reason: Ipv4Refusal): IpClassification {
  return { ok: false, version: 4, reason };
}
function refuse6(reason: Ipv6Refusal): IpClassification {
  return { ok: false, version: 6, reason };
}

/**
 * Parses the four dotted decimal octets of an IPv4 literal. Strict: exactly four
 * parts, each 1–3 digits, no leading `+`/spaces, no short forms — the WHATWG URL
 * parser normalises numeric hosts (`0x7f.1`, `2130706433`) before they reach us,
 * but a DNS answer or a caller-supplied string is not normalised, so anything
 * unusual is refused rather than guessed at.
 */
function parseIpv4(address: string): readonly [number, number, number, number] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    // Leading zeros are legal text but ambiguous (octal in some parsers):
    // accept "0" but refuse "012" / "00" / "000" to avoid two readings.
    if (part.length > 1 && part.startsWith('0')) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

/**
 * Classifies a dotted-decimal IPv4 literal.
 * `ok: true` means global unicast; anything else carries the refusal reason.
 */
export function classifyIpv4(address: string): IpClassification {
  const octets = parseIpv4(address.trim());
  if (octets === null) return refuse4('malformed');
  const [a, b] = octets;
  if (a === 0) return refuse4('this-network');
  if (a === 10) return refuse4('private');
  if (a === 100 && b >= 64 && b <= 127) return refuse4('shared');
  if (a === 127) return refuse4('loopback');
  if (a === 169 && b === 254) return refuse4('link-local');
  if (a === 172 && b >= 16 && b <= 31) return refuse4('private');
  if (a === 192 && b === 0 && octets[2] === 0) return refuse4('ietf-protocol');
  if (a === 192 && b === 0 && octets[2] === 2) return refuse4('documentation');
  if (a === 192 && b === 168) return refuse4('private');
  if (a === 198 && (b === 18 || b === 19)) return refuse4('benchmarking');
  if (a === 198 && b === 51 && octets[2] === 100) return refuse4('documentation');
  if (a === 203 && b === 0 && octets[2] === 113) return refuse4('documentation');
  if (a >= 224 && a <= 239) return refuse4('multicast');
  if (a >= 240) return refuse4('reserved');
  return { ok: true, version: 4 };
}

/**
 * Expands an IPv6 literal (with or without brackets) into its 16 bytes.
 * Supports `::` compression and a trailing dotted-quad (`::ffff:192.0.2.1`).
 * Refuses zone identifiers (`fe80::1%eth0`) and anything malformed.
 */
function parseIpv6(address: string): Uint8Array | null {
  let text = address.trim();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  // Zone identifiers (`fe80::1%eth0`) are link-scoped by definition.
  if (text.length === 0 || text.includes('%')) return null;
  // Split off a trailing IPv4 part (`x:x:x:x:x:x:d.d.d.d`).
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(':');
  if (lastColon === -1) return null;
  const maybeV4 = text.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    const v4 = parseIpv4(maybeV4);
    if (v4 === null) return null;
    tail = [...v4];
    // Keep a trailing `::` (compression); otherwise drop the separating colon.
    text = text.slice(0, lastColon + 1);
    if (!text.endsWith('::')) text = text.slice(0, -1);
  }
  const doubleColon = text.indexOf('::');
  if (doubleColon !== -1 && text.indexOf('::', doubleColon + 1) !== -1) return null;
  const headGroups: string[] = [];
  const tailGroups: string[] = [];
  let groups: string[];
  if (doubleColon === -1) {
    groups = text.length === 0 ? [] : text.split(':');
    if (groups.length + tail.length / 2 !== 8) return null;
    headGroups.push(...groups);
  } else {
    const head = text.slice(0, doubleColon);
    const rest = text.slice(doubleColon + 2);
    const headParts = head.length === 0 ? [] : head.split(':');
    const restParts = rest.length === 0 ? [] : rest.split(':');
    if (headParts.length + restParts.length + tail.length / 2 >= 8) return null;
    headGroups.push(...headParts);
    tailGroups.push(...restParts);
  }
  const words: number[] = [];
  for (const group of headGroups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    words.push(parseInt(group, 16));
  }
  if (doubleColon !== -1) {
    const missing = 8 - (headGroups.length + tailGroups.length + tail.length / 2);
    for (let i = 0; i < missing; i += 1) words.push(0);
    for (const group of tailGroups) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      words.push(parseInt(group, 16));
    }
  }
  if (tail.length > 0) {
    words.push((tail[0]! << 8) | tail[1]!);
    words.push((tail[2]! << 8) | tail[3]!);
  }
  if (words.length !== 8) return null;
  const bytes = new Uint8Array(16);
  words.forEach((word, index) => {
    bytes[index * 2] = (word >> 8) & 0xff;
    bytes[index * 2 + 1] = word & 0xff;
  });
  return bytes;
}

/** Classifies an IPv6 literal; IPv4-mapped (`::ffff:0:0/96`) is classified as its embedded IPv4. */
export function classifyIpv6(address: string): IpClassification {
  const bytes = parseIpv6(address);
  if (bytes === null) return refuse6('malformed');
  const zeroThrough = (end: number): boolean => {
    for (let i = 0; i < end; i += 1) if (bytes[i] !== 0) return false;
    return true;
  };
  // ::ffff:0:0/96 — IPv4-mapped: classify the embedded address, never trust the wrapper.
  if (zeroThrough(10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    const embedded = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
    const inner = classifyIpv4(embedded);
    return inner.ok ? { ok: true, version: 6 } : refuse6('ipv4-mapped-private');
  }
  if (zeroThrough(16)) return refuse6('unspecified');
  if (zeroThrough(15) && bytes[15] === 1) return refuse6('loopback');
  // 64:ff9b::/96 (NAT64) and ::/96 (deprecated IPv4-compatible) embed an IPv4.
  if (
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.subarray(4, 12).every((byte) => byte === 0)
  ) {
    return refuse6('ipv4-embedded');
  }
  if (zeroThrough(12)) return refuse6('ipv4-embedded');
  // Unique local fc00::/7.
  if ((bytes[0]! & 0xfe) === 0xfc) return refuse6('ula');
  // Link-local fe80::/10.
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return refuse6('link-local');
  // Multicast ff00::/8.
  if (bytes[0] === 0xff) return refuse6('multicast');
  // 100::/64 discard-only.
  if (bytes[0] === 0x01 && bytes[1] === 0x00 && zeroThrough(8)) return refuse6('discard');
  // 0000::/8 (incl. IPv4-compatible) and 0100::/8 (incl. 100::/64) are outside 2000::/3.
  if (bytes[0] === 0x00 || bytes[0] === 0x01) return refuse6('not-global-unicast');
  // 2001:db8::/32 documentation.
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) {
    return refuse6('documentation');
  }
  // 2001::/32 Teredo.
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) {
    return refuse6('teredo');
  }
  // 2002::/16 6to4 wraps an arbitrary IPv4 address.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return refuse6('6to4');
  // Global unicast is 2000::/3 (first three bits 001); everything else is
  // special-purpose or reserved.
  if ((bytes[0]! & 0xe0) !== 0x20) return refuse6('not-global-unicast');
  return { ok: true, version: 6 };
}

/** Classifies an IPv4 or IPv6 literal without a decision about version. */
export function classifyIp(address: string): IpClassification {
  const text = address.trim();
  const bare = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text;
  if (bare.includes(':')) return classifyIpv6(bare);
  return classifyIpv4(bare);
}

/**
 * True only for a global-unicast IP literal. Hostnames are *not* resolved here:
 * `"example.com"` is not an address and returns `false` — callers resolve names
 * first (`safe-egress.ts`) and check every answer.
 */
export function isPublicAddress(address: string): boolean {
  return classifyIp(address).ok;
}

const RESERVED_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'] as const;
const RESERVED_EXACT = new Set(['localhost', 'local', 'internal', 'home.arpa']);

/**
 * True for a hostname that can never be an allowed egress destination:
 * loopback aliases, mDNS `.local`, split-horizon `.internal`, RFC 8375
 * `.home.arpa`, any `.arpa` (reverse DNS / infrastructure), single-label names
 * (resolved through search domains, i.e. intranet), and any IP literal in
 * dotted, numeric, hex or bracketed form.
 *
 * `false` means "not reserved" — not "allowed": the caller still has to resolve
 * it and check each address.
 */
export function isReservedHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (host.length === 0) return true;
  // IP literals, including the bracketed IPv6 form URL.hostname produces.
  if (host.includes(':') || host.startsWith('[')) return true;
  if (/^\d+$/.test(host)) return true; // WHATWG numeric IPv4 spelling
  if (/^0x[0-9a-f]+$/i.test(host)) return true; // hex integer spelling
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true; // dotted IPv4
  // Dotted spellings mixing decimal/hex/octal parts (`0x7f.0.0.1`, `0177.0.0.1`):
  // URL parsing normalises them before we see them, but a hand-built host string
  // must not slip through either.
  if (host.includes('.') && host.split('.').length >= 2 && /^[0-9a-fx.]+$/.test(host) && /^\d/.test(host)) {
    return true; // e.g. `0x7f.1`, `1.0x808080`
  }
  const bare = host.replace(/\.$/, '');
  if (RESERVED_EXACT.has(bare)) return true;
  if (!bare.includes('.')) return true; // single label → search domain / intranet
  if (bare.endsWith('.arpa')) return true;
  for (const suffix of RESERVED_SUFFIXES) {
    if (bare === suffix.slice(1) || bare.endsWith(suffix)) return true;
  }
  return false;
}
