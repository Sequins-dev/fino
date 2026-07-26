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
    t.equal(SETTINGS_WT_ENABLED, 746385408);
    t.equal(SETTINGS_ENABLE_CONNECT_PROTOCOL, 8);
    t.equal(SETTINGS_H3_DATAGRAM, 51);
    t.equal(WEBTRANSPORT_BIDI_STREAM_TYPE, 65);
    t.equal(WEBTRANSPORT_UNI_STREAM_TYPE, 84);
    const settings = webTransportSettings();
    t.equal(webTransportSettingsEnabled(settings), true);
    t.equal(webTransportSettingsEnabled(new Map([[SETTINGS_WT_ENABLED, 1]])), false);
    t.deepEqual([...encodeQuicVarint(63n)], [63]);
    t.deepEqual(decodeQuicVarint(new Uint8Array([63])), {
      value: 63n,
      nextOffset: 1,
    });
    t.deepEqual([...encodeQuicVarint(64n)], [64, 64]);
    t.deepEqual(decodeQuicVarint(new Uint8Array([64, 64])), {
      value: 64n,
      nextOffset: 2,
    });
    t.deepEqual([...encodeQuicVarint(16384n)], [128, 0, 64, 0]);
    t.deepEqual(decodeQuicVarint(new Uint8Array([128, 0, 64, 0])), {
      value: 16384n,
      nextOffset: 4,
    });
    const datagram = encodeHttpDatagram(8n, new Uint8Array([170, 187]));
    t.deepEqual([...datagram], [2, 170, 187]);
    const decodedDatagram = decodeHttpDatagram(datagram);
    t.equal(decodedDatagram.streamId, 8n);
    t.deepEqual([...decodedDatagram.payload], [170, 187]);
    const bidiPrefix = encodeWebTransportStreamPrefix('bidirectional', 12n);
    t.deepEqual([...bidiPrefix], [64, 65, 3]);
    t.deepEqual(decodeWebTransportStreamPrefix(bidiPrefix), {
      kind: 'bidirectional',
      sessionId: 12n,
      headerLength: 3,
    });
    const uniPrefix = encodeWebTransportStreamPrefix('unidirectional', 16n);
    t.deepEqual([...uniPrefix], [64, 84, 4]);
    t.deepEqual(decodeWebTransportStreamPrefix(uniPrefix), {
      kind: 'unidirectional',
      sessionId: 16n,
      headerLength: 3,
    });
    t.throws(() => encodeHttpDatagram(2n, new Uint8Array()), /client-initiated bidirectional/);
  });
});
