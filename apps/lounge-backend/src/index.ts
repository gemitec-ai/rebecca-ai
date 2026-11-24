import 'dotenv/config';
import { createLoungeApp, createProductionLoungeDependencies } from './app';
import { loadLoungeRuntimeConfig } from './config/loungeConfig';
import { loungeLogger } from './utils/logger';

const config = loadLoungeRuntimeConfig(process.env, 'v1.45.2', 1);
const deps = createProductionLoungeDependencies(process.env);
const app = createLoungeApp(deps);

app.listen(config.port, () => {
  loungeLogger.info('Private Lounge BFF listening', {
    port: config.port,
    nodeEnv: config.nodeEnv,
    phase2EeaEnabled: config.phase2EeaEnabled,
    useEmulators: Boolean(config.authEmulatorHost || config.firestoreEmulatorHost),
  });
});
