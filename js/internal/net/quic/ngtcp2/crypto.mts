/**
 * internal:net/quic/ngtcp2/crypto — selectable ngtcp2 crypto backend.
 *
 * Prefers ngtcp2's OpenSSL backend when present and falls back to GnuTLS. The
 * endpoint uses this adapter so platform package choices do not leak into the
 * public QUIC API.
 *
 * @internal
 */

import {
  getErrorString,
  sslCtxAddCaCertificates,
  sslCtxFree,
  sslCtxNewClient,
  sslCtxNewServer,
  sslCtxSetAlpnServerProtos,
  sslCtxSetCipherSuites,
  sslCtxSetDefaultVerifyPaths,
  sslCtxLoadVerifyLocations,
  sslCtxSetGroups,
  sslCtxSetMaxEarlyData,
  sslCtxSetKeylogCallback,
  sslCtxSetPermissiveVerify,
  sslCtxSetRecvMaxEarlyData,
  sslCtxSetServernameCallback,
  sslCtxSetVerify,
  sslCtxUseCertKey,
  sslEnableQuicEarlyData,
  sslFree,
  sslGetAlpnSelected,
  sslGetCurrentCipherInfo,
  sslGetPeerCertificate,
  sslGetServername,
  sslGetVerifyResult,
  sslExportSession,
  sslImportSession,
  sslNew,
  sslNewSessionTicket,
  sslSetAlpnProtos,
  sslSetAppData,
  sslSetConnectState,
  sslSetMaxEarlyData,
  sslSetRecvMaxEarlyData,
  sslSetVerify,
  sslSetHostname,
  sslSetAcceptState,
  SSL_VERIFY_FAIL_IF_NO_PEER_CERT,
  SSL_VERIFY_PEER,
} from '../../../openssl.mts';
import { Pointer } from './bindings.mts';
import {
  cryptoBackend as osslBackend,
  cryptoOsslAvailable,
  newCryptoOsslContext,
  requireCryptoOssl,
  sym as osslSym,
  ptr as osslPtr,
} from './crypto-ossl.mts';
import {
  cryptoBackend as gnutlsBackend,
  configureGnutlsServerMtls,
  configureGnutlsSession,
  cryptoGnutlsAvailable,
  freeGnutlsCredentials,
  freeGnutlsSession,
  getGnutlsAlpnSelected,
  getGnutlsPeerCertificate,
  getGnutlsServername,
  getGnutlsVerifyResult,
  exportGnutlsSession,
  getGnutlsCipherInfo,
  importGnutlsSession,
  initCryptoGnutls,
  newGnutlsCredentials,
  newGnutlsSession,
  requireCryptoGnutls,
  sendGnutlsSessionTicket,
  setGnutlsConnectionRef,
  setGnutlsSessionTicketCallback,
  sym as gnutlsSym,
  ptr as gnutlsPtr,
  type GnutlsCredentials,
  type GnutlsSession,
} from './crypto-gnutls.mts';

export type QuicCryptoBackend = 'ossl' | 'gnutls';

export type QuicTlsContext = {
  backend: QuicCryptoBackend;
  handle: object | GnutlsCredentials;
  cipherSuites: readonly string[] | null;
  groups: readonly string[] | null;
  alpnCallback?: { close(): void } | null;
  keylogCallback?: { close(): void } | null;
  keylogLine?: ((line: string) => void) | null;
  sniCallback?: { close(): void } | null;
  verifyCallback?: { close(): void } | null;
  verifyMode?: number;
};

export type QuicTlsSession = {
  backend: QuicCryptoBackend;
  handle: object | GnutlsSession;
};

export type QuicImportedSession = {
  resumed: boolean;
  maxEarlyData: number;
};

export type QuicTlsHandshakeInfo = {
  servername: string | null;
  protocol: string;
  cipher: string | null;
  cipherVersion: string | null;
  validationErrorReason: string | null;
  validationErrorCode: number;
};

export type QuicCaOptions = {
  file?: string;
  directory?: string;
  pem?: string | Uint8Array | Array<string | Uint8Array>;
};

export type QuicTlsContextOptions = {
  verifyClient?: boolean;
  rejectUnauthorized?: boolean;
  ca?: QuicCaOptions;
  certificateFile?: string;
  privateKeyFile?: string;
  groups?: readonly string[] | null;
};

export const cryptoBackend: QuicCryptoBackend | null = cryptoOsslAvailable ? osslBackend : gnutlsBackend;
export const cryptoAvailable = cryptoOsslAvailable || cryptoGnutlsAvailable;
export const sym = cryptoOsslAvailable ? osslSym : gnutlsSym;
export const ptr = cryptoOsslAvailable ? osslPtr : gnutlsPtr;

