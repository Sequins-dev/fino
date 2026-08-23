import type { LoadScenario } from 'fino:load';

export default {
  protocol: 'http',
  session(_client, context) {
    context.metric('fixture', context.sequence + 1);
  },
} satisfies LoadScenario;
