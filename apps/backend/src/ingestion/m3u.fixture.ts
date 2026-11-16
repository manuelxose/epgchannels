/**
 * Bounded excerpt of iptv-org `streams/es.m3u` (commit 61b5e2a, 2026-11-16),
 * shortened. Never a whole upstream playlist.
 *
 * Observed shapes kept: `tvg-id` only, `(1080p)` decorations, `[Geo-blocked]`,
 * the same `tvg-id` repeated with two URLs, an empty line,
 * `#EXTVLCOPT:http-referrer`, nested `#EXTVLCOPT:http-user-agent=#EXTVLCOPT:…`
 * and the `WOW64` junk suffix. URLs of the last three entries are synthetic.
 */
export const M3U_EXCERPT = `#EXTM3U
#EXTINF:-1 tvg-id="3CatCameresdeltemps.es@SD",3Cat Càmeres del temps (1080p)
https://directes-tv-int.3catdirectes.cat/live-content/beauties-hls/master.m3u8
#EXTINF:-1 tvg-id="3CatExclusiu1.es@SD",3Cat Exclusiu 1 (1080p) [Geo-blocked]
https://directes-tv-cat.3catdirectes.cat/live-content/oca1-hls/master.m3u8
#EXTINF:-1 tvg-id="3CatExclusiu1.es@SD",3Cat Exclusiu 1 (1080p) [Geo-blocked]
https://directes-tv-cat.3catdirectes.cat/live-origin/oca1-hls/master.m3u8

#EXTVLCOPT:http-referrer=https://www.12tv.es/
#EXTINF:-1 tvg-id="12tv.es@SD",12TV (720p)
https://cdn.example.org/12tv/playlist.m3u8
#EXTVLCOPT:http-user-agent=#EXTVLCOPT:http-user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36
#EXTINF:-1 tvg-id="Demo.es@SD",Canal Demo (576p)
https://cdn.example.org/demo/index.m3u8
#EXTVLCOPT:http-user-agent=Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.131 Safari/537.36
#EXTINF:-1 tvg-id="Junk.es@SD",Canal Junk
https://cdn.example.org/junk/playlist.m3u8
`;