export function requireCrypto(): void {
  if (cryptoOsslAvailable) requireCryptoOssl();
  else if (cryptoGnutlsAvailable) requireCryptoGnutls();
  else throw new Error('no ngtcp2 crypto backend found. Install libngtcp2_crypto_ossl or libngtcp2_crypto_gnutls');
}

export function initCrypto(): void {
  requireCrypto();
  if (cryptoBackend === 'ossl') sym!.ngtcp2_crypto_ossl_init();
  else initCryptoGnutls();
}

function configureOpenSslCa(ctx: object, ca: QuicCaOptions | undefined, verifyPeer: boolean): void {
  if (ca?.pem !== undefined) sslCtxAddCaCertificates(ctx, ca.pem);
  if (ca?.file !== undefined || ca?.directory !== undefined) {
    sslCtxLoadVerifyLocations(ctx, ca.file ?? null, ca.directory ?? null);
  } else if (verifyPeer) {
    sslCtxSetDefaultVerifyPaths(ctx);
  }
}

export function newServerContext(certFile: string, keyFile: string, alpnProtocols: string[], cipherSuites: readonly string[] | null = null, onKeylogLine?: (line: string) => void, tlsOptions: QuicTlsContextOptions = {}): QuicTlsContext {
  if (cryptoBackend === 'ossl') {
    const ctx = sslCtxNewServer();
    try {
      if (cipherSuites !== null) sslCtxSetCipherSuites(ctx, cipherSuites);
      if (tlsOptions.groups !== undefined && tlsOptions.groups !== null) sslCtxSetGroups(ctx, tlsOptions.groups);
      sslCtxUseCertKey(ctx, certFile, keyFile);
      const verifyMode = tlsOptions.verifyClient === true
        ? SSL_VERIFY_PEER | SSL_VERIFY_FAIL_IF_NO_PEER_CERT
        : 0;
      const verifyCallback = verifyMode !== 0 && tlsOptions.rejectUnauthorized === false
        ? sslCtxSetPermissiveVerify(ctx, verifyMode)
        : null;
      if (verifyMode !== 0 && verifyCallback === null) sslCtxSetVerify(ctx, verifyMode);
      configureOpenSslCa(ctx, tlsOptions.ca, verifyMode !== 0);
      const alpnCallback = sslCtxSetAlpnServerProtos(ctx, alpnProtocols);
      const keylogCallback = onKeylogLine === undefined ? null : sslCtxSetKeylogCallback(ctx, onKeylogLine);
      return { backend: 'ossl', handle: ctx, cipherSuites, groups: tlsOptions.groups ?? null, alpnCallback, keylogCallback, keylogLine: null, sniCallback: null, verifyCallback, verifyMode };
    } catch (error) {
      sslCtxFree(ctx);
      throw error;
    }
  }
  if (tlsOptions.groups !== undefined && tlsOptions.groups !== null) throw new Error('QUIC TLS groups are only supported by the OpenSSL crypto backend');
  const cred = newGnutlsCredentials('server', certFile, keyFile);
  if (tlsOptions.verifyClient === true) configureGnutlsServerMtls(cred, true, tlsOptions.ca, tlsOptions.rejectUnauthorized !== false);
  return { backend: 'gnutls', handle: cred, cipherSuites, groups: null, alpnCallback: null, keylogCallback: null, keylogLine: onKeylogLine ?? null, sniCallback: null, verifyCallback: null, verifyMode: tlsOptions.verifyClient === true ? 1 : 0 };
}

export function newClientContext(verifyPeer: boolean, cipherSuites: readonly string[] | null = null, onKeylogLine?: (line: string) => void, tlsOptions: QuicTlsContextOptions = {}): QuicTlsContext {
  if (cryptoBackend === 'ossl') {
    const ctx = sslCtxNewClient();
    if (cipherSuites !== null) sslCtxSetCipherSuites(ctx, cipherSuites);
    if (tlsOptions.groups !== undefined && tlsOptions.groups !== null) sslCtxSetGroups(ctx, tlsOptions.groups);
    if (tlsOptions.certificateFile !== undefined && tlsOptions.privateKeyFile !== undefined) {
      sslCtxUseCertKey(ctx, tlsOptions.certificateFile, tlsOptions.privateKeyFile);
    }
    sslCtxSetVerify(ctx, verifyPeer ? SSL_VERIFY_PEER : 0);
    configureOpenSslCa(ctx, tlsOptions.ca, verifyPeer);
    const keylogCallback = onKeylogLine === undefined ? null : sslCtxSetKeylogCallback(ctx, onKeylogLine);
    return { backend: 'ossl', handle: ctx, cipherSuites, groups: tlsOptions.groups ?? null, alpnCallback: null, keylogCallback, keylogLine: null, sniCallback: null, verifyCallback: null, verifyMode: verifyPeer ? SSL_VERIFY_PEER : 0 };
  }
  if (tlsOptions.groups !== undefined && tlsOptions.groups !== null) throw new Error('QUIC TLS groups are only supported by the OpenSSL crypto backend');
  return { backend: 'gnutls', handle: newGnutlsCredentials('client', tlsOptions.certificateFile, tlsOptions.privateKeyFile, verifyPeer, tlsOptions.ca), cipherSuites, groups: null, alpnCallback: null, keylogCallback: null, keylogLine: onKeylogLine ?? null, sniCallback: null, verifyCallback: null, verifyMode: verifyPeer ? 1 : 0 };
}

