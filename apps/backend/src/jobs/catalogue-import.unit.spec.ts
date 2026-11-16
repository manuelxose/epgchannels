/**
 * The declared format of a source is not proof of what it is.
 *
 * Audited defect: the reference catalogue labels Twitch player pages as `m3u8`,
 * and the importer trusted that label. Those 26 sources were handed to the HLS
 * engine, which cannot play an HTML page, so the channel failed for a reason the
 * catalogue never admitted.
 */
import { describe, expect, it } from 'vitest';
import { effectiveSourceType } from './catalogue-import.js';

describe('effectiveSourceType', () => {
  it('keeps a real HLS playlist as hls', () => {
    expect(effectiveSourceType('m3u8', 'https://rtvelivestream.rtve.es/la1.m3u8')).toBe('hls');
    expect(effectiveSourceType('hls', 'https://cdn.example.org/live/index.m3u8?token=abc')).toBe('hls');
  });

  it('keeps a DASH manifest as dash', () => {
    expect(effectiveSourceType('mpd', 'https://cdn.example.org/live/manifest.mpd')).toBe('dash');
  });

  it('reclassifies a Twitch player page, whatever the source declared', () => {
    expect(effectiveSourceType('m3u8', 'https://player.twitch.tv/?channel=realmadrid&parent=play.example.org')).toBe(
      'official-embed',
    );
    expect(effectiveSourceType('hls', 'https://player.twitch.tv/?channel=ibai')).toBe('official-embed');
  });

  it('reclassifies other platform players', () => {
    expect(effectiveSourceType('iframe', 'https://www.dailymotion.com/embed/video/x8abc')).toBe('official-embed');
    expect(effectiveSourceType('m3u8', 'https://vimeo.com/embed/123')).toBe('official-embed');
  });

  it('keeps YouTube as youtube: it has its own type, engine and rules', () => {
    expect(effectiveSourceType('youtube', 'https://www.youtube.com/channel/UCBi2mrWuNuyYy4gbM6fU18Q/live')).toBe(
      'youtube',
    );
    expect(effectiveSourceType('m3u8', 'https://www.youtube.com/embed/live_stream?channel=UCBi2mrWuNuyYy4gbM6fU18Q')).toBe(
      'youtube',
    );
  });

  it('leaves a normal emitter address alone', () => {
    // No manifest extension and no player host: the declared type is all we have.
    expect(effectiveSourceType('hls', 'https://cdn.example.org/live/stream')).toBe('hls');
  });

  it('does not invent a type for an address it cannot parse', () => {
    expect(effectiveSourceType('hls', 'not a url')).toBe('hls');
  });
});
