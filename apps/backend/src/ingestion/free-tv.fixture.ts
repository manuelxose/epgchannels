/**
 * Bounded excerpts of Free-TV `playlist.m3u8` (commit dcc6ca5, 2026-11-16),
 * shortened and with generated URLs. Never a whole upstream playlist.
 */

/** Free-TV header: `x-tvg-url` is comma-separated and very long upstream (excerpted). */
export const FREE_TV_HEADER_PLAYLIST = `#EXTM3U x-tvg-url="https://epgshare01.online/epgshare01/epg_ripper_AL1.xml.gz, https://epgshare01.online/epgshare01/epg_ripper_ALJAZEERA1.xml.gz, https://epgshare01.online/epgshare01/epg_ripper_ALL_SOURCES1.xml.gz"
#EXTINF:-1 tvg-name="Kanali 7" tvg-logo="https://i.imgur.com/rL2v9pM.png" tvg-id="Kanali7.al" tvg-country="AL" group-title="Albania",Kanali 7 Ⓢ
https://fe.tring.al/delta/105/out/u/1200_1.m3u8
`;

/**
 * Free-TV entry shape: tvg-name/tvg-logo/tvg-id/tvg-country/group-title, a
 * `[NO PUBLIC STREAM]` placeholder and a non-http `rtsp://` URL.
 */
export const FREE_TV_ENTRIES_PLAYLIST = `#EXTM3U
#EXTINF:-1 tvg-name="Kanali 7" tvg-logo="https://i.imgur.com/rL2v9pM.png" tvg-id="Kanali7.al" tvg-country="AL" group-title="Albania",Kanali 7 Ⓢ
https://fe.tring.al/delta/105/out/u/1200_1.m3u8
#EXTINF:-1 tvg-name="Kanal D Drama",Kanal D Drama
[NO PUBLIC STREAM]
#EXTINF:-1 tvg-name="RTV 21",RTV 21
rtsp://185.50.56.16:554/neontelvizija
`;
