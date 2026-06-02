# topic

fino:topic - Named pub/sub channels with Context binding.

A `Topic` is a named pub/sub channel. When a `Context` is bound to a Topic,
calling `topic.runWithValue(msg, fn)` automatically derives and installs the
bound context value for the duration of `fn`. This separates the concerns of
*publishing* (the library/framework) from *consuming* context (application code).

```ts
import { topic } from 'fino:context/topic';
import { Context } from 'fino:context';

const requestCtx = new Context('request');
const httpTopic = topic('http.request');

httpTopic.bindContext(requestCtx, (req) => req);

// In a handler:
httpTopic.runWithValue(request, () => {
  // requestCtx.get() === request here, and in any awaited code
  handleRequest();
});
```

## topic

```ts
function topic<T = unknown>(name: string): Topic<T>
```

Get or create a named `Topic`. Topics with the same name share state across
all imports - useful for cross-cutting bindings between libraries.

A new topic starts with no subscribers and no context bindings. The function
never returns `null`; invalid or empty names are accepted as ordinary map
keys, so choose stable names such as `package:event`.

```ts
import { topic } from 'fino:context/topic';

const requests = topic<{ id: string }>('http:request');
requests.publish({ id: 'req-1' });
```

## subscribeMatching

```ts
function subscribeMatching<T = unknown>(
  matcher: (
    name: string
  ) => boolean,
  fn: (
    msg: T,
    topicName: string
  ) => void
): SubscriptionHandle
```

Subscribe to all existing and future topics whose names match `matcher`.

Returns a handle that removes every attached subscription when disposed.
The matcher is evaluated for topics already in the registry and for each
topic created later. Callback errors are handled by the matched topic's
normal `publish()` error path.

```ts
import { subscribeMatching, topic } from 'fino:context/topic';

const handle = subscribeMatching(
  (name) => name.startsWith('audit:'),
  (event, topicName) => console.log(topicName, event),
);
topic('audit:login').publish({ user: 'ana' });
handle.dispose();
```

## Topic

```ts
class Topic<T = unknown> {
```

Named publish/subscribe channel that can bind messages into async contexts.

Topics deliver messages synchronously to current subscribers. Use
`runWithValue()` when subscribers and a callback should execute with context
values derived from the message.

```ts
import { topic } from 'fino:context/topic';

const updates = topic<string>('status:update');
updates.subscribe((message) => console.log(message));
updates.publish('ready');
```

### constructor

```ts
constructor(name: string)
```

Create an unregistered topic instance.

Direct construction is useful for private channels. Use `topic(name)` when
other modules should retrieve the same shared instance by name.

```ts
import { Topic } from 'fino:context/topic';

const privateTopic = new Topic<number>('local:count');
privateTopic.publish(1);
```

### name

```ts
get name(): string
```

Read the topic name.

The name is not required to be globally unique for directly constructed
topics, but registry-created topics use it as their lookup key.

```ts
import { topic } from 'fino:context/topic';

console.log(topic('metrics:tick').name);
```

### hasSubscribers

```ts
get hasSubscribers(): boolean
```

Report whether the topic currently has one or more subscribers.

This is a synchronous snapshot. It may be used to avoid constructing
expensive messages, but a subscriber can still be added or disposed
immediately after the check.

```ts
import { topic } from 'fino:context/topic';

const events = topic('metrics:event');
if (events.hasSubscribers) events.publish({ count: 1 });
```

### subscribe

```ts
subscribe(fn: (msg: T) => void): SubscriptionHandle
```

Register a subscriber callback. Returns a `SubscriptionHandle` with a
`dispose()` method to remove the subscription.

The same function can be subscribed multiple times; each call returns an
independent handle.

Delivery is synchronous during `publish()` and `runWithValue()`. A thrown
subscriber error is forwarded to the `execution-flow:error` topic and does
not prevent later subscribers from receiving the same message.

```ts
import { topic } from 'fino:context/topic';

const messages = topic<string>('chat:message');
const handle = messages.subscribe((message) => console.log(message));
handle.dispose();
```

### unsubscribe

```ts
unsubscribe(handle: SubscriptionHandle): void
```

Remove a subscription via its handle.

This is equivalent to calling `handle.dispose()`. Passing a handle from a
different topic is harmless when the handle itself is still valid because
handles close over their own removal logic.

```ts
import { topic } from 'fino:context/topic';

const events = topic('app:event');
const handle = events.subscribe(() => {});
events.unsubscribe(handle);
```

### publish

```ts
publish(msg: T): void
```

Fire all subscribers with `msg`. Each subscriber runs in its own
try/catch; errors are forwarded to the `"execution-flow:error"` topic so
a failing subscriber never blocks delivery to others.

