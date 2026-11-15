// Probe: discover an independently published XMLTV guide we could ingest.
const candidates = [
  'https://raw.githubusercontent.com/iptv-org/epg/master/README.md',
  'https://iptv-org.github.io/epg/guides/es.epg.xml',
  'https://www.tdtchannels.com/epg/TV.xml',
];

for (const url of candidates) {
  try {
    const response = await fetch(url, { headers: { accept: '*/*' } });
    const text = await response.text();
    console.log('===', url, response.status, 'bytes', text.length);
    if (response.ok) {
      const matches = text.match(/https?:\/\/[^\s)"']*\.xml/g);
      if (matches) console.log('xml urls:', [...new Set(matches)].slice(0, 12));
      if (text.trimStart().startsWith('<')) {
        console.log('head:', text.slice(0, 200).replace(/\s+/g, ' '));
        console.log('programmes:', (text.match(/<programme/g) ?? []).length);
        console.log('channels:', (text.match(/<channel /g) ?? []).length);
      }
    }
  } catch (error) {
    console.log('===', url, 'ERR', error.message);
  }
}
