import { describe, it } from 'fino:test/test';
import {
  decodeBackendMessage,
  encodeBind,
  encodeCancelRequest,
  encodeParse,
  encodePasswordMessage,
  encodeQuery,
  encodeSaslInitialResponse,
  encodeSaslResponse,
  encodeStartupMessage
} from 'internal:database/postgres/protocol';
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
describe('Postgres protocol messages', () => {
  it('encodes StartupMessage with protocol 3.0 and null-terminated parameters', (t) => {
    t.equal(hex(encodeStartupMessage({ user: 'ada', database: 'app' })), '0000001f000300007573657200616461006461746162617365006170700000');
  });
  it('encodes CancelRequest with process id and secret key', (t) => {
    t.equal(hex(encodeCancelRequest(1234, new Uint8Array([1, 2, 3, 4]))), '0000001004d2162e000004d201020304');
  });
  it('encodes frontend query, parse, bind, and password messages', (t) => {
    t.equal(hex(encodeQuery('SELECT 1')), '510000000d53454c454354203100');
    t.equal(hex(encodePasswordMessage('secret')), '700000000b73656372657400');
    t.equal(hex(encodeParse('', 'SELECT $1', [23])), '50000000150053454c45435420243100000100000017');
    t.equal(hex(encodeBind('', '', ['42'])), '42000000120000000000010000000234320000');
  });
  it('encodes SASL initial and response password messages', (t) => {
    t.equal(hex(encodeSaslInitialResponse('SCRAM-SHA-256', 'n,,n=*,r=fyko')), '7000000023534352414d2d5348412d323536000000000d6e2c2c6e3d2a2c723d66796b6f');
    t.equal(hex(encodeSaslResponse('c=biws,r=fyko,p=proof')), '7000000019633d626977732c723d66796b6f2c703d70726f6f66');
  });
  it('decodes row descriptions, data rows, command completion, ready state, and notifications', (t) => {
    const rowDescription = new Uint8Array([
      0x54, 0, 0, 0, 26, 0, 1,
      0x6e, 0,
      0, 0, 0, 0,
      0, 0,
      0, 0, 0, 23,
      0, 4,
      0xff, 0xff, 0xff, 0xff,
      0, 0
    ]);
    t.deepEqual(decodeBackendMessage(rowDescription), {
      type: 'RowDescription',
      fields: [{ name: 'n', tableOid: 0, columnAttribute: 0, typeOid: 23, typeSize: 4, typeModifier: -1, format: 0 }]
    });
    t.deepEqual(decodeBackendMessage(new Uint8Array([0x44, 0, 0, 0, 12, 0, 1, 0, 0, 0, 1, 0x31])), {
      type: 'DataRow',
      values: [new Uint8Array([0x31])]
    });
    t.deepEqual(decodeBackendMessage(new Uint8Array([0x43, 0, 0, 0, 13, 0x53, 0x45, 0x4c, 0x45, 0x43, 0x54, 0x20, 0x31, 0])), {
      type: 'CommandComplete',
      tag: 'SELECT 1'
    });
    t.deepEqual(decodeBackendMessage(new Uint8Array([0x5a, 0, 0, 0, 5, 0x49])), { type: 'ReadyForQuery', status: 'I' });
    t.deepEqual(decodeBackendMessage(new Uint8Array([0x41, 0, 0, 0, 18, 0, 0, 0, 7, 0x63, 0x68, 0, 0x70, 0x61, 0x79, 0,])), {
      type: 'NotificationResponse',
      processId: 7,
      channel: 'ch',
      payload: 'pay'
    });
  });
});