Note: does NOT enter bound context scopes. Use `runWithValue()` for that.

Publishing to a topic with no subscribers is a no-op. Messages are passed
by reference; mutating an object in one subscriber affects later
subscribers that receive the same object.

```ts
import { topic } from 'fino:context/topic';

const events = topic<{ ok: boolean }>('service:event');
events.subscribe((event) => console.log(event.ok));
events.publish({ ok: true });
```

### bindContext

```ts
bindContext<C>(ctx: {
  runWithValue<R>(val: C, fn: () => R): R;
}, transform: (msg: T) => C): BindingHandle
```

Declare that when this topic fires via `runWithValue()`, `ctx` should
be set to `transform(msg)` for the duration of the call. Multiple bindings
are entered in registration order (outermost first) and restored in reverse.

```ts
import { Context } from 'fino:context';
import { topic } from 'fino:context/topic';

const requestId = new Context<string>('requestId');
const requests = topic<{ id: string }>('http:request');
const binding = requests.bindContext(requestId, (request) => request.id);
binding.dispose();
```

### unbindContext

```ts
unbindContext(handle: BindingHandle): void
```

Remove a context binding via its handle.

This is equivalent to calling `handle.dispose()`. Once removed, future
`runWithValue()` calls no longer enter the associated context.

```ts
import { Context } from 'fino:context';
import { topic } from 'fino:context/topic';

const ctx = new Context<string>('tenant');
const events = topic<{ tenant: string }>('tenant:event');
const handle = events.bindContext(ctx, (event) => event.tenant);
events.unbindContext(handle);
```

### runWithValue

```ts
runWithValue<R>(msg: T, fn: () => R): R
```

Enter all bound context scopes (in registration order), publish `msg` to
subscribers, then run `fn` - all within those scopes. Context values are
derived by calling each binding's `transform(msg)`. Scopes are restored in
reverse order after `fn` returns or throws.

```ts
import { Context } from 'fino:context';
import { topic } from 'fino:context/topic';

const ctx = new Context<string>('requestId');
const requests = topic<{ id: string }>('http:request');
requests.bindContext(ctx, (request) => request.id);
requests.runWithValue({ id: 'req-1' }, () => console.log(ctx.get()));
```

## SubscriptionHandle

```ts
class SubscriptionHandle {
```

Disposable handle returned from topic subscriptions.

Disposing removes the callback from the topic that created the handle. The
current implementation tolerates repeated disposal.

```ts
import { topic } from 'fino:context/topic';

const handle = topic('logs').subscribe((line) => console.log(line));
handle.dispose();
```

### constructor

```ts
constructor(disposeFn: () => void)
```

Create a subscription handle from a disposal callback.

Application code normally receives handles from `Topic.subscribe()` or
`subscribeMatching()`. The callback is called every time `dispose()` is
invoked, so make custom callbacks idempotent.

```ts
import { SubscriptionHandle } from 'fino:context/topic';

const handle = new SubscriptionHandle(() => console.log('disposed'));
handle.dispose();
```

### dispose

```ts
dispose(): void
```

Remove the subscription.

Calling more than once is safe for handles created by this module. Custom
handles depend on the callback passed to the constructor.

```ts
import { topic } from 'fino:context/topic';

const handle = topic('events').subscribe(() => {});
handle.dispose();
```

## BindingHandle

```ts
class BindingHandle {
```

Disposable handle returned from context bindings.

Disposing removes one registered binding from a topic. Other bindings and
subscriptions remain active.

```ts
import { Context } from 'fino:context';
import { topic } from 'fino:context/topic';

const ctx = new Context<string>('trace');
const handle = topic<{ trace: string }>('trace:event')
  .bindContext(ctx, (event) => event.trace);
handle.dispose();
```

### constructor

```ts
constructor(disposeFn: () => void)
```

Create a binding handle from a disposal callback.

Application code normally receives handles from `Topic.bindContext()`.
Custom callbacks should be idempotent if callers may dispose repeatedly.

```ts
import { BindingHandle } from 'fino:context/topic';

const handle = new BindingHandle(() => console.log('unbound'));
handle.dispose();
```

### dispose

```ts
dispose(): void
```

Remove the context binding.

Calling more than once is safe for handles created by this module. After
disposal, future `Topic.runWithValue()` calls skip the removed binding.

```ts
import { Context } from 'fino:context';
import { topic } from 'fino:context/topic';

const ctx = new Context<string>('trace');
const handle = topic<string>('trace').bindContext(ctx, (trace) => trace);
handle.dispose();
```
