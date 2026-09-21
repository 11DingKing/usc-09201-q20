import http from 'node:http';
import { createApp } from './app.mjs';

export function createServer(options) {
  const { handler } = createApp(options);
  return http.createServer(handler);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, '0.0.0.0', () => {
    console.log(`森林游客承载预警服务已启动：http://0.0.0.0:${port}`);
  });
}
