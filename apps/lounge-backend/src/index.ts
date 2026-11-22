import 'dotenv/config';
import { createLoungeApp, createSkeletonLoungeDependencies } from './app';
import { loungeLogger } from './utils/logger';

const port = Number(process.env['PORT'] ?? 8083);
const app = createLoungeApp(createSkeletonLoungeDependencies(process.env));

app.listen(port, () => {
  loungeLogger.info('Private Lounge BFF architecture skeleton listening', { port });
});
