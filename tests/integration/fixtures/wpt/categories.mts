export interface WptCategory {
  path: string;
  globals: string[];
}

export const WPT_CATEGORIES: WptCategory[] = [
  { path: 'url', globals: ['URL', 'URLSearchParams'] },
  { path: 'urlpattern', globals: ['URLPattern'] },
  { path: 'encoding', globals: ['TextEncoder', 'TextDecoder'] },
  { path: 'dom/abort', globals: ['AbortController', 'AbortSignal'] },
  { path: 'dom/events', globals: ['Event', 'CustomEvent', 'EventTarget'] },
  { path: 'streams', globals: ['ReadableStream', 'WritableStream', 'TransformStream'] },
  { path: 'fetch', globals: ['fetch', 'Headers', 'Request', 'Response'] },
  { path: 'FileAPI', globals: ['Blob', 'File', 'FormData'] },
  { path: 'WebCryptoAPI', globals: ['crypto', 'crypto.subtle', 'CryptoKey'] },
  { path: 'console', globals: ['console'] },
  { path: 'hr-time', globals: ['performance'] },
  { path: 'html/webappapis/timers', globals: ['setTimeout', 'setInterval'] },
  { path: 'html/webappapis/microtask-queuing', globals: ['queueMicrotask'] },
  { path: 'html/webappapis/scripting/processing-model-2', globals: ['reportError'] },
  { path: 'html/browsers/the-window-object', globals: ['self'] },
  { path: 'html/dom/navigator', globals: ['navigator'] },
  { path: 'webmessaging', globals: ['MessageEvent', 'MessageChannel', 'MessagePort'] },
  { path: 'html/webappapis/channel-messaging', globals: ['MessageChannel', 'MessagePort'] },
  { path: 'broadcastchannel', globals: ['BroadcastChannel'] },
  { path: 'eventsource', globals: ['EventSource'] },
  { path: 'compression', globals: ['CompressionStream', 'DecompressionStream'] },
  { path: 'websockets', globals: ['WebSocket', 'CloseEvent', 'ErrorEvent'] },
  { path: 'webtransport', globals: ['WebTransport'] },
];