export function setSNIContexts(ctx: QuicTlsContext, entries: ReadonlyMap<string, QuicTlsContext>): void {
  if (ctx.backend !== 'ossl') throw new Error('QUIC per-SNI TLS contexts are only supported by the OpenSSL crypto backend');
  const handles = new Map<string, object>();
  for (const [name, entry] of entries) {
    if (entry.backend !== 'ossl') throw new Error('QUIC per-SNI TLS contexts are only supported by the OpenSSL crypto backend');
    handles.set(name, entry.handle as object);
  }
  ctx.sniCallback?.close();
  ctx.sniCallback = sslCtxSetServernameCallback(ctx.handle as object, handles);
}

export function freeContext(ctx: QuicTlsContext): void {
  if (ctx.alpnCallback) ctx.alpnCallback.close();
  if (ctx.keylogCallback) ctx.keylogCallback.close();
  if (ctx.sniCallback) ctx.sniCallback.close();
  if (ctx.verifyCallback) ctx.verifyCallback.close();
  if (ctx.backend === 'ossl') sslCtxFree(ctx.handle as object);
  else freeGnutlsCredentials(ctx.handle as GnutlsCredentials);
}

export function getPeerCertificate(session: QuicTlsSession | null): Uint8Array | null {
  if (session === null) return null;
  if (session.backend === 'ossl') return sslGetPeerCertificate(session.handle as object);
  return getGnutlsPeerCertificate(session.handle as GnutlsSession);
}

export function newServerSession(ctx: QuicTlsContext, alpnProtocols: string[], earlyDataMax = 0): QuicTlsSession {
  if (ctx.backend === 'ossl') {
    if (earlyDataMax > 0) {
      sslCtxSetMaxEarlyData(ctx.handle as object, earlyDataMax);
      sslCtxSetRecvMaxEarlyData(ctx.handle as object, earlyDataMax);
    }
    const ssl = sslNew(ctx.handle as object);
    if ((ctx.verifyMode ?? 0) !== 0) sslSetVerify(ssl, ctx.verifyMode!);
    const rc = sym!.ngtcp2_crypto_ossl_configure_server_session(ssl) as number;
    if (rc !== 0) {
      sslFree(ssl);
      throw new Error('ngtcp2_crypto_ossl_configure_server_session failed: ' + getErrorString());
    }
    if ((ctx.verifyMode ?? 0) !== 0) sslSetVerify(ssl, ctx.verifyMode!);
    if (earlyDataMax > 0) {
      sslSetMaxEarlyData(ssl, earlyDataMax);
      sslSetRecvMaxEarlyData(ssl, earlyDataMax);
      sslEnableQuicEarlyData(ssl, true);
    }
    sslSetAcceptState(ssl);
    return { backend: 'ossl', handle: ssl };
  }
  return { backend: 'gnutls', handle: newGnutlsSession('server', ctx.handle as GnutlsCredentials, alpnProtocols, undefined, false, earlyDataMax, ctx.cipherSuites, ctx.keylogLine ?? undefined) };
}

export function newClientSession(ctx: QuicTlsContext, alpnProtocols: string[], serverName: string, verifyPeer: boolean, earlyDataMax = 0): QuicTlsSession {
  if (ctx.backend === 'ossl') {
    const ssl = sslNew(ctx.handle as object);
    try {
      sslSetHostname(ssl, serverName);
      sslSetAlpnProtos(ssl, alpnProtocols);
      if (earlyDataMax > 0) sslSetMaxEarlyData(ssl, earlyDataMax);
      const rc = sym!.ngtcp2_crypto_ossl_configure_client_session(ssl) as number;
      if (rc !== 0) throw new Error('ngtcp2_crypto_ossl_configure_client_session failed: ' + getErrorString());
      sslSetConnectState(ssl);
      return { backend: 'ossl', handle: ssl };
    } catch (error) {
      sslFree(ssl);
      throw error;
    }
  }
  const session = newGnutlsSession('client', ctx.handle as GnutlsCredentials, alpnProtocols, serverName, verifyPeer, earlyDataMax, ctx.cipherSuites, ctx.keylogLine ?? undefined);
  try {
    configureGnutlsSession('client', session);
    return { backend: 'gnutls', handle: session };
  } catch (error) {
    freeGnutlsSession(session);
    throw error;
  }
}

