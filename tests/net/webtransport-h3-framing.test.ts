import { describe, it } from 'fino:test/test';
import {
  SETTINGS_ENABLE_CONNECT_PROTOCOL,
  SETTINGS_H3_DATAGRAM,
  SETTINGS_WT_ENABLED,
  WEBTRANSPORT_BIDI_STREAM_TYPE,
  WEBTRANSPORT_UNI_STREAM_TYPE,
  decodeHttpDatagram,
  decodeQuicVarint,
  decodeWebTransportStreamPrefix,
  encodeHttpDatagram,
  encodeQuicVarint,
  encodeWebTransportStreamPrefix,
  webTransportSettings,
  webTransportSettingsEnabled,
} from '../../js/internal/net/http/h3/webtransport.ts';

describe('WebTransport H3 framing helpers', () => {
  it('matches draft-15 SETTINGS and stream/datagram framing', (t) => {
    t.equal(SETTINGS_WT_ENABLED, 0x2c7cf000);
    t.equal(SETTINGS_ENABLE_CONNECT_PROTOCOL, 0x08);
    t.equal(SETTINGS_H3_DATAGRAM, 0x33);
    t.equal(WEBTRANSPORT_BIDI_STREAM_TYPE, 0x41);
    t.equal(WEBTRANSPORT_UNI_STREAM_TYPE, 0x54);

    const settings = webTransportSettings();
    t.equal(webTransportSettingsEnabled(settings), true);
    t.equal(webTransportSettingsEnabled(new Map([[SETTINGS_WT_ENABLED, 1]])), false);

    t.deepEqual([...encodeQuicVarint(0x3fn)], [0x3f]);
    t.deepEqual(decodeQuicVarint(new Uint8Array([0x3f])), { value: 0x3fn, nextOffset: 1 });
    t.deepEqual([...encodeQuicVarint(0x40n)], [0x40, 0x40]);
    t.deepEqual(decodeQuicVarint(new Uint8Array([0x40, 0x40])), { value: 0x40n, nextOffset: 2 });
    t.deepEqual([...encodeQuicVarint(0x4000n)], [0x80, 0x00, 0x40, 0x00]);
    t.deepEqual(decodeQuicVarint(new Uint8Array([0x80, 0x00, 0x40, 0x00])), { value: 0x4000n, nextOffset: 4 });

    const datagram = encodeHttpDatagram(8n, new Uint8Array([0xaa, 0xbb]));
    t.deepEqual([...datagram], [0x02, 0xaa, 0xbb]);
    const decodedDatagram = decodeHttpDatagram(datagram);
    t.equal(decodedDatagram.streamId, 8n);
    t.deepEqual([...decodedDatagram.payload], [0xaa, 0xbb]);

    const bidiPrefix = encodeWebTransportStreamPrefix('bidirectional', 12n);
    t.deepEqual([...bidiPrefix], [0x40, 0x41, 0x03]);
    t.deepEqual(decodeWebTransportStreamPrefix(bidiPrefix), {
      kind: 'bidirectional',
      sessionId: 12n,
      headerLength: 3,
    });

    const uniPrefix = encodeWebTransportStreamPrefix('unidirectional', 16n);
    t.deepEqual([...uniPrefix], [0x40, 0x54, 0x04]);
    t.deepEqual(decodeWebTransportStreamPrefix(uniPrefix), {
      kind: 'unidirectional',
      sessionId: 16n,
      headerLength: 3,
    });

    t.throws(() => encodeHttpDatagram(2n, new Uint8Array()), /client-initiated bidirectional/);
  });
});
