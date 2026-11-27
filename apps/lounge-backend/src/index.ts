import 'dotenv/config';
import { createLoungeApp, createProductionLoungeDependencies } from './app';
import { loadLoungeRuntimeConfig } from './config/loungeConfig';
import { loungeLogger } from './utils/logger';

const config = loadLoungeRuntimeConfig(process.env);
const deps = createProductionLoungeDependencies({}, { config });
const app = createLoungeApp(deps);

app.listen(config.port, () => {
  loungeLogger.info('Private Lounge BFF listening', {
    port: config.port,
    nodeEnv: config.nodeEnv,
    phase2EeaEnabled: config.phase2EeaEnabled,
    billingEnabled: config.billingEnabled,
    useEmulators: config.isLocalEmulatorMode,
  });
});
