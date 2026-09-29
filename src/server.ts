import { createApp } from './app';
import { loadConfig } from './config';
import { buildContainer } from './container';
import { logger } from './infra/logger';

const config = loadConfig();
const container = buildContainer(config);
const server = createApp(container).listen(config.PORT, () => {
  logger.info({ port: config.PORT }, 'ModaCo API listening');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(async () => {
      await container.close();
      process.exit(0);
    });
  });
}