export function exportSession(session: QuicTlsSession): Uint8Array | null {
  if (session.backend === 'ossl') return sslExportSession(session.handle as object);
  return exportGnutlsSession(session.handle as GnutlsSession);
}

export function importSession(session: QuicTlsSession, data: Uint8Array, earlyDataMax = 0): QuicImportedSession {
  if (session.backend === 'ossl') {
    const imported = sslImportSession(session.handle as object, data, earlyDataMax);
    if (imported.imported && imported.maxEarlyData > 0) sslEnableQuicEarlyData(session.handle as object, true);
    return { resumed: imported.imported, maxEarlyData: imported.maxEarlyData };
  }
  return {
    resumed: importGnutlsSession(session.handle as GnutlsSession, data),
    maxEarlyData: Number.MAX_SAFE_INTEGER,
  };
}

export function freeSession(session: QuicTlsSession): void {
  if (session.backend === 'ossl') sslFree(session.handle as object);
  else freeGnutlsSession(session.handle as GnutlsSession);
}

export function getAlpnSelected(session: QuicTlsSession | null): string {
  if (session === null) return '';
  return session.backend === 'ossl'
    ? (sslGetAlpnSelected(session.handle as object) ?? '')
    : getGnutlsAlpnSelected(session.handle as GnutlsSession);
}

export function getHandshakeInfo(session: QuicTlsSession | null, fallbackServername: string | null = null): QuicTlsHandshakeInfo {
  if (session === null) {
    return {
      servername: fallbackServername,
      protocol: '',
      cipher: null,
      cipherVersion: null,
      validationErrorReason: null,
      validationErrorCode: 0,
    };
  }
  const protocol = getAlpnSelected(session);
  if (session.backend === 'ossl') {
    const cipher = sslGetCurrentCipherInfo(session.handle as object);
    const validation = sslGetVerifyResult(session.handle as object);
    return {
      servername: sslGetServername(session.handle as object) ?? fallbackServername,
      protocol,
      cipher: cipher.cipher,
      cipherVersion: cipher.cipherVersion,
      validationErrorReason: validation.reason,
      validationErrorCode: validation.code,
    };
  }
  const gSession = session.handle as GnutlsSession;
  const cipher = getGnutlsCipherInfo(gSession);
  const verification = getGnutlsVerifyResult(gSession);
  return {
    servername: getGnutlsServername(gSession) ?? fallbackServername,
    protocol,
    cipher: cipher.cipher,
    cipherVersion: cipher.cipherVersion,
    validationErrorReason: verification.reason,
    validationErrorCode: verification.code,
  };
}

export function sendSessionTicket(session: QuicTlsSession): void {
  if (session.backend === 'ossl') sslNewSessionTicket(session.handle as object);
  else sendGnutlsSessionTicket(session.handle as GnutlsSession);
}

export function setSessionTicketCallback(session: QuicTlsSession, callback: ((ticket: Uint8Array) => void) | null): void {
  if (session.backend === 'gnutls') setGnutlsSessionTicketCallback(session.handle as GnutlsSession, callback);
}

export function setConnectionRef(session: QuicTlsSession, connRef: ArrayBuffer): void {
  if (session.backend === 'ossl') sslSetAppData(session.handle as object, Pointer.of(connRef));
  else setGnutlsConnectionRef(session.handle as GnutlsSession, connRef);
}

export function clearConnectionRef(session: QuicTlsSession): void {
  if (session.backend === 'ossl') sslSetAppData(session.handle as object, null);
  else setGnutlsConnectionRef(session.handle as GnutlsSession, null);
}

export function newNativeHandle(session: QuicTlsSession): ArrayBuffer {
  if (session.backend === 'ossl') return newCryptoOsslContext(session.handle as object);
  return (session.handle as GnutlsSession).handle;
}

export function configureSessionForConnection(role: 'client' | 'server', session: QuicTlsSession): void {
  if (session.backend === 'gnutls') configureGnutlsSession(role, session.handle as GnutlsSession);
}

export function freeNativeHandle(backend: QuicCryptoBackend, nativeHandle: ArrayBuffer): void {
  if (backend === 'ossl') sym!.ngtcp2_crypto_ossl_ctx_del(nativeHandle);
}
