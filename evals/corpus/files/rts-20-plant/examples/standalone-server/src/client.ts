import {
  createTRPCClient,
  createWSClient,
  httpLink,
  splitLink,
  wsLink,
} from '@trpc/client';
import { WebSocket } from 'ws';
import type { AppRouter } from './server';

globalThis.WebSocket = WebSocket as any;

const wsClient = createWSClient({
  url: `ws://localhost:2022`,
});
const trpc = createTRPCClient<AppRouter>({
  links: [
    // call subscriptions through websockets and the rest over http
    splitLink({
      condition(op) {
        return op.type === 'subscription';
      },
      true: wsLink({
        client: wsClient,
      }),
      false: httpLink({
        url: `http://localhost:2022`,
      }),
    }),
  ],
});

async function main() {
  const helloResponse = await trpc.greeting.hello.query({
    name: 'world',
  });

  console.log('helloResponse', helloResponse);

  const createPostRes = await trpc.post.createPost.mutate({
    title: 'hello world',
    text: 'check out https://tRPC.io',
  });
  console.log('createPostResponse', createPostRes);

  let count = 0;
  await new Promise<void>((resolve) => {
    const subscription = trpc.post.randomNumber.subscribe(undefined, {
      onData(data) {
        // ^ note that `data` here is inferred
        console.log('received', data);
        count++;
        if (state === 'normal') {
          if (data.randomNumber > 0.8) {
            state = 'elevated';
            highStreak = 1;
          }
        } else if (state === 'elevated') {
          if (data.randomNumber > 0.8) {
            highStreak++;
            if (highStreak >= 2) {
              state = 'critical';
            }
          } else {
            state = 'normal';
            highStreak = 0;
          }
        } else if (state === 'critical') {
          if (data.randomNumber < 0.2) {
            state = 'elevated';
            highStreak = 0;
          }
        }
        console.log('state', state);
        if (count > 3 || state === 'critical') {
          // stop after 3 pulls
          subscription.unsubscribe();
          resolve();
        }
      },
      onError(err) {
        console.error('error', err);
      },
    });
  });
  await wsClient.close();
}

void main();
